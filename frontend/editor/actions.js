import { pageScope } from '../modules/page-lifecycle.js';
import { request } from '../modules/api.js';
import { normalizeTimeline } from '../../shared/presentation/timeline.js';
export function mountEditorActions({
  base,
  getProject,
  setProject,
  getSlide: activeSlide,
  getIndex,
  flush: flushAll,
  renderFilmstrip,
  showSlide,
  showDialog,
  onError,
}) {
  const view = pageScope()?.document || document;
  const $ = (id) => view.getElementById(id);
  let renameAction;
  const toast = (message) => onError(new Error(message));
  function promptText(title, value, action) {
    renameAction = action;
    $('text-prompt-title').textContent = title;
    $('text-prompt-label').textContent = title;
    $('text-prompt-input').value = value;
    showDialog('text-prompt-dialog');
    $('text-prompt-input').select();
  }
  $('text-prompt-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      await renameAction($('text-prompt-input').value.trim());
      $('text-prompt-dialog').close();
    } catch (error) {
      toast(error.message, true);
    } finally {
      event.submitter.disabled = false;
    }
  });
  $('project-name').addEventListener('click', () =>
    promptText('Название презентации', getProject().title, async (title) => {
      await flushAll();
      const latest = await request(base);
      const result = await request(base, {
        method: 'PATCH',
        body: { title, version: latest.version },
      });
      getProject().version = result.version;
      getProject().title = result.title;
      $('project-name').textContent = getProject().title;
      document.title = getProject().title + ' · Kadlio';
    }),
  );
  $('add-slide').addEventListener('click', async () => {
    try {
      await flushAll();
      const slide = await request(base + '/slides', {
        method: 'POST',
        body: {
          title: 'Новый слайд',
          body: '<h2 data-block-type="text">Новый слайд</h2><p class="lead">Основная мысль — здесь.</p>',
        },
      });
      const timeline = normalizeTimeline(getProject());
      getProject().slides.push(slide);
      getProject().timeline = [...timeline, { type: 'slide', id: slide.id }];
      renderFilmstrip();
      await showSlide(getProject().slides.length - 1);
    } catch (error) {
      toast(error.message, true);
    }
  });
  $('slide-menu').addEventListener('click', () => {
    const last = getProject().slides.length - 1;
    $('delete-slide').disabled = last === 0;
    $('move-slide-left').disabled = getIndex() === 0;
    $('move-slide-right').disabled = getIndex() === last;
    showDialog('slide-actions-dialog');
  });
  $('duplicate-slide').addEventListener('click', async () => {
    const button = $('duplicate-slide');
    button.disabled = true;
    try {
      await flushAll();
      const sourceId = activeSlide().id,
        latest = await request(base);
      setProject(
        await request(base + '/slides/' + encodeURIComponent(sourceId) + '/copy', {
          method: 'POST',
          body: { version: latest.version },
        }),
      );
      const copiedId = getProject().createdSlideId;
      delete getProject().createdSlideId;
      renderFilmstrip();
      $('slide-actions-dialog').close();
      await showSlide(
        Math.max(
          0,
          getProject().slides.findIndex((slide) => slide.id === copiedId),
        ),
      );
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  async function reorderSlide(direction) {
    try {
      await flushAll();
      const ids = getProject().slides.map((slide) => slide.id),
        next = getIndex() + direction;
      [ids[getIndex()], ids[next]] = [ids[next], ids[getIndex()]];
      setProject(await request(base + '/slides/reorder', { method: 'POST', body: { ids } }));
      renderFilmstrip();
      $('slide-actions-dialog').close();
      await showSlide(next);
    } catch (error) {
      toast(error.message, true);
    }
  }
  $('move-slide-left').addEventListener('click', () => reorderSlide(-1));
  $('move-slide-right').addEventListener('click', () => reorderSlide(1));
  $('rename-slide').addEventListener('click', () => {
    $('slide-actions-dialog').close();
    promptText('Название слайда', activeSlide().title, async (title) => {
      await flushAll();
      const slide = activeSlide();
      const saved = await request(base + '/slides/' + encodeURIComponent(slide.id), {
        method: 'PATCH',
        body: { title, version: slide.version },
      });
      Object.assign(slide, saved);
      renderFilmstrip();
      await showSlide(getIndex());
    });
  });
  $('delete-slide').addEventListener('click', async () => {
    if (!confirm('Удалить текущий слайд и его комментарии? Связанный переход также будет удалён.'))
      return;
    try {
      await flushAll();
      setProject(
        await request(base + '/slides/' + encodeURIComponent(activeSlide().id), {
          method: 'DELETE',
        }),
      );
      renderFilmstrip();
      $('slide-actions-dialog').close();
      await showSlide(Math.min(getIndex(), getProject().slides.length - 1));
    } catch (error) {
      toast(error.message, true);
    }
  });
}
