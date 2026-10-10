// Совместимость с прежним systemd ExecStart. Новый вход приложения — backend/main.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApplication } from '../backend/main.js';
export { createServer, projectRoot } from '../backend/http/server.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await startApplication();
