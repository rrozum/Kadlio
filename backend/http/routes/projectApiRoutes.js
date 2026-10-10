import { projectFilesRoutes } from './projectFilesRoutes.js';
import { projectGenerationRoutes } from './projectGenerationRoutes.js';
import { projectChatRoutes } from './projectChatRoutes.js';
import { projectSharingRoutes } from './projectSharingRoutes.js';
import { projectExportRoutes } from './projectExportRoutes.js';

import { badRequest } from '../../engine/errors.js';

import { copyProject } from '../../engine/presentations/copy.js';

import { insertPresentationIcon } from '../../modules/addons/icons.js';

import { safeMethods, json, body, sendRuntime, decorate } from '../helpers.js';

export async function projectApiRoutes(context) {
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
  const api = /^\/api\/projects\/([\w-]+)(.*)$/.exec(url.pathname);
  if (api) {
    const id = api[1],
      route = api[2];
    await library.getStore(id);
    if (!route && req.method === 'GET') {
      json(res, decorate(await library.get(id), origin));
      return true;
    }
    if (!route && req.method === 'PATCH') {
      json(res, decorate(await library.rename(id, await body(req)), origin));
      return true;
    }
    if (!route && req.method === 'DELETE') {
      json(res, await ai.deleteContext(id, 'project', await body(req)));
      return true;
    }
    if (route === '/copy' && req.method === 'POST') {
      const payload = await body(req);
      if (Object.keys(payload).some((key) => key !== 'version'))
        throw badRequest('Для копирования укажите только версию проекта.');
      json(res, decorate(await copyProject(library, id, payload), origin));
      return true;
    }
    if (route === '/design' && req.method === 'PATCH') {
      json(res, decorate(await library.updateDesign(id, await body(req)), origin));
      return true;
    }
    if (route === '/timeline' && req.method === 'PATCH') {
      json(res, decorate(await library.updateTimeline(id, await body(req)), origin));
      return true;
    }
    if (route === '/css' && req.method === 'PATCH') {
      json(res, decorate(await library.updateCSS(id, await body(req)), origin));
      return true;
    }
    if (route === '/theme' && req.method === 'POST') {
      json(res, decorate(await library.applyTheme(id, await body(req)), origin));
      return true;
    }
    if (route === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const send = (event) => {
        if (event.id === id && !res.destroyed)
          res.write(
            `id: ${event.revision}\ndata: ${JSON.stringify({ version: event.version, updatedAt: event.updatedAt, revision: event.revision })}\n\n`,
          );
      };
      library.events.on('projectChanged', send);
      const keepalive = setInterval(() => {
        if (!res.destroyed) res.write(': heartbeat\n\n');
      }, 20000);
      keepalive.unref();
      res.on('close', () => {
        clearInterval(keepalive);
        library.events.off('projectChanged', send);
      });
      return true;
    }
    if (route === '/notes' && req.method === 'PATCH') {
      json(res, await (await library.getStore(id)).saveNotes((await body(req)).changes));
      return true;
    }
    if (route === '/slides' && req.method === 'POST') {
      json(res, await library.addSlide(id, await body(req)));
      return true;
    }
    if (route === '/variables' && req.method === 'PATCH') {
      json(res, decorate(await library.updateVariables(id, await body(req)), origin));
      return true;
    }
    if (route === '/slides/reorder' && req.method === 'POST') {
      json(res, decorate(await library.reorder(id, (await body(req)).ids), origin));
      return true;
    }
    const duplicate = /^\/slides\/(slide-\d+)\/copy$/.exec(route);
    if (duplicate && req.method === 'POST') {
      json(res, decorate(await library.duplicateSlide(id, duplicate[1], await body(req)), origin));
      return true;
    }
    const preset = /^\/slides\/(slide-\d+)\/preset$/.exec(route);
    if (preset && req.method === 'POST') {
      json(res, await library.insertPreset(id, preset[1], await body(req)));
      return true;
    }
    const element = /^\/slides\/(slide-\d+)\/elements?$/.exec(route);
    if (element && req.method === 'POST') {
      json(res, await library.insertElement(id, element[1], await body(req)));
      return true;
    }
    const icon = /^\/slides\/(slide-\d+)\/icons?$/.exec(route);
    if (icon && req.method === 'POST') {
      json(res, await insertPresentationIcon(library, id, icon[1], await body(req)));
      return true;
    }
    const elementEffect = /^\/slides\/(slide-\d+)\/effect$/.exec(route);
    if (elementEffect && req.method === 'POST') {
      json(res, await library.applyElementEffect(id, elementEffect[1], await body(req)));
      return true;
    }
    const preview = /^\/slides\/(slide-\d+)\/preview$/.exec(route);
    if (preview && ['GET', 'POST'].includes(req.method)) {
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const options = req.method === 'POST' ? await body(req, 2_000_000, { allowEmpty: true }) : {};
      if (Object.keys(options).some((key) => key !== 'atMs'))
        throw badRequest('Неизвестные параметры предпросмотра.');
      json(
        res,
        await library.renderer.render(id, preview[1], {
          signal: controller.signal,
          atMs: options.atMs,
        }),
      );
      return true;
    }
    const runtime = /^\/slides\/(slide-\d+)\/runtime$/.exec(route);
    if (runtime && safeMethods.has(req.method)) {
      await sendRuntime(
        req,
        res,
        root,
        library,
        await library.get(id),
        runtime[1],
        url.searchParams.get('transitionId'),
      );
      return true;
    }
    const slide = /^\/slides\/(slide-\d+)$/.exec(route);
    if (slide && req.method === 'PATCH') {
      json(res, await library.updateSlide(id, slide[1], await body(req)));
      return true;
    }
    if (slide && req.method === 'DELETE') {
      json(res, decorate(await library.removeSlide(id, slide[1]), origin));
      return true;
    }
    if (route === '/annotations' && req.method === 'POST') {
      const annotation = await (await library.getStore(id)).saveAnnotation(await body(req)),
        message = await ai.appendAnnotation(id, annotation);
      json(res, { annotation, message });
      return true;
    }
    if (route === '/annotations/import' && req.method === 'POST') {
      const annotations = await (
        await library.getStore(id)
      ).importAnnotations((await body(req)).annotations);
      for (const annotation of annotations) await ai.appendAnnotation(id, annotation);
      json(res, annotations);
      return true;
    }
    if (route.startsWith('/annotations/') && req.method === 'DELETE') {
      json(
        res,
        await (await library.getStore(id)).deleteAnnotation(decodeURIComponent(route.slice(13))),
      );
      return true;
    }
    if (await projectFilesRoutes({ ...context, id, route })) return true;
    if (await projectGenerationRoutes({ ...context, id, route })) return true;
    if (await projectSharingRoutes({ ...context, id, route })) return true;
    if (await projectChatRoutes({ ...context, id, route })) return true;
    if (await projectExportRoutes({ ...context, id, route })) return true;
  }

  return false;
}
