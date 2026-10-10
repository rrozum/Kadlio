import { pageScope } from '../modules/page-lifecycle.js';
import { request, downloadBlob } from '../modules/api.js';
import { ShareSettings, GuestFeedbackUI } from '../modules/share-settings.js';
export function mountEditorSharing({
  base,
  getProject,
  flush: flushAll,
  onRefresh: refreshSnapshot,
  chat,
  showDialog,
}) {
  const view = pageScope()?.document || document;
  const $ = (id) => view.getElementById(id);
  $('share-button').addEventListener('click', () => {
    $('share-status').textContent = '';
    showDialog('share-dialog');
    renderShare(getProject().shareUrl || null);
  });
  new ShareSettings({ dialog: $('share-dialog'), getId: () => getProject()?.id });
  // Гость не запускает агента: владелец отдельно переносит отзыв, затем отправляет сообщение.
  new GuestFeedbackUI({
    parent: $('comments-content'),
    getId: () => getProject()?.id,
    onApproved: async () => {
      await refreshSnapshot();
      await chat.loadHistory();
      if (!$('chat-input').value.trim())
        $('chat-input').value = 'Разбери добавленный комментарий гостя и предложи правки.';
    },
  });
  function renderShare(url) {
    $('share-active').hidden = !url;
    $('share-inactive').hidden = !!url;
    if (url) {
      $('share-url').value = url;
      $('share-open').href = url;
    }
  }
  $('share-create').addEventListener('click', async () => {
    try {
      await flushAll();
      $('share-create').disabled = true;
      const result = await request(base + '/share', { method: 'POST' });
      getProject().shareUrl = result.url;
      renderShare(result.url);
    } catch (error) {
      $('share-status').textContent = error.message;
    } finally {
      $('share-create').disabled = false;
    }
  });
  $('share-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('share-url').value);
      $('share-status').textContent = 'Ссылка скопирована';
    } catch {
      $('share-url').select();
      $('share-status').textContent = 'Скопируйте выделенную ссылку';
    }
  });
  $('share-revoke').addEventListener('click', async () => {
    if (!confirm('Отключить публичную ссылку?')) return;
    try {
      await request(base + '/share', { method: 'DELETE' });
      getProject().shareUrl = null;
      renderShare(null);
      $('share-status').textContent = 'Ссылка отключена';
    } catch (error) {
      $('share-status').textContent = error.message;
    }
  });
  function runtimeExportWarning(format) {
    return ['pdf', 'pptx'].includes(format) &&
      (getProject().design?.background?.type === 'video' ||
        getProject().slides.some(
          (slide) =>
            slide.script?.trim() || slide.elementEffects?.length || /<video\b/i.test(slide.body),
        ) ||
        getProject().timeline?.some((entry) => entry.snippet))
      ? 'Видео и JavaScript в ' +
          format.toUpperCase() +
          ' будут статичными. Для интерактивного показа выберите HTML.'
      : '';
  }
  $('export-button').addEventListener('click', () => {
    $('export-runtime-warning').hidden = !runtimeExportWarning('pdf');
    $('export-status').textContent = '';
    showDialog('export-dialog');
  });
  document.querySelectorAll('[data-export]').forEach((button) =>
    button.addEventListener('click', async () => {
      const format = button.dataset.export;
      try {
        await flushAll();
        document.querySelectorAll('[data-export]').forEach((item) => (item.disabled = true));
        $('export-status').classList.remove('error');
        const warning = runtimeExportWarning(format);
        $('export-status').textContent =
          'Готовим ' +
          format.toUpperCase() +
          '… Это может занять около минуты.' +
          (warning ? ' ' + warning : '');
        const response = await fetch(base + '/export/' + format, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!response.ok) {
          const result = await response
            .json()
            .catch(() => ({ error: 'Не удалось экспортировать' }));
          throw new Error(result.error || 'Не удалось экспортировать');
        }
        const disposition = response.headers.get('content-disposition') || '';
        const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i),
          plain = disposition.match(/filename="([^"]+)"/i);
        const filename = encoded
          ? decodeURIComponent(encoded[1])
          : plain
            ? plain[1]
            : getProject().title.replace(/[\\/:*?"<>|]/g, '-') + '.' + format;
        downloadBlob(await response.blob(), filename);
        let serverWarning = '';
        try {
          serverWarning = decodeURIComponent(response.headers.get('X-Presentation-Warnings') || '');
        } catch {}
        $('export-status').textContent =
          'Файл готов и скачивается.' +
          (serverWarning || warning ? ' ' + (serverWarning || warning) : '');
      } catch (error) {
        $('export-status').classList.add('error');
        $('export-status').textContent = error.message;
      } finally {
        document.querySelectorAll('[data-export]').forEach((item) => (item.disabled = false));
      }
    }),
  );
}
