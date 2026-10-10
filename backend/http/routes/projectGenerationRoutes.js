import { badRequest } from '../../engine/errors.js';

import { body } from '../helpers.js';

export async function projectGenerationRoutes(context) {
  const {
    id,
    route,
    req,
    res,
    url,
    root,
    library,
    ai,
    username,
    origin,
    trustProxy,
    transcriber,
    exportState,
  } = context;
  if (route === '/generate' && req.method === 'POST') {
    if (Object.keys(await body(req)).length)
      throw badRequest('Генерация использует сохранённое описание и материалы проекта.');
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    await ai.generate({
      projectId: id,
      signal: controller.signal,
      onEvent: (event) => {
        if (res.destroyed) return true;
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders();
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
    });
    res.end();
    return true;
  }

  return false;
}
