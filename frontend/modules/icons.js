// SVG-кнопки не требуют отдельного фреймворка иконок для интерфейса.
const paths = {
  attachment: '<path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  pointer: '<path d="m4 3 7 17 2-7 7-2L4 3Z"/>',
  text: '<path d="M4 5h16M12 5v15M8 20h8"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 4 4 4-5 5 6"/>',
  comment:
    '<path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 12h6"/>',
  undo: '<path d="M3 10h11a6 6 0 0 1 0 12M3 10l5-5M3 10l5 5"/>',
  redo: '<path d="M21 10H10a6 6 0 0 0 0 12M21 10l-5-5M21 10l-5 5"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
  settings:
    '<path d="M4 6h5m4 0h7M4 12h9m4 0h3M4 18h2m4 0h10"/><circle cx="11" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  share: '<path d="M12 16V3m-5 5 5-5 5 5M5 13v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  notes: '<path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/>',
  blocks:
    '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="15" y="3" width="6" height="8" rx="2"/><rect x="3" y="15" width="8" height="6" rx="2"/><rect x="15" y="15" width="6" height="6" rx="2"/>',
  elements:
    '<rect x="3" y="3" width="11" height="8" rx="2"/><path d="m8 15 4 6 2-4 4-2-10-0Z"/><path d="M17 4h4m-2-2v4"/>',
  icons:
    '<circle cx="7" cy="7" r="3"/><rect x="14" y="4" width="6" height="6" rx="1"/><path d="m7 14 4 6H3l4-6Zm10 0v6m-3-3h6"/>',
  effects: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18"/>',
  slides:
    '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22h8m-4-4v4M7 8h10M7 12h6"/>',
};
export function icon(name) {
  return (
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (paths[name] || paths.slides) +
    '</svg>'
  );
}

export function applyIcons() {
  const controls = {
    'select-tool': ['pointer', 'Выбор'],
    'blocks-tool': ['blocks', 'Блоки'],
    'elements-tool': ['elements', 'Элементы'],
    'icons-tool': ['icons', 'Иконки'],
    'effects-tool': ['effects', 'Эффекты'],
    'text-tool': ['text', 'Текст'],
    'image-tool': ['image', 'Фото'],
    'annotation-tool': ['comment', 'Комментарий'],
    'annotation-add': ['plus', 'Добавить комментарий'],
    'undo-button': ['undo'],
    'redo-button': ['redo'],
    'source-button': ['code'],
    'ai-settings-button': ['settings'],
    'chat-send': ['arrow'],
    'present-link': ['play', 'Показ'],
    'share-button': ['share', 'Поделиться'],
    'export-button': ['download', 'Экспорт'],
    'new-project': ['plus', 'Новая презентация'],
    'first-project': ['plus', 'Создать презентацию'],
    'add-slide': ['plus', 'Слайд'],
    'chat-toggle': ['panel'],
    'properties-toggle': ['settings'],
  };
  for (const [id, [name, label]] of Object.entries(controls)) {
    const element = document.getElementById(id);
    if (element) element.innerHTML = icon(name) + (label ? '<span>' + label + '</span>' : '');
  }
  for (const element of document.querySelectorAll('[data-panel-target]')) {
    const name =
      {
        notes: 'notes',
        comments: 'comment',
        design: 'theme',
        icons: 'icons',
        elements: 'elements',
      }[element.dataset.panelTarget] || 'settings';
    element.innerHTML = icon(name);
  }
  for (const element of document.querySelectorAll('.brand-mark'))
    element.innerHTML = icon('slides');
}
