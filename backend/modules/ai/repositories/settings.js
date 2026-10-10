import path from 'node:path';
import { chmod } from 'node:fs/promises';
import { readJSON, writeJSONAtomic } from '../../../storage/connectors/json-files.js';

const defaults = {
  provider: 'acp',
  apiMode: 'responses',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  apiKey: '',
};
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

export class SettingsRepository {
  constructor(directory) {
    this.file = path.join(directory, 'settings.json');
  }

  async load() {
    try {
      this.value = { ...defaults, ...(await readJSON(this.file)) };
      await chmod(this.file, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.value = { ...defaults };
    }
  }

  visible() {
    const { apiKey, ...visible } = this.value;
    return { ...visible, hasApiKey: Boolean(apiKey) };
  }

  next(value, providers) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw invalid('Неверные настройки.');
    const allowed = ['provider', 'apiMode', 'baseUrl', 'model', 'apiKey', 'clearApiKey'];
    if (Object.keys(value).some((key) => !allowed.includes(key)))
      throw invalid(
        'Неизвестное поле настроек. Команда ACP задаётся только администратором сервера.',
      );
    const next = { ...this.value };
    // Регистрация провайдеров разрешена только кодом сервера. HTTP-настройки
    // выбирают существующий адаптер и не задают команду запуска ACP.
    if (value.provider !== undefined) {
      if (!providers.has(value.provider)) throw invalid('Неверный провайдер.');
      next.provider = value.provider;
    }
    if (value.apiMode !== undefined) {
      if (!['responses', 'chat-completions'].includes(value.apiMode))
        throw invalid('Неверный API-режим.');
      next.apiMode = value.apiMode;
    }
    if (value.baseUrl !== undefined) {
      let url;
      try {
        url = new URL(value.baseUrl);
      } catch {
        throw invalid('Неверный адрес API.');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        ['169.254.169.254', 'metadata.google.internal'].includes(url.hostname)
      )
        throw invalid('Неверный адрес API.');
      next.baseUrl = value.baseUrl.replace(/\/$/, '');
    }
    if (value.model !== undefined) {
      if (typeof value.model !== 'string' || value.model.length > 200)
        throw invalid('Неверное имя модели.');
      next.model = value.model.trim();
    }
    if (value.apiKey !== undefined) {
      if (
        typeof value.apiKey !== 'string' ||
        value.apiKey.length > 5000 ||
        /[\r\n]/.test(value.apiKey)
      )
        throw invalid('Неверный API-ключ.');
      if (value.apiKey.trim()) next.apiKey = value.apiKey.trim();
    }
    if (value.clearApiKey === true) next.apiKey = '';
    return next;
  }

  async save(value) {
    await writeJSONAtomic(this.file, value);
    this.value = value;
  }
}
