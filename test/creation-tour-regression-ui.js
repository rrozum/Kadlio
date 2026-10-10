import assert from 'node:assert/strict';
import {createServer as createHTTPServer} from 'node:http';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from '../backend/http/server.js';
import {AuthStore} from '../backend/modules/auth/service.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const dataDir=await mkdtemp(path.join(os.tmpdir(),'presentations-creation-tour-ui-'));
const screenshots=path.join(root,'test-results');await mkdir(screenshots,{recursive:true});
let application=await createServer(root,{authRequired:false,dataDir}),protectedApplication;
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],providerErrors=[],requests=[];
page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>{const focus=HTMLElement.prototype.focus;window.tourTitleFocus=[];HTMLElement.prototype.focus=function(options){if(this.id==='tour-title')window.tourTitleFocus.push(Boolean(options?.preventScroll));return focus.call(this,options);};});
const privateSource='PRIVATE-SOURCE-creation-tour: one idea per slide, show concrete steps, preserve editable HTML.';
const privateNotes='PRIVATE-SPEAKER-NOTES-creation-tour: explain the thought behind this slide.';
const additionalSlides=[
  ['Материалы задают содержание','Исходные документы остаются у проекта.'],
  ['Оформление задаёт ритм','Выбранная тема применяется ко всей презентации.'],
  ['Одна мысль на слайд','Подробное объяснение остаётся в заметках.'],
  ['Результат нужно проверить','Изображения слайдов показывают реальное расположение текста.'],
  ['Итог остаётся редактируемым','Человек и агент работают с одним HTML.'],
];
let providerMode='error',phase=0,toolSerial=0,projectId,materialId,currentProject,modelSawMaterial=false,modelSawPreview=false;
let releaseThemes,releaseSettings;
const slideBody=(id,title,text)=>`<h1 data-block-id="${id}-title" data-block-type="text" style="position:absolute;left:80px;top:100px;width:1120px;font-size:54px;line-height:1.2">${title}</h1><p data-block-id="${id}-text" data-block-type="text" style="position:absolute;left:80px;top:290px;width:1080px;font-size:32px;line-height:1.3">${text}</p>`;

