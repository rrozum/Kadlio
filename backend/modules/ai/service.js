import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectTools, createThemeTools } from '../mcp/tools.js';
import { ACPManager } from './acp.js';
import { AttachmentStore } from '../uploads/attachments.js';
import { AIContext, generationPrompt } from './context.js';
import { SettingsRepository } from './repositories/settings.js';
import { ChatRepository } from './repositories/chats.js';
import { createProviderRegistry } from './providers/registry.js';

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

// Координатор чатов и генерации: активные запросы, отмена и порядок SSE-событий.
// Содержимое читает контекст, JSON сохраняют репозитории, протокол выбирает реестр.
export class AIService {
  constructor({
    dataDir,
    library,
    root,
    workspace,
    mcpUrl,
    mcpToken,
    acpCommand,
    acpArgs,
    acpAuthHome,
    clientFactory,
  }) {
    this.directory = path.join(dataDir, 'ai');
    this.library = library;
    this.attachments = new AttachmentStore({ dataDir, library });
    this.themeAttachments = new AttachmentStore({ dataDir, library, scope: 'theme' });
    this.tools = createProjectTools(library, { attachments: this.attachments });
    this.chats = new ChatRepository(this.directory);
    this.settingsRepository = new SettingsRepository(this.directory);
    this.context = new AIContext({ library, chats: this.chats });
    this.clientFactory = clientFactory;
    this.active = new Map();
    this.queues = this.chats.queues;
    this.generations = new Map();
    this.deleting = new Set();
    this.configFile = this.settingsRepository.file;
    this.acp = new ACPManager({
      root,
      workspace: workspace || ((id) => this.workspace(id)),
      mcpUrl,
      mcpToken,
      ...(acpCommand ? { command: acpCommand } : {}),
      ...(acpArgs ? { args: acpArgs } : {}),
      ...(acpAuthHome ? { authHome: acpAuthHome } : {}),
    });
    this.providers = createProviderRegistry({ acp: this.acp });
    this.ready = this.initialize();
  }
  get config() {
    return this.settingsRepository.value;
  }
  async initialize() {
    await this.chats.initialize();
    await this.settingsRepository.load();
  }
  workspace(key) {
    return this.context.workspace(key);
  }
  async settings() {
    await this.ready;
    return { ...this.settingsRepository.visible(), acpAvailable: await this.acp.available() };
  }
  async saveSettings(value) {
    await this.ready;
    const next = this.settingsRepository.next(value, this.providers);
    await this.queue('settings', () => this.settingsRepository.save(next));
    return this.settings();
  }
  async status() {
    const keys = [...this.active.keys()];
    return {
      ...(await this.settings()),
      acpStatus: this.acp.state,
      activeProjects: keys.filter((key) => !key.startsWith('theme:')),
      activeThemes: keys.filter((key) => key.startsWith('theme:')).map((key) => key.slice(6)),
    };
  }
  contextKey(id, scope = 'project') {
    return this.chats.key(id, scope);
  }
  assertNotDeleting(id, scope = 'project') {
    if (this.deleting.has(this.contextKey(id, scope)))
      throw Object.assign(new Error('Этот проект или тема сейчас удаляется.'), { status: 409 });
  }
  contextRecord(id, scope = 'project') {
    return this.context.record(id, scope);
  }
  chatFile(id, scope = 'project') {
    return this.chats.file(id, scope);
  }
  async readChat(id, scope = 'project') {
    await this.ready;
    return this.chats.read(id, scope);
  }
  async history(projectId, scope = 'project') {
    await this.contextRecord(projectId, scope);
    return { messages: (await this.readChat(projectId, scope)).messages };
  }
  async resetHistory(projectId, scope = 'project') {
    this.assertNotDeleting(projectId, scope);
    await this.contextRecord(projectId, scope);
    this.assertNotDeleting(projectId, scope);
    const key = this.contextKey(projectId, scope);
    if (this.active.has(key))
      throw Object.assign(new Error('Остановите агента перед очисткой чата.'), { status: 409 });
    await this.providers.reset(key);
    await this.mutateChat(
      projectId,
      (chat) => {
        chat.messages = [];
        chat.acpSessionId = null;
      },
      scope,
    );
    return { messages: [] };
  }
  async deleteContext(id, scope = 'project', payload = {}) {
    await this.ready;
    const key = this.contextKey(id, scope);
    this.assertNotDeleting(id, scope);
    if (this.active.has(key) || (scope === 'project' && this.generations.has(id)))
      throw Object.assign(
        new Error('Дождитесь ответа агента или остановите его перед удалением.'),
        { status: 409 },
      );
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.keys(payload).some((key) => key !== 'version') ||
      (payload.version !== undefined && (!Number.isInteger(payload.version) || payload.version < 0))
    )
      throw invalid('Для удаления укажите корректную текущую версию.');
    this.deleting.add(key);
    try {
      await this.queues.get(key);
      const result = await (scope === 'theme'
        ? this.library.themes.remove(id, payload)
        : this.library.remove(id, payload));
      // Приватный чат удаляется только после успешного CAS-удаления проекта
      // и остановки всех его процессов. Конфликт версии сохраняет весь контекст.
      await this.providers.reset(key);
      await this.chats.removeContext(id, scope);
      return result;
    } finally {
      this.deleting.delete(key);
    }
  }
  queue(key, action) {
    return this.chats.queue(key, action);
  }
  async mutateChat(projectId, action, scope = 'project') {
    this.assertNotDeleting(projectId, scope);
    return this.chats.mutate(projectId, action, scope, this.ready);
  }
  async appendAnnotation(projectId, annotation) {
    await this.library.get(projectId);
    if (!annotation || typeof annotation.id !== 'string' || typeof annotation.comment !== 'string')
      throw invalid('Неверная аннотация.');
    return this.mutateChat(projectId, (chat) => {
      const existing = chat.messages.find((item) => item.annotationId === annotation.id);
      const content = `Комментарий к слайду ${annotation.slideId} в точке (${Math.round(annotation.x * 100)}%, ${Math.round(annotation.y * 100)}%)${annotation.anchorText ? `, рядом с «${annotation.anchorText}»` : ''}:\n${annotation.comment}`;
      if (existing) {
        existing.content = content;
        existing.slideId = annotation.slideId;
        existing.updatedAt = new Date().toISOString();
        return existing;
      }
      const message = {
        id: randomUUID(),
        role: 'user',
        content,
        slideId: annotation.slideId,
        annotationId: annotation.id,
        createdAt: new Date().toISOString(),
      };
      chat.messages.push(message);
      return message;
    });
  }
  async send({
    projectId,
    themeId,
    message,
    slideId,
    annotationId,
    attachmentIds = [],
    onEvent = () => {},
    signal,
    generation = false,
  }) {
    await this.ready;
    const scope = themeId ? 'theme' : 'project';
    if (themeId && projectId) throw invalid('Выберите один контекст чата.');
    const id = themeId || projectId;
    this.assertNotDeleting(id, scope);
    const source = await this.contextRecord(id, scope);
    this.assertNotDeleting(id, scope);
    if (scope === 'theme' && (slideId || annotationId))
      throw invalid('В чате темы нет слайдов или аннотаций.');
    const key = this.contextKey(id, scope),
      attachments = scope === 'theme' ? this.themeAttachments : this.attachments,
      tools =
        scope === 'theme'
          ? createThemeTools(this.library, { boundThemeId: themeId, attachments })
          : this.tools;
    if (scope === 'project' && this.generations.has(id) && !generation)
      throw Object.assign(new Error('Дождитесь завершения создания презентации.'), { status: 409 });
    if (this.active.has(key))
      throw Object.assign(new Error('Агент уже отвечает в этом чате.'), { status: 409 });
    if (message !== undefined && (typeof message !== 'string' || message.length > 50_000))
      throw invalid('Введите сообщение до 50 000 символов.');
    let attachmentContext = await attachments.context(id, attachmentIds, {
      includeDocumentPreview: false,
      signal,
    });
    this.assertNotDeleting(id, scope);
    if (!annotationId && !message?.trim() && !attachmentContext.attachments.length)
      throw invalid('Введите сообщение или добавьте файл.');
    if (this.active.has(key))
      throw Object.assign(new Error('Агент уже отвечает в этом чате.'), { status: 409 });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    this.active.set(key, controller);
    let answer = '';
    const startedAt = Date.now(),
      activity = [];
    const emit = (event) => {
      if (event.type === 'text') {
        answer += event.text;
        if (answer.length > 500_000) {
          controller.abort();
          throw new Error('Ответ агента слишком большой.');
        }
      } else if (['activity', 'tool', 'status'].includes(event.type) && activity.length < 200) {
        activity.push({
          type: event.type,
          ...(event.text ? { text: String(event.text).slice(0, 4000) } : {}),
          ...(event.message ? { message: String(event.message).slice(0, 1000) } : {}),
          ...(event.name ? { name: String(event.name).slice(0, 512) } : {}),
          ...(event.status ? { status: event.status } : {}),
          ...(event.toolCallId ? { toolCallId: String(event.toolCallId).slice(0, 256) } : {}),
        });
      }
      onEvent(event);
    };
    try {
      controller.signal.throwIfAborted();
      const config = { ...this.config };
      const provider = this.providers.get(config.provider);
      await provider.validate(config);
      if (attachmentContext.attachments.some((item) => /\.(pdf|pptx|odp)$/i.test(item.name)))
        onEvent({ type: 'status', message: 'Читаю визуальный образец документа…' });
      attachmentContext = await attachments.withDocumentPreviews(id, attachmentContext, {
        signal: controller.signal,
      });
      const chat = await this.mutateChat(
        id,
        (current) => {
          if (annotationId) {
            const existing = current.messages.find((item) => item.annotationId === annotationId);
            if (!existing) throw invalid('Сначала сохраните аннотацию.');
            if (attachmentContext.attachments.length)
              existing.attachments = attachmentContext.attachments;
          } else
            current.messages.push({
              id: randomUUID(),
              role: 'user',
              content: message?.trim() || 'Посмотри вложения.',
              ...(slideId ? { slideId } : {}),
              ...(attachmentContext.attachments.length
                ? { attachments: attachmentContext.attachments }
                : {}),
              createdAt: new Date().toISOString(),
            });
          return structuredClone(current);
        },
        scope,
      );
      const selected = annotationId
        ? chat.messages.find((item) => item.annotationId === annotationId)
        : chat.messages.at(-1);
      if (!attachmentContext.attachments.length && selected.attachments?.length)
        attachmentContext = await attachments.context(
          id,
          selected.attachments.map((item) => item.id),
          { signal: controller.signal },
        );
      onEvent({ type: 'accepted', message: selected });
      const recent = chat.messages
        .filter((item) => ['user', 'assistant'].includes(item.role) && item.content)
        .slice(-80);
      if (annotationId && recent.at(-1)?.id !== selected.id) recent.push(selected);
      const projectContext = await this.context.sources(source, id, scope);
      await provider.run({
        settings: config,
        id,
        scope,
        key,
        themeId,
        recent,
        selected,
        chat,
        attachmentContext,
        projectContext,
        tools,
        signal: controller.signal,
        onEvent: emit,
        clientFactory: this.clientFactory,
        onSession: (sessionId) =>
          this.mutateChat(
            id,
            (current) => {
              current.acpSessionId = sessionId;
            },
            scope,
          ),
      });
      const saved = await this.saveAssistant(
        id,
        answer,
        { provider: config.provider, activity, elapsedMs: Date.now() - startedAt },
        scope,
      );
      onEvent({ type: 'done', message: saved });
      return saved;
    } catch (error) {
      if (answer)
        await this.saveAssistant(
          id,
          answer,
          { interrupted: true, activity, elapsedMs: Date.now() - startedAt },
          scope,
        );
      if (controller.signal.aborted) {
        onEvent({ type: 'done', cancelled: true });
        return { cancelled: true };
      }
      const safe = String(error.message || 'Ошибка агента.')
        .split(this.config.apiKey || '\0')
        .join(this.config.apiKey ? '[API key]' : '\0')
        .slice(0, 1000);
      onEvent({ type: 'error', message: safe, error: safe, status: error.status || 500 });
      return { error: safe };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.active.get(key) === controller) this.active.delete(key);
    }
  }
  saveAssistant(projectId, content, extra, scope = 'project') {
    return this.mutateChat(
      projectId,
      (chat) => {
        const message = {
          id: randomUUID(),
          role: 'assistant',
          content,
          ...extra,
          createdAt: new Date().toISOString(),
        };
        chat.messages.push(message);
        return message;
      },
      scope,
    );
  }
  async preflightProvider() {
    await this.ready;
    await this.providers.get(this.config.provider).preflight(this.config);
  }
  async generate({ projectId, onEvent = () => {}, signal }) {
    this.assertNotDeleting(projectId);
    const project = await this.library.get(projectId);
    if (
      project.creationMode !== 'smart' ||
      !['pending', 'interrupted', 'error'].includes(project.creation?.status)
    )
      throw Object.assign(
        new Error(
          project.creationMode !== 'smart'
            ? 'Ручное создание не запускает ИИ.'
            : project.creation?.status === 'ready'
              ? 'Презентация уже создана. Продолжите работу в редакторе.'
              : 'Генерация уже выполняется.',
        ),
        { status: 409 },
      );
    if (this.generations.has(projectId) || this.active.has(projectId))
      throw Object.assign(new Error('Агент уже работает с этой презентацией.'), { status: 409 });
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    this.generations.set(projectId, controller);
    let attempt, finalEvent;
    try {
      await this.preflightProvider();
      this.assertNotDeleting(projectId);
      controller.signal.throwIfAborted();
      attempt = await this.library.beginGeneration(projectId);
      onEvent({
        type: 'status',
        message: attempt.resume
          ? 'Продолжаю создание, сохраняя текущие слайды.'
          : 'Создаю презентацию по описанию и материалам.',
        creation: (await this.library.get(projectId)).creation,
      });
      const result = await this.send({
        projectId,
        message: generationPrompt(attempt.resume),
        generation: true,
        signal: controller.signal,
        onEvent: (event) => {
          if (['done', 'error'].includes(event.type)) finalEvent = event;
          else onEvent(event);
        },
      });
      if (result.cancelled) {
        const creation = await this.library.finishGeneration(
          projectId,
          attempt.attempts,
          'interrupted',
        );
        onEvent({ type: 'done', cancelled: true, creation });
        return { ...result, creation };
      }
      if (result.error) {
        const creation = await this.library.finishGeneration(
          projectId,
          attempt.attempts,
          'error',
          result.error,
        );
        onEvent({ ...finalEvent, creation });
        return { ...result, creation };
      }
      const current = await this.library.get(projectId);
      if (!current.slides.length || current.slides.some((slide) => !slide.body.trim()))
        throw new Error(
          'Агент не завершил презентацию: в ней остались пустые слайды. Текущие правки сохранены; продолжите создание.',
        );
      const creation = await this.library.finishGeneration(projectId, attempt.attempts, 'ready');
      onEvent({ ...finalEvent, creation });
      return { ...result, creation };
    } catch (error) {
      if (!attempt) throw error;
      const cancelled = controller.signal.aborted,
        status = cancelled ? 'interrupted' : 'error',
        message = String(error.message || 'Не удалось создать презентацию.')
          .split(this.config.apiKey || '\0')
          .join(this.config.apiKey ? '[API key]' : '\0')
          .slice(0, 1000),
        creation = await this.library.finishGeneration(
          projectId,
          attempt.attempts,
          status,
          cancelled ? undefined : message,
        );
      onEvent(
        cancelled
          ? { type: 'done', cancelled: true, creation }
          : { type: 'error', message, error: message, creation },
      );
      return cancelled ? { cancelled: true, creation } : { error: message, creation };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.generations.get(projectId) === controller) this.generations.delete(projectId);
    }
  }
  cancel(projectId, scope = 'project') {
    this.active.get(this.contextKey(projectId, scope))?.abort();
    if (scope === 'project') this.generations.get(projectId)?.abort();
    return { ok: true };
  }
  approve(projectId, requestId, outcome) {
    return this.acp.approve(projectId, requestId, outcome);
  }
  close() {
    for (const controller of this.active.values()) controller.abort();
    for (const controller of this.generations.values()) controller.abort();
    return this.providers.close();
  }
}
