import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { badRequest, notFound } from '../engine/errors.js';
import { createThemeTools } from '../modules/mcp/tools.js';
import { sendStatic } from './static.js';
import { clientAddress } from './client-address.js';
import { projectApiRoutes } from './routes/projectApiRoutes.js';
import { projectRoutes } from './routes/projectRoutes.js';
import { aiRoutes } from './routes/aiRoutes.js';
import { transcriptionRoutes } from './routes/transcriptionRoutes.js';
import { themeRoutes } from './routes/themeRoutes.js';
import { catalogRoutes } from './routes/catalogRoutes.js';
import { sharedRoutes } from './routes/sharedRoutes.js';
import { mime, safeMethods, json, redirect, htmlFile, body } from './helpers.js';
import { createApplication } from '../application/index.js';
import { resolveApplicationFile, canonicalApplicationPath } from './resources.js';
import { serverConfig } from '../config.js';

export const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export async function createServer(root = projectRoot, options = {}) {
  const config = serverConfig(root, options);
  const { port, host, authRequired, publicOrigin, trustProxy } = config;
  if (authRequired && !publicOrigin) throw new Error('Задайте PUBLIC_ORIGIN для сайта.');
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin)
    throw new Error('PUBLIC_ORIGIN должен быть origin без завершающего слеша.');
  const application = await createApplication(root, config);
  const { library, auth, agentToken, tools, mcp, transcriber, exportState } = application;
  let ai;
  const authenticatedAgent = (req) => {
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization || '')) return false;
    const supplied = Buffer.from(req.headers.authorization.slice(7)),
      expected = Buffer.from(agentToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const base = `http://127.0.0.1:${server.address().port}`,
        url = new URL(req.url, base);
      const localHosts = [
        `127.0.0.1:${server.address().port}`,
        `localhost:${server.address().port}`,
      ];
      if (![...localHosts, publicOrigin && new URL(publicOrigin).host].includes(req.headers.host))
        throw Object.assign(new Error('Неверный Host'), { status: 403 });
      const bridge =
        url.pathname === '/api/agent-tools' &&
        localHosts.includes(req.headers.host) &&
        authenticatedAgent(req);
      const mcpAccess = url.pathname === '/mcp' && authenticatedAgent(req);
      const allowedOrigins = authRequired
        ? [publicOrigin]
        : [base, `http://localhost:${server.address().port}`];
      if (
        !safeMethods.has(req.method) &&
        !bridge &&
        !mcpAccess &&
        ((authRequired && !req.headers.origin) ||
          (req.headers.origin && !allowedOrigins.includes(req.headers.origin)))
      )
        throw Object.assign(new Error('Неверный Origin'), { status: 403 });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      if (url.pathname === '/api/agent-tools') {
        if (!bridge)
          throw Object.assign(new Error('Требуется токен агента и loopback.'), { status: 401 });
        if (req.method !== 'POST') throw notFound();
        const payload = await body(req),
          controller = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) controller.abort();
        });
        if (payload.projectId && payload.themeId)
          throw badRequest('Выберите один контекст инструмента.');
        const scopedTools = payload.themeId
          ? createThemeTools(library, { boundThemeId: payload.themeId })
          : tools;
        json(
          res,
          await scopedTools.execute(payload.name, payload.arguments || {}, {
            signal: controller.signal,
            ...(payload.projectId ? { projectId: payload.projectId } : {}),
            ...(payload.themeId ? { themeId: payload.themeId } : {}),
          }),
        );
        return;
      }
      if (url.pathname === '/mcp') {
        if (!mcpAccess)
          throw Object.assign(new Error('Требуется Bearer-токен MCP.'), { status: 401 });
        await mcp(req, res, req.method === 'POST' ? await body(req) : undefined);
        return;
      }
      if (await sharedRoutes({ req, res, url, root, library, trustProxy })) return;
      const username = auth?.user(req);
      if (req.method === 'GET' && url.pathname === '/login') {
        if (!auth || username) {
          redirect(res, '/');
          return;
        }
        await htmlFile(res, root, 'login.html');
        return;
      }
      if (auth && req.method === 'POST' && url.pathname === '/api/login') {
        const credentials = await body(req, 4096),
          token = await auth.login(
            credentials.username,
            credentials.password,
            clientAddress(req, { trustProxy }),
          );
        if (!token) throw Object.assign(new Error('Неверный логин или пароль.'), { status: 401 });
        res.setHeader('Set-Cookie', auth.cookie(token));
        json(res, { ok: true });
        return;
      }
      const publicFiles = [
        '/app.js',
        '/modules/navigation.js',
        '/modules/page-lifecycle.js',
        '/assets/kadlio.svg',
        '/modules/brand.css',
        '/login.css',
        '/login.js',
        '/deck.css',
        '/deck.js',
        '/modules/theme-init.js',
        '/modules/theme.js',
        '/modules/theme.css',
        '/modules/presentation-effects.js',
        '/modules/presentation-timeline.js',
        '/modules/slide-runtime-player.js',
        '/fonts/Geist-Variable.woff2',
      ];
      if (
        auth &&
        !username &&
        !publicFiles.includes(url.pathname) &&
        !url.pathname.startsWith('/shared/')
      ) {
        if (url.pathname.startsWith('/api/'))
          throw Object.assign(new Error('Войдите в аккаунт, чтобы продолжить.'), { status: 401 });
        redirect(res, '/login?next=' + encodeURIComponent(url.pathname + url.search));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        auth?.logout(req);
        if (auth) res.setHeader('Set-Cookie', auth.cookie(''));
        json(res, { ok: true });
        return;
      }
      const origin = publicOrigin || base;
      const context = {
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
      };
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/projects')) {
        await htmlFile(res, root, 'projects.html');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/projects/new') {
        await htmlFile(res, root, 'project-new.html');
        return;
      }
      if (await catalogRoutes(context)) return;
      if (await themeRoutes(context)) return;
      if (await transcriptionRoutes(context)) return;
      if (await projectRoutes(context)) return;
      if (await aiRoutes(context)) return;
      if (await projectApiRoutes(context)) return;
      if (safeMethods.has(req.method)) {
        const canonical = canonicalApplicationPath(url.pathname);
        if (canonical !== url.pathname) {
          res.writeHead(307, { Location: canonical });
          res.end();
          return;
        }
        const file = resolveApplicationFile(root, url.pathname);
        if (!file || !mime[path.extname(file)]) throw notFound('Не найдено');
        res.setHeader('Content-Type', mime[path.extname(file)]);
        await sendStatic(req, res, file);
        return;
      }
      throw notFound('Не найдено');
    } catch (error) {
      if (res.headersSent) {
        if (String(res.getHeader('Content-Type')).startsWith('text/event-stream'))
          res.end(
            'event: error\ndata: ' +
              JSON.stringify({
                type: 'error',
                message: error.status ? error.message : 'Ошибка сервера.',
              }) +
              '\n\n',
          );
        else res.destroy();
        return;
      }
      res.statusCode = error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (res.statusCode === 500) console.error('Request failed:', error.message);
      json(res, {
        error: res.statusCode === 500 ? 'Ошибка сервера. Повторите попытку.' : error.message,
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  ai = await application.startAI(url);
  server.on('close', () => application.close());
  return { server, library, engine: library, ai, url };
}
