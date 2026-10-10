// Базовые темы принадлежат движку; композиции — отдельному дополнению.
const sans = 'Arial, Helvetica, sans-serif';
const serif = 'Georgia, "Times New Roman", serif';

const theme = (id, name, description, tokens, background, decorations = []) =>
  Object.freeze({
    id,
    name,
    description,
    tokens: Object.freeze(tokens),
    background: Object.freeze(background),
    decorations: Object.freeze(decorations.map((item) => Object.freeze(item))),
  });

export const themePresets = Object.freeze([
  theme(
    'light',
    'Светлая',
    'Белый фон, синий акцент, чистая типографика.',
    {
      background: '#f8fafc',
      text: '#172033',
      muted: '#58677e',
      accent: '#2563eb',
      surface: '#ffffff',
      border: '#dce3ee',
      font: sans,
    },
    { type: 'solid', value: '#f8fafc' },
    [
      {
        id: 'accent-rule',
        type: 'line',
        x: 72,
        y: 686,
        width: 1136,
        height: 2,
        color: '#2563eb',
        opacity: 0.22,
      },
    ],
  ),
  theme(
    'dark',
    'Тёмная',
    'Графитовый фон и спокойный бирюзовый акцент.',
    {
      background: '#14181f',
      text: '#f3f6fa',
      muted: '#a5b2c4',
      accent: '#67d4bd',
      surface: '#202731',
      border: '#394454',
      font: sans,
    },
    { type: 'solid', value: '#14181f' },
    [
      {
        id: 'corner-circle',
        type: 'circle',
        x: 1100,
        y: -100,
        width: 250,
        height: 250,
        color: '#67d4bd',
        opacity: 0.08,
      },
    ],
  ),
  theme(
    'warm',
    'Тёплая',
    'Кремовый фон, терракота и мягкие карточки.',
    {
      background: '#fff7ed',
      text: '#33271f',
      muted: '#756051',
      accent: '#b94c28',
      surface: '#fffcf7',
      border: '#e8d7c6',
      font: sans,
    },
    { type: 'solid', value: '#fff7ed' },
    [
      {
        id: 'accent-rule',
        type: 'line',
        x: 72,
        y: 686,
        width: 160,
        height: 4,
        color: '#b94c28',
        opacity: 0.6,
      },
    ],
  ),
  theme(
    'midnight',
    'Полночь',
    'Синий градиент и выразительный фиолетовый акцент.',
    {
      background: '#10182e',
      text: '#f1f5ff',
      muted: '#a9b7d4',
      accent: '#b5a1ff',
      surface: '#1d2845',
      border: '#3d4b6c',
      font: sans,
    },
    { type: 'gradient', value: 'linear-gradient(135deg, #10182e 0%, #1b2949 100%)' },
    [
      {
        id: 'corner-circle',
        type: 'circle',
        x: 1050,
        y: -130,
        width: 340,
        height: 340,
        color: '#b5a1ff',
        opacity: 0.07,
      },
      {
        id: 'lower-circle',
        type: 'circle',
        x: -170,
        y: 610,
        width: 280,
        height: 280,
        color: '#6b9cff',
        opacity: 0.05,
      },
    ],
  ),
  theme(
    'paper',
    'Бумага',
    'Светлая бумага, книжный шрифт и сдержанный зелёный акцент.',
    {
      background: '#f6f4ee',
      text: '#292f2c',
      muted: '#626c65',
      accent: '#376653',
      surface: '#fffef9',
      border: '#d9ddd3',
      font: serif,
    },
    { type: 'solid', value: '#f6f4ee' },
    [
      {
        id: 'accent-rule',
        type: 'line',
        x: 72,
        y: 686,
        width: 1136,
        height: 1,
        color: '#376653',
        opacity: 0.35,
      },
    ],
  ),
]);

export function getThemePreset(id) {
  const result = themePresets.find((item) => item.id === id);
  if (!result) throw new RangeError(`Unknown presentation theme: ${id}`);
  return result;
}
