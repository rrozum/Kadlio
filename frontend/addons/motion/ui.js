import { PageResizeObserver } from '../../modules/page-lifecycle.js';
import {
  effectPresets,
  playSlideEffect,
  stopSlideEffects,
} from '../../../shared/addons/motion/runtime.js';
import { slideDocument } from '../../engine/slide.js';
import { request } from '../../modules/api.js';
import { SourceEditor } from '../../modules/source-editor.js';
import { playRuntime, stopRuntime } from '../../../shared/addons/motion/player.js';

export class EffectsUI {
  constructor({
    button,
    getProject,
    getSlide,
    getGap,
    getTransition,
    onApply,
    onCopy,
    onRemove,
    onError,
    onEditSnippet,
  }) {
    Object.assign(this, {
      getProject,
      getSlide,
      getGap,
      getTransition,
      onApply,
      onCopy,
      onRemove,
      onError,
      onEditSnippet,
    });
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'effects-dialog';
    this.dialog.className = 'app-dialog effects-dialog';
    this.dialog.innerHTML =
      '<div class="dialog-heading"><h2>Красивое переключение</h2><button type="button" class="icon-button" aria-label="Закрыть">×</button></div><p class="effects-intro">Переход — отдельная карточка между двумя слайдами. Нажмите вариант, чтобы увидеть его.</p><div class="effects-workspace"><div class="effects-preview"><iframe title="Предпросмотр эффекта" sandbox="allow-same-origin"></iframe></div><div class="effects-options"></div></div><label class="effects-gap-label">Место перехода<select id="effect-gap"></select></label><div class="effects-controls"><label>Темп<select id="effect-duration"><option value="400">Быстрый</option><option value="650" selected>Плавный</option><option value="1100">Неспешный</option></select></label><button type="button" id="effect-replay">Повторить</button><button type="button" id="effect-apply" class="primary">Сохранить переход</button></div><div class="effects-placement"><label>Копия в свободный промежуток<select id="effect-copy-gap"></select></label><button type="button" id="effect-copy">Копировать</button><button type="button" id="effect-delete" class="danger">Удалить переход</button></div><p class="form-status" role="status"></p><p class="effects-note">В режиме показа эффект запускается сам. PDF остаётся статичным; PPTX получает ближайший стандартный переход.</p>';
    document.body.append(this.dialog);
    this.iframe = this.dialog.querySelector('iframe');
    const custom = document.createElement('details');
    custom.className = 'transition-custom-js';
    custom.innerHTML =
      '<summary>Собственный JS-переход</summary><p class="field-hint">Эффект получает element = весь слайд, slide, params, signal и onCleanup. PDF и PPTX сохранят статичный вид.</p><label class="block-label">JS из библиотеки<select id="effect-snippet"><option value="">Без собственного JS</option></select></label><div id="effect-custom-fields" hidden><textarea id="effect-custom-code" aria-label="JavaScript перехода" maxlength="50000"></textarea><label class="block-label">Параметры · JSON<textarea id="effect-custom-params" rows="3" spellcheck="false"></textarea></label></div><div class="authoring-actions"><button type="button" id="effect-snippet-library">Создать или изменить в библиотеке</button><button type="button" id="effect-custom-preview">Сохранить и проверить</button></div>';
    this.dialog.querySelector('.effects-placement').after(custom);
    this.customSource = new SourceEditor(custom.querySelector('#effect-custom-code'), {
      language: 'javascript',
    });
    this.customSelect = custom.querySelector('#effect-snippet');
    this.customParams = custom.querySelector('#effect-custom-params');
    this.customSelect.addEventListener('change', () => {
      const snippet = this.snippets?.find((item) => item.id === this.customSelect.value);
      this.dialog.querySelector('#effect-custom-fields').hidden = !snippet;
      this.stopCustom();
      if (snippet) {
        this.customSource.setValue(snippet.code);
        this.customParams.value = JSON.stringify(snippet.defaults || {}, null, 2);
      } else this.play();
    });
    custom.querySelector('#effect-snippet-library').addEventListener('click', () => {
      const snippetId = this.customSelect.value || undefined,
        code = snippetId ? this.customSource.getValue() : undefined;
      let defaults;
      try {
        defaults = snippetId ? this.customOptions() : undefined;
      } catch (error) {
        this.onError?.(error);
        return;
      }
      this.dialog.close();
      this.onEditSnippet?.({ snippetId, code, defaults, libraryOnly: true });
    });
    custom
      .querySelector('#effect-custom-preview')
      .addEventListener('click', () => this.saveCustomPreview());
    this.observer = new PageResizeObserver((entries) =>
      entries.forEach((entry) =>
        entry.target.style.setProperty('--effect-scale', entry.contentRect.width / 1280),
      ),
    );
    this.observer.observe(this.dialog.querySelector('.effects-preview'));
    this.dialog
      .querySelector('.dialog-heading button')
      .addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => {
      this.generation = (this.generation || 0) + 1;
      if (this.stage) stopSlideEffects(this.stage);
      this.stopCustom();
      document.dispatchEvent(new Event('presentations:authoring-idle'));
    });
    this.dialog.querySelector('#effect-replay').addEventListener('click', () => this.play());
    this.dialog.querySelector('#effect-duration').addEventListener('change', () => {
      this.duration = Number(this.dialog.querySelector('#effect-duration').value);
      this.play();
    });
    this.dialog.querySelector('#effect-apply').addEventListener('click', () => this.apply());
    this.dialog
      .querySelector('#effect-gap')
      .addEventListener('change', () =>
        this.open({ gapIndex: Number(this.dialog.querySelector('#effect-gap').value) }).catch(
          (error) => onError?.(error),
        ),
      );
    this.dialog
      .querySelector('#effect-copy')
      .addEventListener('click', () =>
        this.perform(() =>
          this.onCopy(this.gapIndex, Number(this.dialog.querySelector('#effect-copy-gap').value)),
        ),
      );
    this.dialog
      .querySelector('#effect-delete')
      .addEventListener('click', () => this.perform(() => this.onRemove(this.gapIndex)));
    const options = this.dialog.querySelector('.effects-options');
    for (const effect of effectPresets) {
      const control = document.createElement('button');
      control.type = 'button';
      control.dataset.effectId = effect.id;
      const name = document.createElement('strong');
      name.textContent = effect.name;
      const description = document.createElement('span');
      description.textContent = effect.description;
      control.append(name, description);
      control.addEventListener('click', () => {
        this.preset = effect.id;
        this.update();
        this.play();
      });
      options.append(control);
    }
    button?.addEventListener('click', () => this.open().catch((error) => onError?.(error)));
  }
  update() {
    for (const button of this.dialog.querySelectorAll('[data-effect-id]'))
      button.setAttribute('aria-pressed', String(button.dataset.effectId === this.preset));
  }
  get hasDraft() {
    if (!this.dialog.open) return false;
    try {
      return JSON.stringify(this.customValue()) !== this.customBaseline;
    } catch {
      return true;
    }
  }
  async open({ gapIndex = this.getGap?.() || 0 } = {}) {
    const project = this.getProject();
    if (project.slides.length < 2)
      throw new Error('Добавьте второй слайд, чтобы вставить переход.');
    this.gapIndex = Math.min(Math.max(0, gapIndex), project.slides.length - 2);
    const gapSelect = this.dialog.querySelector('#effect-gap'),
      copySelect = this.dialog.querySelector('#effect-copy-gap');
    gapSelect.replaceChildren();
    copySelect.replaceChildren();
    for (let index = 0; index < project.slides.length - 1; index++) {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = index + 1 + ' → ' + (index + 2) + ' · ' + project.slides[index].title;
      gapSelect.append(option);
      if (index !== this.gapIndex && !this.getTransition(index))
        copySelect.append(option.cloneNode(true));
    }
    gapSelect.value = this.gapIndex;
    this.dialog.querySelector('#effect-copy').disabled =
      !copySelect.options.length || !this.getTransition(this.gapIndex);
    this.dialog.querySelector('#effect-delete').disabled = !this.getTransition(this.gapIndex);
    const generation = (this.generation = (this.generation || 0) + 1);
    const slide = project.slides[this.gapIndex + 1],
      transition = this.getTransition(this.gapIndex);
    this.preset = transition?.preset || 'fade';
    this.duration = transition?.duration || 650;
    const source = slideDocument(slide, this.getProject());
    const snippets = (await request('/api/effect-snippets')).snippets;
    if (generation !== this.generation) return;
    this.snippets = snippets;
    this.customSelect.replaceChildren(new Option('Без собственного JS', ''));
    for (const snippet of this.snippets)
      this.customSelect.add(new Option(snippet.name, snippet.id));
    if (
      transition?.snippet &&
      !this.snippets.some((item) => item.id === transition.snippet.snippetId)
    )
      this.customSelect.add(new Option('Сохранённый JS', transition.snippet.snippetId));
    this.customSelect.value = transition?.snippet?.snippetId || '';
    await this.customSource.setValue(transition?.snippet?.code || '');
    if (generation !== this.generation) return;
    this.customParams.value = JSON.stringify(transition?.snippet?.options || {}, null, 2);
    this.customBaseline = JSON.stringify(transition?.snippet || null);
    this.dialog.querySelector('#effect-custom-fields').hidden = !transition?.snippet;
    this.dialog.querySelector('.transition-custom-js').open = !!transition?.snippet;
    this.dialog.querySelector('#effect-duration').value = String(
      [400, 650, 1100].includes(this.duration) ? this.duration : 650,
    );
    this.dialog.querySelector('.form-status').textContent = '';
    this.update();
    if (!this.dialog.open) this.dialog.showModal();
    if (
      source !== this.source ||
      !this.stage?.isConnected ||
      this.stage.ownerDocument !== this.iframe.contentDocument
    ) {
      this.iframe.style.visibility = 'hidden';
      if (this.stage) stopSlideEffects(this.stage);
      await new Promise((resolve) => {
        this.iframe.addEventListener('load', resolve, { once: true });
        this.iframe.srcdoc = source;
      });
      if (generation !== this.generation || !this.dialog.open) return;
      this.stage = this.iframe.contentDocument.querySelector('.slide');
      await this.iframe.contentDocument.fonts.ready;
      if (generation !== this.generation || !this.dialog.open) return;
      this.source = source;
    }
    this.play();
    this.iframe.style.visibility = '';
  }
  play() {
    try {
      if (this.customSelect.value) {
        const saved = this.getTransition(this.gapIndex);
        if (
          !saved?.snippet ||
          JSON.stringify(this.customValue()) !== JSON.stringify(saved.snippet)
        ) {
          this.dialog.querySelector('.form-status').textContent =
            'Сохраните JS-переход, чтобы проверить его.';
          return;
        }
        this.playCustom(saved);
        return;
      }
      this.stopCustom();
      if (this.stage)
        playSlideEffect(
          this.stage,
          { preset: this.preset, duration: this.duration },
          { force: true },
        ).catch((error) => this.onError?.(error));
    } catch (error) {
      this.dialog.querySelector('.form-status').textContent =
        'Проверьте параметры JSON: ' + error.message;
      this.onError?.(error);
    }
  }
  customOptions() {
    const value = JSON.parse(this.customParams.value || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Параметры перехода должны быть JSON-объектом.');
    return value;
  }
  customValue() {
    return this.customSelect.value
      ? {
          snippetId: this.customSelect.value,
          code: this.customSource.getValue(),
          options: this.customOptions(),
        }
      : null;
  }
  value() {
    const snippet = this.customValue();
    return {
      preset: snippet && this.preset === 'none' ? 'fade' : this.preset,
      duration: this.duration,
      ...(snippet ? { snippet } : {}),
    };
  }
  stopCustom() {
    stopRuntime(this.dialog.querySelector('.effects-preview'));
    this.iframe.hidden = false;
  }
  playCustom(transition) {
    this.iframe.hidden = true;
    const project = this.getProject(),
      slide = project.slides[this.gapIndex + 1];
    playRuntime(this.dialog.querySelector('.effects-preview'), {
      url:
        '/api/projects/' +
        project.id +
        '/slides/' +
        slide.id +
        '/runtime?transitionId=' +
        transition.id,
      sceneId: slide.id,
      onError: (message) => {
        this.dialog.querySelector('.form-status').textContent = message;
      },
    });
  }
  async saveCustomPreview() {
    const button = this.dialog.querySelector('#effect-custom-preview');
    button.disabled = true;
    try {
      await this.onApply(this.value(), this.gapIndex);
      const transition = this.getTransition(this.gapIndex);
      this.customBaseline = JSON.stringify(transition?.snippet || null);
      if (transition?.snippet) this.playCustom(transition);
      else this.play();
      this.dialog.querySelector('.form-status').textContent =
        'Переход сохранён. Предпросмотр запущен.';
    } catch (error) {
      this.dialog.querySelector('.form-status').textContent = error.message;
      this.onError?.(error);
    } finally {
      button.disabled = false;
    }
  }
  async perform(action) {
    const status = this.dialog.querySelector('.form-status'),
      buttons = [...this.dialog.querySelectorAll('#effect-apply,#effect-copy,#effect-delete')];
    buttons.forEach((button) => (button.disabled = true));
    try {
      await action();
      this.dialog.close();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
      this.onError?.(error);
    } finally {
      buttons.forEach((button) => (button.disabled = false));
      this.dialog.querySelector('#effect-copy').disabled =
        !this.dialog.querySelector('#effect-copy-gap').options.length ||
        !this.getTransition(this.gapIndex);
      this.dialog.querySelector('#effect-delete').disabled = !this.getTransition(this.gapIndex);
    }
  }
  async apply() {
    const control = this.dialog.querySelector('#effect-apply'),
      status = this.dialog.querySelector('.form-status');
    control.disabled = true;
    status.classList.remove('error');
    status.textContent = 'Сохраняем эффект…';
    try {
      await this.onApply(this.value(), this.gapIndex);
      status.textContent = 'Переход сохранён.';
      this.dialog.close();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
      this.onError?.(error);
    } finally {
      control.disabled = false;
    }
  }
}
