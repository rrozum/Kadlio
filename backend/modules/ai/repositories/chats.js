import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { readJSON, writeJSONAtomic } from '../../../storage/connectors/json-files.js';

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

export class ChatRepository {
  constructor(directory) {
    this.directory = directory;
    this.queues = new Map();
  }

  initialize() {
    return mkdir(path.join(this.directory, 'chats', 'themes'), { recursive: true, mode: 0o700 });
  }

  file(id, scope = 'project') {
    if (!['project', 'theme'].includes(scope)) throw invalid('Неверный контекст чата.');
    if (typeof id !== 'string' || !/^[-a-zA-Z0-9_]{1,100}$/.test(id))
      throw invalid('Неверный projectId.');
    return path.join(
      this.directory,
      'chats',
      ...(scope === 'theme' ? ['themes'] : []),
      id + '.json',
    );
  }

  key(id, scope = 'project') {
    this.file(id, scope);
    return scope === 'theme' ? 'theme:' + id : id;
  }

  queue(key, action) {
    // Ошибка одной операции не блокирует последующие записи этого же чата.
    // Исходный Promise возвращается вызывающему, чтобы он увидел свою ошибку.
    const next = (this.queues.get(key) || Promise.resolve()).then(action, action);
    this.queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  async read(id, scope = 'project') {
    try {
      return await readJSON(this.file(id, scope));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { schemaVersion: 1, messages: [], acpSessionId: null };
    }
  }

  mutate(id, action, scope = 'project', initialized) {
    return this.queue(this.key(id, scope), async () => {
      // Сначала ставим запись в очередь, затем ждём инициализации приложения.
      // Иначе конкурентное удаление может обогнать ещё не поставленную запись.
      await initialized;
      const chat = await this.read(id, scope);
      const result = await action(chat);
      await writeJSONAtomic(this.file(id, scope), chat);
      return result;
    });
  }

  async removeContext(id, scope = 'project') {
    // Вызывает только AIService после удаления канонического проекта/темы
    // и остановки его ACP-процессов. Другие чаты и настройки не затрагиваются.
    await Promise.all([
      rm(this.file(id, scope), { force: true }),
      rm(path.join(this.directory, 'attachments', ...(scope === 'theme' ? ['themes'] : []), id), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
      rm(path.join(this.directory, 'workspaces', ...(scope === 'theme' ? ['themes'] : []), id), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    ]);
    this.queues.delete(this.key(id, scope));
  }
}
