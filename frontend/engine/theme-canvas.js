import { SlideCanvas } from './canvas.js';
import { cleanSlideHTML, selectableBlock } from './blocks.js';

// Пример значений существует только в DOM. Сохраняемый шаблон оставляет {{переменные}}.
export class ThemeCanvas extends SlideCanvas {
  constructor(options) {
    super(options);
    this.bindings = [];
  }
  async renderTemplate(source, design) {
    for (const binding of this.bindings)
      if (binding.node.isConnected && binding.node.nodeValue === binding.display)
        binding.node.nodeValue = binding.source;
    this.design = design;
    this.bindings = [];
    const emptyTemplate = {
      header: '',
      footer: '',
      showAuthor: false,
      showProjectTitle: false,
      showSlideNumber: false,
      html: '',
      css: source.css || '',
    };
    const editorDesign = { ...design, decorations: [], template: emptyTemplate };
    const html =
      '<div class="presentation-template" data-theme-layer>' +
      source.html.replace(/\bdata-template-layer\b/g, 'data-theme-layer') +
      '</div>';
    await super.render(
      { id: 'template', title: 'Шаблон темы', body: html },
      {
        id: 'theme-preview',
        title: 'Пример презентации',
        design: editorDesign,
        css: design.sourceCSS || '',
        slides: [{ id: 'template' }],
      },
      { notifySelection: false },
    );
    this.stage.dataset.themeEditor = 'true';
    this.root = this.doc.querySelector('.slide-body > .presentation-template');
    if (!this.doc.head.querySelector('[data-canvas-style]')) {
      const style = this.doc.createElement('style');
      style.dataset.canvasStyle = 'theme';
      style.textContent =
        '.slide{padding:0!important}.slide-content,.slide-body{width:1280px!important;height:720px!important;padding:0!important;margin:0!important}.slide-body>.presentation-template,[data-theme-layer]{pointer-events:auto!important;z-index:1!important}.presentation-template [data-block-id]{pointer-events:auto!important}.presentation-template{user-select:auto!important}.slide-body [data-block-id]{cursor:pointer}';
      this.doc.head.append(style);
    }
    this.refreshBindings();
    this.fit();
  }
  context() {
    return {
      author: this.design.metadata?.author || 'Имя автора',
      brand: this.design.metadata?.brand || 'Название проекта',
      projectTitle: 'Пример презентации',
      slideTitle: 'Заголовок слайда',
      section: 'Раздел',
      slideNumber: '01',
      slideCount: '12',
    };
  }
  resolve(value) {
    const values = this.context();
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => values[key] ?? match);
  }
  withSource(action) {
    const restored = [];
    for (const binding of this.bindings) {
      if (binding.node.isConnected && binding.node.nodeValue === binding.display) {
        restored.push([binding.node, binding.display]);
        binding.node.nodeValue = binding.source;
      }
    }
    try {
      return action();
    } finally {
      for (const [node, value] of restored) if (node.isConnected) node.nodeValue = value;
    }
  }
  refreshBindings() {
    for (const binding of this.bindings) {
      if (binding.node.isConnected && binding.node.nodeValue === binding.display)
        binding.node.nodeValue = binding.source;
    }
    this.bindings = [];
    const walker = this.doc.createTreeWalker(this.root, this.doc.defaultView.NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (
        node.parentElement.closest('style,script') ||
        node.parentElement.isContentEditable ||
        !node.nodeValue.includes('{{')
      )
        continue;
      const source = node.nodeValue,
        display = this.resolve(source);
      this.bindings.push({ node, source, display });
      node.nodeValue = display;
    }
  }
  sourceHTML() {
    return this.withSource(() =>
      cleanSlideHTML(this.root).replace(/\bdata-theme-layer\b/g, 'data-template-layer'),
    );
  }
  properties() {
    const properties = super.properties();
    if (properties)
      properties.text = this.withSource(
        () => this.selected.innerText || this.selected.textContent || '',
      );
    return properties;
  }
  onDoubleClick(event) {
    const element = selectableBlock(event.target, this.root);
    if (element)
      for (const binding of this.bindings)
        if (element.contains(binding.node) && binding.node.nodeValue === binding.display)
          binding.node.nodeValue = binding.source;
    super.onDoubleClick(event);
  }
  changed() {
    this.updateSelection();
    this.callbacks.onChange(this.sourceHTML());
    this.refreshBindings();
  }
}
