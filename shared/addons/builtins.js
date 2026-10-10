export const builtinAddonDefinitions = Object.freeze([
  {
    id: 'compositions',
    title: 'Композиции',
    targets: ['slide'],
    capabilities: ['catalog', 'insert'],
  },
  {
    id: 'design-elements',
    title: 'Дизайнерские элементы',
    targets: ['slide', 'project'],
    capabilities: ['catalog', 'insert', 'create'],
  },
  {
    id: 'icons',
    title: 'Иконки',
    targets: ['slide'],
    capabilities: ['catalog', 'search', 'insert'],
  },
  {
    id: 'motion',
    title: 'Анимации',
    targets: ['slide', 'timeline', 'project'],
    capabilities: ['catalog', 'apply', 'runtime', 'export'],
  },
]);
