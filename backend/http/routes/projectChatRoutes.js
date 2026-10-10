import { json, body } from '../helpers.js';

export async function projectChatRoutes(context) {
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
  if (route === '/chat' && req.method === 'GET') {
    json(res, await ai.history(id));
    return true;
  }
  if (route === '/chat' && req.method === 'DELETE') {
    json(res, await ai.resetHistory(id));
    return true;
  }
  if (route === '/chat/cancel' && req.method === 'POST') {
    json(res, ai.cancel(id));
    return true;
  }
  if (route === '/chat/permission' && req.method === 'POST') {
    const payload = await body(req);
    json(res, ai.approve(id, payload.requestId, payload.outcome));
    return true;
  }
  if (route === '/chat' && req.method === 'POST') {
    const payload = await body(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    await ai.send({
      projectId: id,
      message: payload.message,
      slideId: payload.slideId,
      annotationId: payload.annotationId,
      attachmentIds: payload.attachmentIds,
      signal: controller.signal,
      onEvent: (event) => {
        if (!res.destroyed) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
    });
    res.end();
    return true;
  }

  return false;
}
