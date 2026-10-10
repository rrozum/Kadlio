import { listen, PageResizeObserver, pageTimeout } from './page-lifecycle.js';
import { request, escapeHTML } from './api.js';
import { SourceEditor } from './source-editor.js';
import { createPresentationDesign } from '../../shared/presentation/design.js';
import { playRuntime, stopRuntime } from '../../shared/addons/motion/player.js';
import { colorHex } from '../engine/blocks.js';

const readData = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
const json = (value) => {
  const result = JSON.parse(value || '{}');
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Параметры должны быть JSON-объектом.');
  return result;
};
// Начальный пример повторяет первый анимированный переход «Растворение».
const slideExample = `// Растворение: слайд плавно появляется за 650 мс.
if (signal.aborted) return;
const animation = slide.animate(
  [{ opacity: 0 }, { opacity: 1 }],
  { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' }
);
onCleanup(() => animation.cancel());
await animation.finished.catch(() => {});`;
const scriptHelp =
  '<details class="script-context-help"><summary>Доступные объекты JavaScript</summary><ul><li><code>slide</code> — DOM-элемент слайда: querySelector, querySelectorAll, style, classList, animate.</li><li><code>signal</code> — AbortSignal: aborted и событие abort сообщают об остановке показа.</li><li><code>onCleanup(fn)</code> — очистка при остановке: отменить анимацию, таймер или обработчик.</li><li>Для эффекта элемента также доступны <code>element</code> — выбранный блок и <code>params</code> — его параметры JSON. В переходе element — весь слайд.</li><li>window и document относятся только к сцене. Доступны обычные браузерные API: DOM, Web Animations, таймеры, requestAnimationFrame, Canvas и SVG. Нет доступа к редактору, аккаунту, хранилищу и сети.</li></ul><p>Код — тело async-функции; можно использовать await. Координаты холста: 1280 × 720.</p></details>';
const example =
  "return element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: params.duration || 600, fill: 'forwards' });";

