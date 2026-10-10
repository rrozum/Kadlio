import { parseHTML } from 'linkedom';
import { randomUUID } from 'node:crypto';
import { badRequest, notFound } from '../../engine/errors.js';

// Дополнение готовит изменение и передаёт его единому движку с текущей версией.
export async function applyElementEffect(engine, id, slideId, payload = {}) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some(
      (key) => !['snippetId', 'blockId', 'options', 'version'].includes(key),
    )
  )
    throw badRequest('Некорректные поля эффекта.');
  const { snippetId, blockId, options, version } = payload;
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)))
    throw badRequest('Параметры эффекта должны быть JSON-объектом.');
  const project = await engine.get(id),
    slide = project.slides.find((item) => item.id === slideId);
  if (!slide) throw notFound('Слайд не найден.');
  const { document } = parseHTML('<html><body>' + slide.body + '</body></html>'),
    matches = [...document.body.querySelectorAll('[data-block-id]')].filter(
      (node) => node.getAttribute('data-block-id') === blockId,
    );
  if (matches.length !== 1)
    throw badRequest('Сначала сохраните выбранный блок с уникальным data-block-id.');
  if (matches[0].closest('[data-locked="true"],[data-block-locked="true"],[data-template-layer]'))
    throw badRequest('Сначала разблокируйте элемент.');
  const snippet = await engine.snippets.get(snippetId),
    binding = {
      id: randomUUID(),
      blockId,
      snippetId,
      code: snippet.code,
      options: { ...snippet.defaults, ...(options || {}) },
    };
  return engine.updateSlide(id, slideId, {
    version,
    elementEffects: [...(slide.elementEffects || []), binding],
  });
}
