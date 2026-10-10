import { PresentationEngine } from '../engine/presentations/service.js';
import { MaterialsStore } from '../modules/uploads/materials.js';
import { ElementStore } from '../modules/addons/elements.js';
import { EffectSnippetStore } from '../modules/addons/effect-snippets.js';
import { EngineAddons } from '../modules/addons/service.js';
import { createPptxProject, importPptxIntoProject } from '../modules/imports/pptx.js';
import { createAddonRegistry } from '../../shared/addons/registry.js';
import { builtinAddonDefinitions } from '../../shared/addons/builtins.js';

// Фасад приложения сохраняет прежний набор операций Library. Сам движок
// не создаёт внешние модули: состав приложения определяется здесь явно.
export class Library extends PresentationEngine {
  constructor(dataDir) {
    super(dataDir);
    this.materials = new MaterialsStore(this);
    this.elements = new ElementStore(this);
    this.snippets = new EffectSnippetStore(this.dataDir);
    this.extensions.push(this.elements, this.snippets);
    this.addonRegistry = createAddonRegistry(builtinAddonDefinitions);
    this.addons = new EngineAddons(this, this.addonRegistry);
  }
  importPptx(payload) {
    return createPptxProject(this, payload);
  }
  importPptxInto(id, payload) {
    return importPptxIntoProject(this, id, payload);
  }
  insertElement(...args) {
    return this.addons.insertElement(...args);
  }
  insertThemeElement(...args) {
    return this.addons.insertThemeElement(...args);
  }
  insertPreset(...args) {
    return this.addons.insertPreset(...args);
  }
  applyElementEffect(...args) {
    return this.addons.applyElementEffect(...args);
  }
}
