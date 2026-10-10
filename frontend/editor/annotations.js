import { pageScope } from '../modules/page-lifecycle.js';
import { request, escapeHTML } from '../modules/api.js';

export function createEditorAnnotations({
  base,
  getProject,
  getSlide: activeSlide,
  getIndex,
  canvas,
  flush: flushAll,
  setTool,
  showSlide,
  updateThumbnailComments,
  chat,
  isAgentConfigured,
  onError,
  notify: toast,
}) {
  const view = pageScope()?.document || document;
  const $ = (id) => view.getElementById(id);
  let selectedAnnotation = null,
    annotationDraft = null;
  function renderPins() {
    if (!getProject()) return;
    $('annotation-pins').replaceChildren();
    getProject()
      .annotations.filter((annotation) => annotation.slideId === activeSlide()?.id)
      .forEach((annotation, index) => {
        const pin = document.createElement('button');
        pin.className =
          'comment-pin' +
          (selectedAnnotation?.id === annotation.id ? ' active' : '') +
          (annotation.resolved ? ' resolved' : '');
        pin.style.left = annotation.x * 1280 * canvas.scale + 'px';
        pin.style.top = annotation.y * 720 * canvas.scale + 'px';
        pin.textContent = annotation.resolved ? '✓' : String(index + 1);
        pin.title = (annotation.resolved ? 'Выполнено: ' : '') + annotation.comment;
        pin.setAttribute('aria-label', 'Комментарий ' + (index + 1) + ': ' + annotation.comment);
        pin.addEventListener('click', () => openAnnotation(annotation, true));
        $('annotation-pins').append(pin);
      });
  }
  function openAnnotation(value, existing = false) {
    annotationDraft = value;
    selectedAnnotation = existing ? value : null;
    $('annotation-input').value = existing ? value.comment : '';
    $('annotation-heading').textContent = existing
      ? 'Комментарий · слайд ' + (getIndex() + 1)
      : 'Новый комментарий';
    $('annotation-anchor').textContent = value.anchorText || '';
    $('annotation-delete').hidden = !existing;
    const width = 1280 * canvas.scale,
      height = 720 * canvas.scale;
    const popover = $('annotation-popover');
    popover.hidden = false;
    popover.style.left =
      Math.max(0, Math.min(width - popover.offsetWidth, value.x * width + 14)) + 'px';
    popover.style.top =
      Math.max(0, Math.min(height - popover.offsetHeight, value.y * height + 12)) + 'px';
    $('annotation-target').hidden = existing;
    $('annotation-target').style.left = value.x * width + 'px';
    $('annotation-target').style.top = value.y * height + 'px';
    renderPins();
    $('annotation-input').focus();
  }
  function closeAnnotation() {
    $('annotation-popover').hidden = true;
    $('annotation-target').hidden = true;
    annotationDraft = null;
    selectedAnnotation = null;
    renderPins();
  }
  function renderComments() {
    if (!getProject()) return;
    $('comments-count').textContent = getProject().annotations.length;
    $('comments-list').replaceChildren();
    if (!getProject().annotations.length) {
      $('comments-list').innerHTML =
        '<p class="comments-empty">Пока нет комментариев. Нажмите «Добавить комментарий» и выберите любую точку слайда.</p>';
      return;
    }
    for (const annotation of getProject().annotations) {
      const index = getProject().slides.findIndex((slide) => slide.id === annotation.slideId);
      const button = document.createElement('button');
      button.className = 'comment-list-item' + (annotation.resolved ? ' resolved' : '');
      button.innerHTML =
        '<strong>' +
        (annotation.resolved ? '✓ Выполнено · ' : '') +
        'Слайд ' +
        (index + 1) +
        ' · ' +
        escapeHTML(getProject().slides[index]?.title || '') +
        '</strong><span>' +
        escapeHTML(annotation.comment) +
        '</span>';
      button.addEventListener('click', async () => {
        try {
          await showSlide(index);
          openAnnotation(annotation, true);
        } catch (error) {
          toast(error.message, true);
        }
      });
      $('comments-list').append(button);
    }
  }
  $('annotation-close').addEventListener('click', () => setTool('select'));
  // Аннотация сохраняется перед запуском агента. При ошибке запроса черновик остаётся открытым.
  $('annotation-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!annotationDraft) return;
    const button = event.submitter;
    button.disabled = true;
    try {
      await flushAll();
      const value = {
        id: selectedAnnotation?.id || crypto.randomUUID(),
        slideId: activeSlide().id,
        x: annotationDraft.x,
        y: annotationDraft.y,
        anchorText: annotationDraft.anchorText || '',
        comment: $('annotation-input').value.trim(),
      };
      const result = await request(base + '/annotations', { method: 'POST', body: value }),
        annotation = result.annotation || result;
      const previous = getProject().annotations.find((item) => item.id === annotation.id);
      if (previous) Object.assign(previous, annotation);
      else getProject().annotations.push(annotation);
      closeAnnotation();
      setTool('select');
      renderPins();
      renderComments();
      updateThumbnailComments();
      $('chat-panel').classList.add('mobile-open');
      await chat.loadHistory();
      if (isAgentConfigured()) {
        await chat.send(annotation.comment, annotation.id);
      } else {
        toast('Комментарий сохранён в чате. Подключите ИИ, чтобы получить правки.');
        $('chat-input').value =
          'Разбери комментарий к слайду ' + (getIndex() + 1) + ': ' + annotation.comment;
        setAnnotationContext(annotation);
      }
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  $('annotation-delete').addEventListener('click', async () => {
    if (!selectedAnnotation) return;
    try {
      await request(base + '/annotations/' + encodeURIComponent(selectedAnnotation.id), {
        method: 'DELETE',
      });
      getProject().annotations = getProject().annotations.filter(
        (annotation) => annotation.id !== selectedAnnotation.id,
      );
      closeAnnotation();
      renderComments();
      updateThumbnailComments();
    } catch (error) {
      toast(error.message, true);
    }
  });
  function setAnnotationContext(annotation) {
    selectedAnnotation = annotation;
    const context = $('annotation-context');
    context.hidden = false;
    context.innerHTML =
      '<button type="button" aria-label="Убрать контекст комментария">×</button>▤ Слайд ' +
      (getIndex() + 1) +
      ': ' +
      escapeHTML(annotation.comment);
    context.querySelector('button').addEventListener('click', () => {
      context.hidden = true;
      selectedAnnotation = null;
    });
  }

  return {
    get selected() {
      return selectedAnnotation;
    },
    get draft() {
      return annotationDraft;
    },
    open: openAnnotation,
    close: closeAnnotation,
    renderPins,
    renderComments,
    setContext: setAnnotationContext,
    clearContext() {
      selectedAnnotation = null;
      $('annotation-context').hidden = true;
    },
  };
}
