/**
 * Собственные элементы презентаций: HTML-рамки и простая геометрия inline SVG.
 * Tabler, Lucide и Excalidraw изучались только как примеры дизайна.
 * Их SVG paths, код, ресурсы и runtime-зависимости здесь не используются.
 * Каталог, происхождение и ограничения экспорта: docs/elements.md.
 */

const field = (key, label, type, options = {}) => Object.freeze({ key, label, type, ...options });
const color = field('color', 'Цвет акцента', 'color');
const stroke = field('stroke', 'Толщина линии', 'number', { min: 1, max: 12, step: 1 });
const opacity = field('opacity', 'Непрозрачность', 'number', { min: 0.05, max: 1, step: 0.05 });
const outlineDefaults = Object.freeze({ color: '', stroke: 4 });
const element = (id, name, description, category, width, height, defaults, fields) =>
  Object.freeze({
    id,
    name,
    description,
    category,
    width,
    height,
    defaults: Object.freeze(defaults),
    fields: Object.freeze(fields),
  });

export const designElements = Object.freeze([
  element(
    'browser-window',
    'Окно браузера',
    'Рамка с тремя кнопками и адресной строкой.',
    'frames',
    1000,
    390,
    {
      color: '',
      title: 'example.local',
      content: 'Содержимое окна\nДобавьте свой текст или изображение.',
    },
    [
      color,
      field('title', 'Адрес / заголовок', 'text'),
      field('content', 'Содержимое', 'multiline'),
    ],
  ),
  element(
    'terminal-window',
    'Терминал',
    'Тёмное окно с редактируемыми командами.',
    'frames',
    820,
    320,
    { color: '', title: 'terminal', content: '$ npm test\n\nAll checks passed.' },
    [color, field('title', 'Заголовок', 'text'), field('content', 'Команды / вывод', 'multiline')],
  ),
  element(
    'mouse-cursor',
    'Указатель',
    'Крупный курсор для выделения детали.',
    'markers',
    88,
    116,
    { ...outlineDefaults },
    [color, stroke],
  ),
  element(
    'arrow-right',
    'Прямая стрелка',
    'Прямая связь или направление движения.',
    'arrows',
    280,
    72,
    { ...outlineDefaults },
    [color, stroke],
  ),
  element(
    'arrow-curved',
    'Изогнутая стрелка',
    'Плавное направление к важной детали.',
    'arrows',
    260,
    170,
    { ...outlineDefaults },
    [color, stroke],
  ),
  element(
    'arrow-elbow',
    'Угловая стрелка',
    'Связь между блоками с поворотом.',
    'arrows',
    260,
    150,
    { ...outlineDefaults },
    [color, stroke],
  ),
  element(
    'arrow-double',
    'Двусторонняя стрелка',
    'Обмен или связь в обе стороны.',
    'arrows',
    300,
    72,
    { ...outlineDefaults },
    [color, stroke],
  ),
  element(
    'connector',
    'Соединительная линия',
    'Плавная линия с точками на концах.',
    'arrows',
    320,
    160,
    { ...outlineDefaults },
    [color, stroke],
  ),
  element(
    'brace',
    'Фигурная скобка',
    'Объединяет несколько связанных пунктов.',
    'markers',
    86,
    230,
    { ...outlineDefaults },
    [color, stroke],
  ),
  element(
    'bracket',
    'Квадратная скобка',
    'Обозначает границу или группу элементов.',
    'markers',
    64,
    230,
    { ...outlineDefaults },
    [color, stroke],
  ),
  element(
    'marker-highlight',
    'Маркер',
    'Полупрозрачная полоса для выделения текста.',
    'markers',
    380,
    62,
    { color: '#f2c84b', opacity: 0.35 },
    [color, opacity],
  ),
  element(
    'underline',
    'Подчёркивание',
    'Двойной свободный штрих под тезисом.',
    'markers',
    400,
    42,
    { color: '', stroke: 5 },
    [color, stroke],
  ),
  element(
    'focus-ring',
    'Обводка',
    'Неровное кольцо вокруг важного фрагмента.',
    'markers',
    180,
    140,
    { color: '', stroke: 4, opacity: 1 },
    [color, stroke, opacity],
  ),
  element(
    'blob',
    'Мягкая форма',
    'Цветовое пятно для фона или акцента.',
    'shapes',
    220,
    180,
    { color: '', opacity: 0.18 },
    [color, opacity],
  ),
  element(
    'dot-grid',
    'Точки',
    'Лёгкая декоративная сетка.',
    'shapes',
    160,
    120,
    { color: '', opacity: 0.3 },
    [color, opacity],
  ),
  element(
    'sticky-note',
    'Стикер',
    'Заметка с загнутым уголком и живым текстом.',
    'frames',
    320,
    240,
    {
      color: '#b7791f',
      fill: '#fff2b5',
      title: 'Запомнить',
      content: 'Короткая мысль\nили напоминание.',
    },
    [
      color,
      field('fill', 'Фон', 'color'),
      field('title', 'Заголовок', 'text'),
      field('content', 'Текст', 'multiline'),
    ],
  ),
]);

