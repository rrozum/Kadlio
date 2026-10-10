import { json, body } from '../helpers.js';

export async function transcriptionRoutes(context) {
  const {
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
  if (req.method === 'GET' && url.pathname === '/api/transcription/status') {
    json(res, await transcriber.status());
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/transcription') {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    json(
      res,
      await transcriber.transcribe(await body(req, 3_000_000), { signal: controller.signal }),
    );
    return true;
  }

  return false;
}
