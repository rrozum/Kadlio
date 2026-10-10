import { iconNodes, iconTags } from '../../vendor/lucide-1.52.0/catalog.js';

// Панель и инструменты агента используют общие имена и теги. Геометрия взята
// из закреплённой версии Lucide; вставка создаёт обычный редактируемый SVG.
const russian = {
  heart: 'Сердце',
  star: 'Звезда',
  check: 'Галочка',
  x: 'Крестик',
  user: 'Пользователь',
  users: 'Команда',
  home: 'Дом',
  house: 'Дом',
  settings: 'Настройки',
  search: 'Поиск',
  mail: 'Почта',
  phone: 'Телефон',
  calendar: 'Календарь',
  clock: 'Часы',
  timer: 'Таймер',
  database: 'База данных',
  server: 'Сервер',
  cloud: 'Облако',
  code: 'Код',
  terminal: 'Терминал',
  bug: 'Ошибка',
  shield: 'Защита',
  lock: 'Замок',
  key: 'Ключ',
  globe: 'Глобус',
  map: 'Карта',
  pin: 'Булавка',
  flag: 'Флаг',
  target: 'Цель',
  lightbulb: 'Идея',
  brain: 'Мозг',
  bot: 'Робот',
  sparkles: 'Искры',
  rocket: 'Ракета',
  zap: 'Молния',
  activity: 'Активность',
  stethoscope: 'Стетоскоп',
  hospital: 'Больница',
  pill: 'Таблетка',
  syringe: 'Шприц',
  cross: 'Медицинский крест',
  file: 'Файл',
  folder: 'Папка',
  image: 'Изображение',
  video: 'Видео',
  camera: 'Камера',
  mic: 'Микрофон',
  music: 'Музыка',
  volume: 'Звук',
  monitor: 'Монитор',
  smartphone: 'Смартфон',
  laptop: 'Ноутбук',
  tablet: 'Планшет',
  printer: 'Принтер',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  download: 'Скачать',
  upload: 'Загрузить',
  link: 'Ссылка',
  share: 'Поделиться',
  copy: 'Копировать',
  clipboard: 'Буфер обмена',
  trash: 'Корзина',
  edit: 'Редактировать',
  pencil: 'Карандаш',
  paintbrush: 'Кисть',
  palette: 'Палитра',
  eye: 'Глаз',
  sun: 'Солнце',
  moon: 'Луна',
  coffee: 'Кофе',
  gift: 'Подарок',
  bell: 'Колокольчик',
  book: 'Книга',
  bookmark: 'Закладка',
  award: 'Награда',
  trophy: 'Кубок',
  chart: 'График',
  trend: 'Тренд',
  arrow: 'Стрелка',
  circle: 'Круг',
  square: 'Квадрат',
  triangle: 'Треугольник',
  message: 'Сообщение',
  speech: 'Речь',
  building: 'Здание',
  briefcase: 'Работа',
  dollar: 'Деньги',
  wallet: 'Кошелёк',
  shopping: 'Покупки',
  cart: 'Корзина',
  truck: 'Грузовик',
  car: 'Автомобиль',
  plane: 'Самолёт',
  train: 'Поезд',
  bike: 'Велосипед',
  tree: 'Дерево',
  leaf: 'Лист',
  flower: 'Цветок',
  droplet: 'Капля',
  flame: 'Пламя',
  mountain: 'Гора',
};
const popular = [
  'heart',
  'star',
  'check',
  'user',
  'users',
  'house',
  'settings',
  'calendar',
  'clock',
  'database',
  'server',
  'cloud',
  'code',
  'bot',
  'brain',
  'lightbulb',
  'rocket',
  'shield',
  'stethoscope',
  'chart-no-axes-combined',
  'message-circle',
  'arrow-right',
  'target',
  'globe',
];
const ids = [
  ...popular.filter((id) => iconNodes[id]),
  ...Object.keys(iconNodes)
    .filter((id) => !popular.includes(id))
    .sort(),
];
const translate = (id) =>
  russian[id] ||
  id
    .split('-')
    .map((word) => russian[word])
    .filter(Boolean)
    .join(' · ') ||
  id;
export const presentationIcons = ids.map((id) => ({
  id,
  name: translate(id),
  tags: [
    ...(iconTags[id] || []),
    ...id
      .split('-')
      .map((word) => russian[word])
      .filter(Boolean),
  ],
  width: 96,
  height: 96,
}));
const searchText = new Map(
  presentationIcons.map((item) => [
    item.id,
    [item.id, item.name, ...item.tags].join(' ').toLocaleLowerCase('ru'),
  ]),
);
export function searchPresentationIcons(query = '', { limit = 80, offset = 0 } = {}) {
  const words = String(query).trim().toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
  return presentationIcons
    .filter((item) => words.every((word) => searchText.get(item.id).includes(word)))
    .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const number = (value, min, max) => {
  if (!Number.isFinite(Number(value)))
    throw new Error('Координаты и размер иконки должны быть числами.');
  return Math.max(min, Math.min(max, Number(value)));
};
export function renderPresentationIcon(
  id,
  {
    blockId = 'icon-' + globalThis.crypto.randomUUID(),
    color = '#199af0',
    x = 100,
    y = 160,
    width = 96,
    height = 96,
  } = {},
) {
  const nodes = Object.hasOwn(iconNodes, id) ? iconNodes[id] : null;
  if (!nodes) throw new Error('Иконка не найдена.');
  if (
    typeof color !== 'string' ||
    !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)
  )
    throw new Error('Цвет иконки должен быть HEX.');
  const children = nodes
    .map(
      ([tag, attributes]) =>
        '<' +
        tag +
        Object.entries(attributes)
          .map(([name, value]) => ' ' + name + '="' + escape(value) + '"')
          .join('') +
        '/>',
    )
    .join('');
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="' +
    escape(translate(id)) +
    '" data-block-id="' +
    escape(blockId) +
    '" data-block-type="icon" data-icon-id="' +
    escape(id) +
    '" style="position:absolute;left:' +
    number(x, 0, 1280) +
    'px;top:' +
    number(y, 0, 720) +
    'px;width:' +
    number(width, 4, 1280) +
    'px;height:' +
    number(height, 4, 720) +
    'px;color:' +
    escape(color) +
    '">' +
    children +
    '</svg>'
  );
}