export function mountAuthoringTools(options) {
  return new SlideAuthoringUI(options);
}
class SlideAuthoringUI {
  constructor(options) {
    Object.assign(this, options);
    this.busy = false;
    this.snippets = [];
    this.makeVideo();
    this.makeScript();
    document.getElementById('video-tool').addEventListener('click', () => this.openVideo());
    document
      .getElementById('script-tool')
      .addEventListener('click', () => this.openScript().catch((error) => this.fail(error)));
  }
  get hasDraft() {
    return (
      this.busy ||
      (this.videoDialog.open && !!this.file) ||
      (this.scriptDialog.open && (this.scriptEditor.dirty || this.snippetDirty))
    );
  }
  get snippetDirty() {
    return (
      !!this.snippetEditor &&
      (this.snippetEditor.dirty ||
        !this.currentSnippet ||
        this.snippetBaseline !== this.snippetFields())
    );
  }
  snippetFields() {
    return JSON.stringify([this.name.value, this.description.value, this.params.value]);
  }
  selected() {
    const canvas = this.getCanvas();
    return canvas.canEditSelection() ? canvas.selected : null;
  }
  fail(error) {
    const output = this.scriptDialog.open ? this.scriptStatus : this.videoStatus;
    output.textContent = error.message || String(error);
    output.classList.add('error');
    this.onError?.(error);
  }
  async work(action, output = this.scriptStatus) {
    if (this.busy) return;
    this.busy = true;
    output.classList.remove('error');
    output.textContent = 'Сохраняем…';
    const controls = [
        ...this.scriptDialog.querySelectorAll('button,input,select,textarea'),
        ...this.videoDialog.querySelectorAll('button,input'),
      ],
      states = controls.map((control) => control.disabled);
    controls.forEach((control) => (control.disabled = true));
    try {
      return await action();
    } catch (error) {
      output.textContent = error.message;
      output.classList.add('error');
      this.onError?.(error);
      throw error;
    } finally {
      controls.forEach((control, index) => (control.disabled = states[index]));
      this.busy = false;
      if (this.scriptDialog.open) this.updateSelection();
      document.dispatchEvent(new Event('presentations:authoring-idle'));
    }
  }
  makeVideo() {
    const dialog = (this.videoDialog = document.createElement('dialog'));
    dialog.id = 'video-dialog';
    dialog.className = 'app-dialog video-dialog';
    dialog.innerHTML =
      '<div class="dialog-heading"><h2>Видео на слайде</h2><button type="button" class="authoring-close icon-button" aria-label="Закрыть">×</button></div><p>MP4 или WebM до 16 МБ. Файл сохранится вместе с презентацией.</p><label class="block-label">Файл<input id="video-file" type="file" accept="video/mp4,video/webm"></label><video id="uploaded-video-preview" controls muted playsinline hidden></video><div class="video-options"><label><input id="video-muted" type="checkbox" checked> Без звука</label><label><input id="video-loop" type="checkbox"> По кругу</label><label><input id="video-autoplay" type="checkbox"> Автозапуск при показе</label></div><p class="field-hint">На рабочем холсте — статичный кадр. Видео запускается в режиме показа и HTML-экспорте; PDF и PPTX используют кадр.</p><p id="video-status" class="form-status" role="status"></p><div class="dialog-actions"><button type="button" class="authoring-close">Отмена</button><button type="button" id="video-background">Сделать фоном</button><button type="button" id="video-insert" class="primary">Добавить видео</button></div>';
    document.body.append(dialog);
    this.videoStatus = dialog.querySelector('#video-status');
    dialog
      .querySelectorAll('.authoring-close')
      .forEach((button) => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('cancel', (event) => {
      if (this.busy) event.preventDefault();
    });
    dialog.addEventListener('close', () => dialog.querySelector('video').pause());
    dialog.querySelector('#video-file').addEventListener('change', (event) => {
      this.file = event.target.files[0] || null;
      this.uploaded = null;
      this.videoStatus.textContent = this.file ? this.file.name : '';
      dialog.querySelector('video').hidden = true;
    });
    dialog
      .querySelector('#video-insert')
      .addEventListener('click', () =>
        this.work(() => this.insertVideo(false), this.videoStatus).catch(() => {}),
      );
    dialog
      .querySelector('#video-background')
      .addEventListener('click', () =>
        this.work(() => this.insertVideo(true), this.videoStatus).catch(() => {}),
      );
  }
  openVideo() {
    this.file = null;
    this.uploaded = null;
    this.videoDialog.querySelector('#video-file').value = '';
    this.videoStatus.textContent = '';
    this.videoStatus.classList.remove('error');
    this.videoDialog.querySelector('video').hidden = true;
    this.videoDialog.showModal();
  }
  async uploadVideo() {
    if (this.uploaded) return this.uploaded;
    if (!this.file) throw new Error('Выберите видео.');
    if (!['video/mp4', 'video/webm'].includes(this.file.type) || this.file.size > 16 * 1024 * 1024)
      throw new Error('Выберите MP4 или WebM до 16 МБ.');
    this.videoStatus.textContent = 'Загружаем видео…';
    const asset = await request(this.base + '/assets', {
      method: 'POST',
      body: { name: this.file.name, mime: this.file.type, data: await readData(this.file) },
    });
    this.uploaded = asset;
    const preview = this.videoDialog.querySelector('video');
    preview.src = asset.url;
    preview.hidden = false;
    const poster = await this.poster(asset.url);
    if (poster) {
      const saved = await request(this.base + '/assets', {
        method: 'POST',
        body: {
          name: this.file.name + '-poster.png',
          mime: 'image/png',
          data: poster.split(',')[1],
        },
      });
      asset.poster = saved.url;
    }
    return asset;
  }
  async poster(url) {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    try {
      return await new Promise((resolve) => {
        let finished = false;
        const end = (value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = pageTimeout(() => end(null), 8000);
        video.addEventListener('error', () => end(null), { once: true });
        video.addEventListener(
          'loadeddata',
          () => {
            try {
              const frame = document.createElement('canvas');
              const scale = Math.min(1, 1280 / video.videoWidth);
              frame.width = Math.max(1, Math.round(video.videoWidth * scale));
              frame.height = Math.max(1, Math.round(video.videoHeight * scale));
              frame.getContext('2d').drawImage(video, 0, 0, frame.width, frame.height);
              end(frame.toDataURL('image/png'));
            } catch {
              end(null);
            }
          },
          { once: true },
        );
        video.load();
      });
    } finally {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
  async insertVideo(background) {
    const targetId = this.getSlide().id;
    await this.flush();
    const asset = await this.uploadVideo();
    if (this.getSlide().id !== targetId) throw new Error('Слайд сменился. Откройте видео ещё раз.');
    if (background) {
      const project = this.getProject(),
        design = structuredClone(project.design || this.legacyDesign(project));
      design.background = {
        type: 'video',
        value: asset.url,
        ...(asset.poster ? { poster: asset.poster } : {}),
      };
      const saved = await request(this.base + '/design', {
        method: 'PATCH',
        body: { design, version: project.version },
      });
      await this.onProject(saved);
    } else {
      const slide = this.getSlide(),
        attrs = ['muted', 'loop', 'autoplay']
          .filter((key) => this.videoDialog.querySelector('#video-' + key).checked)
          .join(' '),
        html =
          '<video data-block-id="video-' +
          crypto.randomUUID() +
          '" data-block-type="video" src="' +
          escapeHTML(asset.url) +
          '"' +
          (asset.poster ? ' poster="' + escapeHTML(asset.poster) + '"' : '') +
          ' controls playsinline preload="metadata" ' +
          attrs +
          ' style="position:absolute;left:400px;top:220px;width:480px;height:270px;object-fit:contain"></video>';
      const saved = await request(this.base + '/slides/' + slide.id, {
        method: 'PATCH',
        body: { body: slide.body + html, version: slide.version || 0 },
      });
      await this.onSlide(saved);
    }
    this.file = null;
    this.videoDialog.close();
  }
  legacyDesign(project) {
    const design = createPresentationDesign('dark', project),
      canvas = this.getCanvas(),
      style = canvas.doc.defaultView.getComputedStyle(canvas.stage);
    design.tokens.text = colorHex(style.color, design.tokens.text);
    design.tokens.muted = colorHex(style.getPropertyValue('--muted').trim(), design.tokens.muted);
    design.tokens.accent = colorHex(style.getPropertyValue('--blue').trim(), design.tokens.accent);
    design.tokens.font = style.fontFamily;
    design.sourceCSS = project.css;
    design.decorations = [];
    design.template.html =
      '<div class="section-label" data-block-id="theme-section" data-block-type="text">{{section}}</div>' +
      (project.author || project.brand
        ? '<footer class="footer"><strong data-block-id="theme-author" data-block-type="text">{{author}}</strong><span class="footer-center" data-block-id="theme-brand" data-block-type="text">{{brand}}</span><span class="page-number" data-block-id="theme-page" data-block-type="text">{{slideNumber}} / {{slideCount}}</span></footer>'
        : '');
    return design;
  }
  makeScript() {
    const dialog = (this.scriptDialog = document.createElement('dialog'));
    dialog.id = 'script-dialog';
    dialog.className = 'app-dialog slide-script-dialog';
    dialog.innerHTML =
      '<div class="dialog-heading"><h2>JavaScript и эффекты</h2><button type="button" class="authoring-close icon-button" aria-label="Закрыть">×</button></div><p id="script-slide-context" class="field-hint"></p><div class="authoring-workspace"><div class="authoring-source"><div class="authoring-tabs" role="tablist"><button type="button" data-authoring-tab="slide" aria-selected="true">JS слайда</button><button type="button" data-authoring-tab="effect" aria-selected="false">Эффект элемента</button></div><div data-authoring-panel="slide"><p class="field-hint">Код выполняется внутри слайда. Для пустого JS показан пример «Растворение»; он применяется только после сохранения.</p>' +
      scriptHelp +
      '<textarea id="slide-script-input" maxlength="50000" aria-label="JavaScript слайда"></textarea><div class="authoring-actions"><button id="slide-script-save" type="button" class="primary">Сохранить JS</button></div></div><div data-authoring-panel="effect" hidden><label class="block-label">Библиотека<input id="snippet-search" type="search" placeholder="Поиск эффекта"><select id="snippet-select" aria-label="Эффект из библиотеки"></select></label><div class="authoring-actions"><button type="button" id="snippet-new">Новый эффект</button><button type="button" id="snippet-reset">Сбросить правки</button></div><label class="block-label">Название<input id="snippet-name" maxlength="100"></label><label class="block-label">Описание<input id="snippet-description" maxlength="500"></label><p class="field-hint">Контекст: element, slide, params, signal, onCleanup. Верните Animation или зарегистрируйте отмену через onCleanup.</p><textarea id="snippet-code" maxlength="50000" aria-label="JavaScript эффекта"></textarea><label class="block-label">Параметры · JSON<textarea id="snippet-params" rows="3" spellcheck="false"></textarea></label><label class="block-label">Длительность, мс<input id="snippet-duration" type="number" min="50" max="60000" step="50" value="600"></label><p id="snippet-selection" class="field-hint"></p><div class="authoring-actions"><button type="button" id="snippet-save">Сохранить в библиотеку</button><button type="button" id="snippet-apply" class="primary">Добавить эффект</button><button type="button" id="snippet-clear">Снять эффекты</button></div><p class="field-hint">Изменение библиотеки не меняет ранее добавленные эффекты. Добавьте новую версию снова; предпросмотр показывает сохранённый слайд.</p></div></div><div class="authoring-player"><div id="authoring-preview" class="authoring-preview"><p class="authoring-placeholder">Запустите сохранённый слайд, чтобы проверить видео и JS.</p></div><div class="authoring-actions"><button id="authoring-play" type="button" class="primary">▶ Запустить</button><button id="authoring-stop" type="button">■ Стоп</button></div><p id="authoring-play-status" class="form-status" role="status"></p><details class="authoring-errors" hidden><summary>Ошибки сцены</summary><pre id="authoring-errors"></pre></details><p class="field-hint">Код выполняется в изолированном окне без доступа к аккаунту и редактору. PDF и PPTX сохраняют статичный вид; интерактивность работает в показе и HTML.</p></div></div><p id="script-status" class="form-status" role="status"></p><div class="dialog-actions"><button type="button" class="authoring-close">Закрыть</button></div>';
    document.body.append(dialog);
    this.scriptEditor = new SourceEditor(dialog.querySelector('#slide-script-input'), {
      language: 'javascript',
    });
    this.snippetEditor = new SourceEditor(dialog.querySelector('#snippet-code'), {
      language: 'javascript',
    });
    this.name = dialog.querySelector('#snippet-name');
    this.description = dialog.querySelector('#snippet-description');
    this.params = dialog.querySelector('#snippet-params');
    this.scriptStatus = dialog.querySelector('#script-status');
    this.preview = dialog.querySelector('#authoring-preview');
    this.resize = new PageResizeObserver(() => {
      if (this.preview.clientWidth)
        this.preview.style.setProperty('--scene-scale', this.preview.clientWidth / 1280);
    });
    this.resize.observe(this.preview);
    dialog
      .querySelectorAll('.authoring-close')
      .forEach((button) => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('cancel', (event) => {
      if (this.busy) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      this.stop();
      document.dispatchEvent(new Event('presentations:authoring-idle'));
    });
    dialog
      .querySelectorAll('[data-authoring-tab]')
      .forEach((button) =>
        button.addEventListener('click', () => this.tab(button.dataset.authoringTab)),
      );
    dialog.querySelector('#snippet-search').addEventListener('input', () => this.renderSnippets());
    dialog.querySelector('#snippet-select').addEventListener('change', (event) => {
      if (this.snippetDirty) {
        event.target.value = this.currentSnippet?.id || '';
        this.scriptStatus.textContent = 'Сначала сохраните эффект или сбросьте его правки.';
        return;
      }
      this.loadSnippet(this.snippets.find((item) => item.id === event.target.value));
    });
    dialog
      .querySelector('#snippet-new')
      .addEventListener('click', () =>
        this.loadSnippet(
          { name: 'Новый эффект', description: '', code: example, defaults: { duration: 600 } },
          true,
        ),
      );
    dialog
      .querySelector('#snippet-reset')
      .addEventListener('click', () => this.loadSnippet(this.currentSnippet || this.snippets[0]));
    for (const [id, action] of [
      ['slide-script-save', () => this.saveScript({ includeExample: true })],
      ['snippet-save', () => this.saveSnippet()],
      ['snippet-apply', () => this.applyEffect()],
      ['snippet-clear', () => this.clearEffect()],
      ['authoring-play', () => this.play()],
    ])
      dialog
        .querySelector('#' + id)
        .addEventListener('click', () => this.work(action).catch(() => {}));
    dialog.querySelector('#authoring-stop').addEventListener('click', () => this.stop());
  }
  async openScript({ snippetId, code, defaults, libraryOnly = false } = {}) {
    await this.flush();
    this.targetSlideId = this.getSlide().id;
    this.scriptVersion = this.getSlide().version || 0;
    this.scriptStatus.textContent = '';
    this.scriptStatus.classList.remove('error');
    this.scriptDialog.querySelector('#script-slide-context').textContent = this.getSlide().title;
    await this.scriptEditor.setValue(this.getSlide().script || slideExample);
    this.libraryOnly = libraryOnly;
    this.snippets = (await request('/api/effect-snippets')).snippets;
    this.scriptDialog.querySelector('#snippet-search').value = '';
    this.renderSnippets();
    await this.loadSnippet(this.snippets.find((item) => item.id === snippetId) || this.snippets[0]);
    if (code !== undefined) {
      this.snippetEditor.textarea.value = code;
      this.snippetEditor.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      if (defaults) this.params.value = JSON.stringify(defaults, null, 2);
    }
    this.tab(snippetId || libraryOnly ? 'effect' : 'slide');
    if (!this.scriptDialog.open) this.scriptDialog.showModal();
  }
  tab(name) {
    this.scriptDialog
      .querySelectorAll('[data-authoring-tab]')
      .forEach((button) =>
        button.setAttribute('aria-selected', String(button.dataset.authoringTab === name)),
      );
    this.scriptDialog
      .querySelectorAll('[data-authoring-panel]')
      .forEach((panel) => (panel.hidden = panel.dataset.authoringPanel !== name));
  }
  renderSnippets() {
    const select = this.scriptDialog.querySelector('#snippet-select'),
      query = this.scriptDialog.querySelector('#snippet-search').value.toLowerCase();
    select.replaceChildren();
    for (const snippet of this.snippets.filter((item) =>
      (item.name + ' ' + item.description).toLowerCase().includes(query),
    )) {
      const option = document.createElement('option');
      option.value = snippet.id;
      option.textContent = snippet.name;
      select.append(option);
    }
    select.value = this.currentSnippet?.id || '';
  }
  async loadSnippet(snippet, fresh = false) {
    if (!snippet) return;
    this.currentSnippet = fresh ? null : snippet;
    this.name.value = snippet.name;
    this.description.value = snippet.description;
    this.params.value = JSON.stringify(snippet.defaults || {}, null, 2);
    this.scriptDialog.querySelector('#snippet-duration').value = snippet.defaults?.duration || 600;
    await this.snippetEditor.setValue(snippet.code);
    this.snippetBaseline = this.snippetFields();
    this.scriptDialog.querySelector('#snippet-select').value = snippet.id || '';
    this.updateSelection();
  }
  updateSelection() {
    const canvas = this.getCanvas(),
      selected = this.selected(),
      blockId = selected?.dataset.blockId,
      count = (this.getSlide().elementEffects || []).filter(
        (effect) => effect.blockId === blockId,
      ).length;
    this.scriptDialog.querySelector('#snippet-selection').textContent = this.libraryOnly
      ? 'Измените библиотеку, затем выберите сохранённую версию в настройках перехода.'
      : selected
        ? 'Выбран ' +
          selected.localName +
          (selected.id ? ' #' + selected.id : '') +
          ' · эффектов: ' +
          count
        : canvas.selected
          ? 'Элемент заблокирован. Сначала снимите замок.'
          : 'Выберите элемент на слайде перед открытием этого окна.';
    this.scriptDialog.querySelector('#snippet-apply').disabled = this.libraryOnly || !selected;
    this.scriptDialog.querySelector('#snippet-clear').disabled =
      this.libraryOnly || !selected || !count;
  }
  currentSlide() {
    if (this.getSlide().id !== this.targetSlideId)
      throw new Error('Выбран другой слайд. Откройте JS заново.');
    return this.getSlide();
  }
  async saveScript({ includeExample = false } = {}) {
    await this.flush();
    const slide = this.currentSlide();
    if (
      !this.scriptEditor.dirty &&
      (!includeExample || this.scriptEditor.getValue() === (slide.script || ''))
    )
      return slide;
    if (slide.version !== this.scriptVersion)
      throw new Error(
        'Слайд изменился. JS-черновик остаётся в этом окне; согласуйте его с новой версией.',
      );
    const saved = await request(this.base + '/slides/' + slide.id, {
      method: 'PATCH',
      body: { script: this.scriptEditor.getValue(), version: slide.version || 0 },
    });
    await this.onSlide(saved);
    this.scriptVersion = saved.version;
    await this.scriptEditor.setValue(saved.script);
    this.scriptStatus.textContent = 'JS сохранён.';
    return saved;
  }
  async saveSnippet() {
    if (this.currentSnippet && !this.snippetDirty) return this.currentSnippet;
    const fields = {
        name: this.name.value,
        description: this.description.value,
        code: this.snippetEditor.getValue(),
        defaults: json(this.params.value),
      },
      saved = await request(
        '/api/effect-snippets' + (this.currentSnippet ? '/' + this.currentSnippet.id : ''),
        {
          method: this.currentSnippet ? 'PATCH' : 'POST',
          body: {
            ...fields,
            ...(this.currentSnippet ? { version: this.currentSnippet.version } : {}),
          },
        },
      );
    this.snippets = this.snippets.filter((item) => item.id !== saved.id);
    this.snippets.push(saved);
    this.renderSnippets();
    await this.loadSnippet(saved);
    this.scriptStatus.textContent = 'Эффект сохранён в библиотеке.';
    document.dispatchEvent(new Event('presentations:snippets-changed'));
    return saved;
  }
  async applyEffect() {
    if (!this.selected()) throw new Error('Выберите и разблокируйте элемент.');
    const duration = Number(this.scriptDialog.querySelector('#snippet-duration').value);
    await this.saveScript();
    const snippet = await this.saveSnippet();
    this.scriptDialog.querySelector('#snippet-duration').value = String(duration);
    const blockId = this.getCanvas().ensureSelectedId();
    if (!blockId) throw new Error('Элемент больше не доступен для изменения.');
    await this.flush();
    const slide = this.currentSlide(),
      options = { ...json(this.params.value), duration };
    if (!Number.isFinite(options.duration) || options.duration < 50 || options.duration > 60000)
      throw new Error('Длительность должна быть от 50 до 60 000 мс.');
    const saved = await request(this.base + '/slides/' + slide.id + '/effect', {
      method: 'POST',
      body: { snippetId: snippet.id, blockId, options, version: slide.version || 0 },
    });
    await this.onSlide(saved);
    this.scriptVersion = saved.version;
    this.updateSelection();
    this.scriptStatus.textContent = 'Эффект добавлен к выбранному элементу.';
  }
  async clearEffect() {
    if (!this.selected()) throw new Error('Сначала выберите и разблокируйте элемент.');
    await this.flush();
    const slide = this.currentSlide(),
      blockId = this.selected().dataset.blockId,
      saved = await request(this.base + '/slides/' + slide.id, {
        method: 'PATCH',
        body: {
          elementEffects: (slide.elementEffects || []).filter(
            (effect) => effect.blockId !== blockId,
          ),
          version: slide.version || 0,
        },
      });
    await this.onSlide(saved);
    this.scriptVersion = saved.version;
    this.updateSelection();
    this.scriptStatus.textContent = 'Эффекты элемента сняты.';
  }
  async play() {
    await this.saveScript();
    await this.flush();
    const slide = this.currentSlide();
    this.stop();
    this.scriptDialog.querySelector('#authoring-play-status').textContent = 'Запускаем…';
    this.preview.querySelector('.authoring-placeholder').hidden = true;
    const log = this.scriptDialog.querySelector('#authoring-errors');
    log.textContent = '';
    log.parentElement.hidden = true;
    this.preview.style.setProperty('--scene-scale', this.preview.clientWidth / 1280);
    this.runtimeFrame = playRuntime(this.preview, {
      url: this.base + '/slides/' + slide.id + '/runtime',
      sceneId: slide.id,
      onError: (message) => {
        log.parentElement.hidden = false;
        log.parentElement.open = true;
        log.textContent = (log.textContent + '\n' + message).trim().slice(-6000);
        this.scriptDialog.querySelector('#authoring-play-status').textContent = 'Ошибка сцены.';
      },
    });
    this.readyListener = (event) => {
      if (
        event.source !== this.runtimeFrame?.contentWindow ||
        event.data?.type !== 'presentation-runtime' ||
        event.data.sceneId !== slide.id ||
        !event.data.ready ||
        event.data.errors?.length
      )
        return;
      const frame = this.runtimeFrame;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (frame === this.runtimeFrame && frame.isConnected && !log.textContent)
            this.scriptDialog.querySelector('#authoring-play-status').textContent =
              'Работает. Перезапуск — кнопкой «Запустить».';
        }),
      );
    };
    listen(window, 'message', this.readyListener);
    this.scriptStatus.textContent = 'Запущен сохранённый слайд.';
  }
  stop() {
    if (this.readyListener) window.removeEventListener('message', this.readyListener);
    this.readyListener = null;
    stopRuntime(this.preview);
    this.runtimeFrame = null;
    this.preview.querySelector('.authoring-placeholder').hidden = false;
    this.scriptDialog.querySelector('#authoring-play-status').textContent = 'Остановлено.';
  }
}
