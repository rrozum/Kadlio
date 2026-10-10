import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../backend/http/server.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kadlio-loading-'));
const app = await createServer(process.cwd(), { authRequired: false, dataDir });
const project = await app.library.create({ title: 'Loading fixture', themeId: 'paper' });
const browser = await chromium.launch({ headless: true, ...(process.env.PRESENTATION_BROWSER_PATH ? { executablePath: process.env.PRESENTATION_BROWSER_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let releaseCSS;
try {
  await page.addInitScript(() => localStorage.setItem('presentations.theme', 'light'));
  const cssGate = new Promise(resolve => { releaseCSS = resolve; });
  await page.route('**/deck.css', async route => { await cssGate; await route.continue(); });
  await page.goto(app.url + '/projects');
  const cover = page.locator('.project-cover').first();
  await cover.locator('iframe').waitFor({ state: 'attached' });
  await cover.locator('.preview-loading').waitFor();
  assert.equal(await cover.locator('iframe').evaluate(frame => getComputedStyle(frame).visibility), 'hidden');
  releaseCSS();
  await cover.locator('.preview-loading').waitFor({ state: 'detached' });
  assert.equal(await cover.locator('iframe').evaluate(frame => getComputedStyle(frame).visibility), 'visible');
  await page.unroute('**/deck.css');
  await page.evaluate(() => { window.styles = [...document.querySelectorAll('link[rel=stylesheet]')]; });
  await page.locator('.library-nav a[href="/themes"]').click();
  await page.locator('.theme-card').first().waitFor();
  await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
  assert.equal(await page.evaluate(() => window.styles.every((link, i) => link === document.querySelectorAll('link[rel=stylesheet]')[i])), true, 'Общие CSS не пересоздаются между каталогами');

  let releaseHistory;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  await page.route('**/api/ai/settings', route => route.fulfill({ json: { provider: 'openai', hasApiKey: true, model: 'fixture-model' } }));
  await page.route('**/api/themes/midnight/chat', async route => { await historyGate; await route.fulfill({ json: { messages: [{ role: 'assistant', content: 'Сохранённый ответ' }] } }); });
  await page.locator('a[href="/themes/midnight"]').click();
  await page.locator('#chat-loading').waitFor();
  await page.locator('#theme-canvas').waitFor();
  await page.locator('#theme-loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#chat-empty').isVisible(), false, 'Подсказки не появляются до получения истории');
  assert.equal(await page.locator('#chat-form').evaluate(form => form.inert), true);
  assert.equal(await page.locator('main.workspace').evaluate(main => main.inert), false, 'Холст доступен независимо от загрузки истории');
  releaseHistory();
  await page.locator('#chat-messages').getByText('Сохранённый ответ').waitFor();
  await page.locator('#chat-loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#chat-empty').isVisible(), false);
  assert.equal(await page.locator('#chat-form').evaluate(form => form.inert), false);

  let releaseEditorHistory;
  const editorGate = new Promise(resolve => { releaseEditorHistory = resolve; });
  await page.route('**/api/projects/' + project.id + '/chat', async route => {
    await editorGate;
    await route.fulfill({ json: { messages: [] } }).catch(() => {});
  });
  await page.locator('.brand').click();
  await page.locator('#theme-search').waitFor();
  await page.locator('.library-nav a[href="/projects"]').click();
  await page.locator('#project-search').waitFor();
  await page.locator('a[href="/projects/' + project.id + '"]').first().click();
  await page.locator('#slide-canvas').waitFor();
  await page.locator('#canvas-loading').waitFor({ state: 'hidden' });
  await page.locator('.thumb-viewport').first().locator('.preview-loading').waitFor({ state: 'detached', timeout: 5000 });
  await page.locator('.brand').click();
  await page.locator('#project-search').waitFor({ timeout: 3000 });
  releaseEditorHistory();
  await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));

  // Медленное чтение закрытого экрана не держит навигацию и не меняет следующий экран.
  const another = await browser.newPage();
  let releaseProjects;
  const projectsGate = new Promise(resolve => { releaseProjects = resolve; });
  await another.route('**/api/projects', async route => { await projectsGate; await route.continue().catch(() => {}); });
  await another.goto(app.url + '/projects');
  await another.locator('.library-nav a[href="/themes"]').click();
  await another.locator('.theme-card').first().waitFor({ timeout: 3000 });
  releaseProjects();
  await another.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
  assert.equal(await another.locator('#project-search').count(), 0);
  await another.close();
  assert.deepEqual(errors, []);
  console.log('SPA loading: скрытые до готовности превью, стабильные CSS, чат без ложного empty state, независимый холст и уход с медленного экрана — OK');
} finally {
  releaseCSS?.();
  await browser.close();
  await new Promise(resolve => app.server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
