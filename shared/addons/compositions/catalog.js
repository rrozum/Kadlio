/**
 * Собственные HTML-композиции и палитры презентаций, без runtime-зависимостей.
 * Slidev, Marp, reveal.js и shadcn/ui изучались как примеры дизайна;
 * их код, шрифты, изображения и компоненты здесь не используются.
 * Источники и публичный контракт модуля описаны в docs/presets.md.
 */

import { themePresets } from '../../presentation/themes.js';
export { themePresets, getThemePreset } from '../../presentation/themes.js';

const field = (key, label, type = 'text') => Object.freeze({ key, label, type });
const preset = (id, name, description, category, width, height, defaults, fields) =>
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

export const blockPresets = Object.freeze([
  preset(
    'statement',
    'Главная мысль',
    'Крупный тезис с коротким пояснением.',
    'text',
    1000,
    340,
    {
      label: 'КЛЮЧЕВАЯ ИДЕЯ',
      title: 'Одна мысль.\nЯсный следующий шаг.',
      body: 'Короткое пояснение, которое помогает понять главный тезис.',
    },
    [
      field('label', 'Надпись'),
      field('title', 'Тезис', 'multiline'),
      field('body', 'Пояснение', 'multiline'),
    ],
  ),
  preset(
    'quote',
    'Цитата',
    'Выделенная цитата и подпись автора.',
    'text',
    1000,
    330,
    {
      quote: 'Хорошее решение можно объяснить несколькими простыми словами.',
      author: 'Автор или источник',
      context: 'Контекст цитаты',
    },
    [field('quote', 'Цитата', 'multiline'), field('author', 'Автор'), field('context', 'Контекст')],
  ),
  preset(
    'comparison',
    'Две стороны',
    'Два подхода, состояния или варианта рядом.',
    'layout',
    1000,
    330,
    {
      leftLabel: 'ВАРИАНТ A',
      leftTitle: 'Первый подход',
      leftBody: 'Кратко опишите его свойства, сильные стороны или ограничения.',
      rightLabel: 'ВАРИАНТ B',
      rightTitle: 'Второй подход',
      rightBody: 'Покажите существенное отличие на тех же критериях.',
    },
    [
      field('leftLabel', 'Левая надпись'),
      field('leftTitle', 'Левый заголовок'),
      field('leftBody', 'Левый текст', 'multiline'),
      field('rightLabel', 'Правая надпись'),
      field('rightTitle', 'Правый заголовок'),
      field('rightBody', 'Правый текст', 'multiline'),
    ],
  ),
  preset(
    'metrics',
    'Три числа',
    'Три показателя с ясными подписями.',
    'data',
    1000,
    270,
    {
      value1: '01',
      label1: 'Первый показатель',
      value2: '02',
      label2: 'Второй показатель',
      value3: '03',
      label3: 'Третий показатель',
      caption: 'Замените примеры реальными данными и укажите источник.',
    },
    [
      field('value1', 'Первое число'),
      field('label1', 'Первая подпись'),
      field('value2', 'Второе число'),
      field('label2', 'Вторая подпись'),
      field('value3', 'Третье число'),
      field('label3', 'Третья подпись'),
      field('caption', 'Источник / пояснение'),
    ],
  ),
  preset(
    'steps',
    'Три шага',
    'Последовательность действий с короткими пояснениями.',
    'layout',
    1000,
    330,
    {
      title1: 'Определить',
      body1: 'Сформулировать цель и ограничения.',
      title2: 'Сделать',
      body2: 'Выполнить небольшой проверяемый шаг.',
      title3: 'Проверить',
      body3: 'Сопоставить результат с исходной целью.',
    },
    [
      field('title1', 'Первый шаг'),
      field('body1', 'Первое пояснение', 'multiline'),
      field('title2', 'Второй шаг'),
      field('body2', 'Второе пояснение', 'multiline'),
      field('title3', 'Третий шаг'),
      field('body3', 'Третье пояснение', 'multiline'),
    ],
  ),
  preset(
    'timeline',
    'Временная шкала',
    'Три вехи на одной линии.',
    'layout',
    1000,
    300,
    {
      date1: 'ЭТАП 1',
      title1: 'Начало',
      body1: 'Отправная точка и первые решения.',
      date2: 'ЭТАП 2',
      title2: 'Развитие',
      body2: 'Основная работа и промежуточный результат.',
      date3: 'ЭТАП 3',
      title3: 'Результат',
      body3: 'Что получилось и что будет дальше.',
    },
    [
      field('date1', 'Первая дата'),
      field('title1', 'Первая веха'),
      field('body1', 'Первое описание', 'multiline'),
      field('date2', 'Вторая дата'),
      field('title2', 'Вторая веха'),
      field('body2', 'Второе описание', 'multiline'),
      field('date3', 'Третья дата'),
      field('title3', 'Третья веха'),
      field('body3', 'Третье описание', 'multiline'),
    ],
  ),
  preset(
    'code-card',
    'Код и пояснение',
    'Читаемый фрагмент кода рядом с его смыслом.',
    'layout',
    1000,
    370,
    {
      language: 'JAVASCRIPT',
      code: 'function explain(input) {\n  const result = simplify(input);\n  return result;\n}',
      title: 'Что здесь важно',
      body: 'Выделите одну деталь, которую аудитория должна заметить в примере.',
    },
    [
      field('language', 'Язык / имя файла'),
      field('code', 'Код', 'multiline'),
      field('title', 'Заголовок'),
      field('body', 'Пояснение', 'multiline'),
    ],
  ),
  preset(
    'callout',
    'Акцент',
    'Важное правило или вывод с цветной линией.',
    'text',
    1000,
    230,
    {
      label: 'ОБРАТИТЕ ВНИМАНИЕ',
      title: 'Важный вывод',
      body: 'Одна конкретная мысль, к которой хочется привлечь внимание.',
    },
    [field('label', 'Надпись'), field('title', 'Заголовок'), field('body', 'Текст', 'multiline')],
  ),
  preset(
    'image-caption',
    'Изображение и текст',
    'Место для изображения, заголовка и подписи.',
    'media',
    1000,
    370,
    {
      image: '',
      alt: 'Описание изображения',
      title: 'Покажите пример',
      body: 'Объясните, что слушатель должен увидеть на изображении.',
      caption: 'Подпись или источник',
    },
    [
      field('image', 'Изображение проекта', 'asset'),
      field('alt', 'Описание изображения'),
      field('title', 'Заголовок'),
      field('body', 'Пояснение', 'multiline'),
      field('caption', 'Подпись'),
    ],
  ),
  preset(
    'feature-cards',
    'Три карточки',
    'Три идеи с одинаковой визуальной иерархией.',
    'layout',
    1000,
    340,
    {
      title1: 'Первый принцип',
      body1: 'Короткая формулировка одной идеи.',
      title2: 'Второй принцип',
      body2: 'Ещё одна мысль с понятным пояснением.',
      title3: 'Третий принцип',
      body3: 'Завершите ряд конкретным выводом.',
    },
    [
      field('title1', 'Первый заголовок'),
      field('body1', 'Первый текст', 'multiline'),
      field('title2', 'Второй заголовок'),
      field('body2', 'Второй текст', 'multiline'),
      field('title3', 'Третий заголовок'),
      field('body3', 'Третий текст', 'multiline'),
    ],
  ),
  preset(
    'checklist',
    'Короткий список',
    'Три пункта для проверки или запоминания.',
    'text',
    1000,
    320,
    {
      title: 'Перед следующим шагом',
      item1: 'Цель сформулирована понятными словами.',
      item2: 'Ключевые решения можно объяснить.',
      item3: 'Результат проверен на реальном сценарии.',
    },
    [
      field('title', 'Заголовок'),
      field('item1', 'Первый пункт'),
      field('item2', 'Второй пункт'),
      field('item3', 'Третий пункт'),
    ],
  ),
  preset(
    'closing',
    'Завершение',
    'Крупный финальный вывод или приглашение к вопросам.',
    'text',
    1000,
    310,
    {
      label: 'СЛЕДУЮЩИЙ ШАГ',
      title: 'Что вы попробуете\nпосле этого доклада?',
      body: 'Выберите одну идею и примените её на ближайшей задаче.',
    },
    [
      field('label', 'Надпись'),
      field('title', 'Заголовок', 'multiline'),
      field('body', 'Текст', 'multiline'),
    ],
  ),
]);

