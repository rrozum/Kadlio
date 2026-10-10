import { listen, PageResizeObserver, pageScope, onPageCleanup } from '../modules/page-lifecycle.js';
import { slideDocument } from './slide.js';
import { selectableBlockAtPoint, cleanSlideHTML, blockType, colorHex } from './blocks.js';

// Сохраняем документ iframe, загруженные шрифты и неизменившиеся блоки.
// Исходные CSP и sandbox остаются в силе; код слайда здесь не выполняется.
export function updateSlideDocument(doc, markup) {
  const next = new DOMParser().parseFromString(markup, 'text/html'),
    stage = doc.querySelector('.slide'),
    target = next.querySelector('.slide');
  if (!stage || !target) return false;
  const link = doc.head.querySelector('link[rel=stylesheet]'),
    nextLink = next.head.querySelector('link[rel=stylesheet]');
  if (link && nextLink && link.getAttribute('href') !== nextLink.getAttribute('href'))
    link.setAttribute('href', nextLink.getAttribute('href'));
  const styles = [...doc.head.querySelectorAll('style:not([data-canvas-style])')];
  [...next.head.querySelectorAll('style')].forEach((style, index) => {
    if (styles[index]) {
      if (styles[index].textContent !== style.textContent)
        styles[index].textContent = style.textContent;
    } else doc.head.append(doc.importNode(style, true));
  });
  if (stage.className !== target.className) stage.className = target.className;
  if (stage.getAttribute('aria-label') !== target.getAttribute('aria-label'))
    stage.setAttribute('aria-label', target.getAttribute('aria-label') || '');
  const content = stage.querySelector('.slide-content'),
    nextContent = target.querySelector('.slide-content');
  const body = content.querySelector('.slide-body'),
    nextBody = nextContent.querySelector('.slide-body');
  if (cleanSlideHTML(body) !== nextBody.innerHTML) body.innerHTML = nextBody.innerHTML;
  const sync = (parent, selector, incoming, before = null) => {
    const old = parent.querySelector(selector);
    if (old?.outerHTML === incoming?.outerHTML) return;
    if (old) old.remove();
    if (incoming) parent.insertBefore(doc.importNode(incoming, true), before);
  };
  sync(
    content,
    ':scope > [data-template-layer]',
    nextContent.querySelector(':scope > [data-template-layer]'),
    body,
  );
  sync(stage, ':scope > .section-label', target.querySelector(':scope > .section-label'), content);
  sync(stage, ':scope > .footer', target.querySelector(':scope > .footer'));
  return true;
}

