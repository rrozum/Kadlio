import { navigate } from './navigation.js';
import { request, escapeHTML } from './api.js';
import { mountThemePreview } from './theme-preview.js';
import { TemplateVariablesUI } from './template-variables-ui.js';

// Сервер проверяет дизайн и версии. Эта панель управляет черновиком общей
// темы и переменных; каталог композиций подключается отдельным дополнением.
export class PresentationDesignUI {
  constructor({ base, getProject, getSlide, flush, onProject, onError, onSelectTab, onPreview }) {
    Object.assign(this, {
      base,
      getProject,
      getSlide,
      flush,
      onProject,
      onError,
      onSelectTab,
      onPreview,
    });
    this.panel = document.getElementById('design-content');
    this.variables = new TemplateVariablesUI({
      base,
      getProject,
      getSlide,
      flush,
      onProject,
      onError,
      onPreview,
      isThemeDraft: () => this.themeDirty,
      onDraftChange: () => this.updateDesignActions(),
    });
    const shortcut = document.createElement('button');
    shortcut.type = 'button';
    shortcut.id = 'template-variables-button';
    shortcut.className = 'full-width';
    shortcut.textContent = 'Переменные шаблона';
    document.querySelector('.slide-html-control').append(shortcut);
    shortcut.addEventListener('click', () => this.openVariables().catch(onError));
    document
      .getElementById('design-tab')
      .addEventListener('click', () => this.openDesign().catch(onError));
    document
      .querySelector('[data-panel-target="design"]')
      .addEventListener('click', () => this.openDesign().catch(onError));
  }
  async openDesign() {
    this.themes = (await request('/api/themes')).themes;
    this.onSelectTab('design');
    if (!this.dirty) this.resetDraft();
    this.renderDesign();
  }
  resetDraft() {
    this.baseline = JSON.stringify(this.getProject().design || null);
    this.selectedThemeId = this.getProject().design?.themeId || null;
    this.previewDesign = undefined;
    this.themeDirty = false;
  }
  get dirty() {
    return !!this.themeDirty || this.variables.dirty;
  }
  displayProject(project) {
    return this.variables.displayProject(
      this.previewDesign === undefined ? project : { ...project, design: this.previewDesign },
    );
  }
  displaySlide(slide) {
    return this.variables.displaySlide(slide);
  }
  onSlideChange() {
    if (this.variables.parent?.isConnected) this.variables.render(this.variables.parent);
  }
  async openVariables() {
    await this.openDesign();
    const section = this.panel.querySelector('.template-variables');
    section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    section.querySelector('input')?.focus();
  }
  sync() {
    if (this.themes && !this.dirty) {
      this.resetDraft();
      this.renderDesign();
    }
  }
  renderDesign() {
    (this.themePreviews || []).forEach((dispose) => dispose());
    this.themePreviews = [];
    this.panel.innerHTML =
      '<h2 class="property-heading">Тема презентации</h2><p class="design-intro">Выберите тему — результат сразу появится на слайдах. Применение сохранит её ко всей презентации.</p><div class="theme-picker theme-project-choices"></div><p class="theme-project-status" role="status"></p><div class="design-actions"><button type="button" id="design-reset">Отменить</button><button type="button" class="primary" id="design-apply">Применить</button></div><div class="theme-project-actions"><button type="button" id="design-edit-copy">Редактировать копию темы</button><a class="button quiet" href="/themes">Библиотека тем ↗</a></div>';
    const choices = this.panel.querySelector('.theme-project-choices');
    for (const theme of [{ id: null, title: 'Исходное оформление' }, ...this.themes]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.themeId = theme.id || 'original';
      button.setAttribute('aria-pressed', String(theme.id === this.selectedThemeId));
      if (theme.design) {
        const preview = document.createElement('div');
        preview.className = 'theme-preview';
        button.append(preview);
        this.themePreviews.push(mountThemePreview(preview, theme));
      }
      const name = document.createElement('strong');
      name.textContent = theme.title;
      button.append(name);
      button.addEventListener('click', async () => {
        try {
          if (this.variables.dirty)
            throw new Error('Сначала сохраните переменные шаблона или отмените их правки.');
          await this.flush();
          this.selectedThemeId = theme.id;
          this.previewDesign = theme.design ? structuredClone(theme.design) : null;
          this.themeDirty = JSON.stringify(this.previewDesign) !== this.baseline;
          this.renderDesign();
          await this.onPreview?.();
        } catch (error) {
          this.onError(error);
        }
      });
      choices.append(button);
    }
    this.panel.querySelector('#design-apply').disabled = !this.themeDirty;
    this.panel.querySelector('.theme-project-status').textContent = this.themeDirty
      ? 'Предпросмотр. Примените тему или отмените выбор.'
      : 'Тема сохранена в презентации.';
    this.panel.querySelector('#design-reset').addEventListener('click', async () => {
      this.resetDraft();
      this.renderDesign();
      await this.onPreview?.();
    });
    this.panel.querySelector('#design-apply').addEventListener('click', () => this.saveDesign());
    this.panel.querySelector('#design-edit-copy').addEventListener('click', () => this.editCopy());
    const variables = document.createElement('section');
    variables.className = 'template-variables';
    this.panel.prepend(variables);
    this.variables.render(variables);
    this.updateDesignActions();
  }
  updateDesignActions() {
    for (const button of this.panel.querySelectorAll(
      '.theme-project-choices button,#design-edit-copy',
    ))
      button.disabled = this.variables.dirty;
  }
  async editCopy() {
    const button = this.panel.querySelector('#design-edit-copy');
    button.disabled = true;
    try {
      await this.flush();
      const project = this.getProject();
      const result = await request('/api/themes', {
        method: 'POST',
        body: {
          title: project.title + ' — тема',
          ...(this.themeDirty && this.selectedThemeId
            ? { baseThemeId: this.selectedThemeId }
            : { projectId: project.id }),
        },
      });
      this.themeDirty = false;
      navigate('/themes/' + encodeURIComponent(result.id));
    } catch (error) {
      this.onError(error);
      button.disabled = false;
    }
  }
  async saveDesign() {
    const controls = this.panel.querySelectorAll('button');
    controls.forEach((button) => (button.disabled = true));
    const state = this.panel.querySelector('.theme-project-status');
    state.textContent = 'Применяем тему…';
    try {
      await this.flush();
      const latest = await request(this.base);
      if (JSON.stringify(latest.design || null) !== this.baseline)
        throw Object.assign(
          new Error(
            'Тему презентации изменили в другом окне. Ваш выбор остался в предпросмотре; обновите страницу для согласования.',
          ),
          { status: 409 },
        );
      const snapshot = this.selectedThemeId
        ? await request(this.base + '/theme', {
            method: 'POST',
            body: { themeId: this.selectedThemeId, version: latest.version || 0 },
          })
        : await request(this.base + '/design', {
            method: 'PATCH',
            body: { design: null, version: latest.version || 0 },
          });
      this.previewDesign = undefined;
      this.themeDirty = false;
      await this.onProject(snapshot);
      this.resetDraft();
      this.renderDesign();
    } catch (error) {
      state.textContent = error.message;
      state.classList.add('error');
    } finally {
      controls.forEach((button) => (button.disabled = false));
    }
  }
}
