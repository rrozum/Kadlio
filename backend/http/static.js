import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Only application assets use this path. HTML, authenticated API
// responses and presentation assets retain their existing no-store behavior.
const files = new Map();
export async function sendStatic(req, res, file) {
  const metadata = await stat(file);
  let asset = files.get(file);
  if (!asset || asset.mtime !== metadata.mtimeMs || asset.size !== metadata.size) {
    const body = await readFile(file);
    asset = {
      body,
      mtime: metadata.mtimeMs,
      size: metadata.size,
      etag: '"' + createHash('sha256').update(body).digest('hex') + '"',
    };
    files.set(file, asset);
  }
  const pinned = /[/\\]vendor[/\\](?:prettier-\d[\d.]*|prismjs-\d[\d.]*)[/\\]/.test(file);
  res.setHeader(
    'Cache-Control',
    pinned
      ? 'private, max-age=31536000, immutable'
      : path.extname(file) === '.woff2'
        ? 'private, max-age=86400'
        : 'private, no-cache',
  );
  res.setHeader('ETag', asset.etag);
  res.setHeader('Last-Modified', new Date(asset.mtime).toUTCString());
  const matches = req.headers['if-none-match']
    ?.split(',')
    .some((value) => value.trim().replace(/^W\//, '') === asset.etag || value.trim() === '*');
  if (matches) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.setHeader('Content-Length', asset.body.length);
  res.end(req.method === 'HEAD' ? undefined : asset.body);
}
