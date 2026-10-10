import path from 'node:path';

import { notFound } from '../../engine/errors.js';

import { mime, safeMethods, json, htmlFile, body, allowTourFrame } from '../helpers.js';

export async function themeRoutes(context) {
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
  if (req.method === 'GET' && url.pathname === '/themes') {
    await htmlFile(res, root, 'themes.html');
    return true;
  }
  const themePage = /^\/themes\/([\w-]+)$/.exec(url.pathname);
  if (req.method === 'GET' && themePage) {
    await library.themes.get(themePage[1]);
    if (url.searchParams.get('embed') === 'tour') allowTourFrame(res);
    await htmlFile(res, root, 'theme-editor.html');
    return true;
  }
  if (url.pathname === '/api/themes' && req.method === 'GET') {
    json(res, { themes: await library.themes.list() });
    return true;
  }
  if (url.pathname === '/api/themes' && req.method === 'POST') {
    json(res, await library.themes.create(await body(req)));
    return true;
  }
  const themeAPI = /^\/api\/themes\/([\w-]+)(.*)$/.exec(url.pathname);
  if (themeAPI) {
    const id = themeAPI[1],
      route = themeAPI[2];
    await library.themes.get(id);
    if (!route && req.method === 'GET') {
      json(res, await library.themes.get(id));
      return true;
    }
    if (!route && req.method === 'PATCH') {
      json(res, await library.themes.update(id, await body(req)));
      return true;
    }
    if (!route && req.method === 'DELETE') {
      json(res, await ai.deleteContext(id, 'theme', await body(req)));
      return true;
    }
    if (route === '/elements' && req.method === 'POST') {
      json(res, await library.insertThemeElement(id, await body(req)));
      return true;
    }
    if (route === '/chat' && req.method === 'GET') {
      json(res, await ai.history(id, 'theme'));
      return true;
    }
    if (route === '/chat' && req.method === 'DELETE') {
      json(res, await ai.resetHistory(id, 'theme'));
      return true;
    }
    if (route === '/chat/cancel' && req.method === 'POST') {
      json(res, ai.cancel(id, 'theme'));
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
        themeId: id,
        message: payload.message,
        attachmentIds: payload.attachmentIds,
        signal: controller.signal,
        onEvent: (event) => {
          if (!res.destroyed) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        },
      });
      res.end();
      return true;
    }
    if (route === '/attachments' && req.method === 'POST') {
      json(res, await ai.themeAttachments.create(id, await body(req, 13_000_000)));
      return true;
    }
    const attachment = /^\/attachments\/([\w-]+)(?:\/file)?$/.exec(route);
    if (attachment && safeMethods.has(req.method)) {
      const { metadata, buffer } = await ai.themeAttachments.read(id, attachment[1]);
      res.setHeader('Content-Type', metadata.mime);
      res.setHeader(
        'Content-Disposition',
        `${metadata.kind === 'image' ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16))}`,
      );
      res.end(req.method === 'HEAD' ? undefined : buffer);
      return true;
    }
    if (route === '/preview' && ['GET', 'POST'].includes(req.method)) {
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      json(res, await library.renderer.renderTheme(id, { signal: controller.signal }));
      return true;
    }
    if (route === '/assets' && req.method === 'POST') {
      json(res, await library.themes.uploadAsset(id, await body(req, 23_000_000)));
      return true;
    }
    const asset = /^\/assets\/([\w.-]+)$/.exec(route);
    if (asset && safeMethods.has(req.method)) {
      res.setHeader('Content-Type', mime[path.extname(asset[1])] || 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : await library.themes.asset(id, asset[1]));
      return true;
    }
    throw notFound('Не найдено');
  }

  return false;
}
