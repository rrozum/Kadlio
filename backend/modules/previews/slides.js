import { resolveApplicationFile } from '../../http/resources.js';
import { chromium } from 'playwright';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { slideDocument } from '../../../shared/presentation/slide-document.js';
import { themePreviewDocument } from '../../../shared/presentation/theme-preview.js';
import { parseHTML } from 'linkedom';
import { createPresentationDesign } from '../../../shared/presentation/design.js';
import { slideRuntimeDocument, runtimeCSP, hasSlideRuntime } from '../addons/runtime.js';

const failure = (message, status) => Object.assign(new Error(message), { status });
const types = {
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// Агент получает изображение того же HTML, что редактор. Он не выбирает
// произвольный URL, исполняемый файл, браузерный script или путь для просмотра.
export function createSlideRenderer({ root, library, timeoutMs = 25000, launchBrowser } = {}) {
  let busy = false,
    active = null;
  async function renderDocument(source, { signal, atMs = 800 } = {}) {
    if (!Number.isInteger(atMs) || atMs < 0 || atMs > 5000)
      throw failure('atMs должен быть целым числом от 0 до 5000.', 400);
    if (busy) throw failure('Предпросмотр уже создаётся. Дождитесь завершения.', 429);
    busy = true;
    let browser, timer;
    const startedAt = Date.now();
    try {
      signal?.throwIfAborted();
      const { document, identity, assetPrefix, readAsset, runtime = false } = await source();
      browser = await (launchBrowser || launch)();
      active = browser;
      const controller = new AbortController();
      const abort = () => {
        controller.abort(signal?.reason);
        browser.close().catch(() => {});
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(
        () => {
          controller.abort(failure('Предпросмотр занял слишком много времени.', 504));
          browser.close().catch(() => {});
        },
        Math.max(1, Math.min(timeoutMs, 25000) - (Date.now() - startedAt)),
      );
      timer.unref();
      try {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
            reducedMotion: runtime ? 'no-preference' : 'reduce',
            javaScriptEnabled: runtime,
            serviceWorkers: 'block',
          }),
          page = await context.newPage();
        page.setDefaultTimeout(Math.min(timeoutMs, 25000));
        const blocked = new Set(),
          fixedCSS =
            'html,body{margin:0!important;padding:0!important;width:1280px!important;height:720px!important;overflow:hidden!important}.slide{width:1280px!important;height:720px!important;transform:none!important;overflow:hidden!important}*,*:before,*:after{animation:none!important;transition:none!important}';
        const html = runtime
          ? document
          : document.replace('</head>', '<style>' + fixedCSS + '</style></head>');
        await page.route('**/*', async (route) => {
          try {
            const url = new URL(route.request().url());
            if (url.origin !== 'http://presentation.local') {
              blocked.add('external-resource');
              await route.abort();
              return;
            }
            if (url.pathname === '/') {
              await route.fulfill({
                contentType: 'text/html; charset=utf-8',
                body: runtime
                  ? '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src \'self\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;width:1280px;height:720px}iframe{width:1280px;height:720px;border:0}</style><iframe id="scene" sandbox="allow-scripts" src="/scene"></iframe>'
                  : html,
              });
              return;
            }
            if (runtime) {
              if (url.pathname === '/scene' && route.request().isNavigationRequest())
                await route.fulfill({
                  contentType: 'text/html; charset=utf-8',
                  headers: {
                    'Content-Security-Policy': runtimeCSP,
                    'X-DNS-Prefetch-Control': 'off',
                  },
                  body: html,
                });
              else {
                blocked.add('unavailable-resource');
                await route.abort();
              }
              return;
            }
            const prefix = assetPrefix;
            if (
              url.pathname.startsWith(prefix) &&
              /^[\w.-]+$/.test(url.pathname.slice(prefix.length)) &&
              !url.pathname.includes('..')
            ) {
              const name = url.pathname.slice(prefix.length),
                contentType = types[path.extname(name)];
              if (!contentType) {
                await route.abort();
                return;
              }
              await route.fulfill({ contentType, body: await readAsset(name) });
              return;
            }
            if (url.pathname.startsWith('/api/')) {
              blocked.add('unavailable-resource');
              await route.abort();
              return;
            }
            const file = resolveApplicationFile(root, url.pathname),
              contentType = file && types[path.extname(file)];
            if (!file || !contentType) {
              blocked.add('unavailable-resource');
              await route.abort();
              return;
            }
            await route.fulfill({ contentType, body: await readFile(file) });
          } catch {
            blocked.add('unavailable-resource');
            await route.abort().catch(() => {});
          }
        });
        await page.goto('http://presentation.local/', { waitUntil: 'networkidle' });
        const canvas = runtime
          ? page.frames().find((frame) => frame.url() === 'http://presentation.local/scene')
          : page;
        if (!canvas) throw failure('JS-сцена не загрузилась.', 500);
        await canvas.evaluate(() => document.fonts.ready);
        if (runtime) {
          await canvas.waitForFunction(() => window.__presentationRuntime?.ready);
          const remaining = await canvas.evaluate(
            (at) => Math.max(0, at - (performance.now() - window.__presentationRuntime.startedAt)),
            atMs,
          );
          if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
        }
        const model = await canvas.evaluate(inspectCanvas),
          runtimeWarnings = runtime
            ? await canvas.evaluate(() =>
                window.__presentationRuntime.errors.map((message) => ({
                  code: 'script-error',
                  message,
                })),
              )
            : [],
          png = await page.screenshot({ type: 'png', animations: runtime ? 'allow' : 'disabled' });
        // Фотографии дают PNG большего размера, чем обычная графика слайда.
        // Ограничиваем размер для транспорта агента, сохраняя размеры холста.
        const image =
            png.length > 750000
              ? await page.screenshot({
                  type: 'jpeg',
                  quality: 85,
                  animations: runtime ? 'allow' : 'disabled',
                })
              : png,
          mimeType = png.length > 750000 ? 'image/jpeg' : 'image/png';
        controller.signal.throwIfAborted();
        if (image.length > 1000000)
          throw failure('Изображение предпросмотра слишком большое.', 413);
        return {
          preview: { mimeType, data: image.toString('base64') },
          ...identity,
          width: 1280,
          height: 720,
          ...(runtime ? { atMs } : {}),
          ...model,
          warnings: [
            ...model.warnings,
            ...runtimeWarnings,
            ...[...blocked].map((code) => ({
              code,
              message:
                code === 'external-resource'
                  ? 'Внешний ресурс заблокирован.'
                  : 'Локальный ресурс не удалось загрузить.',
            })),
          ],
        };
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    } finally {
      clearTimeout(timer);
      await browser?.close().catch(() => {});
      active = null;
      busy = false;
    }
  }
  return {
    render(projectId, slideId, options = {}) {
      return renderDocument(async () => {
        const project = await library.get(projectId),
          slide = project.slides.find((item) => item.id === slideId);
        if (!slide) throw failure('Слайд не найден.', 404);
        const readAsset = (name) => library.asset(projectId, name),
          runtime = hasSlideRuntime(slide, project);
        return {
          document: runtime
            ? await slideRuntimeDocument({ root, project, slideId, readAsset })
            : slideDocument(slide, project),
          runtime,
          identity: { slideId },
          assetPrefix: '/api/projects/' + projectId + '/assets/',
          readAsset,
        };
      }, options);
    },
    renderTheme(themeId, options = {}) {
      return renderDocument(async () => {
        const theme = await library.themes.get(themeId);
        return {
          document: themePreviewDocument(theme),
          identity: { themeId, version: theme.version },
          assetPrefix: '/api/themes/' + themeId + '/assets/',
          readAsset: (name) => library.themes.asset(themeId, name),
        };
      }, options);
    },
    renderElement(elementId, options = {}) {
      return renderDocument(async () => {
        const element = await library.elements.get(elementId),
          { document } = parseHTML('<html><body>' + element.body + '</body></html>'),
          block = document.body.firstElementChild;
        block.setAttribute('data-block-id', 'preview-' + elementId);
        block.style.left = Math.round((1280 - element.width) / 2) + 'px';
        block.style.top = Math.round((720 - element.height) / 2) + 'px';
        const slide = { id: 'element-preview', title: element.name, body: block.outerHTML },
          design = createPresentationDesign('light');
        design.decorations = [];
        design.template = {
          header: '',
          footer: '',
          showAuthor: false,
          showProjectTitle: false,
          showSlideNumber: false,
        };
        return {
          document: slideDocument(slide, { css: '', design, slides: [slide] }),
          identity: { elementId },
          assetPrefix: '/api/elements/' + elementId + '/assets/',
          readAsset: (name) => library.elements.asset(elementId, name),
        };
      }, options);
    },
    close() {
      active?.close().catch(() => {});
    },
  };
}
async function launch() {
  try {
    return await chromium.launch({
      headless: true,
      timeout: 15000,
      args: ['--js-flags=--max-old-space-size=128'],
      ...(process.env.PRESENTATION_BROWSER_PATH
        ? { executablePath: process.env.PRESENTATION_BROWSER_PATH }
        : {}),
    });
  } catch {
    throw failure('Chromium для предпросмотра недоступен на сервере.', 503);
  }
}
function inspectCanvas() {
  const blocks = [],
    warnings = [],
    nodes = document.querySelectorAll(
      '.slide [data-block-id],.slide h1,.slide h2,.slide h3,.slide p,.slide img',
    );
  for (const element of nodes) {
    if (blocks.length >= 150) break;
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element),
      id = element.dataset.blockId || null;
    const hidden =
      style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
    const block = {
      id,
      type: element.dataset.blockType || (element.tagName === 'IMG' ? 'image' : 'text'),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text: (element.innerText || element.alt || '').trim().slice(0, 200),
      hidden,
    };
    blocks.push(block);
    if (
      !hidden &&
      rect.width &&
      rect.height &&
      (rect.left < -0.5 || rect.top < -0.5 || rect.right > 1280.5 || rect.bottom > 720.5)
    )
      warnings.push({
        code: 'outside-canvas',
        blockId: id,
        message: 'Блок выходит за границы слайда.',
      });
    if (
      !hidden &&
      ((['hidden', 'clip'].includes(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 2) ||
        (['hidden', 'clip'].includes(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 2))
    )
      warnings.push({
        code: 'clipped-content',
        blockId: id,
        message: 'Содержимое блока обрезается.',
      });
    if (element.tagName === 'IMG' && (!element.complete || !element.naturalWidth))
      warnings.push({ code: 'missing-image', blockId: id, message: 'Изображение не загрузилось.' });
  }
  return { blocks, warnings: warnings.slice(0, 100) };
}
