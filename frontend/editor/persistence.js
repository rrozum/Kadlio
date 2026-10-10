import { pageScope, pageTimeout } from '../modules/page-lifecycle.js';
import { request } from '../modules/api.js';

// Отдельные очереди HTML и речи сохраняют версии независимо друг от друга.
export function createEditorPersistence({
  base,
  getProject,
  getSlide: activeSlide,
  status,
  onError,
}) {
  const view = pageScope()?.document || document;
  const $ = (id) => view.getElementById(id);
  const dirtySlides = new Set(),
    dirtyNotes = new Set();
  let saveTimer,
    notesTimer,
    saveQueue = Promise.resolve(),
    notesQueue = Promise.resolve();
  const toast = (message) => onError(new Error(message));
  const scheduleBodies = () => {
    clearTimeout(saveTimer);
    saveTimer = pageTimeout(() => saveBodies().catch(onError), 600);
  };
  const scheduleNotes = () => {
    clearTimeout(notesTimer);
    notesTimer = pageTimeout(() => saveNotes().catch(onError), 700);
  };
  function saveBodies() {
    clearTimeout(saveTimer);
    // Ошибка предыдущего запроса не блокирует следующую попытку сохранения.
    const work = saveQueue
      .catch(() => {})
      .then(async () => {
        for (const id of [...dirtySlides]) {
          const slide = getProject().slides.find((item) => item.id === id);
          if (!slide) {
            dirtySlides.delete(id);
            continue;
          }
          const body = slide.body;
          status('Сохраняем…');
          try {
            const saved = await request(base + '/slides/' + encodeURIComponent(id), {
              method: 'PATCH',
              body: { body, version: slide.version || 0 },
            });
            slide.version = saved.version;
            // Ответ подтверждает отправленный снимок, но не более поздний ввод пользователя.
            if (slide.body === body) {
              slide.body = saved.body;
              dirtySlides.delete(id);
            }
          } catch (error) {
            status(error.status === 409 ? 'Конфликт изменений' : 'Ошибка сохранения', 'error');
            if (error.status === 409)
              error.message =
                'Этот слайд изменился в другом окне или агентом. Ваш HTML остаётся здесь: откройте </>, скопируйте его и обновите страницу для согласования.';
            throw error;
          }
        }
        status(
          dirtySlides.size || dirtyNotes.size ? 'Есть изменения' : 'Сохранено',
          dirtySlides.size || dirtyNotes.size ? 'dirty' : '',
        );
      });
    saveQueue = work;
    return work;
  }
  function saveNotes() {
    clearTimeout(notesTimer);
    // Речь имеет свою версию: её сохранение не должно конфликтовать с правкой HTML.
    const work = notesQueue
      .catch(() => {})
      .then(async () => {
        const changes = [...dirtyNotes]
          .map((id) => getProject().slides.find((slide) => slide.id === id))
          .filter(Boolean)
          .map((slide) => ({
            id: slide.id,
            notes: slide.notes || '',
            version: slide.notesVersion || 0,
          }));
        if (!changes.length) return;
        $('notes-status').textContent = 'Сохраняем…';
        try {
          const result = await request(base + '/notes', { method: 'PATCH', body: { changes } });
          for (const saved of result) {
            const slide = getProject().slides.find((item) => item.id === saved.id);
            if (!slide) continue;
            slide.notesVersion = saved.version;
            const sent = changes.find((item) => item.id === saved.id);
            if (slide.notes === sent.notes) dirtyNotes.delete(slide.id);
          }
          $('notes-status').textContent = dirtyNotes.size ? 'Есть изменения' : 'Сохранено';
          status(
            dirtySlides.size || dirtyNotes.size ? 'Есть изменения' : 'Сохранено',
            dirtySlides.size || dirtyNotes.size ? 'dirty' : '',
          );
        } catch (error) {
          $('notes-status').textContent = 'Не сохранено';
          status('Ошибка сохранения', 'error');
          if (error.status === 409)
            error.message =
              'Речь изменили в другом окне. Ваш текст остаётся в редакторе; скопируйте его перед обновлением страницы.';
          throw error;
        }
      });
    notesQueue = work;
    return work;
  }
  async function flushAll() {
    await Promise.all([saveBodies(), saveNotes()]);
  }
  $('notes-input').addEventListener('input', () => {
    const slide = activeSlide();
    slide.notes = $('notes-input').value;
    dirtyNotes.add(slide.id);
    $('notes-status').textContent = 'Есть изменения';
    status('Есть изменения', 'dirty');
    scheduleNotes();
  });
  $('notes-save').addEventListener('click', () =>
    saveNotes().catch((error) => toast(error.message, true)),
  );

  return {
    dirtySlides,
    dirtyNotes,
    saveBodies,
    saveNotes,
    flushAll,
    scheduleBodies,
    scheduleNotes,
  };
}