// Real streaming HTTP and registered tool execution; the fixture never edits
// project storage directly to pretend that a model generated the slides.
const provider=createHTTPServer(async(req,res)=>{
  try{
    let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);requests.push(input);
    if(providerMode==='error'){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture provider unavailable',type:'invalid_request_error'}}));return;}
    const toolResults=input.messages.filter(message=>message.role==='tool');
    for(const item of toolResults)assert.equal(JSON.parse(item.content).error,undefined,`tool failed: ${item.content}`);
    const result=prefix=>JSON.parse(toolResults.findLast(item=>item.tool_call_id.startsWith(prefix)).content);
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=delta=>res.write('data: '+JSON.stringify({id:'creation-fixture',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    const calls=items=>send({tool_calls:items.map(([name,args],index)=>({index,id:name+'-'+(++toolSerial),type:'function',function:{name,arguments:JSON.stringify(args)}}))});
    if(phase===0){
      const names=input.tools.map(tool=>tool.function.name);assert(names.includes('list_materials'));assert(names.includes('read_material'));
      calls([['read_project',{}],['list_materials',{}]]);
    }else if(phase===1){
      currentProject=result('read_project-');assert.equal(currentProject.id,projectId);assert.equal(currentProject.description,'A short talk for a new audience.\nKeep the slides concise.');
      calls([['read_material',{materialId}]]);
    }else if(phase===2){
      modelSawMaterial=JSON.stringify(result('read_material-')).includes(privateSource);assert(modelSawMaterial);
      const first=currentProject.slides[0];
      calls([
        ['update_slide',{slideId:first.id,version:first.version,title:'Система понятных шагов',body:slideBody('first','Система понятных шагов','Сначала идея, затем оформление, затем материалы.')}],
        ...additionalSlides.map(([title,text],index)=>['add_slide',{title,body:slideBody('added-'+index,title,text)}]),
      ]);
    }else if(phase===3){calls([['read_project',{}]]);
    }else if(phase===4){
      currentProject=result('read_project-');assert.equal(currentProject.slides.length,6);
      calls([
        ...currentProject.slides.map(slide=>['update_notes',{slideId:slide.id,notesVersion:slide.notesVersion,notes:privateNotes}]),
        ...[currentProject.slides[0],currentProject.slides.at(-1)].map(slide=>['render_slide',{slideId:slide.id}]),
      ]);
    }else{
      modelSawPreview=JSON.stringify(input.messages).includes('data:image/');assert(modelSawPreview);
      send({content:'Созданы шесть редактируемых слайдов по материалам. Проверены изображения слайдов.'});
    }
    phase++;res.end('data: [DONE]\n\n');
  }catch(error){providerErrors.push(error.message);if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
await application.ai.saveSettings({provider:'openai',apiMode:'chat-completions',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',model:'creation-fixture',apiKey:'fixture-key-not-secret'});
const draft=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('presentations.creation-draft')));
const waitMaterials=()=>page.locator('#tour-files').waitFor({state:'attached'});
const closeApplication=async app=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));};

try{
  await page.goto(application.url+'/projects');
  let notifyThemes;const themesRequested=new Promise(resolve=>notifyThemes=resolve),themesGate=new Promise(resolve=>releaseThemes=resolve);
  await page.route('**/api/themes',async route=>{notifyThemes();await themesGate;await route.continue();});
  const opening=page.locator('#new-project').click();await themesRequested;
  await page.locator('#tour-title').waitFor();assert.equal(await page.locator('#tour-title').isDisabled(),true);assert.equal(await page.locator('#tour-next').isDisabled(),true);assert.equal(await page.locator('[name="tour-mode"][value="manual"]').isDisabled(),true);
  releaseThemes();await opening;await page.unroute('**/api/themes');await page.waitForFunction(()=>!document.getElementById('tour-title').disabled);
  await page.locator('#tour-title').waitFor();await page.waitForFunction(()=>window.tourTitleFocus.includes(true));assert.equal(await page.evaluate(()=>scrollY),0);
  await page.locator('#tour-next').click();assert.equal(new URL(page.url()).pathname,'/projects/new');assert.equal((await application.library.list()).length,0);
  await page.locator('#tour-title').fill('Creation tour fixture');
  await page.locator('#tour-description').fill('A short talk for a new audience.\nKeep the slides concise.');
  await page.locator('#tour-description').press('Enter');assert.equal(await page.locator('#tour-themes').isVisible(),false);
  await page.locator('#tour-description').fill('A short talk for a new audience.\nKeep the slides concise.');
  await page.locator('[name="tour-mode"][value="smart"]').check();
  await page.reload();await page.waitForFunction(()=>!document.documentElement.hasAttribute('aria-busy'));assert.equal(await page.locator('#tour-title').inputValue(),'Creation tour fixture');assert.match(await page.locator('#tour-description').inputValue(),/new audience/);
  await page.locator('#tour-title').press('Enter');await page.locator('#tour-themes').waitFor({state:'visible'});
  await page.locator('[data-theme-id="paper"]').click();
  await page.locator('#tour-back').click();assert.equal(await page.locator('#tour-title').inputValue(),'Creation tour fixture');
  await page.locator('#tour-next').click();await page.locator('#tour-next').click();await page.locator('#tour-materials').waitFor({state:'visible'});await waitMaterials();
  projectId=(await draft()).projectId;assert(projectId);assert.equal((await application.library.list()).length,1);
  let saved=await application.library.get(projectId);assert.equal(saved.creationMode,'smart');assert.equal(saved.design.themeId,'paper');
  assert.equal(saved.slides.length,1);assert(!saved.slides[0].body.includes('Creation tour fixture'));
  // An upload failure blocks generation until it is retried or removed.
  await page.route('**/materials',route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture upload rejected'})}):route.continue());
  await page.locator('#tour-files').setInputFiles({name:'private-requirements.md',mimeType:'text/markdown',buffer:Buffer.from(privateSource)});
  await page.locator('.material-upload.error').waitFor();assert.equal(await page.locator('#tour-next').isDisabled(),true);
  await page.locator('#tour-back').click();await page.locator('#tour-themes').waitFor({state:'visible'});assert.equal(await page.locator('#tour-next').isDisabled(),false);
  await page.locator('#tour-next').click();await page.locator('#tour-materials').waitFor({state:'visible'});assert.equal(await page.locator('.material-upload.error').count(),1);
  await page.unroute('**/materials');await page.locator('.material-retry').click();await page.locator('.material-card:not(.material-upload)').waitFor();
  materialId=await page.locator('.material-card:not(.material-upload)').getAttribute('data-material-id');assert(materialId);
  assert.match(await page.locator('.material-status').textContent(),/Доступен агенту/);
  await page.reload();await page.locator('#tour-materials').waitFor({state:'visible'});assert.equal(await page.locator('.material-card:not(.material-upload)').count(),1);
  assert.equal((await draft()).projectId,projectId);assert.equal((await application.library.list()).length,1);
  // Recreate the server on the same origin: session draft and stored materials
  // must still refer to the same project, rather than a new blank project.
  const port=application.server.address().port;await closeApplication(application);
  application=await createServer(root,{authRequired:false,dataDir,port});
  await page.reload();await page.locator('#tour-materials').waitFor({state:'visible'});await page.locator('.material-card:not(.material-upload)').waitFor();
  assert.equal((await draft()).projectId,projectId);assert.equal((await application.library.list()).length,1);
  assert.equal(await (await fetch(application.url+'/api/projects/'+projectId+'/materials/'+materialId+'/file')).text(),privateSource);
  const settingsGate=new Promise(resolve=>releaseSettings=resolve);await page.route('**/api/ai/settings',async route=>{await settingsGate;await route.continue();});
  await page.locator('#tour-next').click();await page.waitForFunction(async id=>(await(await fetch('/api/projects/'+id)).json()).creation?.status==='error',projectId);
  assert.equal(await page.locator('#tour-retry').isVisible(),false);releaseSettings();await page.locator('#tour-retry').waitFor({state:'visible'});await page.unroute('**/api/ai/settings');
  saved=await application.library.get(projectId);assert.equal(saved.creation.status,'error');assert.equal(saved.slides.length,1);
  assert.equal((await application.library.materials.list(projectId)).length,1);assert.equal((await application.library.list()).length,1);
  await page.reload();await page.locator('#tour-retry').waitFor({state:'visible'});assert.equal((await draft()).projectId,projectId);assert.equal((await application.library.list()).length,1);
  providerMode='success';phase=0;await page.locator('#tour-retry').click();
  await page.locator('#tour-open-editor').waitFor({state:'visible',timeout:60000});
  saved=await application.library.get(projectId);assert.equal(saved.creation.status,'ready');assert.equal(saved.slides.length,6);assert(modelSawMaterial);assert(modelSawPreview);
  assert(saved.slides.every(slide=>slide.notes===privateNotes));assert(saved.slides.every(slide=>slide.body.includes('data-block-id=')));
  assert.equal((await application.library.list()).length,1);assert.equal(await page.locator('#tour-generation-log').isVisible(),true);
  const preview=page.frameLocator('#tour-result-frame');await preview.locator('.deck-stage > .slide').first().waitFor();assert.equal(await preview.locator('.deck-stage > .slide').count(),6);assert.equal(await preview.locator('.viewer-back').count(),0);
  await page.waitForFunction(()=>document.activeElement.id==='tour-result-heading'&&scrollY===0,{},{timeout:3000});assert((await page.locator('#tour-result h1').boundingBox()).y>=0);
  assert.match(await(await fetch(application.url+'/projects/'+projectId+'/view')).text(),/class="viewer-back"/);
  await page.screenshot({path:path.join(screenshots,'creation-tour-ready.png')});
  await page.locator('#tour-open-editor').click();await page.waitForURL(application.url+'/projects/'+projectId);await page.locator('.slide-thumbnail').first().waitFor();await page.locator('#canvas-loading').waitFor({state:'hidden'});assert.equal(await page.locator('.slide-thumbnail').count(),6);
  await page.locator('#materials-button').click();await page.locator('#materials-dialog').waitFor({state:'visible'});await page.locator('#materials-dialog .material-card').waitFor();assert.equal(await page.locator('#materials-dialog .material-card').count(),1);
  await page.locator('[data-close="materials-dialog"]').click();
  // Manual creation preserves the selected theme and never calls the model.
  const requestCount=requests.length;await page.goto(application.url+'/projects/new');await page.locator('#tour-title').fill('Manual tour fixture');await page.locator('[name="tour-mode"][value="manual"]').check();
  await page.locator('#tour-next').click();await page.locator('[data-theme-id="light"]').click();await page.locator('#tour-create-theme').click();await page.locator('#tour-next').click();
  const themeEditor=page.frameLocator('#tour-theme-frame');await themeEditor.locator('#theme-loading').waitFor({state:'hidden'});await page.waitForFunction(()=>!document.querySelector('#tour-theme-frame').contentDocument.documentElement.hasAttribute('aria-busy'));
  await themeEditor.locator('#theme-text-tool').click();await themeEditor.locator('#theme-prop-text').fill('CUSTOM-THEME-FIRST-SNAPSHOT');
  await page.locator('#tour-next').click();await page.locator('#tour-materials').waitFor({state:'visible'});
  const manualDraft=await draft(),manualId=manualDraft.projectId;assert(manualId&&manualId!==projectId);assert(manualDraft.customThemeId);
  assert((await application.library.get(manualId)).design.template.html.includes('CUSTOM-THEME-FIRST-SNAPSHOT'));
  // Editing the same library theme again must explicitly refresh its project
  // snapshot, despite the theme ID remaining identical.
  await page.locator('#tour-back').click();await page.locator('#tour-theme-create').waitFor({state:'visible'});
  await themeEditor.locator('#theme-text-tool').click();await themeEditor.locator('#theme-prop-text').fill('CUSTOM-THEME-SECOND-SNAPSHOT');
  await page.locator('#tour-next').click();await page.locator('#tour-materials').waitFor({state:'visible'});assert((await application.library.get(manualId)).design.template.html.includes('CUSTOM-THEME-SECOND-SNAPSHOT'));
  await page.locator('#tour-next').click();await page.waitForURL('**/projects/'+manualId);await page.locator('#canvas-loading').waitFor({state:'hidden'});
  const manual=await application.library.get(manualId);assert.equal(manual.creationMode,'manual');assert.equal(manual.slides.length,1);assert.equal(manual.design.themeId,manualDraft.customThemeId);assert.equal(manual.slides[0].body.trim(),'');assert.equal(requests.length,requestCount);
  // Authentication and public viewing are checked against the same persisted
  // fixture data. A share must not become a URL for original materials.
  const shareToken=await application.library.share(projectId),authFile=path.join(dataDir,'fixture-auth.sqlite');
  const auth=new AuthStore(authFile,{secure:false});await auth.setUser('fixture','ExampleOnly-TourPassword-123456');auth.close();
  protectedApplication=await createServer(root,{authRequired:true,publicOrigin:'http://127.0.0.1',authFile,dataDir});
  const publicHTML=await (await fetch(protectedApplication.url+'/s/'+shareToken)).text();assert(publicHTML.includes('Система понятных шагов'));
  for(const value of [privateSource,privateNotes,'private-requirements.md','fixture-key-not-secret'])assert(!publicHTML.includes(value));
  for(const suffix of ['', '/materials','/materials/'+materialId+'/file','/chat'])assert.equal((await fetch(protectedApplication.url+'/api/projects/'+projectId+suffix)).status,401);
  const unrelated=await fetch(application.url+'/api/projects/'+manualId+'/materials/'+materialId+'/file');assert.equal(unrelated.status,404);
  const tourAnon=await fetch(protectedApplication.url+'/projects/new',{redirect:'manual'});assert.equal(tourAnon.status,303);assert.match(tourAnon.headers.get('location'),/^\/login/);
  const notPublic=await fetch(protectedApplication.url+'/s/'+shareToken+'/materials/'+materialId+'/file',{redirect:'manual'});assert.notEqual(notPublic.status,200);
  assert.deepEqual(errors,[]);assert.deepEqual(providerErrors,[]);
  console.log('Creation tour UI passed: draft/back/reload, persistent material retry/restart, real model tools and previews, failed-generation retry without duplicate projects, repeated embedded-theme snapshots, manual blank canvas, private sources and public viewing.');
}catch(error){
  console.error('Tour fixture state:',await page.evaluate(()=>({url:location.pathname,scrollY,focus:document.activeElement?.id,scrollAnchor:getComputedStyle(document.body).overflowAnchor,draft:sessionStorage.getItem('presentations.creation-draft'),status:document.getElementById('tour-status')?.textContent,work:document.getElementById('tour-work-status')?.textContent})).catch(()=>null),{phase,providerErrors,requests:requests.length});
  await page.screenshot({path:path.join(screenshots,'creation-tour-failure.png')}).catch(()=>{});throw error;
}finally{
  releaseThemes?.();releaseSettings?.();
  await browser.close();await closeApplication(application);if(protectedApplication)await closeApplication(protectedApplication);
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
