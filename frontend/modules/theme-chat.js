import { finishChatLoading } from './chat-loading.js';
import { pageInterval, onPageCleanup, pageScope } from './page-lifecycle.js';
import { request } from './api.js';
import { ChatAttachments, renderMessageAttachments } from './chat-attachments.js';
import { mountDictation } from './dictation.js';
import { icon } from './icons.js';

const duration = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? seconds + ' сек.'
    : Math.floor(seconds / 60) + ' мин. ' + (seconds % 60) + ' сек.';
};

// Чат темы использует общие настройки провайдеров, вложения и поток сообщений.
// История и инструменты изолированы в пределах одной темы.
export class ThemeChat {
  constructor({ getTheme, prepare, onSaved, onError, onBusy = () => {} }) {
    const view = pageScope()?.document || document;
    this.view = view;
    this.$ = (id) => view.getElementById(id);
    Object.assign(this, { getTheme, prepare, onSaved, onError, onBusy });
    onPageCleanup(() => this.abort?.abort());
    this.busy = false;
    this.settings = {};
    this.id = null;
    this.refreshTask = null;
    this.$('theme-chat-toggle').innerHTML = icon('comment');
    this.$('theme-chat-toggle').setAttribute(
      'aria-pressed',
      String(!matchMedia('(max-width:950px)').matches),
    );
    const prepareFiles = async (files) => {
      try {
        await this.prepare();
        await this.sync();
        this.attachments.add(files);
      } catch (error) {
        this.onError(error);
      }
    };
    this.$('chat-attach').addEventListener(
      'click',
      (event) => {
        if (!this.getTheme().builtin) return;
        event.stopImmediatePropagation();
        this.prepare()
          .then(() => this.sync())
          .then(() => this.$('chat-file-input').click())
          .catch(onError);
      },
      true,
    );
    this.$('chat-file-input').addEventListener(
      'change',
      (event) => {
        if (!this.getTheme().builtin) return;
        event.stopImmediatePropagation();
        const files = [...event.target.files];
        event.target.value = '';
        prepareFiles(files);
      },
      true,
    );
    this.$('chat-input').addEventListener(
      'paste',
      (event) => {
        if (!this.getTheme().builtin) return;
        const files = [...event.clipboardData.items]
          .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter(Boolean);
        if (files.length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          prepareFiles(files);
        }
      },
      true,
    );
    this.attachments = new ChatAttachments({
      base: this.base,
      button: this.$('chat-attach'),
      input: this.$('chat-file-input'),
      list: this.$('chat-attachments'),
      status: this.$('chat-attachment-status'),
      pasteTarget: this.$('chat-input'),
      onChange: () => {
        this.$('chat-send').disabled = this.busy || this.attachments?.blocked;
      },
    });
    this.dictation = mountDictation({
      button: this.$('dictation-button'),
      input: this.$('chat-input'),
      status: this.$('dictation-status'),
      onError,
    });
    this.$('chat-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.send().catch(onError);
    });
    this.$('chat-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.$('chat-form').requestSubmit();
      }
    });
    this.$('chat-stop').addEventListener('click', () => {
      this.abort?.abort();
      request((this.activeBase || this.base) + '/chat/cancel', { method: 'POST' }).catch(onError);
    });
    this.$('chat-reset').addEventListener('click', async () => {
      if (!confirm('Начать новый разговор о теме? История чата будет очищена.')) return;
      try {
        await request(this.base + '/chat', { method: 'DELETE' });
        await this.loadHistory();
      } catch (error) {
        onError(error);
      }
    });
    this.$('theme-chat-toggle').addEventListener('click', () => {
      const mobile = matchMedia('(max-width:950px)').matches;
      if (mobile) this.$('chat-panel').classList.toggle('mobile-open');
      else document.body.classList.toggle('theme-chat-hidden');
      this.$('theme-chat-toggle').setAttribute(
        'aria-pressed',
        String(
          mobile
            ? this.$('chat-panel').classList.contains('mobile-open')
            : !document.body.classList.contains('theme-chat-hidden'),
        ),
      );
    });
    for (const button of document.querySelectorAll('[data-prompt]'))
      button.addEventListener('click', () => {
        this.$('chat-input').value = button.dataset.prompt;
        this.$('chat-input').focus();
      });
    this.$('ai-settings-button').addEventListener('click', () =>
      this.openSettings().catch(onError),
    );
    this.$('connect-ai').addEventListener('click', () => this.openSettings().catch(onError));
    this.$('ai-provider').addEventListener('change', () => this.providerFields());
    this.$('ai-settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try {
        const value = {
          provider: this.$('ai-provider').value,
          baseUrl: this.$('ai-base-url').value.trim(),
          apiMode: this.$('ai-api-mode').value,
          model: this.$('ai-model').value.trim(),
        };
        if (this.$('ai-api-key').value.trim()) value.apiKey = this.$('ai-api-key').value.trim();
        this.settings = await request('/api/ai/settings', { method: 'PUT', body: value });
        this.renderSettings();
        this.$('ai-api-key').value = '';
        this.$('settings-dialog').close();
      } catch (error) {
        this.$('settings-status').textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    for (const button of this.$('settings-dialog').querySelectorAll('[data-close]'))
      button.addEventListener('click', () => this.$('settings-dialog').close());
  }
  get base() {
    return '/api/themes/' + encodeURIComponent(this.getTheme().id);
  }
  get configured() {
    return this.settings.provider === 'acp'
      ? this.settings.acpAvailable
      : this.settings.hasApiKey && this.settings.model;
  }
  async init() {
    try {
      this.settings = await request('/api/ai/settings');
      await this.sync();
      this.renderSettings();
    } catch (error) {
      finishChatLoading(this.view, error);
      throw error;
    }
  }
  async sync() {
    const id = this.getTheme().id;
    if (this.id === id) return this.syncTask;
    this.id = id;
    this.attachments.clear();
    this.attachments.base = this.base;
    const task = this.loadHistory()
      .then(() => this.renderSettings())
      .finally(() => {
        if (this.syncTask === task) this.syncTask = null;
      });
    this.syncTask = task;
    return task;
  }
  renderSettings() {
    this.$('provider-label').textContent = this.configured
      ? this.settings.provider === 'acp'
        ? 'ACP · агент на сервере'
        : this.settings.model
      : 'Подключите своего ИИ';
    this.$('provider-indicator').classList.toggle('connected', !!this.configured);
    this.$('connect-ai').hidden = !!this.configured;
    this.$('chat-empty-title').textContent = this.configured
      ? 'Что изменим в теме?'
      : 'Подключите свой ИИ';
    this.$('chat-empty-caption').textContent = this.getTheme().builtin
      ? 'При отправке сообщения создадим вашу копию встроенной темы. Агент сможет менять её HTML/CSS и проверять вид шаблона.'
      : 'Агент работает с HTML/CSS этой темы и видит её холст. Правки на холсте сохраняются перед отправкой сообщения.';
    this.$('chat-slide-context').textContent = 'Тема';
  }
  providerFields() {
    this.$('api-settings').hidden = this.$('ai-provider').value === 'acp';
    this.$('acp-settings').hidden = !this.$('api-settings').hidden;
  }
  async openSettings() {
    this.settings = await request('/api/ai/settings');
    const s = this.settings;
    this.$('ai-provider').value = s.provider || 'openai';
    this.$('ai-base-url').value = s.baseUrl || 'https://api.openai.com/v1';
    this.$('ai-api-mode').value = s.apiMode || 'responses';
    this.$('ai-model').value = s.model || '';
    this.$('ai-api-key').value = '';
    this.$('ai-api-key').placeholder = s.hasApiKey ? 'Ключ уже сохранён' : 'Вставьте API-ключ';
    this.$('api-key-status').textContent = s.hasApiKey
      ? 'Пустое поле оставляет сохранённый ключ.'
      : 'Ключ хранится на сервере.';
    this.$('acp-status').textContent = s.acpAvailable
      ? 'Агент доступен на сервере.'
      : 'ACP пока не настроен на сервере.';
    this.$('settings-status').textContent = '';
    this.providerFields();
    this.$('settings-dialog').showModal();
  }
  activity(message, event) {
    if (!message.log) {
      const details = document.createElement('details');
      details.className = 'chat-activity';
      const summary = document.createElement('summary');
      summary.textContent = 'Ход работы';
      message.log = document.createElement('div');
      message.log.className = 'activity-log';
      details.append(summary, message.log);
      message.append(details);
      message.tools = new Map();
    }
    const text =
      event.type === 'tool'
        ? (event.name || 'Инструмент') + (event.status ? ' · ' + event.status : '')
        : event.text || event.message;
    if (!text) return;
    const id = event.toolCallId || event.id || event.name;
    let entry = event.type === 'tool' ? message.tools.get(id) : null;
    if (!entry) {
      entry = document.createElement('div');
      entry.className = 'activity-entry';
      message.log.append(entry);
      if (event.type === 'tool') message.tools.set(id, entry);
    }
    entry.textContent = text;
  }
  append(role, content, extra = {}) {
    const element = document.createElement('div');
    element.className = 'chat-message ' + role;
    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = role === 'user' ? 'Вы' : role === 'assistant' ? 'Ассистент' : 'Система';
    const body = document.createElement('div');
    body.className = 'message-content';
    body.textContent = content;
    element.append(label, body);
    renderMessageAttachments(element, extra.attachments, this.base);
    for (const event of extra.activity || []) this.activity(element, event);
    this.$('chat-messages').append(element);
    this.$('chat-empty').hidden = true;
    this.scroll();
    return element;
  }
  scroll() {
    const list = this.$('chat-messages');
    list.scrollTop = list.scrollHeight;
  }
  async loadHistory() {
    const id = this.id,
      result = await request(this.base + '/chat');
    if (this.id !== id) return;
    this.$('chat-messages').replaceChildren();
    for (const message of result.messages || [])
      this.append(message.role, message.content, message);
    this.$('chat-empty').hidden = !!this.$('chat-messages').children.length;
    finishChatLoading(this.view);
  }
  setBusy(value) {
    this.busy = value;
    this.attachments.setBusy(value);
    this.$('chat-send').hidden = value;
    this.$('chat-stop').hidden = !value;
    this.$('chat-input').disabled = value;
    this.$('chat-reset').disabled = value;
    this.$('dictation-button').disabled = value;
    this.$('provider-indicator').classList.toggle('busy', value);
    this.onBusy(value);
  }
  async refresh() {
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = Promise.resolve()
      .then(() => this.onSaved())
      .catch(this.onError)
      .finally(() => (this.refreshTask = null));
    return this.refreshTask;
  }
  async send() {
    if (this.busy) return;
    if (this.attachments.blocked)
      throw new Error('Дождитесь загрузки файлов или уберите файлы с ошибкой.');
    this.setBusy(true);
    this.abort = new AbortController();
    let assistant,
      user,
      timer,
      accepted = false,
      answer = '',
      finished = false;
    try {
      await this.dictation.stop();
      this.$('dictation-button').disabled = true;
      this.abort.signal.throwIfAborted();
      const text = this.$('chat-input').value;
      if (!text.trim() && !this.attachments.metadata.length) return;
      if (!this.configured) {
        await this.openSettings();
        return;
      }
      await this.prepare();
      await this.sync();
      this.abort.signal.throwIfAborted();
      const base = this.base,
        attachments = this.attachments.metadata;
      this.activeBase = base;
      user = this.append('user', text, { attachments });
      assistant = this.append('assistant', 'Работает 0 сек.');
      const start = Date.now();
      timer = pageInterval(() => {
        assistant.querySelector('.message-content').textContent =
          'Работает ' + duration(Date.now() - start);
      }, 1000);
      const response = await fetch(base + '/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, attachmentIds: attachments.map((a) => a.id) }),
        signal: this.abort.signal,
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Ошибка ИИ');
      const accept = () => {
        if (accepted) return;
        accepted = true;
        this.attachments.clear();
        this.$('chat-input').value = '';
      };
      const handle = async (raw) => {
        let type = 'message',
          data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) return;
        const event = JSON.parse(data);
        if (type === 'accepted') accept();
        else if (type === 'text') answer += event.delta || event.text || '';
        else if (['tool', 'activity', 'status'].includes(type)) {
          this.activity(assistant, { ...event, type });
          if (
            type === 'tool' &&
            event.status === 'completed' &&
            /update_theme/.test(event.name || '')
          )
            await this.refresh();
        } else if (type === 'error') throw new Error(event.error || event.message);
        else if (type === 'done') {
          accept();
          finished = true;
          answer = event.message?.content || answer;
        }
      };
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          await handle(raw);
        }
      }
      if (buffer.trim()) await handle(buffer);
      clearInterval(timer);
      assistant.querySelector('.message-content').textContent =
        answer || (finished ? 'Готово.' : 'Ответ завершён.');
      const summary = assistant.querySelector('.chat-activity summary');
      if (summary) summary.textContent = 'Ход работы · ' + duration(Date.now() - start);
      await this.refresh();
    } catch (error) {
      if (!accepted) user?.remove();
      if (assistant)
        assistant.querySelector('.message-content').textContent =
          error.name === 'AbortError' ? 'Запрос остановлен.' : error.message;
      if (error.name !== 'AbortError') this.onError(error);
    } finally {
      clearInterval(timer);
      this.setBusy(false);
      this.abort = null;
      this.activeBase = null;
      this.scroll();
    }
  }
}
