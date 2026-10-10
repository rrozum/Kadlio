import path from 'node:path';

import { renderProject } from '../../engine/html/render.js';

import { rebaseDesign } from '../../engine/html/design.js';

import { shareOptions } from '../../modules/sharing/feedback.js';

import { clientAddress } from '../client-address.js';
import { mime, safeMethods, json, body, sendRuntime } from '../helpers.js';

export async function sharedRoutes(context) {
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
  const guestComment = /^\/s\/([\w-]{32})\/comments$/.exec(url.pathname);
  if (guestComment && req.method === 'POST') {
    json(
      res,
      await library.feedback.create(
        guestComment[1],
        await body(req, 20000),
        clientAddress(req, { trustProxy }),
      ),
    );
    return true;
  }
  const sharedRuntime = /^\/s\/([\w-]{32})\/slides\/(slide-\d+)\/runtime$/.exec(url.pathname);
  if (sharedRuntime && safeMethods.has(req.method)) {
    const project = await library.findShare(sharedRuntime[1]);
    await sendRuntime(
      req,
      res,
      root,
      library,
      project,
      sharedRuntime[2],
      url.searchParams.get('transitionId'),
    );
    return true;
  }
  const share = /^\/s\/([\w-]{32})(?:\/assets\/([\w.-]+))?$/.exec(url.pathname);
  if (share && safeMethods.has(req.method)) {
    const project = await library.findShare(share[1]);
    if (share[2]) {
      res.setHeader('Content-Type', mime[path.extname(share[2])] || 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : await library.asset(project.id, share[2]));
      return true;
    }
    const prefix = '/api/projects/' + project.id + '/assets/',
      publicPrefix = '/s/' + share[1] + '/assets/';
    const design = project.design ? rebaseDesign(project.design, prefix, publicPrefix) : null;
    const options = shareOptions(project);
    const visible = {
      id: project.id,
      title: project.title,
      author: project.author,
      brand: project.brand,
      design,
      timeline: project.timeline,
      css: project.css.split(prefix).join(publicPrefix),
      annotations: [],
      readOnly: true,
      publicShare: {
        ...options,
        commentUrl: '/s/' + share[1] + '/comments',
        runtimeBase: '/s/' + share[1] + '/slides',
      },
      slides: project.slides.map((slide) => ({
        id: slide.id,
        title: slide.title,
        layout: slide.layout,
        section: slide.section,
        kind: slide.kind,
        seconds: slide.seconds,
        notes: options.notes ? slide.notes : '',
        script: slide.script || '',
        elementEffects: slide.elementEffects || [],
        body: slide.body.split(prefix).join(publicPrefix),
      })),
    };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.method === 'HEAD' ? undefined : await renderProject(root, visible));
    return true;
  }

  return false;
}
