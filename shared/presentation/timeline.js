import { normalizeEffects } from '../addons/motion/runtime.js';

const transitionId =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|legacy-slide-\d+)$/i;
const fail = (message) => {
  throw new Error(message);
};

// Канонический порядок — слайды с необязательными отдельными карточками переходов.
// Между соседними слайдами допускается не больше одного перехода.
export function validateTimeline(value, slides) {
  if (
    !Array.isArray(slides) ||
    !slides.length ||
    slides.length > 100 ||
    new Set(slides.map((slide) => slide.id)).size !== slides.length
  )
    fail('Таймлайн должен содержать от 1 до 100 разных слайдов.');
  if (
    !Array.isArray(value) ||
    value.length < slides.length ||
    value.length > slides.length * 2 - 1 ||
    value[0]?.type !== 'slide' ||
    value.at(-1)?.type !== 'slide'
  )
    fail('Таймлайн должен начинаться и заканчиваться слайдом.');
  const allowed = new Set(slides.map((slide) => slide.id)),
    seen = new Set(),
    slideIds = [];
  const entries = value.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.id !== 'string' ||
      seen.has(entry.id)
    )
      fail('Каждый элемент таймлайна должен иметь уникальный ID.');
    seen.add(entry.id);
    if (entry.type === 'slide') {
      if (Object.keys(entry).some((key) => !['type', 'id'].includes(key)) || !allowed.has(entry.id))
        fail('Таймлайн содержит неизвестный слайд или лишние поля.');
      slideIds.push(entry.id);
      return { type: 'slide', id: entry.id };
    }
    if (
      entry.type !== 'transition' ||
      !transitionId.test(entry.id) ||
      Object.keys(entry).some(
        (key) => !['type', 'id', 'preset', 'duration', 'snippet'].includes(key),
      ) ||
      value[index - 1]?.type !== 'slide' ||
      value[index + 1]?.type !== 'slide'
    )
      fail('Между соседними слайдами может находиться один переход с корректным ID.');
    const snippet = entry.snippet;
    if (
      snippet !== undefined &&
      (!snippet ||
        typeof snippet !== 'object' ||
        Array.isArray(snippet) ||
        Object.keys(snippet).some((key) => !['snippetId', 'code', 'options'].includes(key)) ||
        !/^[-\w]{1,100}$/.test(snippet.snippetId) ||
        typeof snippet.code !== 'string' ||
        snippet.code.length > 50000 ||
        !snippet.options ||
        typeof snippet.options !== 'object' ||
        Array.isArray(snippet.options) ||
        JSON.stringify(snippet.options).length > 8000)
    )
      fail('Некорректный JS-эффект перехода.');
    return {
      type: 'transition',
      id: entry.id,
      ...normalizeEffects({ preset: entry.preset, duration: entry.duration }),
      ...(snippet ? { snippet: JSON.parse(JSON.stringify(snippet)) } : {}),
    };
  });
  if (slideIds.length !== slides.length || slideIds.some((id) => !allowed.has(id)))
    fail('Укажите каждый слайд ровно один раз.');
  return entries;
}

export function normalizeTimeline(project) {
  if (project.timeline !== undefined) return validateTimeline(project.timeline, project.slides);
  const result = [];
  for (const [index, slide] of project.slides.entries()) {
    // Раньше эффект принадлежал входящему слайду. У первого слайда нет входящей
    // границы: переносим его эффект в первый промежуток, если там нет эффекта
    // второго слайда. У презентации из одного слайда границ переходов нет.
    let source = slide,
      effect = index ? normalizeEffects(slide.effects) : null;
    if (index === 1 && (!effect || effect.preset === 'none')) {
      const first = normalizeEffects(project.slides[0].effects);
      if (first && first.preset !== 'none') {
        source = project.slides[0];
        effect = first;
      }
    }
    if (effect && effect.preset !== 'none')
      result.push({ type: 'transition', id: 'legacy-' + source.id, ...effect });
    result.push({ type: 'slide', id: slide.id });
  }
  return validateTimeline(result, project.slides);
}

export function timelineForOrder(project, ids) {
  const source = normalizeTimeline(project),
    gaps = [];
  let index = -1;
  for (const entry of source)
    if (entry.type === 'slide') {
      index++;
      if (index < project.slides.length - 1) gaps[index] = null;
    } else gaps[index] = entry;
  const result = [];
  for (const [position, id] of ids.entries()) {
    result.push({ type: 'slide', id });
    if (position < ids.length - 1 && gaps[position]) result.push({ ...gaps[position] });
  }
  return validateTimeline(result, project.slides);
}

export function transitionForGap(project, gapIndex) {
  if (!Number.isInteger(gapIndex) || gapIndex < 0 || gapIndex >= project.slides.length - 1)
    return null;
  let index = -1;
  for (const entry of normalizeTimeline(project))
    if (entry.type === 'slide') index++;
    else if (index === gapIndex) return { ...entry };
  return null;
}

export function boundaryTransition(project, fromSlideId, toSlideId) {
  const entries = normalizeTimeline(project),
    ids = entries.filter((entry) => entry.type === 'slide').map((entry) => entry.id),
    from = ids.indexOf(fromSlideId),
    to = ids.indexOf(toSlideId);
  if (from < 0 || to < 0 || Math.abs(from - to) !== 1) return null;
  const transition = transitionForGap(project, Math.min(from, to));
  return transition
    ? {
        ...normalizeEffects({ preset: transition.preset, duration: transition.duration }),
        ...(transition.snippet ? { snippet: transition.snippet, transitionId: transition.id } : {}),
      }
    : null;
}

export function incomingTransition(project, slideId) {
  const entries = normalizeTimeline(project),
    index = entries.findIndex((entry) => entry.type === 'slide' && entry.id === slideId),
    before = entries[index - 1];
  return before?.type === 'transition'
    ? {
        ...normalizeEffects({ preset: before.preset, duration: before.duration }),
        ...(before.snippet ? { snippet: before.snippet, transitionId: before.id } : {}),
      }
    : null;
}

export function timelineAfterSlideRemoval(project, slideId) {
  const entries = normalizeTimeline(project),
    index = entries.findIndex((entry) => entry.type === 'slide' && entry.id === slideId);
  if (index < 0) fail('Слайд не найден.');
  // При удалении внутреннего слайда удаляем его исходящий переход, а входящий
  // оставляем в объединённом промежутке. Крайний слайд удаляется со своей единственной границей.
  const remove = new Set([index]);
  if (index === entries.length - 1 && entries[index - 1]?.type === 'transition')
    remove.add(index - 1);
  else if (entries[index + 1]?.type === 'transition') remove.add(index + 1);
  return validateTimeline(
    entries.filter((_, position) => !remove.has(position)),
    project.slides.filter((slide) => slide.id !== slideId),
  );
}
