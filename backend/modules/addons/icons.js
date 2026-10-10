import { randomUUID } from 'node:crypto';
import { renderPresentationIcon } from '../../../shared/addons/icons/catalog.js';

const error = (message, status = 400) => Object.assign(new Error(message), { status });
const allowed = new Set(['x', 'y', 'width', 'height', 'color']);
export async function insertPresentationIcon(library, projectId, slideId, payload = {}) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => !['iconId', 'values', 'version'].includes(key)) ||
    typeof payload.iconId !== 'string' ||
    !Number.isInteger(payload.version)
  )
    throw error('Укажите иконку и версию слайда.');
  const values = payload.values ?? {};
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    Object.keys(values).some((key) => !allowed.has(key))
  )
    throw error('Допустимы только положение, размер и цвет иконки.');
  for (const [key, min, max] of [
    ['x', 0, 1280],
    ['y', 0, 720],
    ['width', 4, 1280],
    ['height', 4, 720],
  ])
    if (
      values[key] !== undefined &&
      (typeof values[key] !== 'number' ||
        !Number.isFinite(values[key]) ||
        values[key] < min ||
        values[key] > max)
    )
      throw error('Положение или размер иконки вне границ слайда.');
  const project = await library.get(projectId),
    slide = project.slides.find((item) => item.id === slideId);
  if (!slide) throw error('Слайд не найден.', 404);
  if (payload.version !== (slide.version || 0))
    throw error('Слайд уже изменён. Обновите его и согласуйте правки.', 409);
  let html;
  try {
    html = renderPresentationIcon(payload.iconId, { ...values, blockId: 'icon-' + randomUUID() });
  } catch (cause) {
    throw error(cause.message);
  }
  return library.updateSlide(projectId, slideId, {
    body: slide.body + html,
    version: payload.version,
  });
}
