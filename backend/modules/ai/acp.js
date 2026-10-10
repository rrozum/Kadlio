import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { access, mkdir, copyFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { toolDefinitions, themeToolDefinitions } from '../mcp/definitions.js';

const trustedMcpTools = new Set(toolDefinitions.map((tool) => 'mcp.presentations.' + tool.name));
const trustedThemeTools = new Set(
  themeToolDefinitions.map((tool) => 'mcp.presentations.' + tool.name),
);

// Одного read-only sandbox недостаточно: он всё ещё разрешает команды.
// Нативные инструменты выключены; менять содержимое можно только через MCP движка.
const codexConfig = Object.freeze({
  approval_policy: 'never',
  sandbox_mode: 'read-only',
  web_search: 'disabled',
  // MCP объявлен необязательным в адаптере. Ждём обычный таймаут его запуска,
  // чтобы список инструментов не фиксировался после стандартной паузы в 1 секунду.
  mcp_optional_startup_grace_ms: 0,
  project_doc_max_bytes: 0,
  project_doc_fallback_filenames: [],
  notify: [],
  features: Object.freeze({
    shell_tool: false,
    unified_exec: false,
    unified_exec_tty: false,
    shell_snapshot: false,
    code_mode: false,
    code_mode_host: false,
    artifact: false,
    view_image: false,
    browser_use: false,
    browser_use_external: false,
    browser_use_full_cdp_access: false,
    in_app_browser: false,
    computer_use: false,
    image_generation: false,
    apps: false,
    plugins: false,
    remote_plugin: false,
    hooks: false,
    memories: false,
    chronicle: false,
    multi_agent: false,
    multi_agent_v2: false,
    agent_message_board: false,
    request_permissions_tool: false,
    skill_mcp_dependency_install: false,
    skip_host_skill_discovery: true,
    workspace_dependencies: false,
    daemon_auto_start: false,
    goals: false,
    in_app_local_automation: false,
    tool_suggest: false,
  }),
});

export class ACPManager {
  constructor({
    root,
    workspace,
    mcpUrl,
    mcpToken,
    authHome = process.env.CODEX_HOME ||
      (process.env.HOME ? path.join(process.env.HOME, '.codex') : null),
    command = process.env.ACP_COMMAND || path.join(root, 'node_modules/.bin/codex-acp'),
    args = parseArgs(process.env.ACP_ARGS_JSON),
    idleMs = 300_000,
  }) {
    this.root = root;
    this.workspace = workspace;
    this.mcpUrl = mcpUrl;
    this.mcpToken = mcpToken;
    this.command = command;
    this.args = args;
    this.idleMs = idleMs;
    this.authHome = authHome;
    this.sessions = new Map();
    this.draining = new Set();
    this.state = 'not-connected';
  }
  async available() {
    const candidates = path.isAbsolute(this.command)
      ? [this.command]
      : (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, this.command));
    for (const file of candidates) {
      try {
        await access(file, constants.X_OK);
        return true;
      } catch {}
    }
    return false;
  }
  async prompt({
    projectId,
    themeId,
    prompt,
    images = [],
    previousSessionId,
    onSession,
    onEvent,
    signal,
  }) {
    let entry = this.sessions.get(projectId);
    if (!entry) {
      await this.reset(projectId);
      // Сохраняем не больше двух процессов; активную сессию не вытесняем.
      if (this.sessions.size >= 2) {
        const idle = [...this.sessions.values()].find((item) => !item.active);
        if (!idle) throw new Error('Два ACP-агента уже работают. Дождитесь завершения.');
        await this.dispose(idle);
      }
      entry = await this.start(projectId, onEvent, signal);
      this.sessions.set(projectId, entry);
    }
    clearTimeout(entry.idleTimer);
    entry.active = true;
    entry.onEvent = onEvent;
    entry.toolNames.clear();
    entry.pendingMessage = { id: null, text: '' };
    entry.allowedTools = themeId ? trustedThemeTools : trustedMcpTools;
    const abort = () => {
      if (entry.sessionId)
        entry.connection.agent
          .notify('session/cancel', { sessionId: entry.sessionId })
          .catch(() => {});
      entry.cancelTimer = setTimeout(() => this.dispose(entry), 5_000);
      entry.cancelTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      signal?.throwIfAborted();
      let sessionOrigin = entry.sessionId ? 'повторный запрос' : 'новая сессия';
      if (images.length && !entry.init.agentCapabilities?.promptCapabilities?.image)
        throw Object.assign(new Error('Этот ACP-агент не поддерживает изображения в сообщениях.'), {
          status: 409,
        });
      if (!entry.sessionId) {
        const setup = {
          cwd: entry.cwd,
          mcpServers: [
            {
              name: 'presentations',
              command: process.execPath,
              args: [
                path.join(this.root, 'backend/modules/mcp/server.js'),
                ...(themeId ? ['--theme', themeId] : ['--project', projectId]),
              ],
              env: [
                { name: 'PRESENTATIONS_MCP_URL', value: this.mcpUrl },
                { name: 'PRESENTATIONS_MCP_TOKEN', value: this.mcpToken },
              ],
            },
          ],
        };
        if (!this.mcpUrl || !this.mcpToken)
          throw new Error('ACP MCP bridge не настроен на сервере.');
        let session;
        if (previousSessionId && entry.init.agentCapabilities?.loadSession) {
          entry.replaying = true;
          try {
            session = await timeout(
              entry.connection.agent.request('session/load', {
                ...setup,
                sessionId: previousSessionId,
              }),
              20_000,
              () => this.dispose(entry),
            );
            entry.sessionId = previousSessionId;
            sessionOrigin = 'восстановленная сессия';
          } catch (error) {
            if (error.code === -32000) throw error;
            if (entry.connection.signal.aborted) throw error;
          } finally {
            entry.replaying = false;
          }
        }
        if (!entry.sessionId) {
          session = await timeout(
            entry.connection.agent.request('session/new', setup),
            20_000,
            () => this.dispose(entry),
          );
          entry.sessionId = session.sessionId;
        }
        await onSession?.(entry.sessionId);
      }
      if (entry.mcpFailure) throw entry.mcpFailure;
      this.state = 'ready';
      onEvent({
        type: 'status',
        message: 'ACP подключён · ' + sessionOrigin,
        sessionId: entry.sessionId,
      });
      signal?.throwIfAborted();
      const result = await timeout(
        entry.connection.agent.request('session/prompt', {
          sessionId: entry.sessionId,
          prompt: [
            { type: 'text', text: prompt },
            ...images.map((image) => ({ type: 'image', mimeType: image.mime, data: image.data })),
          ],
        }),
        600_000,
        () => this.dispose(entry),
      );
      if (entry.mcpFailure) throw entry.mcpFailure;
      signal?.throwIfAborted();
      if (entry.pendingMessage.text) onEvent({ type: 'text', text: entry.pendingMessage.text });
      return result;
    } catch (error) {
      if (entry.mcpFailure) throw entry.mcpFailure;
      if (
        error.code === -32000 ||
        /authentication required|not authenticated|auth required/i.test(error.message)
      ) {
        this.state = 'auth-required';
        onEvent({
          type: 'status',
          status: 'auth-required',
          message:
            'Авторизуйте Codex на сервере под пользователем сайта: codex login --device-auth. API-ключ сайта и вход в ChatGPT — разные способы подключения.',
        });
        this.dispose(entry);
        const failure = new Error('Codex требует авторизации на сервере.');
        failure.status = 409;
        throw failure;
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      clearTimeout(entry.cancelTimer);
      entry.active = false;
      if (this.sessions.get(projectId) === entry) {
        entry.idleTimer = setTimeout(() => this.dispose(entry), this.idleMs);
        entry.idleTimer.unref();
      }
    }
  }
  async start(projectId, onEvent, signal) {
    const cwd = await this.workspace(projectId);
    const codexHome = path.join(cwd, '.codex'),
      hostHome = path.join(cwd, '.host');
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await mkdir(hostHome, { recursive: true, mode: 0o700 });
    if (this.authHome) {
      // Копируем только авторизацию оператора, без конфигов, MCP, hooks и навыков.
      // Уже обновлённую приватную авторизацию сохраняем при перезапуске.
      const authFile = path.join(codexHome, 'auth.json');
      try {
        await copyFile(path.join(this.authHome, 'auth.json'), authFile, constants.COPYFILE_EXCL);
        await chmod(authFile, 0o600);
      } catch (error) {
        if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
      }
    }
    const env = {};
    for (const name of [
      'PATH',
      'USER',
      'LOGNAME',
      'LANG',
      'LC_ALL',
      'TZ',
      'CODEX_PATH',
      'CODEX_API_KEY',
      'OPENAI_API_KEY',
    ])
      if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, {
      HOME: hostHome,
      CODEX_HOME: codexHome,
      NO_BROWSER: '1',
      INITIAL_AGENT_MODE: 'read-only',
      CODEX_CONFIG: JSON.stringify(codexConfig),
    });
    // Codex и MCP — дочерние процессы адаптера. Останавливаем всю свою POSIX
    // группу, иначе дети продолжат писать приватные журналы после выхода wrapper.
    const detached = process.platform !== 'win32';
    const child = spawn(this.command, this.args, {
      cwd,
      env,
      detached,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry = {
      projectId,
      cwd,
      child,
      processGroup: detached ? child.pid : null,
      onEvent,
      toolNames: new Map(),
      active: false,
      sessionId: null,
    };
    // stderr может содержать диагностику с credentials; в интерфейс его не передаём.
    child.stderr.on('data', () => {});
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), {
      maxMessageBytes: 32_000_000,
    });
    const app = client({ name: 'kadlio', version: '1.0.0' })
      .onNotification('session/update', ({ params }) => this.update(entry, params))
      .onRequest('session/request_permission', ({ params }) => this.permission(entry, params));
    entry.connection = app.connect(stream);
    child.on('error', (error) => entry.connection.close(error));
    child.on('exit', () => {
      entry.connection.close(new Error('ACP-процесс завершён.'));
      this.dispose(entry);
    });
    const abort = () => this.dispose(entry);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      entry.init = await timeout(
        entry.connection.agent.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'kadlio', version: '1.0.0' },
        }),
        20_000,
        () => this.dispose(entry),
      );
      if (entry.init.protocolVersion !== PROTOCOL_VERSION)
        throw new Error('ACP-агент использует несовместимую версию протокола.');
      return entry;
    } catch (error) {
      this.dispose(entry);
      if (error.code === 'ENOENT')
        throw new Error(
          'codex-acp не установлен на сервере. Установите @agentclientprotocol/codex-acp.',
        );
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  update(entry, { sessionId, update }) {
    if (entry.sessionId && entry.sessionId !== sessionId) return;
    // Это точное событие сбоя запуска MCP от codex-acp, в том числе при load
    // или простое. Оно отличается от обычной ошибки вызова инструмента.
    const startupTitle = update.title || entry.toolNames.get(update.toolCallId);
    if (
      ['tool_call', 'tool_call_update'].includes(update.sessionUpdate) &&
      update.status === 'failed' &&
      startupTitle === 'mcp__presentations__startup' &&
      /^mcp_startup\.presentations\./.test(update.toolCallId || '')
    ) {
      if (!entry.mcpFailure) {
        entry.mcpFailure = Object.assign(
          new Error(
            'Не удалось подключить инструменты презентации. Сессия закрыта; повторите запрос.',
          ),
          { status: 503 },
        );
        this.state = 'mcp-unavailable';
        entry.onEvent?.({
          type: 'status',
          status: 'mcp-unavailable',
          message: entry.mcpFailure.message,
        });
        this.dispose(entry);
      }
      return;
    }
    if (entry.replaying) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      if (!entry.active || !entry.pendingMessage) return;
      if (
        update.messageId &&
        entry.pendingMessage.id &&
        update.messageId !== entry.pendingMessage.id
      )
        this.flushActivity(entry);
      if (update.messageId) entry.pendingMessage.id = update.messageId;
      entry.pendingMessage.text += update.content.text;
      if (entry.pendingMessage.text.length > 500_000) this.dispose(entry);
    } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      if (update.sessionUpdate === 'tool_call') this.flushActivity(entry);
      const previous = entry.toolNames.get(update.toolCallId),
        name = previous || update.title?.slice(0, 512) || 'ACP tool';
      // Доверяем исходному имени вызова: последующая смена заголовка
      // не превращает нативный инструмент в разрешённый вызов MCP.
      if (
        update.sessionUpdate === 'tool_call' &&
        typeof update.toolCallId === 'string' &&
        update.toolCallId.length <= 256 &&
        update.title
      ) {
        if (!entry.toolNames.has(update.toolCallId) && entry.toolNames.size >= 256)
          entry.toolNames.delete(entry.toolNames.keys().next().value);
        entry.toolNames.set(
          update.toolCallId,
          previous && previous !== update.title ? 'ACP tool' : name,
        );
      }
      entry.onEvent?.({
        type: 'tool',
        toolCallId: update.toolCallId,
        name,
        status: update.status || 'running',
      });
    } else if (update.sessionUpdate === 'plan')
      entry.onEvent?.({ type: 'status', message: 'Агент составил план', plan: update.entries });
  }
  flushActivity(entry) {
    if (entry.pendingMessage?.text)
      entry.onEvent?.({ type: 'activity', text: entry.pendingMessage.text });
    entry.pendingMessage = { id: null, text: '' };
  }
  permission(entry, params) {
    if (!entry.active || params.sessionId !== entry.sessionId)
      return { outcome: { outcome: 'cancelled' } };
    const knownName = entry.toolNames.get(params.toolCall.toolCallId);
    // Разрешение получают только зарегистрированные MCP вызовы текущего scope.
    // Остальные сразу отклоняются; подтверждение в браузере не расширяет доступ.
    if (knownName && (entry.allowedTools || trustedMcpTools).has(knownName)) {
      const allow = params.options.find((option) => option.kind === 'allow_once');
      if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    }
    const reject =
      params.options.find((option) => option.kind === 'reject_once') ||
      params.options.find((option) => option.kind === 'reject_always');
    return reject
      ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }
  approve(projectId, requestId, outcome) {
    const error = new Error(
      'Агент работает только через инструменты презентации. Дополнительные разрешения отключены.',
    );
    error.status = 403;
    throw error;
  }
  dispose(entry) {
    if (entry.disposal) return entry.disposal;
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.cancelTimer);
    if (this.sessions.get(entry.projectId) === entry) this.sessions.delete(entry.projectId);
    entry.connection?.close();
    this.draining.add(entry);
    entry.disposal = stopOwnedProcess(entry).finally(() => this.draining.delete(entry));
    // Фоновые notifications не ждут остановки. Явный reset получает её ошибки
    // и не даёт удалить workspace, пока процесс ещё способен в него записывать.
    entry.disposal.catch(() => {});
    return entry.disposal;
  }
  close() {
    return Promise.all(
      [...new Set([...this.sessions.values(), ...this.draining])].map((entry) =>
        this.dispose(entry),
      ),
    );
  }
  reset(projectId) {
    return Promise.all(
      [...new Set([...this.sessions.values(), ...this.draining])]
        .filter((entry) => entry.projectId === projectId)
        .map((entry) => this.dispose(entry)),
    );
  }
}

async function stopOwnedProcess(entry) {
  const group =
    Number.isInteger(entry.processGroup) &&
    entry.processGroup > 1 &&
    entry.processGroup !== process.pid
      ? entry.processGroup
      : null;
  const signal = (name) => {
    try {
      if (group) process.kill(-group, name);
      else if (entry.child.exitCode === null) entry.child.kill(name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const alive = () => {
    if (!group) return entry.child.pid && entry.child.exitCode === null;
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 2000;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  // Группа может пережить wrapper: его exitCode не доказывает остановку Codex.
  // Оставшиеся дети, игнорирующие SIGTERM, получают SIGKILL.
  if (alive()) {
    signal('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function parseArgs(value) {
  if (!value) return [];
  const args = JSON.parse(value);
  if (
    !Array.isArray(args) ||
    args.length > 32 ||
    args.some((item) => typeof item !== 'string' || item.length > 1024)
  )
    throw new Error('Неверный ACP_ARGS_JSON.');
  return args;
}
async function timeout(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error('ACP-агент не ответил вовремя.'));
        }, ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
