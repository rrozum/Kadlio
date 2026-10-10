import { listen } from './page-lifecycle.js';
// Тур встраивает обычный редактор и сохраняет тему через тот же путь проверки версии CAS.
export function mountThemeTour({ getState, onSave }) {
  const enabled = new URLSearchParams(location.search).get('embed') === 'tour';
  if (!enabled) return { enabled: false, notify() {} };
  document.body.classList.add('theme-tour');
  let previous = '',
    pending = false;
  const send = (message) => {
    if (window.parent !== window) window.parent.postMessage(message, location.origin);
  };
  const notify = () => {
    const state = getState();
    if (!state) return;
    const message = { type: 'presentation-theme-state', ...state, saving: state.saving || pending },
      serialized = JSON.stringify(message);
    if (serialized !== previous) {
      previous = serialized;
      send(message);
    }
  };
  listen(window, 'message', async (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== window.parent ||
      window.parent === window
    )
      return;
    const { type, requestId } = event.data || {};
    if (
      type !== 'presentation-theme-save' ||
      typeof requestId !== 'string' ||
      !requestId ||
      requestId.length > 100
    )
      return;
    let ownsSave = false;
    try {
      const state = getState();
      if (!state) throw new Error('Дождитесь загрузки темы.');
      if (state.busy) throw new Error('Дождитесь ответа агента или остановите его.');
      if (state.saving || pending) throw new Error('Дождитесь сохранения темы.');
      pending = true;
      ownsSave = true;
      notify();
      const saved = await onSave();
      send({
        type: 'presentation-theme-saved',
        requestId,
        themeId: saved.id,
        version: saved.version,
      });
    } catch (error) {
      send({
        type: 'presentation-theme-save-error',
        requestId,
        themeId: getState()?.themeId,
        error: error.message || String(error),
      });
    } finally {
      if (ownsSave) pending = false;
      notify();
    }
  });
  return { enabled, notify };
}
