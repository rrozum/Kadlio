// Copyright (c) 2026 Vincenzo AFK — MIT License.
// Адаптировано из extractJSON проекта SlideForge; см. THIRD_PARTY_NOTICES.md.
// Ответ модели — данные. Каждый аргумент инструмента дополнительно проверяет движок.
export function parseModelJSON(text, maximum = 2_000_000) {
  if (typeof text !== 'string' || text.length > maximum)
    throw new Error('Слишком большой или неверный JSON от модели.');
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = cleaned.indexOf('{'),
    end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Модель вернула неверные аргументы инструмента.');
  let value;
  try {
    value = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error('Модель вернула неверные аргументы инструмента.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Ожидался JSON-объект.');
  return value;
}