export class SlideCanvas {
  constructor({ iframe, frame, space, selection, callbacks }) {
    Object.assign(this, { iframe, frame, space, selection, callbacks });
    this.scope = pageScope();
    this.disposed = false;
    onPageCleanup(() => {
      this.disposed = true;
    });
    this.scale = 1;
    this.scaleMode = 'auto';
    this.manualScale = 1;
    this.mode = 'select';
    this.selected = null;
    this.observer = new PageResizeObserver(() => this.fit());
    this.observer.observe(space);
    selection
      .querySelector('[data-drag]')
      .addEventListener('pointerdown', (event) => this.startTransform(event, 'move'));
    selection
      .querySelectorAll('[data-resize]')
      .forEach((handle) =>
        handle.addEventListener('pointerdown', (event) =>
          this.startTransform(event, handle.dataset.resize),
        ),
      );
    this.pointerMove = (event) => this.queueTransform(event);
    this.pointerUp = () => this.endTransform();
    listen(window, 'pointermove', this.pointerMove);
    listen(window, 'pointerup', this.pointerUp);
    listen(window, 'pointercancel', this.pointerUp);
  }
  async render(slide, project, { notifySelection = true } = {}) {
    const sameSlide = this.slide?.id === slide.id && this.projectId === project.id,
      selectedId = sameSlide ? this.selected?.dataset.blockId : null;
    if (!sameSlide) {
      this.selected = null;
      this.selection.hidden = true;
    }
    this.slide = slide;
    this.projectId = project.id;
    const markup = slideDocument(slide, project, { editor: true });
    if (this.doc && this.doc === this.iframe.contentDocument && this.doc.querySelector('.slide'))
      updateSlideDocument(this.doc, markup);
    else {
      await new Promise((resolve, reject) => {
        const signal = this.scope?.controller.signal;
        const cleanup = () => {
          this.iframe.removeEventListener('load', loaded);
          signal?.removeEventListener('abort', aborted);
        };
        const loaded = () => {
          cleanup();
          resolve();
        };
        const aborted = () => {
          cleanup();
          reject(new DOMException('Экран закрыт', 'AbortError'));
        };
        if (signal?.aborted) return aborted();
        this.iframe.addEventListener('load', loaded, { once: true });
        signal?.addEventListener('abort', aborted, { once: true });
        this.iframe.srcdoc = markup;
      });
      this.doc = this.iframe.contentDocument;
      this.bindDocument();
    }
    this.root = this.doc.querySelector('.slide-body') || this.doc.querySelector('.slide-content');
    this.stage = this.doc.querySelector('.slide');
    for (const media of this.stage.querySelectorAll('video,audio')) media.pause();
    if (this.selected && !this.root.contains(this.selected))
      this.selected = selectedId
        ? [...this.root.querySelectorAll('[data-block-id]')].find(
            (element) => element.dataset.blockId === selectedId,
          ) || null
        : null;
    const currentDoc = this.doc;
    this.doc.fonts?.ready.then(() => {
      if (!this.disposed && this.doc === currentDoc) {
        this.fit();
        this.callbacks.onReady?.();
      }
    });
    this.fit();
    this.setMode(this.mode);
    if (notifySelection)
      this.callbacks.onSelection(this.selected ? this.properties() : null, { passive: true });
  }
  bindDocument() {
    this.doc.addEventListener('pointerdown', (event) => this.onPointer(event));
    this.doc.addEventListener('dblclick', (event) => this.onDoubleClick(event));
    this.doc.addEventListener('dragstart', (event) => {
      if (this.mode === 'select') event.preventDefault();
    });
    this.doc.addEventListener('click', (event) => {
      if (this.mode === 'select' && !event.target.closest('[contenteditable="true"]'))
        event.preventDefault();
    });
    this.doc.addEventListener(
      'play',
      (event) => {
        if (event.target.matches('video,audio')) event.target.pause();
      },
      true,
    );
    this.doc.addEventListener('input', () => this.changed());
    this.doc.addEventListener('focusout', (event) => {
      if (event.target.isContentEditable) {
        event.target.removeAttribute('contenteditable');
        this.changed();
      }
    });
    this.doc.addEventListener('keydown', (event) => this.onKey(event));
    this.doc.addEventListener('paste', (event) => {
      if (!event.target.isContentEditable) return;
      event.preventDefault();
      this.doc.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    });
    this.doc.addEventListener('pointermove', this.pointerMove);
    this.doc.addEventListener('pointerup', this.pointerUp);
    this.doc.addEventListener('pointercancel', this.pointerUp);
  }
  fit() {
    const bounds = this.space.getBoundingClientRect();
    const compact = window.innerWidth <= 700;
    this.scale =
      this.scaleMode === 'manual'
        ? this.manualScale
        : Math.max(
            0.1,
            Math.min((bounds.width - (compact ? 34 : 66)) / 1280, (bounds.height - 55) / 720, 1.7),
          );
    this.space.dataset.zoomMode = this.scaleMode;
    this.frame.style.width = 1280 * this.scale + 'px';
    this.frame.style.height = 720 * this.scale + 'px';
    this.iframe.style.transform = `scale(${this.scale})`;
    this.updateSelection();
    this.callbacks.onScale(this.scale, { mode: this.scaleMode });
  }
  setZoom(scale) {
    const value = Number(scale);
    if (!Number.isFinite(value)) return;
    this.scaleMode = 'manual';
    this.manualScale = Math.max(0.1, Math.min(2, Math.round(value * 100) / 100));
    this.fit();
  }
  zoomBy(delta = 0.1) {
    this.setZoom(this.scale + Number(delta));
  }
  resetZoom() {
    this.scaleMode = 'auto';
    this.fit();
    this.space.scrollTo({ left: 0, top: 0 });
  }
  setMode(mode) {
    this.pendingDrag = null;
    this.mode = mode;
    if (this.doc) this.doc.body.style.cursor = mode === 'annotation' ? 'crosshair' : 'default';
    if (mode === 'annotation') this.select(null);
  }
  onPointer(event) {
    if (event.button !== 0 || event.isPrimary === false || this.transformState) return;
    if (this.mode === 'annotation') {
      event.preventDefault();
      this.callbacks.onAnnotation({
        x: Math.max(0, Math.min(1, event.clientX / 1280)),
        y: Math.max(0, Math.min(1, event.clientY / 720)),
        anchorText: (event.target.textContent || event.target.alt || '').trim().slice(0, 300),
      });
      return;
    }
    if (event.target.isContentEditable) return;
    const placeholder = event.target.closest('[data-preset-placeholder="image"]');
    if (placeholder && this.root.contains(placeholder) && !this.lockInfo(placeholder).locked) {
      event.preventDefault();
      this.callbacks.onImagePlaceholder?.(placeholder);
      return;
    }
    const element = selectableBlockAtPoint(event.target, this.root, {
      deep: event.altKey,
      x: event.clientX,
      y: event.clientY,
    });
    this.select(element);
    this.pendingDrag = this.canEditSelection()
      ? { element, pointerId: event.pointerId, start: this.pointerPosition(event) }
      : null;
    // Перетаскивание принадлежит холсту: нативный drag текста/картинки мешает
    // этому жесту. Редактирование текста завершает обработчик выше этой точки.
    if (element) event.preventDefault();
  }
  onDoubleClick(event) {
    if (this.mode !== 'select') return;
    this.pendingDrag = null;
    const element = selectableBlockAtPoint(event.target, this.root, {
      deep: event.altKey,
      x: event.clientX,
      y: event.clientY,
    });
    if (!element || blockType(element) !== 'text' || this.lockInfo(element).locked) return;
    event.preventDefault();
    this.select(element);
    element.contentEditable = 'true';
    element.focus();
    const selection = this.doc.getSelection();
    const range = this.doc.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  select(element) {
    if (
      element &&
      !this.root?.contains(element) &&
      element !== this.stage &&
      element !== this.stage?.querySelector('[data-template-layer]')
    )
      return;
    if (this.selected?.isContentEditable && this.selected !== element) this.selected.blur();
    this.selected = element;
    this.updateSelection();
    this.callbacks.onSelection(element ? this.properties() : null);
  }
  updateSelection() {
    if (!this.selected || !this.selected.isConnected || !this.root) {
      this.selection.hidden = true;
      return;
    }
    const rect = this.selected.getBoundingClientRect();
    Object.assign(this.selection.style, {
      left: rect.left * this.scale + 'px',
      top: rect.top * this.scale + 'px',
      width: rect.width * this.scale + 'px',
      height: rect.height * this.scale + 'px',
    });
    this.selection.hidden = false;
    const info = this.lockInfo(this.selected);
    this.selection.classList.toggle('locked', info.locked);
    this.selection.querySelectorAll('[data-drag],[data-resize]').forEach((control) => {
      control.disabled = info.locked;
      control.hidden = info.locked;
    });
    this.selection.querySelector('.selection-tag').textContent =
      (info.theme
        ? 'Тема'
        : {
            image: 'Изображение',
            preset: 'Композиция',
            element: 'Элемент',
            text: 'Текст',
            group: 'Группа',
            shape: 'Фигура',
            icon: 'Иконка',
            video: 'Видео',
          }[blockType(this.selected)]) + (info.locked ? ' · заблокировано' : '');
  }
  properties() {
    const element = this.selected;
    if (!element) return null;
    const rect = element.getBoundingClientRect(),
      style = this.doc.defaultView.getComputedStyle(element);
    const lock = this.lockInfo(element);
    return {
      type: lock.theme ? 'theme' : blockType(element),
      locked: lock.locked,
      inheritedLock: lock.owner && lock.owner !== element,
      lockOwner: lock.owner,
      tag: element.localName,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text: element.innerText || element.textContent || '',
      alt: element.alt || '',
      fontSize: parseFloat(style.fontSize),
      color: colorHex(style.color),
      bold: Number(style.fontWeight) >= 600 || style.fontWeight === 'bold',
      italic: style.fontStyle === 'italic',
      align: style.textAlign,
      borderWidth: parseFloat(style.borderTopWidth) || 0,
      borderColor: colorHex(style.borderTopColor, '#199af0'),
      background: colorHex(style.backgroundColor, '#11181c'),
      transparent:
        style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent',
      radius: parseFloat(style.borderTopLeftRadius) || 0,
      opacity: Math.round(Number(style.opacity) * 100),
      fit: style.objectFit || 'contain',
    };
  }
  lockInfo(element = this.selected) {
    if (!element) return { locked: false, theme: false, owner: null };
    const theme =
      (!this.root?.contains(element) && this.stage?.contains(element)) ||
      (!!element.closest('[data-template-layer]') && this.stage?.dataset.themeEditor !== 'true');
    const owner = element.closest('[data-locked="true"]');
    return { locked: !!theme || !!owner, theme: !!theme, owner };
  }
  canEditSelection() {
    return !!this.selected && this.root?.contains(this.selected) && !this.lockInfo().locked;
  }
  ensureSelectedId() {
    if (!this.canEditSelection()) return null;
    if (!this.selected.dataset.blockId) {
      this.selected.dataset.blockId = crypto.randomUUID();
      this.changed();
    }
    return this.selected.dataset.blockId;
  }
  toggleLock() {
    if (!this.selected || this.lockInfo().theme) return;
    const owner = this.lockInfo().owner || this.selected;
    if (!this.root.contains(owner)) return;
    if (!owner.dataset.blockId) owner.dataset.blockId = crypto.randomUUID();
    if (owner.dataset.locked === 'true') owner.removeAttribute('data-locked');
    else owner.dataset.locked = 'true';
    this.changed();
    this.callbacks.onSelection(this.properties());
  }
  selectTheme() {
    this.select(this.stage.querySelector('[data-template-layer]') || this.stage);
  }
  ensureAbsolute() {
    if (!this.canEditSelection()) return null;
    const element = this.selected;
    const rect = element.getBoundingClientRect();
    if (!element.dataset.blockId) element.dataset.blockId = crypto.randomUUID();
    Object.assign(element.style, {
      position: 'absolute',
      margin: '0',
      width: rect.width + 'px',
      height: rect.height + 'px',
      boxSizing: 'border-box',
    });
    // У корневого SVG нет offsetParent. Берём позиционированного HTML-предка,
    // чтобы начало drag не смещалось на padding/позицию группы или слайда.
    let parent = element.offsetParent;
    if (!parent) {
      parent = element.parentElement;
      while (parent && parent !== this.stage) {
        const style = this.doc.defaultView.getComputedStyle(parent);
        if (style.position !== 'static' || style.transform !== 'none') break;
        parent = parent.parentElement;
      }
      parent ||= this.stage;
    }
    const parentRect = parent.getBoundingClientRect();
    element.style.left = rect.left - parentRect.left - parent.clientLeft + 'px';
    element.style.top = rect.top - parentRect.top - parent.clientTop + 'px';
    return rect;
  }
  pointerPosition(event) {
    if (event.view === this.doc?.defaultView || event.target?.ownerDocument === this.doc)
      return { x: event.clientX, y: event.clientY };
    const rect = this.iframe.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / this.scale,
      y: (event.clientY - rect.top) / this.scale,
    };
  }
  startTransform(event, operation, { start = this.pointerPosition(event) } = {}) {
    if (!this.canEditSelection() || (event.type === 'pointerdown' && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    this.selected.blur();
    const rect = this.ensureAbsolute();
    this.pendingDrag = null;
    this.transformState = {
      operation,
      pointerId: event.pointerId,
      startX: start.x,
      startY: start.y,
      left: parseFloat(this.selected.style.left),
      top: parseFloat(this.selected.style.top),
      width: rect.width,
      height: rect.height,
    };
    const capture = event.target.ownerDocument === this.doc ? this.selected : event.target;
    try {
      capture.setPointerCapture?.(event.pointerId);
      this.pointerCapture = capture;
    } catch {}
  }
  transform(event) {
    const state = this.transformState;
    if (!state || !this.canEditSelection()) return;
    // События окна используют экранные пиксели, события iframe — координаты слайда.
    const point = this.pointerPosition(event);
    const dx = point.x - state.startX,
      dy = point.y - state.startY;
    let { left, top, width, height } = state;
    if (state.operation === 'move') {
      left += dx;
      top += dy;
    } else {
      if (state.operation.includes('e')) width = Math.max(16, width + dx);
      if (state.operation.includes('s')) height = Math.max(16, height + dy);
      if (state.operation.includes('w')) {
        width = Math.max(16, width - dx);
        left = state.left + state.width - width;
      }
      if (state.operation.includes('n')) {
        height = Math.max(16, height - dy);
        top = state.top + state.height - height;
      }
    }
    Object.assign(this.selected.style, {
      left: Math.round(left) + 'px',
      top: Math.round(top) + 'px',
      width: Math.round(width) + 'px',
      height: Math.round(height) + 'px',
    });
    this.updateSelection();
    this.callbacks.onSelection(this.properties());
  }
  queueTransform(event) {
    if (this.pendingDrag) {
      const pending = this.pendingDrag;
      if (event.pointerId !== pending.pointerId) return;
      if (this.selected !== pending.element || !this.canEditSelection()) {
        this.pendingDrag = null;
        return;
      }
      const point = this.pointerPosition(event);
      if (Math.hypot(point.x - pending.start.x, point.y - pending.start.y) * this.scale < 4) return;
      this.startTransform(event, 'move', { start: pending.start });
    }
    if (!this.transformState) return;
    if (event.pointerId !== this.transformState.pointerId) return;
    this.pendingPointer = event;
    if (!this.transformFrame)
      this.transformFrame = requestAnimationFrame(() => {
        this.transformFrame = null;
        const latest = this.pendingPointer;
        this.pendingPointer = null;
        if (latest) this.transform(latest);
      });
  }
  endTransform() {
    this.pendingDrag = null;
    if (!this.transformState) return;
    if (this.transformFrame) cancelAnimationFrame(this.transformFrame);
    this.transformFrame = null;
    if (this.pendingPointer) {
      const latest = this.pendingPointer;
      this.pendingPointer = null;
      this.transform(latest);
    }
    const pointerId = this.transformState.pointerId;
    this.transformState = null;
    try {
      this.pointerCapture?.releasePointerCapture(pointerId);
    } catch {}
    this.pointerCapture = null;
    this.changed();
  }
  setProperty(name, value) {
    if (!this.canEditSelection()) return;
    const element = this.selected;
    if (!element.dataset.blockId) element.dataset.blockId = crypto.randomUUID();
    if (name === 'text') {
      if (blockType(element) !== 'text') return;
      element.textContent = value;
      element.style.whiteSpace = 'pre-wrap';
      element.style.height = 'auto';
    } else if (name === 'alt') element.alt = value;
    else if (name === 'x' || name === 'y') {
      this.ensureAbsolute();
      const parent = element.offsetParent || this.stage,
        rect = parent.getBoundingClientRect();
      element.style[name === 'x' ? 'left' : 'top'] =
        Number(value) -
        (name === 'x' ? rect.left + parent.clientLeft : rect.top + parent.clientTop) +
        'px';
    } else if (name === 'width' || name === 'height')
      element.style[name] = Math.max(8, Number(value)) + 'px';
    else if (name === 'fontSize') element.style.fontSize = Math.max(8, Number(value)) + 'px';
    else if (name === 'borderWidth') {
      element.style.borderWidth = Math.max(0, Number(value)) + 'px';
      element.style.borderStyle = 'solid';
    } else if (name === 'borderColor') {
      element.style.borderColor = value;
      if (!parseFloat(this.properties().borderWidth)) element.style.borderWidth = '1px';
      element.style.borderStyle = 'solid';
    } else if (name === 'radius') element.style.borderRadius = Math.max(0, Number(value)) + 'px';
    else if (name === 'opacity')
      element.style.opacity = Math.max(0, Math.min(100, Number(value))) / 100;
    else if (name === 'background') element.style.background = value;
    else if (name === 'bold') element.style.fontWeight = value ? '700' : '400';
    else if (name === 'italic') element.style.fontStyle = value ? 'italic' : 'normal';
    else if (name === 'align') element.style.textAlign = value;
    else if (name === 'fit') element.style.objectFit = value;
    else if (name === 'color') element.style.color = value;
    this.changed();
    this.callbacks.onSelection(this.properties());
  }
  insert(element) {
    this.root.append(element);
    this.select(element);
    this.changed();
  }
  replaceImage({ src, alt }) {
    if (!this.canEditSelection() || blockType(this.selected) !== 'image') return;
    this.selected.src = src;
    this.selected.alt = alt;
    this.changed();
  }
  duplicate() {
    if (!this.canEditSelection()) return;
    const original = this.selected;
    this.ensureAbsolute();
    const clone = original.cloneNode(true);
    clone.dataset.blockId = crypto.randomUUID();
    clone.removeAttribute('id');
    clone.removeAttribute('contenteditable');
    for (const child of clone.querySelectorAll('[data-block-id]'))
      child.dataset.blockId = crypto.randomUUID();
    clone.style.left = parseFloat(original.style.left) + 20 + 'px';
    clone.style.top = parseFloat(original.style.top) + 20 + 'px';
    original.parentNode.append(clone);
    this.select(clone);
    this.changed();
  }
  remove() {
    if (this.canEditSelection()) {
      this.selected.remove();
      this.select(null);
      this.changed();
    }
  }
  changed() {
    this.updateSelection();
    this.callbacks.onChange(cleanSlideHTML(this.root));
  }
  onKey(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.changed();
      this.callbacks.onSave?.();
      return;
    }
    if (event.target.isContentEditable) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.target.blur();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.callbacks.onUndo?.(event.shiftKey);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selected) {
      event.preventDefault();
      this.remove();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.select(null);
      this.callbacks.onEscape?.();
      return;
    }
    if (this.selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      if (!this.canEditSelection()) return;
      this.ensureAbsolute();
      const step = event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowLeft')
        this.selected.style.left = parseFloat(this.selected.style.left) - step + 'px';
      if (event.key === 'ArrowRight')
        this.selected.style.left = parseFloat(this.selected.style.left) + step + 'px';
      if (event.key === 'ArrowUp')
        this.selected.style.top = parseFloat(this.selected.style.top) - step + 'px';
      if (event.key === 'ArrowDown')
        this.selected.style.top = parseFloat(this.selected.style.top) + step + 'px';
      this.changed();
      this.callbacks.onSelection(this.properties());
      return;
    }
    this.callbacks.onKey?.(event);
  }
}
