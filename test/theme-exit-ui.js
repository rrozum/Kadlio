import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from '../backend/http/server.js';

const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=await mkdtemp(path.join(os.tmpdir(),'presentations-theme-exit-ui-'));
const app=await createServer(root,{authRequired:false,dataDir}),theme=await app.library.themes.create({title:'Exit fixture',baseThemeId:'light'});
const baseline=await app.library.themes.get(theme.id);
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1500,height:950}}),errors=[],writes=[],nativeDialogs=[];
page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(['POST','PATCH','PUT','DELETE'].includes(request.method())&&request.url().includes('/api/'))writes.push(request.url());});page.on('dialog',async dialog=>{nativeDialogs.push(dialog.type());await dialog.dismiss();});
const screenshotDir=path.join(root,'test-results');await mkdir(screenshotDir,{recursive:true});
const open=async()=>{await page.goto(app.url+'/themes/'+theme.id);await page.locator('#theme-loading').waitFor({state:'hidden'});};
const beforeUnloadCancelled=()=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});
try{
  await open();assert.equal(await beforeUnloadCancelled(),false);await page.locator('.brand[data-theme-exit]').click();await page.waitForURL(app.url+'/themes');assert.equal(nativeDialogs.length,0);
  await open();await page.locator('#theme-text-tool').click();const canvas=page.frameLocator('#theme-canvas');await canvas.getByText('Новый текст',{exact:true}).waitFor();assert.equal(await page.locator('#theme-save-status').textContent(),'Есть изменения');assert.equal(await beforeUnloadCancelled(),true);
  await page.locator('.brand[data-theme-exit]').click();await page.locator('#theme-exit-dialog').waitFor({state:'visible'});assert.equal(nativeDialogs.length,0);await page.locator('#theme-exit-dialog').press('Control+s');assert.equal(writes.length,0);await page.screenshot({path:path.join(screenshotDir,'theme-exit-confirm.png')});await page.locator('#theme-exit-continue').click();await page.locator('#theme-exit-dialog').waitFor({state:'hidden'});await canvas.getByText('Новый текст',{exact:true}).waitFor();assert.equal(await beforeUnloadCancelled(),true);
  await page.locator('.brand[data-theme-exit]').click();await page.locator('#theme-exit-dialog').press('Escape');await page.locator('#theme-exit-dialog').waitFor({state:'hidden'});await canvas.getByText('Новый текст',{exact:true}).waitFor();assert.equal(writes.length,0);
  // A real hard refresh still has the browser's warning; dismissing retains the draft.
  const reload=await page.reload({waitUntil:'domcontentloaded'}).then(()=>null,error=>error);assert(reload);assert.deepEqual(nativeDialogs,['beforeunload']);await canvas.getByText('Новый текст',{exact:true}).waitFor();
  await page.locator('.brand[data-theme-exit]').click();await page.locator('#theme-exit-discard').click();await page.waitForURL(app.url+'/themes');assert.deepEqual(nativeDialogs,['beforeunload']);assert.equal(writes.length,0);assert.deepEqual(await app.library.themes.get(theme.id),baseline);
  await page.goBack({waitUntil:'domcontentloaded'});await page.locator('#theme-canvas').waitFor();await page.locator('#theme-loading').waitFor({state:'hidden'});await page.locator('#theme-name').fill('Draft after browser Back');assert.equal(await beforeUnloadCancelled(),true);await page.locator('.brand[data-theme-exit]').click();await page.locator('#theme-exit-discard').click();await page.waitForURL(app.url+'/themes');assert.deepEqual(nativeDialogs,['beforeunload']);
  await open();await page.locator('#theme-source').click();await page.waitForFunction(()=>document.getElementById('theme-source-html').closest('.source-editor').dataset.ready==='true');const originalSource=await page.locator('#theme-source-html').inputValue(),draft=originalSource+'\n<!-- unsaved source draft -->';await page.locator('#theme-source-html').fill(draft);assert.equal(await page.locator('#theme-save-status').textContent(),'Сохранено');assert.equal(await beforeUnloadCancelled(),true);
  await page.locator('#theme-source-dialog [data-theme-exit]').click();await page.locator('#theme-exit-dialog').waitFor({state:'visible'});await page.locator('#theme-exit-continue').click();assert.equal(await page.locator('#theme-source-html').inputValue(),draft);assert.equal(await page.locator('#theme-source-dialog').evaluate(element=>element.open),true);
  await page.locator('#theme-source-dialog [data-theme-exit]').click();await page.locator('#theme-exit-dialog').press('Escape');assert.equal(await page.locator('#theme-source-html').inputValue(),draft);assert.equal(writes.length,0);
  await page.locator('#theme-source-dialog [data-theme-exit]').click();await page.locator('#theme-exit-discard').click();await page.waitForURL(app.url+'/themes');assert.deepEqual(nativeDialogs,['beforeunload']);assert.deepEqual(await app.library.themes.get(theme.id),baseline);assert.equal(writes.length,0);
  await open();await page.locator('#theme-source').click();await page.waitForFunction(()=>document.getElementById('theme-source-html').closest('.source-editor').dataset.ready==='true');assert.equal(await beforeUnloadCancelled(),false);await page.locator('#theme-source-html').fill(draft);await page.locator('[data-close=theme-source-dialog]').first().click();assert.equal(await beforeUnloadCancelled(),false);await page.locator('.brand[data-theme-exit]').click();await page.waitForURL(app.url+'/themes');assert.deepEqual(errors,[]);assert.equal(writes.length,0);
  console.log('Theme exit UI passed: header/back navigation, canvas and source drafts, Continue/Escape preserve edits, real refresh warning, discard without API writes or second native warning.');
}finally{await browser.close();await app.ai.close();await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
