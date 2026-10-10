import { Script } from 'node:vm';
import { badRequest } from '../errors.js';
const validId = /^[\w-]{1,100}$/;

export function validateSlideScript(value = '') {
  if (typeof value !== 'string' || value.length > 50000)
    throw badRequest('JS должен быть текстом до 50 000 символов.');
  // Компилируем только для проверки синтаксиса. Пользовательский код на Node.js не выполняется.
  try {
    new Script('async function slideProgram({slide,signal,onCleanup}){\n' + value + '\n}');
  } catch (error) {
    throw badRequest('Ошибка синтаксиса JS: ' + error.message);
  }
  return value;
}
export function validateElementEffects(value) {
  if (!Array.isArray(value) || value.length > 50)
    throw badRequest('На слайде может быть до 50 эффектов элементов.');
  const seen = new Set();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) => !['id', 'blockId', 'snippetId', 'code', 'options'].includes(key),
      ) ||
      !validId.test(item.id) ||
      seen.has(item.id) ||
      !validId.test(item.blockId) ||
      !validId.test(item.snippetId) ||
      typeof item.code !== 'string'
    )
      throw badRequest('Некорректная привязка эффекта.');
    seen.add(item.id);
    return {
      id: item.id,
      blockId: item.blockId,
      snippetId: item.snippetId,
      code: validateSlideScript(item.code),
      options: validateOptions(item.options || {}),
    };
  });
}
export function validateOptions(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 8000
  )
    throw badRequest('Параметры эффекта должны быть JSON-объектом до 8000 символов.');
  return JSON.parse(JSON.stringify(value));
}
