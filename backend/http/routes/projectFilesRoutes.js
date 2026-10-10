import path from 'node:path';

import { materialLimits } from '../../modules/uploads/materials.js';

import { mime, safeMethods, json, body } from '../helpers.js';

export async function projectFilesRoutes(context) {
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
  if (route === '/assets' && req.method === 'POST') {
    json(res, await library.uploadAsset(id, await body(req, 23_000_000)));
    return true;
  }
  if (route === '/materials' && req.method === 'GET') {
    json(res, { materials: await library.materials.list(id), limits: materialLimits });
    return true;
  }
  if (route === '/materials' && req.method === 'POST') {
    json(res, await library.materials.create(id, await body(req, 13_000_000)));
    return true;
  }
  const material = /^\/materials\/([\w-]+)(?:\/file)?$/.exec(route);
  if (material && safeMethods.has(req.method)) {
    const { metadata, buffer } = await library.materials.read(id, material[1]);
    res.setHeader('Content-Type', metadata.mime || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      (metadata.kind === 'image' ? 'inline' : 'attachment') +
        "; filename*=UTF-8''" +
        encodeURIComponent(metadata.name).replace(/'/g, '%27'),
    );
    res.end(req.method === 'HEAD' ? undefined : buffer);
    return true;
  }
  if (material && req.method === 'DELETE' && !route.endsWith('/file')) {
    json(res, await library.materials.remove(id, material[1]));
    return true;
  }
  const asset = /^\/assets\/([\w.-]+)$/.exec(route);
  if (asset && safeMethods.has(req.method)) {
    res.setHeader('Content-Type', mime[path.extname(asset[1])] || 'application/octet-stream');
    res.end(req.method === 'HEAD' ? undefined : await library.asset(id, asset[1]));
    return true;
  }
  if (route === '/attachments' && req.method === 'POST') {
    json(res, await ai.attachments.create(id, await body(req, 13_000_000)));
    return true;
  }
  const attachment = /^\/attachments\/([\w-]+)(?:\/file)?$/.exec(route);
  if (attachment && safeMethods.has(req.method)) {
    const { metadata, buffer } = await ai.attachments.read(id, attachment[1]);
    res.setHeader('Content-Type', metadata.mime || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      (metadata.kind === 'image' ? 'inline' : 'attachment') +
        "; filename*=UTF-8''" +
        encodeURIComponent(metadata.name).replace(/'/g, '%27'),
    );
    res.end(req.method === 'HEAD' ? undefined : buffer);
    return true;
  }

  return false;
}
