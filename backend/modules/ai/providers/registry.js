import { runOpenAI } from '../openai.js';
import { buildACPContext } from '../context.js';

const unavailable = (message) => Object.assign(new Error(message), { status: 409 });

// Простой явный контракт: id, validate(settings), preflight(settings), run(turn).
// Новый адаптер добавляется здесь кодом; автопоиска и регистрации через HTTP нет.
// validate проверяет настройки перед обычным сообщением; preflight проверяет
// готовность перед генерацией, пока её статус и история ещё не изменены.
export class ProviderRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    if (
      !provider ||
      typeof provider.id !== 'string' ||
      !/^[a-z0-9-]+$/.test(provider.id) ||
      typeof provider.run !== 'function' ||
      typeof provider.validate !== 'function' ||
      typeof provider.preflight !== 'function'
    )
      throw new Error('Неверный адаптер ИИ-провайдера.');
    if (this.providers.has(provider.id))
      throw new Error(`ИИ-провайдер ${provider.id} уже зарегистрирован.`);
    this.providers.set(provider.id, provider);
    return this;
  }

  has(id) {
    return this.providers.has(id);
  }

  get(id) {
    const provider = this.providers.get(id);
    if (!provider) throw Object.assign(new Error('Неверный провайдер.'), { status: 400 });
    return provider;
  }

  reset(contextKey) {
    // Контекст мог использовать несколько провайдеров до очистки чата.
    // Останавливаем их сохранённые сессии, а не только выбранный сейчас адаптер.
    return Promise.all(
      [...this.providers.values()].map((provider) => provider.reset?.(contextKey)),
    );
  }

  close() {
    return Promise.all([...this.providers.values()].map((provider) => provider.close?.()));
  }
}

export function createProviderRegistry({ acp }) {
  const validateOpenAI = (settings) => {
    if (!settings.apiKey || !settings.model)
      throw unavailable('В настройках ИИ укажите API-ключ и имя модели.');
  };
  return new ProviderRegistry([
    {
      id: 'openai',
      validate: validateOpenAI,
      preflight: validateOpenAI,
      run({
        settings,
        recent,
        selected,
        attachmentContext,
        id,
        themeId,
        projectContext,
        tools,
        signal,
        onEvent,
        clientFactory,
      }) {
        return runOpenAI({
          settings,
          messages: recent.map((item) =>
            item.id === selected.id ? { ...item, attachmentContext } : item,
          ),
          ...(themeId ? { themeId } : { projectId: id }),
          projectContext,
          tools,
          signal,
          onEvent,
          clientFactory,
        });
      },
    },
    {
      id: 'acp',
      validate() {},
      reset(contextKey) {
        return acp.reset(contextKey);
      },
      close() {
        return acp.close();
      },
      async preflight() {
        if (!(await acp.available())) throw unavailable('Codex ACP недоступен на сервере.');
      },
      run(turn) {
        return acp.prompt({
          projectId: turn.key,
          ...(turn.themeId ? { themeId: turn.themeId } : {}),
          prompt: buildACPContext(turn),
          images: turn.attachmentContext.images,
          previousSessionId: turn.chat.acpSessionId,
          onSession: turn.onSession,
          signal: turn.signal,
          onEvent: turn.onEvent,
        });
      },
    },
  ]);
}
