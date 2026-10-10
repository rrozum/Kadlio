import path from 'node:path';

// Конфигурация транспорта и путей собирается один раз. Модули получают
// зависимости/параметры явно; секреты не переходят в интерфейс или презентацию.
export function serverConfig(root, overrides = {}) {
  return {
    port: 0,
    host: process.env.HOST || '127.0.0.1',
    authRequired: true,
    publicOrigin: process.env.PUBLIC_ORIGIN,
    authFile: process.env.AUTH_DB,
    initialAdmin: {
      username: process.env.ADMIN_USERNAME || '',
      password: process.env.ADMIN_PASSWORD || '',
    },
    dataDir: process.env.PROJECTS_DATA_DIR || path.join(root, 'data'),
    legacyRoot: process.env.PRESENTATION_LEGACY_ROOT,
    dataFile: process.env.PRESENTATION_DATA_FILE,
    aiOptions: {},
    transcriptionOptions: {},
    documentPreviewOptions: {},
    trustProxy: process.env.TRUST_PROXY || false,
    ...overrides,
  };
}
