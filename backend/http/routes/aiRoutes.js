import { json, body } from '../helpers.js';

export async function aiRoutes(context) {
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
  if (url.pathname === '/api/ai/settings' && req.method === 'GET') {
    json(res, await ai.settings());
    return true;
  }
  if (url.pathname === '/api/ai/settings' && req.method === 'PUT') {
    json(res, await ai.saveSettings(await body(req)));
    return true;
  }
  if (url.pathname === '/api/ai/status' && req.method === 'GET') {
    json(res, await ai.status());
    return true;
  }

  return false;
}
