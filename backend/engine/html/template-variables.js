import { badRequest } from '../errors.js';

const fields = ['author', 'brand', 'projectTitle', 'slideTitle', 'section'];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
export function validateVariableUpdate(payload) {
  if (
    !object(payload) ||
    Object.keys(payload).some(
      (key) => !['values', 'version', 'slideId', 'slideVersion'].includes(key),
    ) ||
    !Number.isInteger(payload.version) ||
    payload.version < 0 ||
    !object(payload.values)
  )
    throw badRequest('Необходимы значения переменных и версия презентации.');
  const keys = Object.keys(payload.values);
  if (
    !keys.length ||
    keys.some((key) => !fields.includes(key)) ||
    keys.some((key) => typeof payload.values[key] !== 'string' || payload.values[key].length > 200)
  )
    throw badRequest(
      'Переменные шаблона должны быть текстом до 200 символов. Нумерация вычисляется автоматически.',
    );
  const values = { ...payload.values };
  if (values.projectTitle !== undefined) {
    values.projectTitle = values.projectTitle.trim();
    if (!values.projectTitle) throw badRequest('Название презентации не может быть пустым.');
  }
  const slideChanged = keys.some((key) => ['slideTitle', 'section'].includes(key));
  if (
    slideChanged &&
    (typeof payload.slideId !== 'string' ||
      !/^slide-\d+$/.test(payload.slideId) ||
      !Number.isInteger(payload.slideVersion) ||
      payload.slideVersion < 0)
  )
    throw badRequest('Для переменных слайда необходимы его ID и версия.');
  if (!slideChanged && (payload.slideId !== undefined || payload.slideVersion !== undefined))
    throw badRequest('Версия слайда нужна только для изменения его переменных.');
  return { ...payload, values, slideChanged };
}
