// Подсветка поверх textarea: HTML остаётся исходным текстом и не становится DOM страницы.
let runtime, javascriptRuntime;
async function sourceRuntime() {
  if (!runtime)
    runtime = (async () => {
      globalThis.Prism = { manual: true, disableWorkerMessageHandler: true };
      const prettier = await import('../../shared/vendor/prettier-3.9.9/standalone.js');
      const [html, postcss] = await Promise.all([
        import('../../shared/vendor/prettier-3.9.9/html.js'),
        import('../../shared/vendor/prettier-3.9.9/postcss.js'),
      ]);
      await import('../vendor/prismjs-1.30.0/core.js');
      await import('../vendor/prismjs-1.30.0/markup.js');
      await import('../vendor/prismjs-1.30.0/css.js');
      Prism.languages.insertBefore('markup', 'tag', {
        'template-variable': { pattern: /\{\{\s*\w+\s*\}\}/, alias: 'variable' },
      });
      return { prettier, plugins: [html.default, postcss.default], prism: globalThis.Prism };
    })();
  return runtime;
}
async function sourceJavaScriptRuntime() {
  if (!javascriptRuntime)
    javascriptRuntime = (async () => {
      const base = await sourceRuntime();
      const [babel, estree] = await Promise.all([
        import('../../shared/vendor/prettier-3.9.9/babel.js'),
        import('../../shared/vendor/prettier-3.9.9/estree.js'),
      ]);
      await import('../vendor/prismjs-1.30.0/clike.js');
      await import('../vendor/prismjs-1.30.0/javascript.js');
      return { ...base, plugins: [babel.default, estree.default] };
    })();
  return javascriptRuntime;
}

export class SourceEditor {
  constructor(textarea, { language = 'html' } = {}) {
    this.textarea = textarea;
    this.language = language;
    this.original = '';
    this.displayBaseline = '';
    this.revision = 0;
    const wrapper = document.createElement('div');
    wrapper.className = 'source-editor';
    wrapper.dataset.language = language;
    this.wrapper = wrapper;
    textarea.before(wrapper);
    const toolbar = document.createElement('div');
    toolbar.className = 'source-editor-toolbar';
    const label = document.createElement('span');
    label.textContent = language.toUpperCase();
    this.info = document.createElement('span');
    this.info.className = 'source-editor-info';
    this.info.setAttribute('aria-live', 'polite');
    const format = document.createElement('button');
    format.type = 'button';
    format.className = 'source-format';
    format.textContent = '{ } Форматировать';
    format.title = 'Отступы и переносы строк';
    format.addEventListener('click', () => this.format());
    toolbar.append(label, this.info, format);
    const surface = document.createElement('div');
    surface.className = 'source-editor-surface';
    this.highlight = document.createElement('pre');
    this.highlight.className = 'source-editor-highlight';
    this.highlight.setAttribute('aria-hidden', 'true');
    this.code = document.createElement('code');
    this.highlight.append(this.code);
    textarea.spellcheck = false;
    textarea.wrap = 'off';
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocomplete', 'off');
    surface.append(this.highlight, textarea);
    wrapper.append(toolbar, surface);
    textarea.addEventListener('input', () => {
      this.revision++;
      this.paint();
    });
    textarea.addEventListener('scroll', () => this.syncScroll());
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        const input = this.textarea;
        if (event.shiftKey) {
          const start = input.value.lastIndexOf('\n', Math.max(0, input.selectionStart - 1)) + 1;
          const spaces = /^ {1,2}/.exec(input.value.slice(start));
          if (spaces) input.setRangeText('', start, start + spaces[0].length, 'preserve');
        } else input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    this.paint();
  }
  get dirty() {
    return this.textarea.value !== this.displayBaseline;
  }
  getValue() {
    return this.dirty ? this.textarea.value : this.original;
  }
  async setValue(value) {
    this.original = String(value ?? '');
    this.textarea.value = this.original;
    this.displayBaseline = this.original;
    this.revision++;
    this.wrapper.dataset.ready = 'false';
    this.paint();
    if (!this.original.trim()) {
      this.wrapper.dataset.ready = 'true';
      return;
    }
    await this.format({ initial: true });
    this.wrapper.dataset.ready = 'true';
  }
  async format({ initial = false } = {}) {
    const revision = this.revision,
      value = this.textarea.value,
      wasDirty = this.dirty;
    this.info.textContent = 'Форматируем…';
    try {
      const javascript = this.language === 'javascript',
        { prettier, plugins } = await (javascript ? sourceJavaScriptRuntime() : sourceRuntime());
      // Сниппет хранит тело async-функции: await/return в этом контексте допустимы.
      const input = javascript ? 'async function sourceProgram() {\n' + value + '\n}' : value;
      let result = await prettier.format(input, {
        parser: javascript ? 'babel' : this.language,
        plugins,
        printWidth: 90,
        tabWidth: 2,
        htmlWhitespaceSensitivity: 'strict',
        singleAttributePerLine: this.language === 'html',
      });
      if (javascript)
        result = result
          .slice(result.indexOf('{') + 2, result.lastIndexOf('}'))
          .split('\n')
          .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
          .join('\n');
      if (this.revision !== revision || this.textarea.value !== value) return;
      this.textarea.value = result;
      if (initial || !wasDirty) this.displayBaseline = result;
      this.paint();
    } catch (error) {
      if (this.revision !== revision) return;
      this.paint();
      this.info.textContent = 'Проверьте синтаксис';
      this.info.title = error.message;
    }
  }
  paint() {
    const value = this.textarea.value;
    if (globalThis.Prism?.languages?.[this.language])
      this.code.innerHTML = Prism.highlight(
        value + (value.endsWith('\n') ? ' ' : ''),
        Prism.languages[this.language],
        this.language,
      );
    else this.code.textContent = value;
    this.info.textContent = value.split('\n').length + ' строк';
    this.info.title = '';
    this.syncScroll();
  }
  syncScroll() {
    this.code.style.transform =
      'translate(' + -this.textarea.scrollLeft + 'px, ' + -this.textarea.scrollTop + 'px)';
  }
}
