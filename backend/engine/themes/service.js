import { ThemeRepository } from '../../storage/repositories/theme.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { badRequest } from '../errors.js';
import { themePresets } from '../../../shared/presentation/themes.js';
import { createPresentationDesign } from '../../../shared/presentation/design.js';
import { validatePresentationDesign, assetReferences, rebaseDesign } from '../html/design.js';
import { decodeMedia } from '../html/media.js';

const missing = () => Object.assign(new Error('Тема не найдена.'), { status: 404 });
const conflict = () =>
  Object.assign(new Error('Тему уже изменили. Обновите её и согласуйте правки.'), { status: 409 });
const builtinIds = new Set(themePresets.map((theme) => theme.id));
const title = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw badRequest('Укажите название темы до 200 символов.');
  return value.trim();
};

// Тема — отдельный снимок оформления. Применение копирует оформление и файлы;
// последующее изменение библиотечной темы не переписывает готовые презентации.
export class ThemeStore {
  constructor(dataDir, { readProject, readProjectAsset } = {}) {
    this.root = path.join(dataDir, 'themes');
    this.readProject = readProject;
    this.readProjectAsset = readProjectAsset;
    this.repository = new ThemeRepository(this.root);
    this.queues = this.repository.queues;
  }
  directory(id) {
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw missing();
    return path.join(this.root, id);
  }
  async init() {
    await this.repository.init();
    for (const preset of themePresets) {
      const directory = this.directory(preset.id);
      await this.repository.ensureDirectory(preset.id);
      try {
        await this.repository.read(preset.id);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const now = new Date().toISOString();
        await this.repository.write(preset.id, {
          id: preset.id,
          title: preset.name,
          builtin: true,
          version: 0,
          design: createPresentationDesign(preset.id),
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    return this;
  }
  async get(id) {
    try {
      const record = (this.directory(id), await this.repository.read(id));
      return { ...record, builtin: builtinIds.has(id) };
    } catch (error) {
      if (error.code === 'ENOENT') throw missing();
      throw error;
    }
  }
  async list() {
    const records = [];
    for (const id of await this.repository.ids())
      if (/^[\w-]{1,64}$/.test(id)) {
        try {
          records.push(await this.get(id));
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    return records.sort(
      (a, b) => Number(b.builtin) - Number(a.builtin) || a.title.localeCompare(b.title),
    );
  }
  queue(id, action) {
    return this.repository.queue(id, action);
  }
  async create(payload) {
    if (
      !payload ||
      Object.keys(payload).some(
        (key) => !['title', 'baseThemeId', 'design', 'projectId'].includes(key),
      )
    )
      throw badRequest('Некорректные поля темы.');
    const name = title(payload.title),
      id = randomUUID(),
      directory = this.directory(id);
    if (payload.design === null) throw badRequest('Тема должна иметь оформление.');
    if (
      [payload.baseThemeId, payload.design, payload.projectId].filter(
        (value) => value !== undefined,
      ).length > 1
    )
      throw badRequest('Выберите один источник темы.');
    let design, from, readAsset;
    if (payload.projectId) {
      const project = await this.readProject(payload.projectId);
      design = project.design
        ? structuredClone(project.design)
        : createPresentationDesign('dark', project);
      if (!project.design) {
        design.sourceCSS = project.css;
        design.decorations = [];
        design.template.html =
          '<div class="section-label" data-block-id="theme-section" data-block-type="text">{{section}}</div><footer class="footer"><strong data-block-id="theme-author" data-block-type="text">{{author}}</strong><span class="footer-center" data-block-id="theme-brand" data-block-type="text">{{brand}}</span><span class="page-number" data-block-id="theme-page" data-block-type="text">{{slideNumber}} / {{slideCount}}</span></footer>';
      }
      from = '/api/projects/' + project.id + '/assets/';
      readAsset = (name) => this.readProjectAsset(project.id, name);
    } else if (payload.baseThemeId) {
      const source = await this.get(payload.baseThemeId);
      design = source.design;
      from = '/api/themes/' + source.id + '/assets/';
      readAsset = (name) => this.asset(source.id, name);
    } else design = payload.design || createPresentationDesign('light');
    const to = '/api/themes/' + id + '/assets/';
    if (from) design = rebaseDesign(design, from, to);
    design = { ...design, themeId: id };
    const checked = validatePresentationDesign(design, id, { assetScope: 'themes' }),
      assets = assetReferences(checked);
    if (assets.length && !readAsset)
      throw badRequest('Создайте тему и загрузите её изображения перед изменением оформления.');
    try {
      await this.repository.ensureDirectory(id, { assets: true });
      for (const url of assets)
        await this.repository.writeAsset(
          id,
          path.basename(url),
          await readAsset(path.basename(url)),
        );
      const now = new Date().toISOString(),
        record = {
          id,
          title: name,
          builtin: false,
          version: 0,
          design: checked,
          createdAt: now,
          updatedAt: now,
        };
      await this.repository.write(id, record);
      return record;
    } catch (error) {
      await this.repository.remove(id);
      throw error;
    }
  }
  async update(id, payload) {
    if (
      !payload ||
      Object.keys(payload).some((key) => !['title', 'design', 'version'].includes(key)) ||
      !Number.isInteger(payload.version)
    )
      throw badRequest('Необходима версия темы и допустимые поля.');
    return this.queue(id, async () => {
      const current = await this.get(id);
      if (current.builtin)
        throw Object.assign(new Error('Встроенная тема доступна для чтения. Создайте её копию.'), {
          status: 409,
        });
      if (current.version !== payload.version) throw conflict();
      const design =
        payload.design === undefined
          ? current.design
          : validatePresentationDesign({ ...payload.design, themeId: id }, id, {
              assetScope: 'themes',
            });
      for (const url of assetReferences(design)) await this.asset(id, path.basename(url));
      const next = {
        ...current,
        title: payload.title === undefined ? current.title : title(payload.title),
        design,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.repository.write(id, next);
      return next;
    });
  }
  async remove(id, { version } = {}) {
    return this.queue(id, async () => {
      const current = await this.get(id);
      if (current.builtin)
        throw Object.assign(new Error('Встроенную тему удалить нельзя.'), { status: 409 });
      if (version !== current.version) throw conflict();
      await this.repository.remove(id);
      return { ok: true };
    });
  }
  async uploadAsset(id, { name, mime, data } = {}) {
    const current = await this.get(id);
    if (current.builtin)
      throw Object.assign(new Error('Создайте копию встроенной темы.'), { status: 409 });
    const { bytes, extension } = decodeMedia({ mime, data });
    const filename = randomUUID() + '.' + extension,
      directory = path.join(this.directory(id), 'assets');
    await this.repository.ensureDirectory(id, { assets: true });
    await this.repository.writeAsset(id, filename, bytes);
    return {
      url: '/api/themes/' + id + '/assets/' + filename,
      name: String(name || filename).slice(0, 200),
    };
  }
  async asset(id, name) {
    if (!/^[\w.-]{1,120}$/.test(name) || name.includes('..')) throw missing();
    await this.get(id);
    return this.repository.readAsset(id, name);
  }
}
