import { request } from './api.js';
export class ShareSettings {
  constructor({ dialog, getId }) {
    Object.assign(this, { dialog, getId });
    this.epoch = 0;
    const introduction = dialog.querySelector(':scope > p');
    if (introduction && !introduction.classList.contains('form-status'))
      introduction.textContent =
        'По ссылке можно смотреть слайды без входа в аккаунт. Выберите дополнительные возможности.';
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'share-options';
    fieldset.innerHTML =
      '<legend>Что доступно по ссылке</legend><label><input type="checkbox" data-share-option="comments"> Комментарии для автора</label><label><input type="checkbox" data-share-option="notes"> Читать речь спикера</label><p class="field-hint">Комментарии гостей попадут к агенту только после вашего решения.</p><p class="form-status" role="status" data-share-options-status></p>';
    this.root = fieldset;
    dialog.querySelector('.form-status').before(fieldset);
    this.status = fieldset.querySelector('[data-share-options-status]');
    this.controls = [...fieldset.querySelectorAll('input')];
    fieldset.addEventListener('change', () => this.save());
    dialog.addEventListener('toggle', (event) => {
      if (event.newState === 'open') this.load();
      else this.epoch++;
    });
  }
  busy(value) {
    for (const control of this.controls) control.disabled = value;
  }
  fill(value) {
    for (const control of this.controls)
      control.checked = value?.[control.dataset.shareOption] === true;
  }
  async load() {
    const id = this.getId(),
      epoch = ++this.epoch;
    if (!id) return;
    this.busy(true);
    this.status.textContent = '';
    try {
      const current = await request('/api/projects/' + id);
      if (this.epoch !== epoch) return;
      this.fill(current.shareOptions);
      this.status.textContent = 'Настройки сохраняются сразу.';
    } catch (error) {
      if (this.epoch === epoch) this.status.textContent = error.message;
    } finally {
      if (this.epoch === epoch) this.busy(false);
    }
  }
  async save() {
    const id = this.getId(),
      epoch = this.epoch;
    if (!id) return;
    const settings = Object.fromEntries(
      this.controls.map((input) => [input.dataset.shareOption, input.checked]),
    );
    this.busy(true);
    this.status.textContent = 'Сохраняем…';
    try {
      const current = await request('/api/projects/' + id);
      const saved = await request('/api/projects/' + id + '/share', {
        method: 'PATCH',
        body: { ...settings, version: current.version },
      });
      if (this.epoch === epoch) {
        this.fill(saved);
        this.status.textContent = 'Сохранено';
      }
    } catch (error) {
      if (this.epoch === epoch) this.status.textContent = error.message;
    } finally {
      if (this.epoch === epoch) this.busy(false);
    }
  }
}

export class GuestFeedbackUI {
  constructor({ parent, getId, onApproved = () => {} }) {
    Object.assign(this, { getId, onApproved });
    this.epoch = 0;
    this.root = document.createElement('section');
    this.root.className = 'guest-feedback';
    this.root.innerHTML =
      '<div class="property-heading"><strong>Комментарии по ссылке</strong><button type="button" data-feedback-refresh class="text-button">Обновить</button></div><p class="field-hint">Выберите комментарий и передайте его в чат. До этого агент его не видит.</p><div data-feedback-list></div><p class="form-status" data-feedback-status role="status"></p>';
    parent.append(this.root);
    this.list = this.root.querySelector('[data-feedback-list]');
    this.status = this.root.querySelector('[data-feedback-status]');
    this.root.querySelector('[data-feedback-refresh]').addEventListener('click', () => this.load());
    document.getElementById('comments-tab').addEventListener('click', () => this.load());
    document
      .querySelector('[data-panel-target="comments"]')
      ?.addEventListener('click', () => this.load());
  }
  async load() {
    const id = this.getId(),
      epoch = ++this.epoch;
    if (!id) return;
    this.status.textContent = 'Загружаем…';
    try {
      const { feedback } = await request('/api/projects/' + id + '/feedback');
      if (epoch !== this.epoch) return;
      this.list.replaceChildren();
      for (const item of feedback) {
        const card = document.createElement('article');
        card.className = 'guest-feedback-item';
        const heading = document.createElement('strong'),
          text = document.createElement('p'),
          button = document.createElement('button');
        heading.textContent =
          (item.name || 'Гость') + ' · ' + item.slideId.replace('slide-', 'Слайд ');
        text.textContent = item.comment;
        button.type = 'button';
        button.dataset.feedbackId = item.id;
        button.textContent = item.status === 'approved' ? 'В чате агента' : 'Передать в чат';
        button.disabled = item.status === 'approved';
        button.addEventListener('click', () => this.approve(id, item, button));
        card.append(heading, text, button);
        this.list.append(card);
      }
      this.status.textContent = feedback.length ? '' : 'Пока нет комментариев от гостей.';
    } catch (error) {
      if (epoch === this.epoch) this.status.textContent = error.message;
    }
  }
  async approve(id, item, button) {
    button.disabled = true;
    this.status.textContent = 'Добавляем в чат…';
    try {
      const result = await request('/api/projects/' + id + '/feedback/' + item.id + '/approve', {
        method: 'POST',
        body: {},
      });
      button.textContent = 'В чате агента';
      this.status.textContent =
        'Комментарий добавлен в чат. Отправьте запрос агенту, когда будете готовы.';
      await this.onApproved(result);
    } catch (error) {
      button.disabled = false;
      this.status.textContent = error.message;
    }
  }
}
