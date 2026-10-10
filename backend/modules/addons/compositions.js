import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { badRequest, notFound } from '../../engine/errors.js';
import { renderBlockPreset, blockPresets } from '../../../shared/addons/compositions/catalog.js';

// Дополнение готовит изменение и передаёт его единому движку с текущей версией.
export async function insertPreset(engine, id, slideId, { presetId, values = {}, version }) {
  const preset = blockPresets.find((item) => item.id === presetId);
  if (!preset) throw badRequest('Неизвестный пресет блока.');
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    Object.keys(values).some((key) => !Object.hasOwn(preset.defaults, key))
  )
    throw badRequest('Некорректные поля пресета.');
  for (const field of preset.fields.filter((f) => f.type === 'asset'))
    if (values[field.key]) {
      const url = values[field.key];
      if (
        typeof url !== 'string' ||
        !url.startsWith('/api/projects/' + id + '/assets/') ||
        url.includes('..')
      )
        throw badRequest('Используйте изображение из текущей презентации.');
      await engine.asset(id, path.basename(url));
    }
  let block;
  try {
    block = renderBlockPreset(presetId, { values, blockId: 'preset-' + randomUUID() });
  } catch (error) {
    throw badRequest(error.message);
  }
  const current = await engine.get(id),
    slide = current.slides.find((s) => s.id === slideId);
  if (!slide) throw notFound('Слайд не найден.');
  return engine.updateSlide(id, slideId, { version, body: slide.body + '\n' + block });
}