const colors = {
  text: 'var(--pres-text,#f3f6fa)',
  muted: 'var(--pres-muted,#a5b2c4)',
  accent: 'var(--pres-accent,#67d4bd)',
  surface: 'var(--pres-surface,#202731)',
  border: 'var(--pres-border,#394454)',
  font: 'var(--pres-font,Arial,Helvetica,sans-serif)',
};

function escapeHTML(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

function text(
  id,
  key,
  value,
  { tag = 'p', size = 26, weight = 400, color = colors.text, style = '' } = {},
) {
  const suffix = /^item\d+$/.test(key) ? key.replace('item', 'item-') : key;
  const css = `margin:0;box-sizing:border-box;font-family:${colors.font};font-size:${size}px;font-weight:${weight};line-height:1.25;color:${color};white-space:pre-wrap;overflow-wrap:anywhere;${style}`;
  return `<${tag} data-block-id="${id}-${suffix}" data-block-type="text" data-preset-field="${key}" style="${escapeHTML(css)}">${escapeHTML(value)}</${tag}>`;
}

const label = (id, key, value, style = '') =>
  text(id, key, value, {
    size: 16,
    weight: 700,
    color: colors.accent,
    style: `letter-spacing:1.6px;${style}`,
  });
const cardStyle = `box-sizing:border-box;background:${colors.surface};border:1px solid ${colors.border};border-radius:22px;`;
const rule = (style = '') =>
  `<div aria-hidden="true" style="height:4px;width:64px;background:${colors.accent};border-radius:2px;${style}"></div>`;

const renderers = {
  statement: (id, v) =>
    `${label(id, 'label', v.label)}${text(id, 'title', v.title, { tag: 'h2', size: 54, weight: 700, style: 'margin-top:26px;max-width:970px;letter-spacing:-1.7px;' })}${text(id, 'body', v.body, { size: 25, color: colors.muted, style: 'margin-top:26px;max-width:850px;' })}`,
  quote: (id, v) =>
    `<div aria-hidden="true" style="position:absolute;left:0;top:-32px;color:${colors.accent};font-family:Georgia,serif;font-size:156px;line-height:1;">“</div><div style="padding:30px 44px 28px 112px;${cardStyle}">${text(id, 'quote', v.quote, { tag: 'blockquote', size: 38, weight: 500, style: 'letter-spacing:-.5px;' })}${rule('margin-top:24px;')}${text(id, 'author', v.author, { size: 23, weight: 700, style: 'margin-top:22px;' })}${text(id, 'context', v.context, { size: 19, color: colors.muted, style: 'margin-top:7px;' })}</div>`,
  comparison: (id, v) =>
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;height:100%;">${['left', 'right'].map((side, index) => `<div style="padding:30px;${cardStyle}${index ? `border-top:4px solid ${colors.accent};` : ''}">${label(id, `${side}Label`, v[`${side}Label`])}${text(id, `${side}Title`, v[`${side}Title`], { tag: 'h3', size: 34, weight: 700, style: 'margin-top:26px;' })}${text(id, `${side}Body`, v[`${side}Body`], { size: 24, color: colors.muted, style: 'margin-top:20px;' })}</div>`).join('')}</div>`,
  metrics: (id, v) =>
    `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:22px;">${[1, 2, 3].map((index) => `<div style="padding:28px;${cardStyle}">${text(id, `value${index}`, v[`value${index}`], { size: 68, weight: 700, color: colors.accent, style: 'line-height:1.05;letter-spacing:-2px;' })}${text(id, `label${index}`, v[`label${index}`], { size: 23, style: 'margin-top:22px;' })}</div>`).join('')}</div>${text(id, 'caption', v.caption, { size: 18, color: colors.muted, style: 'margin-top:22px;' })}`,
  steps: (id, v) =>
    `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;height:100%;">${[1, 2, 3].map((index) => `<div style="padding:28px;${cardStyle}"><div aria-hidden="true" style="width:54px;height:54px;box-sizing:border-box;border:2px solid ${colors.accent};border-radius:16px;display:flex;align-items:center;justify-content:center;color:${colors.accent};font-family:${colors.font};font-size:23px;font-weight:700;">0${index}</div>${text(id, `title${index}`, v[`title${index}`], { tag: 'h3', size: 29, weight: 700, style: 'margin-top:30px;' })}${text(id, `body${index}`, v[`body${index}`], { size: 23, color: colors.muted, style: 'margin-top:16px;' })}</div>`).join('')}</div>`,
  timeline: (id, v) =>
    `<div aria-hidden="true" style="position:absolute;left:18px;right:18px;top:61px;height:2px;background:${colors.border};"></div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:28px;">${[1, 2, 3].map((index) => `<div>${label(id, `date${index}`, v[`date${index}`])}<div aria-hidden="true" style="position:relative;width:18px;height:18px;box-sizing:border-box;border:4px solid ${colors.accent};border-radius:50%;background:${colors.surface};margin-top:32px;margin-bottom:32px;"></div>${text(id, `title${index}`, v[`title${index}`], { tag: 'h3', size: 32, weight: 700 })}${text(id, `body${index}`, v[`body${index}`], { size: 23, color: colors.muted, style: 'margin-top:18px;' })}</div>`).join('')}</div>`,
  'code-card': (id, v) =>
    `<div style="display:grid;grid-template-columns:1.25fr 1fr;gap:30px;height:100%;"><div style="padding:28px;${cardStyle}">${label(id, 'language', v.language)}${text(id, 'code', v.code, { tag: 'pre', size: 24, style: 'font-family:Consolas,"Courier New",monospace;margin-top:28px;line-height:1.55;background:transparent;border:0;padding:0;box-shadow:none;' })}</div><div style="padding:26px 4px;">${rule()}${text(id, 'title', v.title, { tag: 'h3', size: 34, weight: 700, style: 'margin-top:28px;' })}${text(id, 'body', v.body, { size: 25, color: colors.muted, style: 'margin-top:22px;' })}</div></div>`,
  callout: (id, v) =>
    `<div style="height:100%;padding:28px 34px;${cardStyle}border-left:7px solid ${colors.accent};">${label(id, 'label', v.label)}${text(id, 'title', v.title, { tag: 'h3', size: 37, weight: 700, style: 'margin-top:20px;' })}${text(id, 'body', v.body, { size: 25, color: colors.muted, style: 'margin-top:18px;max-width:860px;' })}</div>`,
  'image-caption': (id, v) => {
    const image = v.image;
    // Только ресурсы текущего проекта: без внешних загрузок, script URL и входного inline SVG.
    if (image && !/^\/api\/projects\/[a-zA-Z0-9_-]+\/assets\/[a-zA-Z0-9_.-]+$/.test(image))
      throw new TypeError('Image must be a project asset URL');
    const visual = image
      ? `<img data-block-id="${id}-image" data-block-type="image" data-preset-field="image" src="${escapeHTML(image)}" alt="${escapeHTML(v.alt)}" style="display:block;width:100%;height:100%;object-fit:contain;border-radius:22px;">`
      : `<div data-preset-placeholder="image" aria-label="Место для изображения" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;${cardStyle}"><div aria-hidden="true" style="width:112px;height:84px;box-sizing:border-box;border:2px solid ${colors.border};border-radius:14px;display:flex;align-items:center;justify-content:center;color:${colors.muted};font-family:${colors.font};font-size:18px;">Изображение</div></div>`;
    return `<div style="display:grid;grid-template-columns:1.3fr 1fr;gap:32px;height:100%;"><div style="height:100%;min-height:0;">${visual}</div><div style="padding:20px 0;">${rule()}${text(id, 'title', v.title, { tag: 'h3', size: 36, weight: 700, style: 'margin-top:26px;' })}${text(id, 'body', v.body, { size: 25, color: colors.muted, style: 'margin-top:24px;' })}${text(id, 'caption', v.caption, { size: 18, color: colors.muted, style: 'margin-top:28px;' })}</div></div>`;
  },
  'feature-cards': (id, v) =>
    `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;height:100%;">${[1, 2, 3].map((index) => `<div style="padding:30px 26px;${cardStyle}">${rule()}${text(id, `title${index}`, v[`title${index}`], { tag: 'h3', size: 30, weight: 700, style: 'margin-top:34px;' })}${text(id, `body${index}`, v[`body${index}`], { size: 23, color: colors.muted, style: 'margin-top:22px;' })}</div>`).join('')}</div>`,
  checklist: (id, v) =>
    `${text(id, 'title', v.title, { tag: 'h3', size: 36, weight: 700, style: 'margin-bottom:28px;' })}<div style="display:grid;gap:16px;">${[1, 2, 3].map((index) => `<div style="display:flex;align-items:center;gap:22px;padding:15px 22px;${cardStyle}"><div aria-hidden="true" style="width:27px;height:27px;flex-shrink:0;box-sizing:border-box;border:2px solid ${colors.accent};border-radius:8px;position:relative;"><div style="position:absolute;left:7px;top:3px;width:7px;height:12px;border-right:2px solid ${colors.accent};border-bottom:2px solid ${colors.accent};transform:rotate(45deg);"></div></div>${text(id, `item${index}`, v[`item${index}`], { size: 24 })}</div>`).join('')}</div>`,
  closing: (id, v) =>
    `${rule()}${label(id, 'label', v.label, 'margin-top:28px;')}${text(id, 'title', v.title, { tag: 'h2', size: 53, weight: 700, style: 'margin-top:22px;letter-spacing:-1.4px;' })}${text(id, 'body', v.body, { size: 25, color: colors.muted, style: 'margin-top:28px;max-width:870px;' })}`,
};

/** Известная тема. Неизменяемый объект содержит обычные JSON-совместимые значения. */

/**
 * Рендерим обычные значения в редактируемый HTML, который сохраняется в слайде.
 * Изменения каталога автоматически не пересоздают уже вставленную композицию.
 */
export function renderBlockPreset(presetId, { values = {}, blockId } = {}) {
  const definition = blockPresets.find((item) => item.id === presetId);
  if (!definition) throw new RangeError(`Unknown block preset: ${presetId}`);
  const id = blockId ?? `preset-${globalThis.crypto.randomUUID()}`;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new TypeError('Invalid block identifier');
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new TypeError('Preset values must be an object');
  const data = {};
  for (const key of Object.keys(definition.defaults)) {
    const value = values[key] ?? definition.defaults[key];
    if (!['string', 'number'].includes(typeof value))
      throw new TypeError(`Invalid preset value: ${key}`);
    data[key] = String(value);
    if (data[key].length > 32000) throw new RangeError(`Preset value is too long: ${key}`);
  }
  return `<div data-block-id="${id}" data-block-type="preset" data-preset-id="${definition.id}" style="position:absolute;left:88px;top:154px;width:${definition.width}px;height:${definition.height}px;box-sizing:border-box;color:${colors.text};font-family:${colors.font};line-height:1.25;">${renderers[presetId](id, data)}</div>`;
}
