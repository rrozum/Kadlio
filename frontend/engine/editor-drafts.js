// Перед принятием серверного снимка сохраняем неподтверждённые HTML и речь.
// Конфликт HTML останавливает принятие; локальный текст не заменяется чужой версией.
export function preserveLocalDrafts(project, snapshot, { dirtySlides, dirtyNotes }) {
  for (const old of project.slides) {
    const incoming = snapshot.slides.find((slide) => slide.id === old.id);
    if (!incoming) continue;
    if (dirtySlides.has(old.id)) {
      if (incoming.version !== old.version)
        throw new Error('Слайд изменился. Ваш локальный HTML сохранён в редакторе.');
      incoming.body = old.body;
    }
    if (dirtyNotes.has(old.id)) {
      incoming.notes = old.notes;
      incoming.notesVersion = old.notesVersion;
    }
  }
}
