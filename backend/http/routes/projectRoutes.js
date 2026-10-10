import { renderProject } from '../../engine/html/render.js';

import { json, htmlFile, body, decorate, allowTourFrame } from '../helpers.js';

export async function projectRoutes(context) {
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
  const page = /^\/projects\/([\w-]+)(\/view)?$/.exec(url.pathname);
  if (req.method === 'GET' && page) {
    const project = await library.get(page[1]);
    if (!page[2]) {
      await htmlFile(res, root, 'editor.html');
      return true;
    }
    if (url.searchParams.get('embed') === 'tour') allowTourFrame(res);
    const html = await renderProject(root, {
      ...project,
      username,
      apiBase: '/api/projects/' + project.id,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      url.searchParams.get('embed') === 'tour'
        ? html
        : html.replace(
            '</body>',
            `<a class="viewer-back" href="/projects/${project.id}">Редактор</a></body>`,
          ),
    );
    return true;
  }
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    json(res, { projects: await library.list() });
    return true;
  }
  if (url.pathname === '/api/projects' && req.method === 'POST') {
    json(res, decorate(await library.create(await body(req)), origin));
    return true;
  }
  if (url.pathname === '/api/projects/import-pptx' && req.method === 'POST') {
    json(res, decorate(await library.importPptx(await body(req, 13_000_000)), origin));
    return true;
  }

  return false;
}
