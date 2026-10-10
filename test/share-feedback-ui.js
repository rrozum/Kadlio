import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {createServer,projectRoot} from '../backend/http/server.js';

const dataDir=await mkdtemp(path.join(os.tmpdir(),'presentation-share-ui-')),app=await createServer(projectRoot,{authRequired:false,dataDir});
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})}),owner=await browser.newPage({viewport:{width:1660,height:1000}}),guest=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
for(const page of [owner,guest])page.on('pageerror',error=>errors.push(error.message));
try{
  const project=await app.library.create({title:'Public feedback fixture'}),store=await app.library.getStore(project.id);await store.saveNotes([{id:'slide-01',notes:'Текст речи доступен только с разрешения автора.',version:0}]);
  await owner.goto(app.url+'/projects/'+project.id);await owner.locator('#canvas-loading').waitFor({state:'hidden'});await owner.locator('#share-button').click();
  const comments=owner.locator('#share-dialog [data-share-option=comments]'),notes=owner.locator('#share-dialog [data-share-option=notes]');await comments.waitFor();await owner.waitForFunction(()=>!document.querySelector('[data-share-option=comments]').disabled);await comments.check();await owner.getByText('Сохранено',{exact:true}).last().waitFor();await owner.waitForFunction(()=>!document.querySelector('[data-share-option=notes]').disabled);await notes.check();
  await owner.waitForFunction(()=>document.querySelector('[data-share-options-status]').textContent==='Сохранено');await owner.locator('#share-create').click();await owner.locator('#share-active').waitFor({state:'visible'});const url=await owner.locator('#share-url').inputValue();
  await mkdir(path.join(projectRoot,'test-results'),{recursive:true});await owner.screenshot({path:path.join(projectRoot,'test-results/share-options.png')});
  await guest.goto(url);assert.equal(await guest.locator('#notes-drawer').isVisible(),false);assert.equal(await guest.locator('#annotation-panel').isVisible(),false);
  await guest.locator('#notes-toggle').click();await guest.getByText('Текст речи доступен только с разрешения автора.',{exact:true}).waitFor();assert.equal(await guest.locator('.note-text').getAttribute('contenteditable'),null);assert.equal(await guest.locator('#notes-save').isVisible(),false);await guest.locator('#notes-close').click();
  await guest.locator('#annotation-toggle').click();const bounds=await guest.locator('#stage-shell').boundingBox();await guest.mouse.click(bounds.x+bounds.width*.35,bounds.y+bounds.height*.45);await guest.locator('#annotation-form').waitFor({state:'visible'});await guest.locator('#guest-name').fill('Коллега');await guest.locator('#annotation-text').fill('Комментарий от гостя, который ещё не виден агенту.');await guest.locator('#annotation-form [type=submit]').click();await guest.getByText('Комментарий отправлен автору',{exact:true}).waitFor();assert.equal(await guest.locator('.annotation-pin').count(),1);
  assert.deepEqual((await app.ai.history(project.id)).messages,[]);assert.equal((await app.library.get(project.id)).annotations.length,0);
  await owner.locator('#share-dialog [data-close=share-dialog]').click();await owner.locator('#comments-tab').click();const item=owner.locator('.guest-feedback-item');await item.waitFor();await item.getByText('Передать в чат',{exact:true}).click();await item.getByText('В чате агента',{exact:true}).waitFor();await owner.locator('.chat-message.user').filter({hasText:'Комментарий от гостя'}).waitFor();assert.equal((await app.ai.history(project.id)).messages.length,1);assert.equal((await app.ai.history(project.id)).messages.some(message=>message.role==='assistant'),false);assert.equal((await app.library.get(project.id)).annotations.length,1);
  await guest.reload();assert.equal(await guest.locator('#annotation-panel').isVisible(),false);
  // A slow response to one comment must not close a newer point draft.
  let releaseResponse,submittedResolve;const submitted=new Promise(resolve=>submittedResolve=resolve);
  await guest.route('**/s/*/comments',async route=>{const response=await route.fetch();submittedResolve();await new Promise(resolve=>releaseResponse=resolve);await route.fulfill({response});});
  await guest.locator('#annotation-toggle').click();const fresh=await guest.locator('#stage-shell').boundingBox();await guest.mouse.click(fresh.x+fresh.width*.25,fresh.y+fresh.height*.35);await guest.locator('#annotation-text').fill('First slow comment');await guest.locator('#annotation-form [type=submit]').click();await submitted;
  await guest.mouse.click(fresh.x+fresh.width*.65,fresh.y+fresh.height*.55);await guest.locator('#annotation-text').fill('New draft must survive');releaseResponse();await guest.getByText('Комментарий отправлен автору',{exact:true}).waitFor();
  assert.equal(await guest.locator('#annotation-panel').isVisible(),true);assert.equal(await guest.locator('#annotation-text').inputValue(),'New draft must survive');
  assert.deepEqual(errors,[]);console.log('Share UI passed: opt-in speech/comments, anonymous point pin, private pending feedback and explicit owner-to-chat approval without automatic inference.');
}finally{await browser.close();await app.ai.close();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true});}
