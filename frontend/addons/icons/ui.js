export class IconLibraryUI {
  constructor({ parent, getCanvas, onInsert, onError }) {
    Object.assign(this, { parent, getCanvas, onInsert, onError });
    this.page = 0;
    parent.innerHTML =
      '<div class="property-heading"><strong>SVG-иконки</strong></div><p class="field-hint">Нажмите на иконку, затем переместите её на слайде. Цвет и размер меняются в свойствах.</p><label class="block-label" for="icon-search">Поиск<input id="icon-search" type="search" placeholder="Сердце, облако, arrow…" autocomplete="off"></label><p class="icon-library-status field-hint" role="status"></p><div class="presentation-icon-grid"></div><div class="icon-library-pages"><button type="button" class="icon-library-prev" disabled>← Назад</button><button type="button" class="icon-library-next">Далее →</button></div>';
    this.input = parent.querySelector('#icon-search');
    this.grid = parent.querySelector('.presentation-icon-grid');
    this.status = parent.querySelector('.icon-library-status');
    this.input.addEventListener('input', () => {
      this.page = 0;
      this.render();
    });
    parent.querySelector('.icon-library-prev').addEventListener('click', () => {
      this.page--;
      this.render();
    });
    parent.querySelector('.icon-library-next').addEventListener('click', () => {
      this.page++;
      this.render();
    });
  }
  async open() {
    if (this.catalog) return;
    if (this.loading) return this.loading;
    this.status.textContent = 'Загружаем иконки…';
    this.loading = import('../../../shared/addons/icons/catalog.js')
      .then((catalog) => {
        this.catalog = catalog;
        this.render();
      })
      .catch((error) => {
        this.status.textContent = 'Не удалось загрузить иконки. Откройте панель ещё раз.';
        this.onError?.(error);
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }
  render() {
    if (!this.catalog) return;
    const { searchPresentationIcons, renderPresentationIcon } = this.catalog,
      offset = this.page * 80,
      items = searchPresentationIcons(this.input.value, { offset, limit: 81 });
    this.grid.replaceChildren();
    for (const item of items.slice(0, 80)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'presentation-icon-choice';
      button.dataset.iconId = item.id;
      button.title = item.name + ' · ' + item.id;
      button.setAttribute('aria-label', 'Добавить иконку ' + item.name);
      button.innerHTML = renderPresentationIcon(item.id, {
        blockId: 'preview-' + item.id,
        color: '#89949c',
        x: 0,
        y: 0,
        width: 24,
        height: 24,
      });
      const svg = button.firstElementChild;
      svg.removeAttribute('style');
      svg.setAttribute('aria-hidden', 'true');
      svg.removeAttribute('role');
      const name = document.createElement('span');
      name.textContent = item.name;
      button.append(name);
      button.addEventListener('click', () => this.insert(item));
      this.grid.append(button);
    }
    this.parent.querySelector('.icon-library-prev').disabled = this.page === 0;
    this.parent.querySelector('.icon-library-next').disabled = items.length <= 80;
    this.status.textContent = items.length
      ? 'Показаны ' +
        (offset + 1) +
        '–' +
        (offset + Math.min(80, items.length)) +
        (this.input.value.trim() ? '' : ' из ' + this.catalog.presentationIcons.length)
      : 'Ничего не найдено. Попробуйте другое слово.';
  }
  insert(item) {
    try {
      const canvas = this.getCanvas();
      if (!canvas.root) throw new Error('Слайд ещё загружается.');
      const template = canvas.doc.createElement('template');
      template.innerHTML = this.catalog.renderPresentationIcon(item.id, { x: 592, y: 312 });
      canvas.insert(template.content.firstElementChild);
      this.onInsert?.();
    } catch (error) {
      this.onError?.(error);
    }
  }
}
