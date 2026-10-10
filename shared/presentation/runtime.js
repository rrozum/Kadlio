// Проверка наличия интерактивной сцены не запускает код слайда.
export const hasSlideRuntime = (slide, project) =>
  !!slide.script?.trim() ||
  !!slide.elementEffects?.length ||
  /<video\b/i.test(slide.body || '') ||
  project?.design?.background?.type === 'video' ||
  !!project?.timeline?.some(
    (entry, index, entries) =>
      entry.snippet && (entries[index - 1]?.id === slide.id || entries[index + 1]?.id === slide.id),
  );
