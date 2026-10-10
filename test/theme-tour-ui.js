import assert from 'node:assert/strict';
import {createServer as createHTTPServer} from 'node:http';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from '../backend/http/server.js';

const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=await mkdtemp(path.join(os.tmpdir(),'presentations-theme-tour-ui-'));
const app=await createServer(root,{authRequired:false,dataDir}),theme=await app.library.themes.create({title:'Embedded theme fixture',baseThemeId:'light'});
let finishProvider,releasePatch;
const provider=createHTTPServer(async(req,res)=>{
  for await(const _ of req){};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=text=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'theme-tour-fixture',choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\n');
  send('');await new Promise(resolve=>finishProvider=resolve);send('Тема проверена.');res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
await app.ai.saveSettings({provider:'openai',apiMode:'chat-completions',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',model:'theme-tour-fixture',apiKey:'fixture-not-a-real-key'});
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1500,height:900}}),errors=[],writes=[];
page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='PATCH'&&request.url().includes('/api/themes/'))writes.push(request.url());});
const parentURL=app.url+'/theme-tour-fixture';
await page.route(parentURL,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe id="tour-theme" style="display:block;width:100%;height:760px;border:0" title="Тема"></iframe></body></html>'}));
const editor=()=>page.frameLocator('#tour-theme'),canvas=()=>editor().frameLocator('#theme-canvas');
const send=async requestId=>page.evaluate(requestId=>document.getElementById('tour-theme').contentWindow.postMessage({type:'presentation-theme-save',requestId},location.origin),requestId);
const response=async requestId=>{await page.waitForFunction(id=>window.themeMessages.some(message=>message.requestId===id),requestId);return page.evaluate(id=>window.themeMessages.find(message=>message.requestId===id),requestId);};
const state=()=>page.evaluate(()=>window.themeMessages.filter(message=>message.type==='presentation-theme-state').at(-1));
const waitForGate=async getGate=>{const until=Date.now()+10000;while(!getGate()){assert(Date.now()<until,'The fixture request must reach its gate.');await new Promise(resolve=>setTimeout(resolve,10));}getGate()();};
const screenshots=path.join(root,'test-results');await mkdir(screenshots,{recursive:true});
try{
  await page.goto(parentURL);await page.evaluate(id=>{window.themeMessages=[];window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===document.getElementById('tour-theme').contentWindow)window.themeMessages.push(event.data);});document.getElementById('tour-theme').src='/themes/'+id+'?embed=tour';},theme.id);
  await editor().locator('#theme-loading').waitFor({state:'hidden'});await editor().getByText('theme-tour-fixture',{exact:true}).waitFor();await page.waitForFunction(()=>window.themeMessages.some(message=>message.type==='presentation-theme-state'));
  assert.deepEqual(await state(),{type:'presentation-theme-state',themeId:theme.id,dirty:false,busy:false,saving:false});assert.equal(await editor().locator('.brand[data-theme-exit]').isVisible(),false);assert.equal(await editor().locator('#theme-copy').isVisible(),false);assert.equal(await editor().locator('#chat-panel').isVisible(),true);
  await editor().locator('#theme-text-tool').click();await editor().locator('#theme-prop-text').fill('Тур · {{projectTitle}}');await canvas().getByText('Тур · Пример презентации',{exact:true}).waitFor();await page.waitForFunction(()=>window.themeMessages.at(-1).dirty===true);assert.equal((await app.library.themes.get(theme.id)).version,theme.version);
  // A same-origin sibling/self message and a forged foreign-origin message cannot request a save.
  await editor().locator('body').evaluate(()=>{window.postMessage({type:'presentation-theme-save',requestId:'self'},location.origin);window.dispatchEvent(new MessageEvent('message',{origin:'https://foreign.invalid',source:window.parent,data:{type:'presentation-theme-save',requestId:'foreign'}}));});
  await page.waitForTimeout(200);assert.equal(writes.length,0);assert.equal(await page.evaluate(()=>window.themeMessages.some(message=>['self','foreign'].includes(message.requestId))),false);
  await send('visual-save');assert.equal((await response('visual-save')).type,'presentation-theme-saved');let saved=await app.library.themes.get(theme.id);assert(saved.design.template.html.includes('Тур · {{projectTitle}}'));assert(!saved.design.template.html.includes('Тур · Пример презентации'));assert.equal(new URL(await editor().locator('body').evaluate(()=>location.href)).search,'?embed=tour');assert.equal((await state()).dirty,false);
  // The parent can advance while the HTML dialog contains an unapplied draft: it is applied then saved through CAS.
  await editor().locator('#theme-source').click();await page.waitForFunction(()=>document.getElementById('tour-theme').contentDocument.getElementById('theme-source-html').closest('.source-editor').dataset.ready==='true');
  const html=await editor().locator('#theme-source-html').inputValue();await editor().locator('#theme-source-html').fill(html+'\n<p class="tour-heading" data-block-id="tour-heading" data-block-type="text" style="position:absolute;left:120px;top:300px;width:800px">{{slideTitle}}</p>');await editor().locator('#theme-source-css').fill('.tour-heading {font-size:42px;color:#228877}');await page.waitForFunction(()=>window.themeMessages.at(-1).dirty===true);
  assert.equal(await editor().locator('#theme-source-dialog [data-theme-exit]').isVisible(),false);
  await page.route(app.url+'/api/themes/'+theme.id,async route=>{if(route.request().method()==='PATCH')await new Promise(resolve=>releasePatch=resolve);await route.continue();});
  await send('source-save');await page.waitForFunction(()=>window.themeMessages.at(-1).saving===true);await send('duplicate-save');assert.equal((await response('duplicate-save')).type,'presentation-theme-save-error');assert.equal((await state()).saving,true);
  await waitForGate(()=>releasePatch);const sourceSaved=await response('source-save');await page.unroute(app.url+'/api/themes/'+theme.id);assert.equal(sourceSaved.type,'presentation-theme-saved');saved=await app.library.themes.get(theme.id);assert.equal(sourceSaved.version,saved.version);assert(saved.design.template.html.includes('{{slideTitle}}'));assert.equal(await editor().locator('#theme-source-dialog').evaluate(element=>element.open),false);assert.equal(await canvas().locator('[data-block-id=tour-heading]').textContent(),'Заголовок слайда');assert.equal(await canvas().locator('[data-block-id=tour-heading]').evaluate(element=>getComputedStyle(element).fontSize),'42px');assert.equal((await state()).dirty,false);
  await editor().locator('#chat-input').fill('Проверь тему.');await editor().locator('#chat-send').click();await editor().locator('#chat-stop').waitFor({state:'visible'});await page.waitForFunction(()=>window.themeMessages.at(-1).busy===true);const beforeBusySave=(await app.library.themes.get(theme.id)).version;await send('busy-save');const busyReply=await response('busy-save');assert.equal(busyReply.type,'presentation-theme-save-error');assert.match(busyReply.error,/агента/);assert.equal((await app.library.themes.get(theme.id)).version,beforeBusySave);
  await waitForGate(()=>finishProvider);await editor().locator('#chat-stop').waitFor({state:'hidden'});await page.waitForFunction(()=>window.themeMessages.at(-1).busy===false);
  await editor().locator('#theme-toggle').click();await editor().locator('body').evaluate(()=>Promise.allSettled(document.getAnimations().map(animation=>animation.finished)));await page.screenshot({path:path.join(screenshots,'theme-tour-light.png')});await editor().locator('#theme-toggle').click();await editor().locator('body').evaluate(()=>Promise.allSettled(document.getAnimations().map(animation=>animation.finished)));await page.screenshot({path:path.join(screenshots,'theme-tour-dark.png')});
  // Conflicts are reported to the parent, and the bound ID and local draft stay intact.
  saved=await app.library.themes.get(theme.id);await app.library.themes.update(theme.id,{title:'Remote theme title',version:saved.version});await editor().locator('#theme-name').fill('Local theme title');await send('conflict');assert.equal((await response('conflict')).type,'presentation-theme-save-error');assert.equal((await app.library.themes.get(theme.id)).title,'Remote theme title');assert.equal(await editor().locator('#theme-name').inputValue(),'Local theme title');assert.equal((await state()).dirty,true);
  await page.setViewportSize({width:390,height:850});await editor().locator('body').evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await editor().locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await editor().locator('#theme-chat-toggle').click();await editor().locator('#chat-panel').waitFor({state:'visible'});await page.screenshot({path:path.join(screenshots,'theme-tour-mobile.png')});assert.deepEqual(errors,[]);
  console.log('Embedded theme UI passed: compact existing editor, live canvas and literal variables, parent save with unapplied HTML/CSS, origin/source guards, busy rejection, CAS conflict, light/dark and mobile chat.');
}finally{releasePatch?.();finishProvider?.();await browser.close();await app.ai.close();await new Promise(resolve=>provider.close(resolve));await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
