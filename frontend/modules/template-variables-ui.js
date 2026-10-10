import { pageTimeout } from './page-lifecycle.js';
import { request } from './api.js';
import {
  templateVariables,
  resolveTemplate,
  themeTemplateSource,
} from '../../shared/presentation/design.js';

const globalFields = ['author', 'brand', 'projectTitle'];
const labels = {
  author: 'Автор',
  brand: 'Подпись / команда',
  projectTitle: 'Название презентации',
  slideTitle: 'Название слайда',
  section: 'Раздел',
  slideNumber: 'Номер слайда',
  slideCount: 'Всего слайдов',
};
export function templateVariableValues(project, slide) {
  const index = Math.max(
    0,
    project.slides.findIndex((item) => item.id === slide.id),
  );
  return Object.fromEntries(
    templateVariables.map((key) => [
      key,
      resolveTemplate('{{' + key + '}}', project, slide, index),
    ]),
  );
}
export function usedTemplateVariables(project) {
  if (!project.design)
    return { used: ['author', 'brand', 'section', 'slideNumber', 'slideCount'], unknown: [] };
  const names = [
    ...new Set(
      [...themeTemplateSource(project.design).html.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  return {
    used: templateVariables.filter((key) => names.includes(key)),
    unknown: names.filter((key) => !templateVariables.includes(key)),
  };
}

// Черновик переменных изменяет только метаданные, а не HTML слайда или библиотечную тему.
export class TemplateVariablesUI {
  constructor(options) {
    Object.assign(this, options);
    this.globals = {};
    this.slides = new Map();
    this.busy = false;
  }
  get dirty() {
    return this.busy || Object.keys(this.globals).length > 0 || this.slides.size > 0;
  }
  displaySlide(slide) {
    const changes = this.slides.get(slide.id)?.changes;
    return changes
      ? {
          ...slide,
          ...(changes.slideTitle !== undefined ? { title: changes.slideTitle } : {}),
          ...(changes.section !== undefined ? { section: changes.section } : {}),
        }
      : slide;
  }
  displayProject(project) {
    if (!this.dirty) return project;
    const draft = { ...project, slides: project.slides.map((slide) => this.displaySlide(slide)) };
    for (const key of ['author', 'brand'])
      if (this.globals[key] !== undefined) {
        draft[key] = this.globals[key];
        if (draft.design) {
          draft.design = structuredClone(draft.design);
          draft.design.metadata[key] = this.globals[key];
        }
      }
    if (this.globals.projectTitle !== undefined) draft.title = this.globals.projectTitle;
    return draft;
  }
  render(parent) {
    this.parent = parent;
    const project = this.getProject(),
      slide = this.getSlide(),
      catalog = usedTemplateVariables(project),
      values = templateVariableValues(this.displayProject(project), this.displaySlide(slide));
    parent.innerHTML =
      '<h2 class="property-heading">Переменные шаблона</h2><p class="field-hint">Значения подставляются в шаблон этой презентации. Тема в библиотеке остаётся прежней.</p><p class="template-variable-context"></p><form class="template-variable-form"><div class="template-variable-fields"></div><p class="template-variable-unknown field-hint"></p><p class="template-variable-status form-status" role="status"></p><div class="design-actions"><button type="button" class="template-variable-reset">Отменить</button><button type="submit" class="primary template-variable-save">Сохранить значения</button></div></form>';
    parent.querySelector('.template-variable-context').textContent =
      'Слайд ' + values.slideNumber + ' · ' + slide.title;
    const fields = parent.querySelector('.template-variable-fields');
    for (const key of catalog.used) {
      const label = document.createElement('label');
      label.className = 'block-label';
      label.textContent = labels[key];
      const hint = document.createElement('code');
      hint.textContent = '{{' + key + '}}';
      label.append(hint);
      if (['slideNumber', 'slideCount'].includes(key)) {
        const output = document.createElement('output');
        output.dataset.variable = key;
        output.textContent = values[key];
        label.append(output);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.variable = key;
        input.maxLength = 200;
        input.value = values[key];
        input.autocomplete = 'off';
        input.disabled = this.busy || this.isThemeDraft?.();
        input.addEventListener('input', () => this.change(key, input.value));
        label.append(input);
      }
      fields.append(label);
    }
    if (!catalog.used.length) fields.textContent = 'В этом шаблоне нет поддерживаемых переменных.';
    const unknown = parent.querySelector('.template-variable-unknown');
    unknown.hidden = !catalog.unknown.length;
    unknown.textContent = catalog.unknown.length
      ? 'Другие обозначения остаются в шаблоне без изменений: ' +
        catalog.unknown.map((key) => '{{' + key + '}}').join(', ')
      : '';
    parent.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.save().catch(() => {});
    });
    parent.querySelector('.template-variable-reset').addEventListener('click', () => this.cancel());
    this.updateState();
  }
  change(key, value) {
    const project = this.getProject(),
      slide = this.getSlide(),
      values = templateVariableValues(project, slide);
    if (globalFields.includes(key)) {
      this.globalBaseline ||= { values, design: JSON.stringify(project.design || null) };
      if (value === this.globalBaseline.values[key]) delete this.globals[key];
      else this.globals[key] = value;
      if (!Object.keys(this.globals).length) this.globalBaseline = null;
    } else {
      const draft = this.slides.get(slide.id) || { values, changes: {} };
      if (value === draft.values[key]) delete draft.changes[key];
      else draft.changes[key] = value;
      if (Object.keys(draft.changes).length) this.slides.set(slide.id, draft);
      else this.slides.delete(slide.id);
    }
    this.updateState();
    this.onDraftChange?.();
    clearTimeout(this.previewTimer);
    this.previewTimer = pageTimeout(
      () => this.onPreview?.().catch((error) => this.onError?.(error)),
      100,
    );
  }
  updateState() {
    if (!this.parent) return;
    const active = this.slides.get(this.getSlide().id),
      hasCurrent = Object.keys(this.globals).length || active;
    this.parent.querySelector('.template-variable-save').disabled =
      this.busy || !hasCurrent || this.isThemeDraft?.();
    this.parent.querySelector('.template-variable-reset').disabled = this.busy || !this.dirty;
    const state = this.parent.querySelector('.template-variable-status');
    state.classList.remove('error');
    state.textContent = this.isThemeDraft?.()
      ? 'Сначала примените тему или отмените её выбор.'
      : hasCurrent
        ? 'Предпросмотр. Сохраните значения или отмените правки.'
        : this.slides.size
          ? 'На другом слайде есть черновик переменных.'
          : 'Нумерация обновляется автоматически при перестановке слайдов.';
  }
  async cancel() {
    clearTimeout(this.previewTimer);
    this.globals = {};
    this.globalBaseline = null;
    this.slides.clear();
    this.render(this.parent);
    this.onDraftChange?.();
    await this.onPreview?.();
    document.dispatchEvent(new Event('presentations:variables-idle'));
  }
  async save() {
    if (this.busy) return;
    const slideId = this.getSlide().id,
      slideDraft = this.slides.get(slideId),
      values = { ...this.globals, ...slideDraft?.changes };
    if (!Object.keys(values).length) return;
    this.busy = true;
    this.updateState();
    const controls = [...this.parent.querySelectorAll('input,button')];
    controls.forEach((control) => (control.disabled = true));
    const state = this.parent.querySelector('.template-variable-status');
    state.textContent = 'Сохраняем значения…';
    try {
      await this.flush();
      const latest = await request(this.base),
        slide = latest.slides.find((item) => item.id === slideId);
      if (!slide) throw new Error('Слайд уже удалён. Черновик остаётся в панели.');
      const current = templateVariableValues(latest, slide);
      if (
        (this.globalBaseline &&
          (JSON.stringify(latest.design || null) !== this.globalBaseline.design ||
            Object.keys(this.globals).some(
              (key) => current[key] !== this.globalBaseline.values[key],
            ))) ||
        (slideDraft &&
          Object.keys(slideDraft.changes).some((key) => current[key] !== slideDraft.values[key]))
      )
        throw new Error(
          'Переменные изменили в другом окне или агентом. Ваш черновик остаётся в панели; отмените его, чтобы увидеть новые значения.',
        );
      const payload = {
        values,
        version: latest.version || 0,
        ...(slideDraft ? { slideId, slideVersion: slide.version || 0 } : {}),
      };
      const saved = await request(this.base + '/variables', { method: 'PATCH', body: payload });
      this.globals = {};
      this.globalBaseline = null;
      this.slides.delete(slideId);
      await this.onProject(saved, { slideId });
      this.busy = false;
      this.render(this.parent);
      this.onDraftChange?.();
      this.parent.querySelector('.template-variable-status').textContent = 'Значения сохранены.';
    } catch (error) {
      state.textContent = error.message;
      state.classList.add('error');
      this.onError?.(error);
      throw error;
    } finally {
      this.busy = false;
      controls.forEach((control) => (control.disabled = false));
      this.parent.querySelector('.template-variable-save').disabled =
        !Object.keys(this.globals).length && !this.slides.get(this.getSlide().id);
      document.dispatchEvent(new Event('presentations:variables-idle'));
    }
  }
}
