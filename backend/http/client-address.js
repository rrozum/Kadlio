import { isIP } from 'node:net';

// Forwarded headers are trusted only behind an explicitly configured local
// proxy. Use the nearest hop, never a client-controlled prefix of the chain.
export function clientAddress(req, { trustProxy = false } = {}) {
  const peer = req.socket.remoteAddress || 'unknown';
  if (trustProxy !== 'loopback' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer))
    return peer;
  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || header.length > 2048) return peer;
  const nearest = header.split(',').at(-1).trim();
  return isIP(nearest) ? nearest : peer;
}
