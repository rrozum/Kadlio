import path from 'node:path';

// Старые URL статических модулей остаются доступными после переноса исходников.
// Общие файлы используются браузером, серверным предпросмотром и экспортом.
const legacyModules = {
  'modules/presentation-design.js': 'shared/presentation/design.js',
  'modules/presentation-timeline.js': 'shared/presentation/timeline.js',
  'modules/slideforge-theme.js': 'shared/presentation/default-theme.js',
  'modules/presentation-presets.js': 'shared/addons/compositions/catalog.js',
  'modules/design-elements.js': 'shared/addons/design-elements/catalog.js',
  'modules/presentation-icons.js': 'shared/addons/icons/catalog.js',
  'modules/presentation-effects.js': 'shared/addons/motion/runtime.js',
  'modules/slide-runtime-player.js': 'shared/addons/motion/player.js',
};

export function resolveApplicationFile(root, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\//, '');
  const alias =
    legacyModules[relative] ||
    (relative.startsWith('vendor/prettier-3.9.9/') ? 'shared/' + relative : undefined);
  const directory = path.resolve(
    root,
    alias || relative.startsWith('shared/') ? 'shared' : 'frontend',
  );
  const name = alias
    ? alias.slice('shared/'.length)
    : relative.startsWith('shared/')
      ? relative.slice('shared/'.length)
      : relative;
  const file = path.resolve(directory, name);
  return file.startsWith(directory + path.sep) ? file : null;
}

export function canonicalApplicationPath(pathname) {
  const alias = legacyModules[pathname.replace(/^\//, '')];
  return alias ? '/' + alias : pathname;
}