const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const font = 'var(--pres-font,Arial,Helvetica,sans-serif)';
const textColor = 'var(--pres-text,#f3f6fa)';
const muted = 'var(--pres-muted,#a5b2c4)';
const surface = 'var(--pres-surface,#202731)';
const border = 'var(--pres-border,#394454)';
const accent = 'var(--element-color,var(--pres-accent,#67d4bd))';

function noteInk(fill) {
  if (!fill) return textColor;
  const [red, green, blue] = [1, 3, 5].map((offset) =>
    Number.parseInt(fill.slice(offset, offset + 2), 16),
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 145 ? '#44351a' : '#fffdf5';
}

function text(id, key, value, style) {
  const css = `position:absolute;margin:0;box-sizing:border-box;font-family:${font};font-size:25px;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;${style}`;
  return `<p data-block-id="${id}-${key}" data-block-type="text" data-element-field="${key}" style="${escapeHTML(css)}">${escapeHTML(value)}</p>`;
}

const windowControls = () =>
  `<div aria-hidden="true" style="position:absolute;left:22px;top:21px;display:flex;gap:10px;">${['#ff6b66', '#f4bd4f', '#62c655'].map((value) => `<span style="display:block;width:13px;height:13px;box-sizing:border-box;border-radius:50%;background:${value};"></span>`).join('')}</div>`;

function svg(width, height, body, { stroke: line = 4, opacity: alpha = 1 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" width="100%" height="100%" style="position:absolute;inset:0;display:block;overflow:visible;color:inherit;" fill="none" stroke="currentColor" stroke-width="${line}" stroke-linecap="round" stroke-linejoin="round" opacity="${alpha}">${body}</svg>`;
}
const path = (d) => `<path vector-effect="non-scaling-stroke" d="${d}"/>`;

const renderers = {
  'browser-window': (id, v) =>
    `<div style="position:absolute;inset:0;box-sizing:border-box;border:1px solid currentColor;border-radius:20px;overflow:hidden;background:${surface};"><div style="position:absolute;inset:0 0 auto;height:57px;background:var(--pres-bg,#14181f);border-bottom:1px solid ${border};">${windowControls()}<div style="position:absolute;left:112px;top:11px;right:22px;height:34px;box-sizing:border-box;background:${surface};border:1px solid ${border};border-radius:8px;"></div></div>${text(id, 'title', v.title, `left:127px;top:17px;right:40px;font-size:18px;line-height:1.25;color:${muted};`)}${text(id, 'content', v.content, `left:34px;top:95px;right:34px;color:${textColor};font-size:29px;`)}</div>`,
  'terminal-window': (id, v) =>
    `<div style="position:absolute;inset:0;box-sizing:border-box;border:1px solid currentColor;border-radius:20px;overflow:hidden;background:#101a24;"><div style="position:absolute;inset:0 0 auto;height:57px;background:#202e3a;border-bottom:1px solid #344353;">${windowControls()}</div>${text(id, 'title', v.title, 'left:114px;top:17px;right:24px;font-size:19px;line-height:1.25;color:#b9cbdc;')}${text(id, 'content', v.content, 'left:31px;top:87px;right:31px;color:#dce8f3;font-family:Consolas,"Courier New",monospace;font-size:25px;line-height:1.5;')}</div>`,
  'mouse-cursor': (id, v) =>
    svg(
      88,
      116,
      '<path vector-effect="non-scaling-stroke" d="M14 10 L71 59 L47 64 L62 96 L48 103 L33 70 L14 88 Z" fill="currentColor" stroke="var(--pres-bg,#14181f)"/>',
      v,
    ),
  'arrow-right': (id, v) => svg(280, 72, path('M14 36 H261 M238 13 L261 36 L238 59'), v),
  'arrow-curved': (id, v) =>
    svg(260, 170, path('M18 146 C25 47 124 16 236 49 M210 22 L236 49 L204 65'), v),
  'arrow-elbow': (id, v) =>
    svg(260, 150, path('M18 130 V53 Q18 31 41 31 H239 M215 10 L239 31 L215 52'), v),
  'arrow-double': (id, v) =>
    svg(300, 72, path('M17 36 H283 M41 13 L17 36 L41 59 M259 13 L283 36 L259 59'), v),
  connector: (id, v) =>
    svg(
      320,
      160,
      `${path('M18 130 C139 130 167 30 302 30')}<circle vector-effect="non-scaling-stroke" cx="18" cy="130" r="7" fill="currentColor" stroke="none"/><circle vector-effect="non-scaling-stroke" cx="302" cy="30" r="7" fill="currentColor" stroke="none"/>`,
      v,
    ),
  brace: (id, v) =>
    svg(
      86,
      230,
      path('M69 12 H55 Q36 12 36 31 V77 Q36 105 17 115 Q36 125 36 153 V199 Q36 218 55 218 H69'),
      v,
    ),
  bracket: (id, v) => svg(64, 230, path('M51 12 H16 V218 H51'), v),
  'marker-highlight': (id, v) =>
    svg(
      380,
      62,
      '<path d="M10 12 L367 8 L372 47 L16 54 L6 40 Z" fill="currentColor" stroke="none"/>',
      v,
    ),
  underline: (id, v) =>
    svg(
      400,
      42,
      `${path('M13 16 C111 7 268 11 386 17')}${path('M42 30 C169 22 283 23 358 29')}`,
      v,
    ),
  'focus-ring': (id, v) =>
    svg(
      180,
      140,
      path(
        'M164 70 C164 29 133 13 89 15 C41 8 15 33 17 70 C11 111 45 128 91 126 C143 130 168 107 164 70 Z',
      ),
      v,
    ),
  blob: (id, v) =>
    svg(
      220,
      180,
      '<path d="M207 73 C215 111 172 153 127 164 C84 174 33 152 18 112 C1 69 30 26 72 18 C113 2 193 20 207 73 Z" fill="currentColor" stroke="none"/>',
      v,
    ),
  'dot-grid': (id, v) =>
    svg(
      160,
      120,
      Array.from(
        { length: 24 },
        (_, index) =>
          `<circle cx="${20 + (index % 6) * 24}" cy="${18 + Math.floor(index / 6) * 27}" r="3" fill="currentColor" stroke="none"/>`,
      ).join(''),
      v,
    ),
  'sticky-note': (id, v) =>
    `${svg(320, 240, `<path d="M12 8 H260 L308 56 V231 H12 Z" fill="${v.fill || surface}" stroke="none"/><path d="M260 8 V56 H308" stroke="currentColor" stroke-width="2" opacity=".4"/>`, { stroke: 2 })}${text(id, 'title', v.title, `left:34px;top:40px;width:220px;color:${noteInk(v.fill)};font-size:27px;font-weight:700;`)}${text(id, 'content', v.content, `left:34px;top:93px;width:246px;color:${noteInk(v.fill)};font-size:23px;`)}`,
};

/** Рендерим проверенные скалярные значения. Сохранённый HTML автоматически не пересоздаётся. */
export function renderDesignElement(elementId, { values = {}, blockId } = {}) {
  const definition = designElements.find((item) => item.id === elementId);
  if (!definition) throw new RangeError(`Unknown design element: ${elementId}`);
  const id = blockId ?? `element-${globalThis.crypto.randomUUID()}`;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new TypeError('Invalid block identifier');
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new TypeError('Element values must be an object');
  const data = {};
  for (const descriptor of definition.fields) {
    const value = values[descriptor.key] ?? definition.defaults[descriptor.key];
    if (descriptor.type === 'color') {
      if (typeof value !== 'string' || (value !== '' && !/^#[a-fA-F0-9]{6}$/.test(value)))
        throw new TypeError(`Invalid element color: ${descriptor.key}`);
      data[descriptor.key] = value;
    } else if (descriptor.type === 'number') {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < descriptor.min ||
        value > descriptor.max
      )
        throw new RangeError(`Invalid element number: ${descriptor.key}`);
      data[descriptor.key] = value;
    } else {
      if (typeof value !== 'string' || value.length > 16000)
        throw new TypeError(`Invalid element text: ${descriptor.key}`);
      data[descriptor.key] = value;
    }
  }
  return `<div data-block-id="${id}" data-block-type="element" data-element-id="${elementId}" aria-label="${escapeHTML(definition.name)}" style="position:absolute;left:96px;top:180px;width:${definition.width}px;height:${definition.height}px;box-sizing:border-box;color:${data.color || accent};font-family:${font};line-height:1.25;">${renderers[elementId](id, data)}</div>`;
}
