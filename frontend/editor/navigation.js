import { mountPreviewFrame } from '../modules/preview-frame.js';
import { pageScope, PageIntersectionObserver, pageTimeout } from '../modules/page-lifecycle.js';
import { slideDocument } from '../engine/slide.js';
import { updateSlideDocument } from '../engine/canvas.js';

export function createEditorNavigation({
  projectId,
  getProject,
  getSlide: activeSlide,
  getIndex,
  setIndex,
  getTimeline,
  canvas,
  dirtyNotes,
  flush: flushAll,
  displaySlide,
  displayProject,
  onBeforeSlide,
  onAfterSlide,
  onSlideChange,
  onError,
}) {
  const view = pageScope()?.document || document;
  const $ = (id) => view.getElementById(id);
  let navigationQueue = Promise.resolve();
  const toast = (message) => onError(new Error(message));
  const thumbnailNodes = new Map(),
    thumbnailPending = new Set(),
    visibleThumbnails = new Set();
  let thumbnailTimer;
  const thumbnailObserver = new PageIntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.slideId;
        if (entry.isIntersecting) {
          visibleThumbnails.add(id);
          queueThumbnail(id);
        } else visibleThumbnails.delete(id);
      }
    },
    { root: $('slide-list'), rootMargin: '0px 240px', threshold: 0 },
  );
  // Переключения выполняются по очереди: сначала сохраняем текущий слайд, затем меняем DOM.
  function showSlide(index) {
    if (getTimeline()?.busy) return Promise.resolve();
    const work = navigationQueue.catch(() => {}).then(() => showSlideNow(index));
    navigationQueue = work;
    return work;
  }
  async function showSlideNow(index) {
    if (!getProject()?.slides.length) return;
    await flushAll();
    setIndex(Math.max(0, Math.min(getProject().slides.length - 1, index)));
    onBeforeSlide();
    const slide = activeSlide();
    location.hash = slide.id;
    $('slide-title').textContent = slide.title;
    $('slide-counter').textContent = getIndex() + 1 + ' / ' + getProject().slides.length;
    $('chat-slide-context').textContent = 'Слайд ' + (getIndex() + 1);
    $('notes-input').value = slide.notes || '';
    $('notes-status').textContent = dirtyNotes.has(slide.id) ? 'Есть изменения' : 'Сохранено';
    $('present-link').href =
      '/projects/' + encodeURIComponent(projectId) + '/view#' + encodeURIComponent(slide.id);
    $('mode-present-link').href = $('present-link').href;
    $('slide-prev').disabled = getIndex() === 0;
    $('slide-next').disabled = getIndex() === getProject().slides.length - 1;
    document.querySelectorAll('.slide-thumbnail').forEach((button) => {
      button.classList.toggle('active', button.dataset.slideId === slide.id);
      button.setAttribute('aria-current', button.dataset.slideId === slide.id ? 'true' : 'false');
    });
    document
      .querySelector('.slide-thumbnail.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    onSlideChange();
    await canvas.render(displaySlide(slide), displayProject());
    onAfterSlide();
  }
  function renderFilmstrip() {
    const list = $('slide-list'),
      ids = new Set(getProject().slides.map((slide) => slide.id));
    $('filmstrip-count').textContent = getProject().slides.length;
    for (const [id, button] of thumbnailNodes)
      if (!ids.has(id)) {
        thumbnailObserver.unobserve(button);
        button.previewDispose?.();
        button.remove();
        thumbnailNodes.delete(id);
        thumbnailPending.delete(id);
        visibleThumbnails.delete(id);
      }
    getProject().slides.forEach((slide, index) => {
      let button = thumbnailNodes.get(slide.id);
      if (!button) {
        button = document.createElement('button');
        button.className = 'slide-thumbnail';
        button.dataset.slideId = slide.id;
        button.role = 'listitem';
        const viewport = document.createElement('div');
        viewport.className = 'thumb-viewport';
        const iframe = document.createElement('iframe');
        iframe.tabIndex = -1;
        iframe.setAttribute('sandbox', 'allow-same-origin');
        button.previewDispose = mountPreviewFrame(viewport, { frame: iframe, title: slide.title });
        const number = document.createElement('span');
        number.className = 'thumb-number';
        const label = document.createElement('div');
        label.className = 'thumb-label';
        button.append(viewport, number, label);
        button.addEventListener('click', () =>
          showSlide(
            getProject().slides.findIndex((item) => item.id === button.dataset.slideId),
          ).catch((error) => toast(error.message, true)),
        );
        thumbnailNodes.set(slide.id, button);
      }
      button.classList.toggle('active', slide.id === activeSlide()?.id);
      button.setAttribute('aria-current', String(slide.id === activeSlide()?.id));
      button.title = slide.title;
      button.setAttribute('aria-label', index + 1 + '. ' + slide.title);
      button.querySelector('iframe').title = slide.title;
      button.querySelector('.thumb-number').textContent = String(index + 1).padStart(2, '0');
      button.querySelector('.thumb-label').textContent = slide.title;
      if (button.parentNode !== list) list.append(button);
      thumbnailObserver.observe(button);
      updateThumbnail(slide);
    });
    getTimeline().render(thumbnailNodes);
    updateThumbnailComments();
  }
  function queueThumbnail(id) {
    thumbnailPending.add(id);
    if (!thumbnailTimer) thumbnailTimer = pageTimeout(flushThumbnails, 100);
  }
  // Миниатюры рендерятся только в видимой части ленты; iframe переиспользуется, пока жив документ.
  function flushThumbnails() {
    thumbnailTimer = null;
    for (const id of [...thumbnailPending]) {
      if (!visibleThumbnails.has(id)) continue;
      const slide = getProject().slides.find((item) => item.id === id),
        iframe = thumbnailNodes.get(id)?.querySelector('iframe');
      thumbnailPending.delete(id);
      if (!slide || !iframe) continue;
      const markup = slideDocument(displaySlide(slide), displayProject());
      if (iframe.renderMarkup === markup) continue;
      if (
        !iframe.contentDocument?.querySelector('.slide') ||
        !updateSlideDocument(iframe.contentDocument, markup)
      )
        iframe.srcdoc = markup;
      iframe.renderMarkup = markup;
    }
  }
  function updateThumbnail(slide) {
    queueThumbnail(slide.id);
  }
  function updateThumbnailComments() {
    for (const button of document.querySelectorAll('.slide-thumbnail')) {
      button.querySelector('.thumb-comment-count')?.remove();
      const count = getProject().annotations.filter(
        (annotation) => annotation.slideId === button.dataset.slideId,
      ).length;
      if (count) {
        const badge = document.createElement('span');
        badge.className = 'thumb-comment-count';
        badge.textContent = '▤ ' + count;
        button.append(badge);
      }
    }
  }

  return {
    showSlide,
    showSlideNow,
    renderFilmstrip,
    updateThumbnail,
    updateThumbnailComments,
    thumbnailNodes,
  };
}
