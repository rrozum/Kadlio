import path from 'node:path';

import { blockPresets, themePresets } from '../../../shared/addons/compositions/catalog.js';

import { mime, safeMethods, json, body } from '../helpers.js';

export async function catalogRoutes(context) {
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
  if (req.method === 'GET' && url.pathname === '/api/presets') {
    json(res, { blocks: blockPresets, themes: themePresets });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/elements') {
    json(res, { elements: await library.elements.list() });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/effect-snippets') {
    json(res, { snippets: await library.snippets.list() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/effect-snippets') {
    json(res, await library.snippets.create(await body(req)));
    return true;
  }
  const snippetRecord = /^\/api\/effect-snippets\/([\w-]+)$/.exec(url.pathname);
  if (snippetRecord && req.method === 'GET') {
    json(res, await library.snippets.get(snippetRecord[1]));
    return true;
  }
  if (snippetRecord && req.method === 'PATCH') {
    json(res, await library.snippets.update(snippetRecord[1], await body(req)));
    return true;
  }
  const elementRecord = /^\/api\/elements\/([\w-]+)(?:\/assets\/([\w.-]+))?$/.exec(url.pathname);
  if (elementRecord && safeMethods.has(req.method)) {
    if (elementRecord[2]) {
      const data = await library.elements.asset(elementRecord[1], elementRecord[2]);
      res.setHeader(
        'Content-Type',
        mime[path.extname(elementRecord[2])] || 'application/octet-stream',
      );
      res.end(req.method === 'HEAD' ? undefined : data);
    } else json(res, await library.elements.get(elementRecord[1]));
    return true;
  }

  return false;
}
