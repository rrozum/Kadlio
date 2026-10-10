import { shareOptions, updateShareOptions } from '../../modules/sharing/feedback.js';

import { json, body } from '../helpers.js';

export async function projectSharingRoutes(context) {
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
  if (route === '/feedback' && req.method === 'GET') {
    json(res, { feedback: await library.feedback.list(id) });
    return true;
  }
  const approveFeedback = /^\/feedback\/([\w-]+)\/approve$/.exec(route);
  if (approveFeedback && req.method === 'POST') {
    json(res, await library.feedback.approve(id, approveFeedback[1], ai));
    return true;
  }
  if (route === '/share' && req.method === 'PATCH') {
    json(res, await updateShareOptions(library, id, await body(req)));
    return true;
  }
  if (route === '/share' && req.method === 'POST') {
    const token = await library.share(id);
    json(res, { token, url: origin + '/s/' + token, options: shareOptions(await library.get(id)) });
    return true;
  }
  if (route === '/share' && req.method === 'DELETE') {
    await library.share(id, false);
    json(res, { ok: true });
    return true;
  }

  return false;
}
