import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, projectRoot } from './http/server.js';

export async function startApplication() {
  try {
    const { server } = await createServer(projectRoot, { port: Number(process.env.PORT || 3210) });
    console.log('Студия презентаций: ' + process.env.PUBLIC_ORIGIN);
    // Сохраняем прежний lifecycle: завершение процесса после закрытия HTTP.
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => server.close(() => process.exit(0)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await startApplication();
