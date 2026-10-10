// Анимации — необязательный модуль презентации. Исходный HTML не меняется.
export const effectPresets = [
  { id: 'none', name: 'Без эффекта', description: 'Спокойное переключение без движения.' },
  { id: 'fade', name: 'Растворение', description: 'Мягкая смена слайда, подходит почти всегда.' },
  { id: 'rise', name: 'Плавный подъём', description: 'Содержание поднимается и проявляется.' },
  { id: 'zoom', name: 'Приближение', description: 'Небольшой масштаб, как акцент на новой мысли.' },
  { id: 'slide', name: 'Сдвиг', description: 'Слайды плавно сменяют друг друга по горизонтали.' },
  { id: 'blur', name: 'В фокусе', description: 'Мягкий переход из размытия в резкость.' },
  {
    id: 'stagger',
    name: 'По очереди',
    description: 'Блоки появляются последовательно, без лишних кликов.',
  },
];

export function normalizeEffects(value) {
  if (value == null) return null;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['preset', 'duration'].includes(key)) ||
    !effectPresets.some((item) => item.id === value.preset) ||
    !Number.isInteger(value.duration) ||
    value.duration < 300 ||
    value.duration > 1400
  )
    throw new Error('Выберите готовый эффект и длительность от 300 до 1400 мс.');
  return { preset: value.preset, duration: value.duration };
}

const running = new WeakMap();
export function stopSlideEffects(slide) {
  const state = running.get(slide);
  if (!state) return;
  state.animations.forEach((animation) => animation.cancel());
  if (state.previous) {
    const { slide: previous, display, zIndex, pointerEvents } = state.previous;
    Object.assign(previous.style, { display, zIndex, pointerEvents });
    delete previous.dataset.effectGhost;
  }
  slide.style.zIndex = state.zIndex;
  delete slide.dataset.effectRunning;
  running.delete(slide);
}

export async function playSlideEffect(
  slide,
  value,
  { previous = null, direction = 1, force = false } = {},
) {
  if (!slide || (previous === slide && !force)) return;
  stopSlideEffects(slide);
  const effects = normalizeEffects(value);
  const win = slide.ownerDocument.defaultView;
  if (
    !effects ||
    effects.preset === 'none' ||
    win.__PRESENTATION_EXPORT__ ||
    (!force && win.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
    typeof slide.animate !== 'function'
  )
    return;
  if (previous && previous !== slide) stopSlideEffects(previous);
  const { preset, duration } = effects,
    state = { animations: [], zIndex: slide.style.zIndex, previous: null };
  running.set(slide, state);
  slide.dataset.effectRunning = preset;
  const animate = (element, frames, extra = {}) => {
    const animation = element.animate(frames, {
      duration,
      easing: 'cubic-bezier(.22,1,.36,1)',
      fill: 'both',
      ...extra,
    });
    state.animations.push(animation);
    return animation;
  };
  if (previous && previous !== slide && previous.isConnected) {
    state.previous = {
      slide: previous,
      display: previous.style.display,
      zIndex: previous.style.zIndex,
      pointerEvents: previous.style.pointerEvents,
    };
    previous.dataset.effectGhost = '';
    Object.assign(previous.style, { display: 'block', pointerEvents: 'none', zIndex: '1' });
    slide.style.zIndex = '2';
    // Под входящей анимацией оставляем уже нарисованный исходящий слайд.
    // Затухание обоих слоёв открывает тёмную подложку. Сохранение оригинала
    // обходится без клонирования HTML/SVG и сохраняет изображения, ID и декодированные ресурсы.
    if (preset === 'slide')
      animate(
        previous,
        [{ transform: 'translateX(0)' }, { transform: `translateX(${-direction * 100}px)` }],
        { duration: duration * 0.8 },
      );
  }
  const fade = [{ opacity: 0 }, { opacity: 1 }];
  const frames = {
    fade,
    rise: [
      { opacity: 0, transform: 'translateY(36px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    zoom: [
      { opacity: 0, transform: 'scale(.965)' },
      { opacity: 1, transform: 'scale(1)' },
    ],
    slide: [
      { opacity: 0, transform: `translateX(${direction * 90}px)` },
      { opacity: 1, transform: 'translateX(0)' },
    ],
    blur: [
      { opacity: 0, filter: 'blur(10px)', transform: 'scale(1.015)' },
      { opacity: 1, filter: 'blur(0)', transform: 'scale(1)' },
    ],
  };
  if (preset === 'stagger') {
    animate(slide, fade, { duration: Math.min(duration, 300) });
    const body = slide.querySelector('.slide-body') || slide.querySelector('.slide-content');
    const blocks = [...(body?.children || [])]
      .filter((node) => !node.matches('style,[data-template-layer]'))
      .slice(0, 12);
    for (const [index, block] of blocks.entries())
      animate(
        block,
        [
          { opacity: 0, translate: '0 24px' },
          { opacity: 1, translate: '0 0' },
        ],
        { delay: index * Math.min(75, 360 / Math.max(1, blocks.length - 1)) },
      );
  } else animate(slide, frames[preset] || fade);
  await Promise.allSettled(state.animations.map((animation) => animation.finished));
  if (running.get(slide) === state) stopSlideEffects(slide);
}

// Переходы PowerPoint дают приближение для браузерных эффектов blur/stagger.
export function pptxTransitionXML(value) {
  const effects = normalizeEffects(value);
  if (!effects || effects.preset === 'none') return '';
  const effect =
    { rise: '<p:push dir="u"/>', slide: '<p:push dir="l"/>', zoom: '<p:zoom dir="in"/>' }[
      effects.preset
    ] || '<p:fade/>';
  const speed = effects.duration <= 450 ? 'fast' : effects.duration >= 1000 ? 'slow' : 'med';
  return `<p:transition spd="${speed}" advClick="1">${effect}</p:transition>`;
}
