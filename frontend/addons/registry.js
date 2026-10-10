import { createAddonRegistry } from '../../shared/addons/registry.js';
import { builtinAddonDefinitions } from '../../shared/addons/builtins.js';
import { CompositionsUI } from './compositions/ui.js';
import { ElementsUI } from './design-elements/ui.js';
import { IconLibraryUI } from './icons/ui.js';
import { EffectsUI } from './motion/ui.js';

// Общий каталог описывает возможности дополнений, а этот список связывает их
// с браузерным интерфейсом. Дополнение получает реальные объекты движка и
// обычный путь сохранения; отдельного формата сцены или второй базы здесь нет.
const definitions = createAddonRegistry(builtinAddonDefinitions);
export const editorAddonMounts = [
  { ...definitions.get('compositions'), mount: (context) => new CompositionsUI(context) },
  { ...definitions.get('design-elements'), mount: (context) => new ElementsUI(context) },
  { ...definitions.get('icons'), mount: (context) => new IconLibraryUI(context) },
  { ...definitions.get('motion'), mount: (context) => new EffectsUI(context) },
];

// options содержит DOM-слоты и события только тех дополнений, которые нужны
// данному экрану. Например, редактор темы монтирует лишь дизайнерские элементы.
export function mountEditorAddons(context, options, mounts = editorAddonMounts) {
  const mounted = {};
  for (const addon of createAddonRegistry(mounts).list()) {
    if (!Object.hasOwn(options, addon.id)) continue;
    mounted[addon.id] = addon.mount({ ...context, ...options[addon.id] });
  }
  return mounted;
}
