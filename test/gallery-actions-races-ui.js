import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from '../backend/http/server.js';

const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=await mkdtemp(path.join(os.tmpdir(),'presentations-gallery-races-'));
const app=await createServer(root,{authRequired:false,dataDir});
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const releases=[];
async function delayDelete(pathname){
  let release,notify;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>notify=resolve);releases.push(release);
  await page.route('**'+pathname,async route=>{if(route.request().method()==='DELETE'){notify();await gate;}await route.continue();});
  return {started,release:()=>release(),dispose:()=>page.unroute('**'+pathname)};
}
const projectCard=id=>page.locator('[data-project-id="'+id+'"]');
const themeCard=id=>page.locator('[data-theme-id="'+id+'"]');
async function openProjectDelete(id){await projectCard(id).locator('.project-menu-trigger').click();await page.locator('#project-menu-delete').click();await page.locator('#delete-dialog').waitFor({state:'visible'});}
async function openProjectShare(id){await projectCard(id).locator('.project-menu-trigger').click();await page.locator('#project-menu-share').click();await page.locator('#gallery-share-active').waitFor({state:'visible'});}

try{
  // A response for one deletion must never remove the other card or close its
  // newly opened confirmation. Assert UI and persistent ownership separately.
  const first=await app.library.create({title:'First project'}),second=await app.library.create({title:'Second project'});
  await page.goto(app.url+'/projects');await projectCard(second.id).waitFor();const projectDelete=await delayDelete('/api/projects/'+first.id);
  await openProjectDelete(first.id);await page.locator('#delete-form button[type=submit]').click();await projectDelete.started;
  await page.locator('[data-close=delete-dialog]').last().click();await openProjectDelete(second.id);projectDelete.release();
  await projectCard(first.id).waitFor({state:'detached'});await projectCard(second.id).waitFor();
  assert.equal(await page.locator('#delete-dialog').isVisible(),true);assert.equal(await page.locator('#delete-description').textContent(),'Second project');
  assert.equal(await page.locator('#delete-form button[type=submit]').isDisabled(),false);
  assert.deepEqual((await app.library.list()).map(project=>project.id),[second.id]);
  await page.locator('[data-close=delete-dialog]').last().click();await projectDelete.dispose();

  const themeA=await app.library.themes.create({title:'First theme'}),themeB=await app.library.themes.create({title:'Second theme'});
  await page.goto(app.url+'/themes');await themeCard(themeB.id).waitFor();const themeDelete=await delayDelete('/api/themes/'+themeA.id);
  await themeCard(themeA.id).locator('.theme-delete').click();await page.locator('#delete-theme-form button[type=submit]').click();await themeDelete.started;
  await page.locator('[data-close=delete-theme-dialog]').last().click();await themeCard(themeB.id).locator('.theme-delete').click();themeDelete.release();
  await themeCard(themeA.id).waitFor({state:'detached'});await themeCard(themeB.id).waitFor();
  assert.equal(await page.locator('#delete-theme-dialog').isVisible(),true);assert.match(await page.locator('#delete-theme-description').textContent(),/Second theme/);
  assert.equal(await page.locator('#delete-theme-form button[type=submit]').isDisabled(),false);
  assert.deepEqual((await app.library.themes.list()).filter(theme=>!theme.builtin).map(theme=>theme.id),[themeB.id]);
  await page.locator('[data-close=delete-theme-dialog]').last().click();await themeDelete.dispose();

  // Revoke A while B's share dialog opens. Only A's public token is removed;
  // B's URL, buttons, status and actual unauthenticated viewing remain valid.
  const sharedA=await app.library.create({title:'Shared A'});await app.library.share(sharedA.id);const bToken=await app.library.share(second.id);
  await page.goto(app.url+'/projects');await projectCard(sharedA.id).waitFor();await openProjectShare(sharedA.id);
  const revoke=await delayDelete('/api/projects/'+sharedA.id+'/share');page.once('dialog',dialog=>dialog.accept());await page.locator('#gallery-share-revoke').click();await revoke.started;
  await page.locator('[data-close=gallery-share-dialog]').click();await openProjectShare(second.id);
  const bURL=await page.locator('#gallery-share-url').inputValue();assert.equal(bURL,app.url+'/s/'+bToken);revoke.release();
  await page.waitForFunction(async id=>!(await(await fetch('/api/projects/'+id)).json()).shareUrl,sharedA.id);
  assert.equal(await page.locator('#gallery-share-active').isVisible(),true);assert.equal(await page.locator('#gallery-share-inactive').isVisible(),false);
  assert.equal(await page.locator('#gallery-share-url').inputValue(),bURL);assert.equal(await page.locator('#gallery-share-open').getAttribute('href'),bURL);
  assert.equal(await page.locator('#gallery-share-status').textContent(),'');assert.equal((await fetch(bURL)).status,200);
  assert.equal((await app.library.get(second.id)).shareToken,bToken);assert.equal((await app.library.get(sharedA.id)).shareToken,null);
  await revoke.dispose();assert.deepEqual(errors,[]);
  console.log('Gallery action races passed: delayed project/theme deletion preserves the other confirmation, and share revocation preserves the other project link and public viewing.');
}finally{
  releases.forEach(release=>release());await browser.close();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));
  await app.library.renderer.close();await app.library.documentPreviews.close();await app.ai.close();await rm(dataDir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
