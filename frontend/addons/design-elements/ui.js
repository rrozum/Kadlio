import {
  listen,
  PageResizeObserver,
  PageIntersectionObserver,
} from '../../modules/page-lifecycle.js';
import { request } from '../../modules/api.js';
import {
  designElements,
  renderDesignElement,
} from '../../../shared/addons/design-elements/catalog.js';
import { slideDocument } from '../../engine/slide.js';
import { ChatAttachments } from '../../modules/chat-attachments.js';

const categories = {
  all: 'Все',
  frames: 'Окна',
  markers: 'Акценты',
  arrows: 'Стрелки',
  shapes: 'Декор',
  custom: 'Мои',
};
const builtin = (id) => designElements.find((item) => item.id === id);
const clamp = (value, maximum) => Math.max(0, Math.min(Math.round(value), Math.max(0, maximum)));

// Библиотека хранит и вставляет HTML. Панель передаёт id и координаты слайда;
// сервер копирует ресурсы и проверяет версии через общий путь сохранения.
export class ElementsUI {
  constructor({
    parent,
    button,
    base,
    getCanvas,
    getProject,
    getSlide,
    flush,
    onSlide,
    onInsert,
    onGenerate,
    onError,
    onAccepted,
  }) {
    Object.assign(this, {
      base,
      getCanvas,
      getProject,
      getSlide,
      flush,
      onSlide,
      onInsert,
      onGenerate,
      onError,
      onAccepted,
    });
    this.category = 'all';
    this.items = [];
    this.records = new Map();
    this.previewCache = new Map();
    this.inserting = false;
    this.fallback = !parent;
    if (!parent) {
      this.drawer = document.createElement('aside');
      this.drawer.className = 'elements-side-drawer';
      this.drawer.hidden = true;
      this.drawer.setAttribute('aria-label', 'Дизайнерские элементы');
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'icon-button elements-close';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Закрыть элементы');
      close.addEventListener('click', () => {
        this.drawer.hidden = true;
      });
      parent = document.createElement('div');
      this.drawer.append(close, parent);
      document.body.append(this.drawer);
    }
    this.parent = parent;
    parent.classList.add('elements-catalog');
    parent.innerHTML =
      '<div class="elements-heading"><h2>Элементы</h2><button type="button" class="icon-button elements-refresh" title="Обновить библиотеку" aria-label="Обновить элементы">↻</button></div><p class="elements-intro">Перетащите элемент на слайд или нажмите, чтобы добавить.</p><div class="element-filters" role="group" aria-label="Категории элементов"></div><div class="element-grid"></div><p class="elements-status form-status" role="status"></p>';
    this.grid = parent.querySelector('.element-grid');
    this.status = parent.querySelector('.elements-status');
    parent
      .querySelector('.elements-refresh')
      .addEventListener('click', () => this.refresh().catch((error) => this.fail(error)));
    this.resizeObserver = new PageResizeObserver((entries) =>
      entries.forEach(({ target }) => this.fitPreview(target)),
    );
    this.visibleObserver = new PageIntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            this.visibleObserver.unobserve(entry.target);
            this.loadPreview(entry.target).catch(() => {
              entry.target.classList.add('element-preview-unavailable');
            });
          }
      },
      { rootMargin: '80px' },
    );
    this.pointerMove = (event) => this.moveDrag(event);
    this.pointerUp = (event) => this.endDrag(event);
    listen(window, 'pointermove', this.pointerMove);
    listen(window, 'pointerup', this.pointerUp);
    listen(window, 'pointercancel', () => this.cancelDrag());
    button?.addEventListener('click', () => this.open().catch((error) => this.fail(error)));
    listen(window, 'presentations:elements-changed', () =>
      this.refresh().catch((error) => this.fail(error)),
    );
    if (onGenerate) this.createDialog();
  }
  fail(error) {
    this.status.textContent = error.message || String(error);
    this.status.classList.add('error');
    this.onError?.(error);
  }
  async open() {
    if (this.drawer) this.drawer.hidden = false;
    await this.refresh();
  }
  async refresh() {
    if (this.loading) return this.loading;
    this.status.classList.remove('error');
    this.status.textContent = 'Загружаем элементы…';
    this.loading = (async () => {
      const result = await request('/api/elements'),
        oldIds = new Set(this.items.map((item) => item.id));
      this.items = result.elements || designElements;
      if (this.fallback && !this.base) this.items = this.items.filter((item) => builtin(item.id));
      this.render();
      this.status.textContent = '';
      const added = this.items.filter((item) => !oldIds.has(item.id) && !builtin(item.id));
      if (oldIds.size && added.length) {
        this.category = 'all';
        this.render();
        const tile = this.records.get(added.at(-1).id)?.button;
        tile?.classList.add('element-new');
        tile?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }
  render() {
    const filters = this.parent.querySelector('.element-filters');
    filters.replaceChildren();
    for (const category of [
      'all',
      ...new Set(this.items.map((item) => item.category || 'custom')),
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = categories[category] || category;
      button.setAttribute('aria-pressed', String(category === this.category));
      button.addEventListener('click', () => {
        this.category = category;
        this.render();
      });
      filters.append(button);
    }
    const wanted = new Set(this.items.map((item) => item.id));
    for (const [id, record] of this.records)
      if (!wanted.has(id)) {
        this.visibleObserver.unobserve(record.viewport);
        this.resizeObserver.unobserve(record.viewport);
        record.button.remove();
        this.records.delete(id);
        this.previewCache.delete(id);
      }
    for (const item of this.items) {
      let record = this.records.get(item.id);
      if (!record) {
        record = this.makeTile(item);
        this.records.set(item.id, record);
        this.grid.append(record.button);
        this.visibleObserver.observe(record.viewport);
      }
      record.item = item;
      record.button.hidden =
        this.category !== 'all' && (item.category || 'custom') !== this.category;
    }
    if (this.createTile) this.createTile.remove();
    if (this.onGenerate) {
      this.createTile = document.createElement('button');
      this.createTile.type = 'button';
      this.createTile.className = 'element-create';
      this.createTile.id = 'element-create-open';
      this.createTile.innerHTML =
        '<span aria-hidden="true">+</span><strong>Создать с ИИ</strong><small>Опишите элемент или приложите образец</small>';
      this.createTile.addEventListener('click', () => this.openCreate());
      this.grid.append(this.createTile);
    }
  }
  makeTile(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'element-choice';
    button.dataset.elementId = item.id;
    button.setAttribute('aria-label', 'Добавить ' + item.name);
    button.title = item.description || item.name;
    const viewport = document.createElement('div');
    viewport.className = 'element-preview';
    viewport.dataset.elementId = item.id;
    viewport.innerHTML = '<span class="element-preview-loader" aria-hidden="true">◫</span>';
    const name = document.createElement('strong');
    name.textContent = item.name;
    button.append(viewport, name);
    button.addEventListener('pointerdown', (event) => this.startDrag(event, item, button));
    button.addEventListener('click', () => {
      if (performance.now() < (this.suppressClickUntil || 0)) return;
      this.insert(item).catch((error) => this.fail(error));
    });
    return { button, viewport, item };
  }
  async loadPreview(viewport) {
    const item = this.records.get(viewport.dataset.elementId)?.item;
    if (!item || viewport.querySelector('iframe')) return;
    let body;
    if (builtin(item.id)) body = renderDesignElement(item.id, { blockId: 'preview-' + item.id });
    else {
      if (!this.previewCache.has(item.id))
        this.previewCache.set(item.id, request('/api/elements/' + encodeURIComponent(item.id)));
      body = (await this.previewCache.get(item.id)).body;
    }
    if (!viewport.isConnected) return;
    const template = document.createElement('template');
    template.innerHTML = body;
    const element = template.content.firstElementChild;
    if (!element) throw new Error('Пустой элемент');
    Object.assign(element.style, {
      left: '24px',
      top: '24px',
      width: item.width + 'px',
      height: item.height + 'px',
    });
    const project = this.getProject?.() || {},
      design = project.design ? structuredClone(project.design) : null;
    if (design) {
      design.decorations = [];
      design.template = {
        header: '',
        footer: '',
        showAuthor: false,
        showProjectTitle: false,
        showSlideNumber: false,
      };
    }
    const slide = { id: 'element-preview-' + item.id, title: item.name, body: element.outerHTML },
      width = item.width + 48,
      height = item.height + 48;
    // Маленькое окно обрезает свободное место слайда. Предпросмотр сохраняет
    // HTML/CSS и локальные изображения; скрипты запрещены, второй сцены нет.
    const css = `html,body,.slide{width:${width}px!important;height:${height}px!important}.slide{padding:0!important;background:transparent!important}.slide-content,.slide-body{position:relative!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important}`;
    const markup = slideDocument(slide, {
      ...project,
      design,
      author: '',
      brand: '',
      slides: [slide],
    })
      .replace('</head>', '<style>' + css + '</style></head>')
      .replace("img-src 'self' data: blob: https:", "img-src 'self' data: blob:")
      .replace("font-src 'self' data: https:", "font-src 'self' data:");
    const iframe = document.createElement('iframe');
    iframe.title = item.name;
    iframe.tabIndex = -1;
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.style.width = width + 'px';
    iframe.style.height = height + 'px';
    iframe.srcdoc = markup;
    viewport.dataset.previewWidth = width;
    viewport.dataset.previewHeight = height;
    viewport.replaceChildren(iframe);
    this.resizeObserver.observe(viewport);
    this.fitPreview(viewport);
  }
  fitPreview(viewport) {
    const frame = viewport.querySelector('iframe');
    if (!frame) return;
    const width = Number(viewport.dataset.previewWidth),
      height = Number(viewport.dataset.previewHeight),
      scale = Math.min(viewport.clientWidth / width, viewport.clientHeight / height);
    frame.style.transform = 'scale(' + scale + ')';
    frame.style.left = (viewport.clientWidth - width * scale) / 2 + 'px';
    frame.style.top = (viewport.clientHeight - height * scale) / 2 + 'px';
  }
  startDrag(event, item, button) {
    if (event.button !== 0 || this.inserting || this.drag) return;
    this.drag = {
      item,
      button,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      slideId: this.getSlide?.()?.id,
    };
    button.setPointerCapture(event.pointerId);
  }
  moveDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      this.ghost = document.createElement('div');
      this.ghost.className = 'element-drag-ghost';
      this.ghost.textContent = drag.item.name;
      document.body.append(this.ghost);
      drag.button.classList.add('element-dragging');
    }
    event.preventDefault();
    this.ghost.style.left = event.clientX + 14 + 'px';
    this.ghost.style.top = event.clientY + 14 + 'px';
    const canvas = this.getCanvas?.(),
      rect = canvas?.iframe?.getBoundingClientRect();
    this.dropValid =
      !!rect &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    canvas?.frame?.classList.toggle('element-drop-target', this.dropValid);
  }
  endDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const rect = this.getCanvas?.()?.iframe?.getBoundingClientRect(),
      valid =
        drag.moved &&
        rect &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
    const point = valid
      ? {
          x: ((event.clientX - rect.left) * 1280) / rect.width - drag.item.width / 2,
          y: ((event.clientY - rect.top) * 720) / rect.height - drag.item.height / 2,
        }
      : null;
    if (drag.moved) this.suppressClickUntil = performance.now() + 500;
    this.cancelDrag();
    if (valid) this.insert(drag.item, point, drag.slideId).catch((error) => this.fail(error));
  }
  cancelDrag() {
    if (this.drag) {
      this.drag.button.classList.remove('element-dragging');
      try {
        this.drag.button.releasePointerCapture(this.drag.pointerId);
      } catch {}
    }
    this.drag = null;
    this.ghost?.remove();
    this.ghost = null;
    this.getCanvas?.()?.frame?.classList.remove('element-drop-target');
  }
  async insert(item, point, targetId = this.getSlide?.()?.id) {
    if (this.inserting) return;
    this.inserting = true;
    this.status.classList.remove('error');
    this.status.textContent = 'Добавляем элемент…';
    const values = {
      x: clamp(point?.x ?? (1280 - item.width) / 2, 1280 - item.width),
      y: clamp(point?.y ?? (720 - item.height) / 2, 720 - item.height),
    };
    try {
      if (this.base) {
        await this.flush?.();
        const slide = this.getSlide();
        if (!slide || slide.id !== targetId)
          throw new Error('Выбран другой слайд. Добавьте элемент ещё раз.');
        const saved = await request(
          this.base + '/slides/' + encodeURIComponent(slide.id) + '/elements',
          { method: 'POST', body: { elementId: item.id, values, version: slide.version || 0 } },
        );
        await this.onSlide(saved);
      } else {
        const template = document.createElement('template');
        template.innerHTML = renderDesignElement(item.id, {
          blockId: 'element-' + crypto.randomUUID(),
        });
        Object.assign(template.content.firstElementChild.style, {
          left: values.x + 'px',
          top: values.y + 'px',
        });
        await this.onInsert(template.content.firstElementChild.outerHTML);
        if (this.drawer) this.drawer.hidden = true;
      }
      this.status.textContent = 'Добавлено';
    } finally {
      this.inserting = false;
    }
  }
  createDialog() {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'element-create-dialog';
    this.dialog.className = 'app-dialog element-create-dialog';
    this.dialog.innerHTML =
      '<form id="element-create-form"><div class="dialog-heading"><h2>Создать элемент</h2><button type="button" class="icon-button element-create-close" aria-label="Закрыть">×</button></div><p>Например: карточка браузера, стрелка или плашка. Готовый элемент сохранится в библиотеке.</p><label class="block-label" for="element-create-prompt">Что нарисовать?<textarea id="element-create-prompt" rows="4" maxlength="6000" placeholder="Форма, цвета и детали…"></textarea></label><div id="element-create-attachments" class="chat-attachments" hidden></div><div class="element-create-tools"><button type="button" id="element-create-attach">▧ Добавить образец</button><input type="file" id="element-create-files" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden></div><p id="element-create-upload-status" class="form-status" role="status"></p><p id="element-create-status" class="form-status" role="status"></p><div class="dialog-actions"><button type="button" class="element-create-close">Отмена</button><button type="submit" id="element-create-submit" class="primary">Создать с ИИ</button></div></form>';
    document.body.append(this.dialog);
    this.prompt = this.dialog.querySelector('#element-create-prompt');
    this.createStatus = this.dialog.querySelector('#element-create-status');
    this.submit = this.dialog.querySelector('#element-create-submit');
    this.attachments = new ChatAttachments({
      base: this.base,
      button: this.dialog.querySelector('#element-create-attach'),
      input: this.dialog.querySelector('#element-create-files'),
      list: this.dialog.querySelector('#element-create-attachments'),
      status: this.dialog.querySelector('#element-create-upload-status'),
      pasteTarget: this.prompt,
      onChange: () => queueMicrotask(() => this.updateCreateControls()),
    });
    this.prompt.addEventListener('input', () => this.updateCreateControls());
    this.dialog.querySelectorAll('.element-create-close').forEach((button) =>
      button.addEventListener('click', () => {
        if (!this.creating) this.dialog.close();
      }),
    );
    this.dialog.addEventListener('cancel', (event) => {
      if (this.creating) event.preventDefault();
    });
    this.dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.generate().catch((error) => {
        this.createStatus.textContent = error.message;
        this.createStatus.classList.add('error');
        this.onError?.(error);
      });
    });
  }
  openCreate() {
    if (this.creating) return;
    this.createStatus.textContent = '';
    this.createStatus.classList.remove('error');
    this.dialog.showModal();
    this.updateCreateControls();
    this.prompt.focus();
  }
  updateCreateControls() {
    if (this.submit)
      this.submit.disabled =
        !!this.creating ||
        this.attachments.blocked ||
        (!this.prompt.value.trim() && !this.attachments.metadata.length);
  }
  async generate() {
    if (this.creating || this.attachments.blocked) return;
    const description = this.prompt.value.trim(),
      attachments = this.attachments.metadata;
    if (!description && !attachments.length) return;
    const previousIds = new Set(this.items.map((item) => item.id));
    const message =
      'Создай новый дизайнерский элемент для общей библиотеки через create_design_element. Это элемент оформления, не анимация и не переход. Используй HTML с одним корневым элементом, inline CSS/SVG, редактируемыми текстами и стабильными ID. Если приложен образец, прочитай его через read_attachment; нужное изображение сначала перенеси через use_attachment_image. Не меняй текущие слайды и тему. Сохрани элемент в библиотеке через create_design_element, затем обязательно вызови render_design_element для созданного ID, посмотри изображение и проверь отсутствие обрезки и пропавших картинок.\n\nЗапрос: ' +
      (description || 'Создай элемент по приложенному образцу.');
    this.creating = true;
    this.prompt.disabled = true;
    this.attachments.setBusy(true);
    this.createStatus.textContent = 'Создаём элемент…';
    this.updateCreateControls();
    let accepted = false;
    const onAccepted = () => {
      accepted = true;
      this.dialog.close();
      this.onAccepted?.();
    };
    try {
      const result = await this.onGenerate({
        message,
        attachments,
        attachmentIds: attachments.map((item) => item.id),
        onAccepted,
      });
      if (result?.accepted && !accepted) onAccepted();
      if (!result?.completed)
        throw new Error(result?.error || 'Элемент ещё не создан. Запрос можно повторить.');
      await this.refresh();
      if (!this.items.some((item) => !builtin(item.id) && !previousIds.has(item.id)))
        throw new Error(
          'Агент завершил ответ, но не сохранил новый элемент. Запрос можно повторить.',
        );
      this.attachments.clear();
      this.prompt.value = '';
    } catch (error) {
      await this.refresh().catch(() => {});
      if (!this.dialog.open) this.dialog.showModal();
      throw error;
    } finally {
      this.creating = false;
      this.prompt.disabled = false;
      this.attachments.setBusy(false);
      this.updateCreateControls();
    }
  }
}
