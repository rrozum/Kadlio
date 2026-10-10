import { pageScope } from '../modules/page-lifecycle.js';
import { SourceEditor } from '../modules/source-editor.js';
export function createEditorSource({
  getSlide: activeSlide,
  getIndex,
  canvas,
  displaySlide,
  displayProject,
  onBodyChange,
  saveBodies,
  renderPins,
  showDialog,
}) {
  const view = pageScope()?.document || document;
  const $ = (id) => view.getElementById(id);
  const slideSource = new SourceEditor($('source-input'));
  function openSlideSource() {
    $('source-status').textContent = '';
    $('source-slide-context').textContent =
      'Слайд ' + (getIndex() + 1) + ' · ' + activeSlide().title;
    showDialog('source-dialog');
    slideSource.setValue(activeSlide().body).then(() => $('source-input').focus());
  }
  $('source-button').addEventListener('click', openSlideSource);
  $('slide-html-button').addEventListener('click', openSlideSource);
  $('source-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      const body = slideSource.getValue();
      if (body !== activeSlide().body) {
        onBodyChange(body);
        await saveBodies();
        await canvas.render(displaySlide(activeSlide()), displayProject());
        renderPins();
      }
      $('source-dialog').close();
    } catch (error) {
      $('source-status').classList.add('error');
      $('source-status').textContent = error.message;
    } finally {
      event.submitter.disabled = false;
    }
  });
  return {
    get hasDraft() {
      return $('source-dialog').open && slideSource.dirty;
    },
    open: openSlideSource,
  };
}
