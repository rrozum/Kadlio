import { finishChatLoading } from '../modules/chat-loading.js';
import { pageScope, onPageCleanup, pageInterval } from '../modules/page-lifecycle.js';
import { request } from '../modules/api.js';
import { ChatAttachments, renderMessageAttachments } from '../modules/chat-attachments.js';
import { mountDictation } from '../modules/dictation.js';

export function createEditorChat({
  base,
  getSlide: activeSlide,
  flush: flushAll,
  getSelectedAnnotation,
  clearAnnotationContext,
  onRefresh: refreshAfterAgent,
  onError,
  notify: toast,
}) {
  const view = pageScope()?.document || document;
  const $ = (id) => view.getElementById(id);
  let settings = {},
    chatBusy = false,
    chatAbort,
    chatHistoryRefreshPending = false;
  onPageCleanup(() => chatAbort?.abort());
  const showDialog = (id) => $(id).showModal();
  const dictation = mountDictation({
    button: $('dictation-button'),
    input: $('chat-input'),
    status: $('dictation-status'),
    onError,
  });
  const chatAttachments = new ChatAttachments({
    base,
    button: $('chat-attach'),
    input: $('chat-file-input'),
    list: $('chat-attachments'),
    status: $('chat-attachment-status'),
    pasteTarget: $('chat-input'),
    onChange: () =>
      queueMicrotask(() => {
        $('chat-send').disabled = chatBusy || chatAttachments.blocked;
      }),
  });
  function renderSettings() {
    const configured =
      settings.provider === 'acp' ? settings.acpAvailable : settings.hasApiKey && settings.model;
    $('provider-label').textContent = configured
      ? settings.provider === 'acp'
        ? 'ACP · агент на сервере'
        : settings.model || 'OpenAI API'
      : 'Подключите своего ИИ';
    $('provider-indicator').classList.toggle('connected', !!configured);
    $('connect-ai').hidden = !!configured;
    $('chat-empty-title').textContent = configured
      ? 'Что изменим в презентации?'
      : 'Подключите свой ИИ';
    $('chat-empty-caption').textContent = configured
      ? 'Расскажите, что хотите изменить. Ассистент видит HTML, заметки и комментарии этой презентации.'
      : 'Выберите OpenAI-совместимый API или серверного агента через ACP, чтобы редактировать слайды в чате.';
  }
  async function openSettings() {
    try {
      settings = await request('/api/ai/settings');
      $('ai-provider').value = settings.provider || 'openai';
      $('ai-base-url').value = settings.baseUrl || 'https://api.openai.com/v1';
      $('ai-api-mode').value = settings.apiMode || 'responses';
      $('ai-model').value = settings.model || '';
      $('ai-api-key').value = '';
      $('ai-api-key').placeholder = settings.hasApiKey ? 'Ключ уже сохранён' : 'Вставьте API-ключ';
      $('api-key-status').textContent = settings.hasApiKey
        ? 'Ключ сохранён. Пустое поле оставляет его без изменений.'
        : 'Ключ нужен только для OpenAI-совместимого API.';
      $('acp-status').textContent = settings.acpAvailable
        ? 'Агент доступен на сервере. Его авторизация используется для ACP-сессии.'
        : 'ACP пока не настроен. Установите и авторизуйте агента на сервере, затем задайте его команду запуска.';
      updateProviderFields();
      $('settings-status').textContent = '';
      $('settings-status').classList.remove('error');
      showDialog('settings-dialog');
    } catch (error) {
      toast(error.message, true);
    }
  }
  function updateProviderFields() {
    const acp = $('ai-provider').value === 'acp';
    $('api-settings').hidden = acp;
    $('acp-settings').hidden = !acp;
  }
  $('ai-settings-button').addEventListener('click', openSettings);
  $('connect-ai').addEventListener('click', openSettings);
  $('ai-provider').addEventListener('change', updateProviderFields);
  $('ai-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      const value = {
        provider: $('ai-provider').value,
        baseUrl: $('ai-base-url').value.trim(),
        apiMode: $('ai-api-mode').value,
        model: $('ai-model').value.trim(),
      };
      if ($('ai-api-key').value.trim()) value.apiKey = $('ai-api-key').value.trim();
      settings = await request('/api/ai/settings', { method: 'PUT', body: value });
      renderSettings();
      $('ai-api-key').value = '';
      $('settings-dialog').close();
      toast('Настройки ИИ сохранены');
    } catch (error) {
      $('settings-status').classList.add('error');
      $('settings-status').textContent = error.message;
    } finally {
      event.submitter.disabled = false;
    }
  });
  function workDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000)),
      minutes = Math.floor(seconds / 60);
    const count = minutes || seconds;
    const words = minutes ? ['минуту', 'минуты', 'минут'] : ['секунду', 'секунды', 'секунд'];
    const word =
      count % 100 >= 11 && count % 100 <= 14
        ? words[2]
        : count % 10 === 1
          ? words[0]
          : count % 10 >= 2 && count % 10 <= 4
            ? words[1]
            : words[2];
    return count + ' ' + word;
  }
  function addActivity(message, event) {
    if (!message.activityDetails) {
      const details = document.createElement('details');
      details.className = 'chat-activity';
      const summary = document.createElement('summary');
      summary.textContent = 'Ход работы';
      const log = document.createElement('div');
      log.className = 'activity-log';
      details.append(summary, log);
      message.append(details);
      message.activityDetails = details;
      message.activityLog = log;
      message.activityTools = new Map();
    }
    const name = event.name || event.tool || 'Инструмент';
    const content =
      event.type === 'tool'
        ? name +
          (event.status ? ' · ' + event.status : '') +
          (event.message ? '\n' + event.message : '')
        : event.text || event.message || '';
    if (!content) return;
    const toolId = event.toolCallId || event.id || event.callId || name;
    let entry = event.type === 'tool' ? message.activityTools.get(toolId) : null;
    if (!entry) {
      entry = document.createElement('div');
      entry.className = 'activity-entry';
      message.activityLog.append(entry);
      if (event.type === 'tool') message.activityTools.set(toolId, entry);
    }
    entry.textContent = content;
  }
  function appendMessage(role, content = '', extra = {}) {
    const element = document.createElement('div');
    element.className =
      'chat-message ' + (role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system');
    if (extra.annotationId) element.dataset.annotationId = extra.annotationId;
    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent =
      role === 'user'
        ? extra.annotationId
          ? 'Комментарий'
          : 'Вы'
        : role === 'assistant'
          ? 'Ассистент'
          : 'Система';
    const body = document.createElement('div');
    body.className = 'message-content';
    body.textContent = content;
    element.append(label, body);
    renderMessageAttachments(element, extra.attachments, base);
    for (const activity of extra.activity || []) addActivity(element, activity);
    if (element.activityDetails && extra.elapsedMs)
      element.activityDetails.querySelector('summary').textContent =
        'Ход работы · ' + workDuration(extra.elapsedMs);
    $('chat-messages').append(element);
    $('chat-empty').hidden = true;
    scrollChat();
    return element;
  }
  function scrollChat() {
    const panel = $('chat-messages');
    panel.scrollTop = panel.scrollHeight;
  }
  // Проверяем busy до и после GET: активный SSE нельзя заменить запоздалой историей.
  async function loadChat() {
    if (chatBusy) {
      chatHistoryRefreshPending = true;
      return;
    }
    const result = await request(base + '/chat');
    if (chatBusy) {
      chatHistoryRefreshPending = true;
      return;
    }
    chatHistoryRefreshPending = false;
    $('chat-messages').replaceChildren();
    for (const message of result.messages || []) {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.text || JSON.stringify(message.content || '');
      appendMessage(message.role || 'system', content, message);
    }
    $('chat-empty').hidden = !!$('chat-messages').children.length;
    finishChatLoading(view);
  }
  function setChatBusy(busy) {
    chatBusy = busy;
    chatAttachments.setBusy(busy);
    $('chat-send').hidden = busy;
    $('chat-stop').hidden = !busy;
    $('chat-input').disabled = busy;
    $('chat-reset').disabled = busy;
    $('dictation-button').disabled = busy;
    $('provider-indicator').classList.toggle('busy', busy);
  }
  async function sendChat(
    message,
    annotationId,
    { withAttachments = false, explicitFiles = [], preserveComposer = false, onAccepted } = {},
  ) {
    if (chatBusy) {
      toast('Ассистент ещё работает. Дождитесь ответа или нажмите «Стоп».');
      return { accepted: false, completed: false, error: 'Ассистент ещё работает.' };
    }
    if (withAttachments && chatAttachments.blocked)
      throw new Error('Дождитесь загрузки файлов или уберите файлы с ошибкой.');
    const attachments = withAttachments ? chatAttachments.metadata : explicitFiles;
    if (!message?.trim() && !attachments.length) return { accepted: false, completed: false };
    message = message || '';
    await dictation.stop();
    await flushAll();
    const slideId = activeSlide().id;
    let pendingUserMessage;
    if (!annotationId) pendingUserMessage = appendMessage('user', message, { attachments });
    else if (
      !$('chat-messages').querySelector('[data-annotation-id="' + CSS.escape(annotationId) + '"]')
    )
      pendingUserMessage = appendMessage('user', message, { annotationId, attachments });
    const assistant = appendMessage('assistant', 'Работает 0 секунд');
    let answer = '';
    let completed = false;
    let finishedMessage;
    let accepted = false,
      failure;
    const started = Date.now();
    const timer = pageInterval(() => {
      assistant.querySelector('.message-content').textContent =
        'Работает ' + workDuration(Date.now() - started);
    }, 1000);
    setChatBusy(true);
    chatAbort = new AbortController();
    if (!preserveComposer) {
      clearAnnotationContext();
    }
    try {
      const response = await fetch(base + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          slideId,
          annotationId,
          attachmentIds: attachments.map((item) => item.id),
        }),
        credentials: 'same-origin',
        signal: chatAbort.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Ошибка подключения' }));
        throw new Error(error.error || error.message || 'Ошибка ИИ');
      }
      // Очищаем черновик и вложения после принятия сервером, а не после начала запроса.
      const accept = (data) => {
        if (accepted) return;
        accepted = true;
        if (withAttachments) {
          chatAttachments.clear();
          $('chat-input').value = '';
        } else if (!annotationId && !preserveComposer) $('chat-input').value = '';
        onAccepted?.();
        const user =
          pendingUserMessage ||
          (annotationId &&
            $('chat-messages').querySelector(
              '[data-annotation-id="' + CSS.escape(annotationId) + '"]',
            ));
        if (user && data?.message) {
          user.querySelector('.message-content').textContent = data.message.content || message;
          user.querySelector('.message-attachments')?.remove();
          renderMessageAttachments(user, data.message.attachments || attachments, base);
        }
      };
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      const processEvent = async (raw) => {
        let type = 'message',
          dataText = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          if (line.startsWith('data:')) dataText += line.slice(5).trim();
        }
        if (!dataText) return;
        let data;
        try {
          data = JSON.parse(dataText);
        } catch {
          data = { text: dataText };
        }
        if (type === 'accepted') accept(data);
        else if (type === 'text') answer += data.delta || data.text || data.content || '';
        else if (type === 'tool' || type === 'activity' || type === 'status')
          addActivity(assistant, { ...data, type });
        else if (type === 'permission') renderPermission(assistant, data);
        else if (type === 'error')
          throw new Error(data.error || data.message || 'Ассистент не смог выполнить запрос');
        else if (type === 'done') {
          accept();
          completed = true;
          finishedMessage = data.message;
        }
        scrollChat();
      };
      // Один сетевой chunk может содержать часть события или несколько SSE-событий.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          await processEvent(event);
        }
      }
      if (buffer.trim()) await processEvent(buffer);
      clearInterval(timer);
      if (finishedMessage?.content) answer = finishedMessage.content;
      assistant.querySelector('.message-content').textContent =
        answer || (completed ? 'Готово.' : 'Ответ завершён.');
      if (assistant.activityDetails)
        assistant.activityDetails.querySelector('summary').textContent =
          'Ход работы · ' + workDuration(finishedMessage?.elapsedMs || Date.now() - started);
      await refreshAfterAgent();
    } catch (error) {
      failure = error;
      if (!accepted) {
        pendingUserMessage?.remove();
        if (withAttachments) $('chat-input').value = message;
      }
      if (error.name === 'AbortError') {
        assistant.querySelector('.message-content').textContent = answer || 'Запрос остановлен.';
      } else {
        const body = assistant.querySelector('.message-content');
        body.textContent = answer ? answer + '\n\n' + error.message : error.message;
        assistant.classList.add('system');
        toast(error.message, true);
      }
    } finally {
      clearInterval(timer);
      setChatBusy(false);
      chatAbort = null;
      if (chatHistoryRefreshPending) await loadChat().catch((error) => toast(error.message, true));
      scrollChat();
    }
    return { accepted, completed, message: finishedMessage, error: failure?.message };
  }
  function renderPermission(message, data) {
    const card = document.createElement('div');
    card.className = 'tool-result';
    const text = document.createElement('div');
    text.textContent = 'Агент запросил разрешение';
    card.append(text);
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Подробности действия';
    const description = document.createElement('div');
    description.textContent = data.title || data.message || 'Действие агента';
    details.append(summary, description);
    card.append(details);
    const actions = document.createElement('div');
    actions.className = 'message-tools';
    for (const [outcome, label] of [
      ['allow_once', 'Разрешить один раз'],
      ['reject_once', 'Отклонить'],
    ]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', async () => {
        try {
          await request(base + '/chat/permission', {
            method: 'POST',
            body: { requestId: data.requestId, outcome },
          });
          actions.replaceChildren();
          text.textContent = outcome === 'allow_once' ? 'Разрешено.' : 'Отклонено.';
        } catch (error) {
          toast(error.message, true);
        }
      });
      actions.append(button);
    }
    card.append(actions);
    message.append(card);
    scrollChat();
  }
  $('chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await dictation.stop();
      await sendChat($('chat-input').value, getSelectedAnnotation()?.id, { withAttachments: true });
    } catch (error) {
      toast(error.message, true);
    }
  });
  $('chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('chat-form').requestSubmit();
    }
  });
  $('chat-stop').addEventListener('click', async () => {
    chatAbort?.abort();
    try {
      await request(base + '/chat/cancel', { method: 'POST' });
    } catch (error) {
      toast(error.message, true);
    }
  });
  $('chat-reset').addEventListener('click', async () => {
    if (
      !confirm('Начать новый разговор? История чата будет очищена; слайды и комментарии останутся.')
    )
      return;
    try {
      await request(base + '/chat', { method: 'DELETE' });
      await loadChat();
    } catch (error) {
      toast(error.message, true);
    }
  });
  document.querySelectorAll('[data-prompt]').forEach((button) =>
    button.addEventListener('click', () => {
      $('chat-input').value = button.dataset.prompt;
      $('chat-input').focus();
    }),
  );

  return {
    get busy() {
      return chatBusy;
    },
    get configured() {
      return settings.provider === 'acp'
        ? settings.acpAvailable
        : settings.hasApiKey && settings.model;
    },
    get settings() {
      return settings;
    },
    set settings(value) {
      settings = value;
    },
    send: sendChat,
    loadHistory: loadChat,
    failLoading: (error) => finishChatLoading(view, error),
    renderSettings,
    openSettings,
  };
}
