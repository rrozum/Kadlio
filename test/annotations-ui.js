import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {createServer,projectRoot} from '../backend/http/server.js';

const dataDir=await mkdtemp(tmpdir()+'/presentation-annotations-'),app=await createServer(projectRoot,{authRequired:false,dataDir});
const project=await app.library.create({title:'Annotation entry points',blank:true});
const body='<h2>Imported HTML remains editable</h2><div class="legacy-card"><span>Ordinary nested content</span></div><p data-locked="true" class="lead">Locked content can receive feedback</p>';
await app.library.updateSlide(project.id,'slide-01',{body,version:0});
await app.library.updateCSS(project.id,{css:'.legacy-card{padding:30px;border:1px solid #7c99aa;font-size:28px}.slide::before{content:"";position:absolute;inset:0;pointer-events:none}',version:1});
const second=await app.library.addSlide(project.id,{title:'Another slide',body:'<h2>Another slide</h2>'}),initial=await app.library.get(project.id);
await app.library.updateTimeline(project.id,{version:initial.version,timeline:[{type:'slide',id:'slide-01'},{type:'transition',id:randomUUID(),preset:'zoom',duration:600},{type:'slide',id:second.id}]});
const sent=[];
const provider=httpServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  sent.push(JSON.parse(raw));
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end('data: '+JSON.stringify({id:'annotation-fixture',choices:[{index:0,delta:{content:'Комментарий принят '+sent.length},finish_reason:null}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
await app.ai.saveSettings({provider:'openai',apiMode:'chat-completions',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',model:'annotation-fixture',apiKey:'not-a-real-key'});
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1660,height:1020}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
const frame=()=>page.frameLocator('#slide-canvas');
const point={x:420,y:400};
const clickPoint=async()=>{const bounds=await page.locator('#slide-frame').boundingBox();await page.mouse.click(bounds.x+bounds.width*point.x/1280,bounds.y+bounds.height*point.y/720);};
const samePoint=annotation=>{assert(Math.abs(annotation.x-point.x/1280)<.003);assert(Math.abs(annotation.y-point.y/720)<.003);};
const snapshot=()=>app.library.get(project.id);
try{
  await page.goto(app.url+'/projects/'+project.id);await page.locator('#canvas-loading').waitFor({state:'hidden'});
  const before=await snapshot();
  // Opening the panel through the formerly broken rail button also arms
  // annotation mode; clicking on the slide must open the comment editor.
  await page.locator('[data-panel-target="comments"]').click();
  assert.equal(await page.locator('#annotation-tool').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#select-tool').getAttribute('aria-pressed'),'false');
  assert(await page.locator('#annotation-add').isVisible());
  await clickPoint();await page.locator('#annotation-popover').waitFor({state:'visible'});
  await page.locator('#annotation-input').fill('A comment for the agent');
  // A failed save leaves the typed text available for retry.
  await page.route('**/api/projects/'+project.id+'/annotations',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic save failure'})}),{times:1});
  await page.locator('#annotation-form button[type="submit"]').click();await page.getByText('Synthetic save failure',{exact:true}).waitFor();
  assert(await page.locator('#annotation-popover').isVisible());assert.equal(await page.locator('#annotation-input').inputValue(),'A comment for the agent');assert.equal((await snapshot()).annotations.length,0);
  await page.locator('#annotation-form button[type="submit"]').click();
  await page.getByText('Комментарий принят 1',{exact:true}).waitFor();await page.locator('#chat-stop').waitFor({state:'hidden'});
  assert.equal(await page.locator('.comment-pin').count(),1);assert.equal(sent.length,1);
  let saved=await snapshot();assert.equal(saved.annotations.length,1);samePoint(saved.annotations[0]);assert.equal(saved.annotations[0].slideId,'slide-01');assert.equal(saved.slides[0].body,before.slides[0].body);assert.equal(saved.slides[0].version,before.slides[0].version);assert.deepEqual(saved.timeline,before.timeline);
  let history=(await app.ai.history(project.id)).messages;assert.equal(history.filter(message=>message.annotationId===saved.annotations[0].id).length,1);assert(sent[0].messages.some(message=>typeof message.content==='string'&&message.content.includes('A comment for the agent')));
  await page.reload();await page.locator('#canvas-loading').waitFor({state:'hidden'});assert.equal(await page.locator('.comment-pin').count(),1);
  await page.locator('.comment-pin').click();assert.equal(await page.locator('#annotation-input').inputValue(),'A comment for the agent');await page.locator('#annotation-close').click();assert.equal(await page.locator('#annotation-tool').getAttribute('aria-pressed'),'false');
  // The tab, explicit Add button, original tool and keyboard all reach the
  // same mode. Merely entering/cancelling it never writes slide HTML.
  for(const entry of ['#comments-tab','#annotation-add','#annotation-tool']){
    await page.locator(entry).click();assert.equal(await page.locator('#annotation-tool').getAttribute('aria-pressed'),'true');
    await frame().locator('[data-locked="true"]').click();await page.locator('#annotation-popover').waitFor({state:'visible'});await page.locator('#annotation-close').click();
  }
  await page.locator('#select-tool').focus();await page.keyboard.press('a');assert.equal(await page.locator('#annotation-tool').getAttribute('aria-pressed'),'true');
  await page.locator('#annotation-tool').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('#annotation-tool').getAttribute('aria-pressed'),'false');
  // At a small viewport the inspector cannot cover the point being selected.
  await page.setViewportSize({width:390,height:844});await page.locator('[data-panel-target="notes"]').click();assert(await page.locator('#properties-panel').isVisible());
  await page.locator('[data-panel-target="comments"]').click();assert(await page.locator('#properties-panel').isHidden());
  await clickPoint();await page.locator('#annotation-popover').waitFor({state:'visible'});await page.locator('#annotation-input').fill('Mobile annotation');await page.locator('#annotation-form button[type="submit"]').click();await page.getByText('Комментарий принят 2',{exact:true}).waitFor();await page.locator('#chat-stop').waitFor({state:'hidden'});
  saved=await snapshot();assert.equal(saved.annotations.length,2);samePoint(saved.annotations[1]);assert.equal(sent.length,2);assert.equal(saved.slides[0].body,before.slides[0].body);assert.deepEqual(saved.timeline,before.timeline);assert.equal((await app.ai.history(project.id)).messages.filter(message=>message.annotationId).length,2);assert.deepEqual(errors,[]);
  console.log('Annotations UI passed: rail/tab/Add/tool/keyboard, exact point, locked and legacy HTML, retry, real mock SSE delivery, pins and history after reload, unchanged content/timeline, mobile canvas access.');
}finally{await browser.close();await app.ai.close();await new Promise(resolve=>app.server.close(resolve));provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
