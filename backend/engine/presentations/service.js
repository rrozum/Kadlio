import path from 'node:path';
import { readFile, writeFile, readdir, mkdir, cp, rm, stat } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ProjectStore } from './store.js';
import { badRequest, notFound, conflict } from '../errors.js';
import { cloneSlideHTML } from '../html/clone.js';
import { sanitizeHTML } from '../html/sanitize.js';
import { validateSlideScript, validateElementEffects } from '../html/runtime-validation.js';
import { writeAtomic } from '../../storage/connectors/json-files.js';
const atomicFile = (file, content) => writeAtomic(file, content, { mode: 0o600 });
import { createTitleSlide, createThemeCSS } from '../../../shared/presentation/default-theme.js';
import {
  validatePresentationDesign,
  validateThemeCSS,
  assetReferences,
  rebaseDesign,
} from '../html/design.js';
import { ThemeStore } from '../themes/service.js';
import { normalizeEffects } from '../../../shared/addons/motion/runtime.js';
import {
  normalizeTimeline,
  validateTimeline,
  timelineForOrder,
  timelineAfterSlideRemoval,
} from '../../../shared/presentation/timeline.js';
import { validateVariableUpdate } from '../html/template-variables.js';
import { decodeMedia } from '../html/media.js';

const validId = /^[a-zA-Z0-9_-]{1,64}$/;
function setTimeline(project, timeline) {
  try {
    project.timeline = validateTimeline(timeline, project.slides);
  } catch (error) {
    throw badRequest(error.message);
  }
  for (const entry of project.timeline) if (entry.snippet) validateSlideScript(entry.snippet.code);
  const byId = new Map(project.slides.map((slide) => [slide.id, slide]));
  project.slides = project.timeline
    .filter((entry) => entry.type === 'slide')
    .map((entry) => byId.get(entry.id));
  for (const slide of project.slides) delete slide.effects;
}

