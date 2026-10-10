import { pageScope, pageTimeout } from './page-lifecycle.js';
import { navigate } from './navigation.js';
// Не прерываем уже начатую запись при переходе: CAS-ответ должен быть обработан.
export function request(url, options = {}) {
  const scope = pageScope();
  const writing = !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase());
  // Уход отменяет только чтения. Уже начатая запись завершается до dispose,
  // чтобы сохранение заметок/CAS не терялось при навигации.
  if (!writing && scope) {
    options = {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, scope.controller.signal])
        : scope.controller.signal,
    };
  }
  const task = requestInternal(url, options);
  if (writing) scope?.requests.add(task);
  return task.finally(() => {
    if (writing) scope?.requests.delete(task);
  });
}
async function requestInternal(url, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 401) {
    navigate(
      '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash),
    );
    throw new Error('Войдите снова');
  }
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(
      typeof data === 'object'
        ? data.error || data.message || 'Не удалось сохранить изменения'
        : data || 'Не удалось выполнить запрос',
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
export const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  pageTimeout(() => URL.revokeObjectURL(url), 10000);
}
