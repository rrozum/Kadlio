import { PageResizeObserver } from '../../modules/page-lifecycle.js';
import { request } from '../../modules/api.js';
import { slideDocument } from '../../engine/slide.js';
import { renderBlockPreset } from '../../../shared/addons/compositions/catalog.js';

// Композиция вставляется как HTML через тот же серверный путь CAS, что и ручная правка.
export class CompositionsUI {
  constructor({ base, getProject, getSlide, flush, onSlide, onProject, onError, onSelectTab }) {
    Object.assign(this, {
      base,
      getProject,
      getSlide,
      flush,
      onSlide,
      onProject,
      onError,
      onSelectTab,
    });
    this.previewObserver = new PageResizeObserver((entries) =>
      entries.forEach((entry) =>
        entry.target.style.setProperty('--preset-scale', entry.contentRect.width / 1280),
      ),
    );
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'blocks-dialog';
    this.dialog.className = 'app-dialog blocks-dialog';
    this.dialog.innerHTML =
      '<div class="dialog-heading"><h2>Готовые блоки</h2><button type="button" class="icon-button" aria-label="Закрыть">×</button></div><p>Выберите композицию. Текст и оформление можно менять прямо на слайде.</p><div class="preset-filters" role="group" aria-label="Категории блоков"></div><div class="preset-grid"></div><p class="form-status" role="status"></p>';
    document.body.append(this.dialog);
    this.dialog
      .querySelector('.dialog-heading button')
      .addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('click', (event) => {
      if (event.target !== this.dialog) return;
      const rect = this.dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        this.dialog.close();
    });
    document
      .getElementById('blocks-tool')
      .addEventListener('click', () => this.openCatalog().catch(onError));
  }
  async catalog() {
    if (!this.catalogData) this.catalogData = await request('/api/presets');
    return this.catalogData;
  }
  async openCatalog() {
    await this.catalog();
    this.category = 'all';
    this.renderCatalog();
    this.dialog.querySelector('.form-status').textContent = '';
    this.dialog.showModal();
  }
  renderCatalog() {
    const { blocks } = this.catalogData,
      filters = this.dialog.querySelector('.preset-filters');
    filters.replaceChildren();
    for (const category of ['all', ...new Set(blocks.map((item) => item.category))]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent =
        { all: 'Все блоки', text: 'Текст', layout: 'Композиции', data: 'Данные', media: 'Медиа' }[
          category
        ] || category;
      button.setAttribute('aria-pressed', String(category === this.category));
      button.addEventListener('click', () => {
        this.category = category;
        this.renderCatalog();
      });
      filters.append(button);
    }
    const grid = this.dialog.querySelector('.preset-grid');
    this.previewObserver.disconnect();
    grid.replaceChildren();
    for (const preset of blocks.filter(
      (item) => this.category === 'all' || item.category === this.category,
    )) {
      const card = document.createElement('article');
      card.className = 'preset-card';
      card.dataset.presetId = preset.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset-choice';
      button.setAttribute('aria-label', 'Вставить ' + preset.name);
      const viewport = document.createElement('div');
      viewport.className = 'preset-preview';
      const iframe = document.createElement('iframe');
      iframe.title = preset.name;
      iframe.tabIndex = -1;
      iframe.setAttribute('sandbox', 'allow-same-origin');
      const project = this.getProject(),
        slide = {
          id: 'preview-' + preset.id,
          title: preset.name,
          layout: '',
          section: '',
          body: renderBlockPreset(preset.id, {
            values: preset.defaults,
            blockId: 'preview-' + preset.id,
          }),
        };
      iframe.srcdoc = slideDocument(slide, { ...project, author: '', brand: '' });
      viewport.append(iframe);
      const title = document.createElement('strong');
      title.textContent = preset.name;
      const caption = document.createElement('span');
      caption.textContent = preset.description;
      button.append(viewport, title, caption);
      button.addEventListener('click', () => this.insertPreset(preset.id));
      card.append(button);
      const actions = document.createElement('div');
      actions.className = 'preset-actions';
      for (const [newSlide, label] of [
        [false, 'Вставить блок'],
        [true, 'На новый слайд'],
      ]) {
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = label;
        action.dataset.presetAction = newSlide ? 'new-slide' : 'insert';
        action.addEventListener('click', () => this.insertPreset(preset.id, newSlide));
        actions.append(action);
      }
      card.append(actions);
      grid.append(card);
      this.previewObserver.observe(viewport);
    }
  }
  async insertPreset(presetId, newSlide = false) {
    const state = this.dialog.querySelector('.form-status');
    state.classList.remove('error');
    state.textContent = 'Добавляем блок…';
    const controls = this.dialog.querySelectorAll('button');
    controls.forEach((button) => (button.disabled = true));
    try {
      await this.flush();
      const preset = this.catalogData.blocks.find((item) => item.id === presetId);
      const slide = newSlide
        ? await request(this.base + '/slides', {
            method: 'POST',
            body: { title: preset.name, body: '' },
          })
        : this.getSlide();
      const saved = await request(
        this.base + '/slides/' + encodeURIComponent(slide.id) + '/preset',
        { method: 'POST', body: { presetId, version: slide.version || 0 } },
      );
      if (newSlide) await this.onProject(await request(this.base), { slideId: saved.id });
      else await this.onSlide(saved);
      this.dialog.close();
      this.onSelectTab('properties');
    } catch (error) {
      state.classList.add('error');
      state.textContent =
        error.status === 409
          ? 'Слайд изменился в другом окне. Обновите его перед добавлением блока.'
          : error.message;
    } finally {
      controls.forEach((button) => (button.disabled = false));
    }
  }
}