export class PresentationEngine {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.projectsDir = path.join(this.dataDir, 'projects');
    this.stores = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.revision = 0;
    this.themes = new ThemeStore(this.dataDir, {
      readProject: (id) => this.get(id),
      readProjectAsset: (id, name) => this.asset(id, name),
    });
    this.extensions = [];
  }
  directory(id) {
    if (!validId.test(id)) throw notFound();
    return path.join(this.projectsDir, id);
  }
  async init({ legacyRoot, legacyFile } = {}) {
    await mkdir(this.projectsDir, { recursive: true, mode: 0o700 });
    await this.themes.init();
    for (const extension of this.extensions) await extension.init?.();
    if (
      !(await readdir(this.projectsDir)).some((name) => validId.test(name)) &&
      legacyRoot &&
      legacyFile
    ) {
      const source = JSON.parse(await readFile(legacyFile, 'utf8')),
        id = randomUUID(),
        directory = this.directory(id);
      await mkdir(directory, { mode: 0o700 });
      await cp(path.join(legacyRoot, 'slides'), path.join(directory, 'slides'), {
        recursive: true,
      });
      const assetSource = path.join(legacyRoot, 'public/assets');
      try {
        await cp(assetSource, path.join(directory, 'assets'), { recursive: true });
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const prefix = '/api/projects/' + id + '/assets/';
      const css = (await readFile(path.join(legacyRoot, 'public/deck.css'), 'utf8')).replace(
        /(?:\/assets\/|assets\/)/g,
        prefix,
      );
      await writeFile(path.join(directory, 'theme.css'), css, { mode: 0o600 });
      for (const slide of source.slides) {
        const file = path.join(directory, 'slides', slide.id + '.html');
        await atomicFile(
          file,
          (await readFile(file, 'utf8')).replace(/(?:\/assets\/|assets\/)/g, prefix),
        );
        slide.version = slide.version || 0;
      }
      const timestamp = new Date().toISOString();
      await atomicFile(
        path.join(directory, 'presentation.json'),
        JSON.stringify(
          {
            ...source,
            id,
            author: source.author || '',
            brand: source.brand || '',
            version: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          null,
          2,
        ) + '\n',
      );
    }
    // После перезапуска процесса генерации уже нет. Сохраняем частичные
    // слайды; повторный запуск выполняется только по действию владельца.
    for (const id of (await readdir(this.projectsDir)).filter((name) => validId.test(name))) {
      let store;
      try {
        store = await this.getStore(id);
      } catch (error) {
        if (error.status === 404) continue;
        throw error;
      }
      const project = await store.read();
      if (project.creation?.status === 'generating')
        await store.mutate((p) => {
          p.creation = {
            ...p.creation,
            status: 'interrupted',
            error: 'Генерация остановлена при перезапуске сервера.',
            updatedAt: new Date().toISOString(),
          };
          p.version = (p.version || 0) + 1;
        });
    }
    return this;
  }
  async getStore(id) {
    const directory = this.directory(id);
    if (!this.stores.has(id)) {
      try {
        await stat(path.join(directory, 'presentation.json'));
      } catch (e) {
        if (e.code === 'ENOENT') throw notFound();
        throw e;
      }
      const store = new ProjectStore(directory);
      store.onChange = (project) =>
        this.events.emit('projectChanged', {
          id,
          version: project.version || 0,
          updatedAt: project.updatedAt,
          revision: ++this.revision,
        });
      this.stores.set(id, store);
    }
    return this.stores.get(id);
  }
  async get(id) {
    const store = await this.getStore(id);
    await store.queue.catch(() => {});
    const snapshot = await store.snapshot();
    setTimeline(snapshot, normalizeTimeline(snapshot));
    snapshot.slides = snapshot.slides.map((s) => ({ ...s, body: sanitizeHTML(s.body) }));
    return { ...snapshot, css: await readFile(path.join(this.directory(id), 'theme.css'), 'utf8') };
  }
  async list() {
    const items = await readdir(this.projectsDir);
    const projects = [];
    for (const id of items.filter((name) => validId.test(name))) {
      try {
        const p = await (await this.getStore(id)).read();
        projects.push({
          id,
          title: p.title,
          version: p.version || 0,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          slideCount: p.slides.length,
          creationMode: p.creationMode || 'manual',
          ...(p.creation ? { creation: p.creation } : {}),
        });
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  async create({ title, themeId, description = '', creationMode = 'manual', blank = false } = {}) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200)
      throw badRequest('Укажите название презентации до 200 символов.');
    if (typeof description !== 'string' || description.length > 10000)
      throw badRequest('Описание должно быть текстом до 10 000 символов.');
    if (!['manual', 'smart'].includes(creationMode) || typeof blank !== 'boolean')
      throw badRequest('Выберите ручное или умное создание презентации.');
    const id = randomUUID(),
      directory = this.directory(id),
      timestamp = new Date().toISOString();
    await mkdir(path.join(directory, 'slides'), { recursive: true, mode: 0o700 });
    const slide = {
      id: 'slide-01',
      title: title.trim(),
      seconds: 60,
      section: '',
      layout: '',
      kind: 'main',
      notes: '',
      notesVersion: 0,
      version: 0,
    };
    await writeFile(
      path.join(directory, 'slides/slide-01.html'),
      blank ? '' : createTitleSlide(title.trim()),
      { mode: 0o600 },
    );
    await writeFile(path.join(directory, 'theme.css'), createThemeCSS(), { mode: 0o600 });
    await atomicFile(
      path.join(directory, 'presentation.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id,
          title: title.trim(),
          description: description.trim(),
          creationMode,
          creation: {
            status: creationMode === 'smart' ? 'pending' : 'ready',
            attempts: 0,
            updatedAt: timestamp,
          },
          author: '',
          brand: '',
          version: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          slides: [slide],
          timeline: [{ type: 'slide', id: slide.id }],
          annotations: [],
        },
        null,
        2,
      ) + '\n',
    );
    try {
      return themeId ? await this.applyTheme(id, { themeId, version: 0 }) : await this.get(id);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      this.stores.delete(id);
      throw error;
    }
  }
  async rename(id, payload = {}) {
    if (
      Object.keys(payload).some(
        (key) => !['title', 'description', 'creationMode', 'version'].includes(key),
      ) ||
      !Number.isInteger(payload.version)
    )
      throw badRequest('Необходима версия и допустимые поля проекта.');
    const { title, description, creationMode, version } = payload;
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200))
      throw badRequest('Некорректное название.');
    if (
      description !== undefined &&
      (typeof description !== 'string' || description.length > 10000)
    )
      throw badRequest('Описание должно быть текстом до 10 000 символов.');
    if (creationMode !== undefined && !['manual', 'smart'].includes(creationMode))
      throw badRequest('Неверный режим создания.');
    await (
      await this.getStore(id)
    ).mutate((p) => {
      if (version !== (p.version || 0))
        throw conflict('Проект уже изменён. Обновите его и согласуйте правки.');
      if (p.creation?.status === 'generating')
        throw conflict('Остановите генерацию перед изменением параметров проекта.');
      if (creationMode !== undefined && creationMode !== (p.creationMode || 'manual')) {
        if (p.creationMode === 'smart' && p.creation?.status === 'ready')
          throw conflict('Генерация уже завершена. Продолжите работу в редакторе.');
        p.creationMode = creationMode;
        p.creation = {
          status: creationMode === 'smart' ? 'pending' : 'ready',
          attempts: 0,
          updatedAt: new Date().toISOString(),
        };
      }
      if (title !== undefined) p.title = title.trim();
      if (description !== undefined) p.description = description.trim();
      p.version = (p.version || 0) + 1;
    });
    return this.get(id);
  }
  async updateVariables(id, payload = {}) {
    const { values, version, slideId, slideVersion, slideChanged } =
      validateVariableUpdate(payload);
    await (
      await this.getStore(id)
    ).mutate((project) => {
      if (version !== (project.version || 0))
        throw conflict(
          'Переменные уже изменены. Ваш черновик сохранён; согласуйте его с новой версией.',
        );
      const slide = slideChanged ? project.slides.find((item) => item.id === slideId) : null;
      if (slideChanged && !slide) throw notFound('Слайд не найден.');
      if (slideChanged && slideVersion !== (slide.version || 0))
        throw conflict('Слайд уже изменён. Ваш черновик переменных сохранён.');
      for (const key of ['author', 'brand'])
        if (values[key] !== undefined) {
          project[key] = values[key];
          if (project.design) project.design.metadata[key] = values[key];
        }
      if (values.projectTitle !== undefined) project.title = values.projectTitle;
      if (slideChanged) {
        if (values.slideTitle !== undefined) slide.title = values.slideTitle;
        if (values.section !== undefined) slide.section = values.section;
        slide.version = (slide.version || 0) + 1;
      }
      project.version = (project.version || 0) + 1;
    });
    return this.get(id);
  }
  async beginGeneration(id) {
    let generation;
    await (
      await this.getStore(id)
    ).mutate((p) => {
      if (p.creationMode !== 'smart') throw conflict('Ручное создание не запускает ИИ.');
      if (!['pending', 'interrupted', 'error'].includes(p.creation?.status))
        throw conflict(
          p.creation?.status === 'ready'
            ? 'Презентация уже создана. Продолжите работу в редакторе.'
            : 'Генерация уже выполняется.',
        );
      const attempts = (p.creation.attempts || 0) + 1,
        now = new Date().toISOString();
      generation = { attempts, resume: attempts > 1 };
      p.creation = { status: 'generating', attempts, startedAt: now, updatedAt: now };
      p.version = (p.version || 0) + 1;
    });
    return generation;
  }
  async finishGeneration(id, attempts, status, error) {
    if (!['ready', 'interrupted', 'error'].includes(status))
      throw badRequest('Неверный статус генерации.');
    await (
      await this.getStore(id)
    ).mutate((p) => {
      if (p.creation?.attempts !== attempts || p.creation.status !== 'generating')
        throw conflict('Состояние генерации уже изменилось.');
      const now = new Date().toISOString();
      p.creation = {
        ...p.creation,
        status,
        updatedAt: now,
        ...(status === 'ready' ? { completedAt: now } : {}),
        ...(error ? { error: String(error).slice(0, 1000) } : {}),
      };
      p.version = (p.version || 0) + 1;
    });
    return (await this.get(id)).creation;
  }
  async updateDesign(id, { design, version }) {
    if (!Number.isInteger(version)) throw badRequest('Необходима версия презентации.');
    const checked = validatePresentationDesign(design, id);
    for (const url of assetReferences(checked)) await this.asset(id, path.basename(url));
    await (
      await this.getStore(id)
    ).mutate((p) => {
      if (version !== (p.version || 0))
        throw conflict('Оформление уже изменено. Обновите презентацию и согласуйте правки.');
      p.design = checked;
      p.version = (p.version || 0) + 1;
    });
    return this.get(id);
  }
  async updateCSS(id, { css, version } = {}) {
    if (!Number.isInteger(version)) throw badRequest('Необходима версия презентации.');
    const checked = validateThemeCSS(css, id);
    for (const url of assetReferences(checked)) await this.asset(id, path.basename(url));
    await (
      await this.getStore(id)
    ).mutate(async (project) => {
      if (version !== (project.version || 0))
        throw conflict('CSS уже изменён. Обновите презентацию.');
      await atomicFile(path.join(this.directory(id), 'theme.css'), checked);
      project.version = (project.version || 0) + 1;
    });
    return this.get(id);
  }
  async applyTheme(id, { themeId, version } = {}) {
    if (!Number.isInteger(version)) throw badRequest('Необходима версия презентации.');
    const theme = await this.themes.get(themeId),
      from = '/api/themes/' + theme.id + '/assets/',
      to = '/api/projects/' + id + '/assets/';
    const design = validatePresentationDesign(rebaseDesign(theme.design, from, to), id),
      references = assetReferences(theme.design);
    await (
      await this.getStore(id)
    ).mutate(async (project) => {
      if (version !== (project.version || 0))
        throw conflict('Оформление уже изменено. Обновите презентацию.');
      const directory = path.join(this.directory(id), 'assets');
      if (references.length) await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const url of references)
        await atomicFile(
          path.join(directory, path.basename(url)),
          await this.themes.asset(theme.id, path.basename(url)),
        );
      project.design = design;
      project.version = (project.version || 0) + 1;
    });
    return this.get(id);
  }
  async remove(id, { version } = {}) {
    const store = await this.getStore(id),
      action = store.queue
        .catch(() => {})
        .then(async () => {
          const current = await store.read();
          if (version !== undefined && version !== (current.version || 0))
            throw conflict('Презентация уже изменена. Обновите список перед удалением.');
          await rm(this.directory(id), { recursive: true });
          this.stores.delete(id);
          return { ok: true };
        });
    store.queue = action;
    return action;
  }
  async updateSlide(id, slideId, changes) {
    const allowed = new Set([
      'body',
      'title',
      'section',
      'layout',
      'notes',
      'notesVersion',
      'seconds',
      'effects',
      'script',
      'elementEffects',
      'version',
    ]);
    if (
      !changes ||
      Object.keys(changes).some((key) => !allowed.has(key)) ||
      !Number.isInteger(changes.version)
    )
      throw badRequest('Необходима версия слайда и допустимые поля.');
    return (await this.getStore(id)).mutate(async (p) => {
      const slide = p.slides.find((s) => s.id === slideId);
      if (!slide) throw notFound('Слайд не найден.');
      if (changes.version !== (slide.version || 0)) throw conflict();
      if (changes.notes !== undefined && changes.notesVersion !== (slide.notesVersion || 0))
        throw conflict('Заметка уже изменена.');
      const body = changes.body === undefined ? undefined : sanitizeHTML(changes.body);
      const script = changes.script === undefined ? undefined : validateSlideScript(changes.script),
        elementEffects =
          changes.elementEffects === undefined
            ? undefined
            : validateElementEffects(changes.elementEffects);
      for (const key of ['title', 'section', 'layout', 'notes'])
        if (
          changes[key] !== undefined &&
          (typeof changes[key] !== 'string' ||
            changes[key].length > (key === 'notes' ? 100000 : 200))
        )
          throw badRequest('Некорректное поле ' + key);
      if (
        changes.seconds !== undefined &&
        (!Number.isFinite(changes.seconds) || changes.seconds < 0 || changes.seconds > 3600)
      )
        throw badRequest('Некорректный тайминг.');
      let effects;
      if (changes.effects !== undefined)
        try {
          effects = normalizeEffects(changes.effects);
        } catch (error) {
          throw badRequest(error.message);
        }
      if (changes.notes !== undefined && slide.notes !== changes.notes)
        slide.notesVersion = (slide.notesVersion || 0) + 1;
      for (const key of ['title', 'section', 'layout', 'notes', 'seconds'])
        if (changes[key] !== undefined) slide[key] = changes[key];
      if (script !== undefined) slide.script = script;
      if (elementEffects !== undefined) slide.elementEffects = elementEffects;
      if (changes.effects !== undefined) {
        const timeline = normalizeTimeline(p),
          position = timeline
            .filter((entry) => entry.type === 'slide')
            .findIndex((entry) => entry.id === slideId);
        if (p.slides.length < 2 && effects && effects.preset !== 'none')
          throw badRequest('Для перехода нужны два слайда. Добавьте следующий слайд.');
        const target = p.slides[position === 0 ? 1 : position]?.id,
          index = timeline.findIndex((entry) => entry.type === 'slide' && entry.id === target),
          previous = timeline[index - 1];
        if (index >= 0) {
          if (previous?.type === 'transition') timeline.splice(index - 1, 1);
          const nextIndex = timeline.findIndex(
            (entry) => entry.type === 'slide' && entry.id === target,
          );
          if (effects && effects.preset !== 'none')
            timeline.splice(nextIndex, 0, {
              type: 'transition',
              id: previous?.type === 'transition' ? previous.id : randomUUID(),
              ...effects,
            });
        }
        setTimeline(p, timeline);
      }
      if (body !== undefined)
        await atomicFile(path.join(this.directory(id), 'slides', slide.id + '.html'), body);
      slide.version = (slide.version || 0) + 1;
      p.version = (p.version || 0) + 1;
      return {
        ...slide,
        body:
          body ??
          (await readFile(path.join(this.directory(id), 'slides', slide.id + '.html'), 'utf8')),
      };
    });
  }
  async addSlide(id, { body, title = 'Новый слайд' } = {}) {
    const store = await this.getStore(id);
    let added;
    await store.mutate(async (p) => {
      if (p.slides.length >= 100) throw badRequest('В одной презентации максимум 100 слайдов.');
      const number = Math.max(0, ...p.slides.map((s) => Number(s.id.slice(6)))) + 1;
      added = {
        id: 'slide-' + String(number).padStart(2, '0'),
        title: String(title).slice(0, 200),
        seconds: 60,
        section: '',
        layout: '',
        kind: 'main',
        notes: '',
        notesVersion: 0,
        version: 0,
      };
      const timeline = p.timeline === undefined ? null : normalizeTimeline(p);
      await atomicFile(
        path.join(this.directory(id), 'slides', added.id + '.html'),
        sanitizeHTML(body ?? createTitleSlide(added.title)),
      );
      p.slides.push(added);
      setTimeline(
        p,
        timeline ? [...timeline, { type: 'slide', id: added.id }] : normalizeTimeline(p),
      );
      p.version = (p.version || 0) + 1;
    });
    return (await this.get(id)).slides.find((s) => s.id === added.id);
  }
  async removeSlide(id, slideId) {
    await (
      await this.getStore(id)
    ).mutate((p) => {
      if (p.slides.length <= 1) throw badRequest('Оставьте хотя бы один слайд.');
      if (!p.slides.some((s) => s.id === slideId)) throw notFound('Слайд не найден.');
      const timeline = timelineAfterSlideRemoval(p, slideId);
      p.slides = p.slides.filter((s) => s.id !== slideId);
      setTimeline(p, timeline);
      p.annotations = p.annotations.filter((a) => a.slideId !== slideId);
      p.version = (p.version || 0) + 1;
    });
    return this.get(id);
  }
  async reorder(id, ids) {
    await (
      await this.getStore(id)
    ).mutate((p) => {
      if (
        !Array.isArray(ids) ||
        ids.length !== p.slides.length ||
        new Set(ids).size !== ids.length ||
        ids.some((s) => !p.slides.some((v) => v.id === s))
      )
        throw badRequest('Укажите каждый слайд ровно один раз.');
      setTimeline(p, timelineForOrder(p, ids));
      p.version = (p.version || 0) + 1;
    });
    return this.get(id);
  }
  async updateTimeline(id, payload = {}) {
    if (
      !payload ||
      Object.keys(payload).some((key) => !['timeline', 'version'].includes(key)) ||
      !Number.isInteger(payload.version)
    )
      throw badRequest('Необходим таймлайн и версия проекта.');
    await (
      await this.getStore(id)
    ).mutate((p) => {
      if (payload.version !== (p.version || 0))
        throw conflict('Таймлайн уже изменён. Обновите презентацию.');
      setTimeline(p, payload.timeline);
      p.version = (p.version || 0) + 1;
    });
    return this.get(id);
  }
  async duplicateSlide(id, slideId, payload = {}) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.keys(payload).some((key) => key !== 'version') ||
      !Number.isInteger(payload.version)
    )
      throw badRequest('Необходима версия проекта.');
    const { version } = payload;
    let createdSlideId;
    await (
      await this.getStore(id)
    ).mutate(async (p) => {
      if (version !== (p.version || 0))
        throw conflict('Презентация уже изменена. Обновите её перед копированием.');
      const original = p.slides.find((slide) => slide.id === slideId);
      if (!original) throw notFound('Слайд не найден.');
      if (p.slides.length >= 100) throw badRequest('В одной презентации максимум 100 слайдов.');
      const timeline = normalizeTimeline(p),
        number = Math.max(...p.slides.map((slide) => Number(slide.id.slice(6)))) + 1;
      createdSlideId = 'slide-' + String(number).padStart(2, '0');
      const { effects: legacy, ...metadata } = original,
        copy = { ...metadata, id: createdSlideId, version: 0, notesVersion: 0 },
        body = cloneSlideHTML(
          await readFile(path.join(this.directory(id), 'slides', slideId + '.html'), 'utf8'),
        );
      await atomicFile(path.join(this.directory(id), 'slides', createdSlideId + '.html'), body);
      p.slides.push(copy);
      const index = timeline.findIndex((entry) => entry.type === 'slide' && entry.id === slideId);
      timeline.splice(index + 1, 0, { type: 'slide', id: createdSlideId });
      setTimeline(p, timeline);
      const now = new Date().toISOString();
      p.annotations.push(
        ...p.annotations
          .filter((annotation) => annotation.slideId === slideId)
          .map((annotation) => ({
            ...annotation,
            id: randomUUID(),
            slideId: createdSlideId,
            createdAt: now,
            updatedAt: now,
          })),
      );
      p.version = (p.version || 0) + 1;
    });
    return { ...(await this.get(id)), createdSlideId };
  }
  async share(id, enabled = true) {
    let token;
    await (
      await this.getStore(id)
    ).mutate((p) => {
      p.shareToken = enabled ? p.shareToken || randomBytes(24).toString('base64url') : null;
      token = p.shareToken;
    });
    return token;
  }
  async findShare(token) {
    if (!/^[\w-]{32}$/.test(token)) throw notFound('Ссылка недействительна.');
    for (const item of await this.list()) {
      const p = await (await this.getStore(item.id)).read();
      if (p.shareToken === token) return this.get(item.id);
    }
    throw notFound('Ссылка недействительна или отозвана.');
  }
  async uploadAsset(id, { name, mime, data }) {
    await this.getStore(id);
    const { bytes, extension } = decodeMedia({ mime, data });
    const filename = randomUUID() + '.' + extension,
      directory = path.join(this.directory(id), 'assets');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicFile(path.join(directory, filename), bytes);
    return {
      url: '/api/projects/' + id + '/assets/' + filename,
      name: String(name || filename).slice(0, 200),
    };
  }
  async asset(id, name) {
    if (!/^[\w.-]{1,120}$/.test(name) || name.includes('..')) throw notFound();
    await this.getStore(id);
    return readFile(path.join(this.directory(id), 'assets', name));
  }
}
