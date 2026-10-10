import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { badRequest } from '../engine/errors.js';
import { shareOptions } from '../modules/sharing/feedback.js';
import { slideRuntimeDocument, runtimeCSP } from '../modules/addons/runtime.js';
export const mime = {
  '.woff2': 'font/woff2',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
export const safeMethods = new Set(['GET', 'HEAD']);
export async function sendRuntime(req, res, root, library, project, slideId, transitionId) {
  const html = await slideRuntimeDocument({
    root,
    project,
    slideId,
    readAsset: (name) => library.asset(project.id, name),
    ...(transitionId ? { transitionId } : {}),
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', runtimeCSP);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.end(req.method === 'HEAD' ? undefined : html);
}
export function decorate(project, origin) {
  const { shareToken, ...visible } = project;
  return {
    ...visible,
    shareOptions: shareOptions(project),
    shareUrl: shareToken ? origin + '/s/' + shareToken : null,
  };
}
export function json(res, data) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
export function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}
export function allowTourFrame(res) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    String(res.getHeader('Content-Security-Policy')).replace(
      "frame-ancestors 'none'",
      "frame-ancestors 'self'",
    ),
  );
}
export async function htmlFile(res, root, name) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(await readFile(path.join(root, 'frontend', name)));
}
export async function body(req, limit = 2_000_000, { allowEmpty = false } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw badRequest('Слишком большой запрос');
    chunks.push(chunk);
  }
  if (!bytes && allowEmpty) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw badRequest('Неверный JSON');
  }
}
