import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { createServer } from '../backend/http/server.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kadlio-spa-'));
const app = await createServer(process.cwd(), { authRequired: false, dataDir });
const fixture = await app.library.create({ title: 'SPA fixture' });
const browser = await chromium.launch({ headless: true, ...(process.env.PRESENTATION_BROWSER_PATH ? { executablePath: process.env.PRESENTATION_BROWSER_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ready = async () => page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
try {
  await page.goto(app.url + '/projects');
  await page.getByRole('heading', { name: fixture.title, exact: true }).waitFor();
  await page.evaluate(() => { window.spaMarker = 'same-document'; window.savedHeader = document.querySelector('.projects-header'); window.savedFooter = document.querySelector('.projects-footer'); });
  const footerText = await page.locator('.projects-footer').innerText();
  const before = await page.locator('.library-nav').boundingBox();
  await page.locator('.library-nav a[href="/themes"]').click();
  await page.locator('#theme-search').waitFor(); await ready();
  assert.equal(await page.evaluate(() => window.spaMarker), 'same-document');
  assert.equal(await page.evaluate(() => window.savedHeader === document.querySelector('.projects-header')), true);
  const after = await page.locator('.library-nav').boundingBox();
  assert.deepEqual(after, before);
  assert.equal(await page.locator('.projects-footer').innerText(), footerText);
  assert.equal(await page.evaluate(() => window.savedFooter === document.querySelector('.projects-footer')), true);
  assert.equal(await page.locator('.private-label').count(), 0);
  await page.locator('#theme-toggle').click();
  await page.waitForFunction(() => document.documentElement.dataset.uiTheme === 'light');
  assert.equal(await page.locator('.kadlio-mark').evaluate(el => getComputedStyle(el).color), 'rgb(124, 58, 237)');
  await page.locator('.library-nav a[href="/projects"]').click();
  await page.locator('#project-search').waitFor(); await ready();
  assert.equal(await page.evaluate(() => window.spaMarker), 'same-document');
  await page.goBack(); await page.locator('#theme-search').waitFor(); await ready();
  await page.goForward(); await page.locator('#project-search').waitFor(); await ready();
  // Медленная загрузка CSS не должна менять ещё открытый каталог.
  await page.route('**/editor.css', async route => {
    await new Promise(resolve => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.evaluate(() => {
    window.navigationFrames = [];
    const inspect = () => {
      const logo = document.querySelector('.kadlio-mark');
      const rect = logo?.getBoundingClientRect();
      window.navigationFrames.push({ width: rect?.width, height: rect?.height,
        footer: !!document.querySelector('.projects-footer'),
        library: document.body.classList.contains('projects-app'), headerDisplay: getComputedStyle(document.querySelector('header')).display, bodyDisplay: getComputedStyle(document.body).display });
      if (document.querySelector('#project-search') || document.documentElement.hasAttribute('aria-busy'))
        requestAnimationFrame(inspect);
    };
    requestAnimationFrame(inspect);
  });
  await page.locator(`a[href="/projects/${fixture.id}"]`).first().click();
  await page.locator('#slide-canvas').waitFor();
  await page.locator('#canvas-loading').waitFor({ state: 'hidden' }); await ready();
  assert.equal(await page.evaluate(() => window.spaMarker), 'same-document');
  const frames = await page.evaluate(() => window.navigationFrames);
  assert.ok(frames.length > 3);
  assert.ok(frames.every(frame => frame.width > 0 && frame.width <= 32 && frame.height <= 32), 'Логотип не исчезает и не растягивается в промежуточных кадрах');
  assert.ok(frames.filter(frame => frame.library).every(frame => frame.footer), 'Каталог сохраняет общий футер при переходе');
  assert.ok(frames.filter(frame => frame.library).every(frame => frame.headerDisplay === 'grid' && frame.bodyDisplay === 'flex'), 'Ни один кадр каталога не теряет CSS');
  assert.ok(frames.filter(frame => !frame.library).every(frame => frame.bodyDisplay === 'grid'), 'Редактор не показывает кадр без оформления');
  await page.locator('#script-tool').click();
  await page.locator('#script-dialog').waitFor();
  assert.match(await page.locator('#slide-script-input').inputValue(), /slide\.animate/);
  await page.locator('.script-context-help summary').click();
  await page.locator('.script-context-help').getByText(/AbortSignal/).waitFor();
  await page.locator('#script-dialog .authoring-close').first().click();
  assert.equal((await app.library.get(fixture.id)).slides[0].script || '', '');
  await page.locator('.brand').click();
  await page.locator('#project-search').waitFor(); await ready();
  await page.locator(`a[href="/projects/${fixture.id}"]`).first().click();
  await page.locator('#slide-canvas').waitFor();
  await page.locator('#canvas-loading').waitFor({ state: 'hidden' }); await ready();
  await page.locator('.brand').click(); await page.locator('#project-search').waitFor(); await ready();
  const token = await app.library.share(fixture.id);
  const publicPage = await browser.newPage();
  await publicPage.goto(app.url + '/s/' + token);
  await publicPage.locator('.toolbar .viewer-brand').waitFor();
  assert.equal(await publicPage.locator('.viewer-brand').textContent(), 'Kadlio');
  assert.equal(await publicPage.locator('.viewer-brand svg use').getAttribute('href'), '/assets/kadlio.svg#mark');
  await publicPage.close();
  assert.deepEqual(errors, []);
  console.log('SPA: постоянный документ и шапка, back/forward, темы и повторный mount редактора — OK');
} finally {
  await browser.close(); await new Promise(resolve => app.server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
