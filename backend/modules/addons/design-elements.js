import { notFound, conflict } from '../../engine/errors.js';

// Дополнение готовит изменение и передаёт его единому движку с текущей версией.
export async function insertElement(engine, id, slideId, { elementId, values = {}, version } = {}) {
  const project = await engine.get(id),
    slide = project.slides.find((item) => item.id === slideId);
  if (!slide) throw notFound('Слайд не найден.');
  if (version !== slide.version) throw conflict();
  const html = await engine.elements.materialize(elementId, { ownerId: id, values });
  return engine.updateSlide(id, slideId, { body: slide.body + '\n' + html, version });
}
export async function insertThemeElement(engine, id, { elementId, values = {}, version } = {}) {
  const theme = await engine.themes.get(id);
  if (theme.version !== version) throw conflict('Тема уже изменилась. Обновите её перед вставкой.');
  const html = await engine.elements.materialize(elementId, {
    ownerId: id,
    scope: 'themes',
    values,
  });
  const design = structuredClone(theme.design);
  design.template.html = (design.template.html || '') + '\n' + html;
  return engine.themes.update(id, { version, design });
}
