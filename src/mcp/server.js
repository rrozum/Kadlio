// Совместимость прежнего запуска stdio MCP. HTTP-приложение использует новый модуль.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStdioMcp } from '../../backend/modules/mcp/server.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await startStdioMcp();
