import { insertPreset } from './compositions.js';
import { insertElement, insertThemeElement } from './design-elements.js';
import { applyElementEffect } from './motion.js';

// Явная серверная проводка встроенных дополнений. Новое дополнение получает
// существующий движок; для изменения слайда оно использует updateSlide/CAS.
export class EngineAddons {
  constructor(engine, registry) {
    this.engine = engine;
    this.registry = registry;
  }
  insertPreset(...args) {
    this.registry.get('compositions');
    return insertPreset(this.engine, ...args);
  }
  insertElement(...args) {
    this.registry.get('design-elements');
    return insertElement(this.engine, ...args);
  }
  insertThemeElement(...args) {
    this.registry.get('design-elements');
    return insertThemeElement(this.engine, ...args);
  }
  applyElementEffect(...args) {
    this.registry.get('motion');
    return applyElementEffect(this.engine, ...args);
  }
}
