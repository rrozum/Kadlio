import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createServer} from '../backend/http/server.js';
import {transitionForGap} from '../shared/presentation/timeline.js';

const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=await mkdtemp(path.join(os.tmpdir(),'presentation-filmstrip-ui-'));
const app=await createServer(root,{authRequired:false,dataDir}),project=await app.library.create({title:'Timeline browser fixture'}),base='/api/projects/'+project.id;
for(let index=2;index<=5;index++)await app.library.addSlide(project.id,{title:'Slide '+index,body:'<h2 data-block-id="title">Slide '+index+'</h2>'});
let snapshot=await app.library.get(project.id);const ids=snapshot.slides.map(slide=>slide.id);
await app.library.updateSlide(project.id,ids[1],{notes:'Notes remain on slide two',version:snapshot.slides[1].version,notesVersion:snapshot.slides[1].notesVersion});
const annotation={id:randomUUID(),slideId:ids[1],x:.4,y:.5,comment:'Comment stays on slide two',anchorText:''};await(await app.library.getStore(project.id)).saveAnnotation(annotation);
const transitionA={type:'transition',id:randomUUID(),preset:'fade',duration:650},transitionB={type:'transition',id:randomUUID(),preset:'slide',duration:400};
snapshot=await app.library.get(project.id);await app.library.updateTimeline(project.id,{version:snapshot.version,timeline:[{type:'slide',id:ids[0]},transitionA,{type:'slide',id:ids[1]},{type:'slide',id:ids[2]},transitionB,{type:'slide',id:ids[3]},{type:'slide',id:ids[4]}]});
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})}),page=await browser.newPage({viewport:{width:1660,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const slide=id=>page.locator('.slide-thumbnail[data-slide-id="'+id+'"]');
const gap=index=>page.locator('[data-gap-index="'+index+'"]');
const saved=()=>page.waitForFunction(()=>!document.getElementById('slide-list').hasAttribute('aria-busy'));
async function drag(source,target,{after=false}={}){const from=await source.boundingBox(),to=await target.boundingBox();await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+(after?to.width-8:8),to.y+to.height/2,{steps:12});assert.equal(await page.locator('.timeline-dragging').count(),1);await page.mouse.up();await saved();}
try{
  await page.goto(app.url+'/projects/'+project.id+'#'+ids[1]);await page.locator('#canvas-loading').waitFor({state:'hidden'});
  assert.equal(await page.locator('.transition-card').count(),2);assert.equal(await page.locator('.transition-gap').count(),2);
  await slide(ids[2]).click();await page.waitForFunction(id=>location.hash==='#'+id,ids[2]);await slide(ids[1]).click();await page.waitForFunction(id=>location.hash==='#'+id,ids[1]);
  await page.locator('#notes-tab').click();assert.equal(await page.locator('#notes-input').inputValue(),'Notes remain on slide two');
  const iframeIdentity=await slide(ids[0]).locator('iframe').evaluate(frame=>{frame.contentWindow.originalIdentity=123;return true;});assert(iframeIdentity);
  await drag(slide(ids[0]),slide(ids[3]),{after:true});
  snapshot=await app.library.get(project.id);assert.deepEqual(snapshot.slides.map(slide=>slide.id),[ids[1],ids[2],ids[3],ids[0],ids[4]]);assert.equal(transitionForGap(snapshot,0).id,transitionA.id);assert.equal(transitionForGap(snapshot,2).id,transitionB.id);
  assert.equal(await page.evaluate(()=>location.hash),'#'+ids[1]);assert.equal(await page.locator('#notes-input').inputValue(),'Notes remain on slide two');assert.equal(snapshot.slides[0].notes,'Notes remain on slide two');assert.equal(snapshot.annotations[0].slideId,ids[1]);assert.equal(await page.locator('.comment-pin').count(),1);assert.equal(await slide(ids[0]).locator('iframe').evaluate(frame=>frame.contentWindow.originalIdentity),123);
  // A transition moved into an occupied gap swaps both cards without deleting either.
  await drag(gap(0),gap(2));snapshot=await app.library.get(project.id);assert.equal(transitionForGap(snapshot,0).id,transitionB.id);assert.equal(transitionForGap(snapshot,2).id,transitionA.id);
  await gap(2).click();await page.locator('#effects-dialog').waitFor({state:'visible'});await page.locator('#effect-copy-gap').selectOption('1');await page.locator('#effect-copy').click();await page.locator('#effects-dialog').waitFor({state:'hidden'});snapshot=await app.library.get(project.id);assert.equal(transitionForGap(snapshot,1).preset,'fade');assert.notEqual(transitionForGap(snapshot,1).id,transitionA.id);
  await gap(1).click();await page.locator('[data-effect-id=zoom]').click();await page.locator('#effect-apply').click();await page.locator('#effects-dialog').waitFor({state:'hidden'});snapshot=await app.library.get(project.id);assert.equal(transitionForGap(snapshot,1).preset,'zoom');
  await gap(1).click();await page.locator('#effect-delete').click();await page.locator('#effects-dialog').waitFor({state:'hidden'});assert.equal(transitionForGap(await app.library.get(project.id),1),null);
  // Network failure keeps the original order and active slide. A second gesture
  // cannot race the first save; disabled navigation leaves the selection stable.
  const before=(await app.library.get(project.id)).slides.map(slide=>slide.id);let release,intercepted;
  const entered=new Promise(resolve=>intercepted=resolve);await page.route('**'+base+'/timeline',async route=>{intercepted();await new Promise(resolve=>release=resolve);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture save failure'})});});
  const from=await slide(ids[0]).boundingBox(),to=await slide(ids[1]).boundingBox();await page.mouse.move(from.x+30,from.y+30);await page.mouse.down();await page.mouse.move(to.x+5,to.y+30,{steps:10});await page.mouse.up();await entered;
  assert.equal(await page.locator('#slide-list').getAttribute('aria-busy'),'true');await slide(ids[3]).dispatchEvent('click');assert.equal(await page.evaluate(()=>location.hash),'#'+ids[1]);assert(await page.locator('#slide-next').isDisabled());release();await saved();assert.deepEqual((await app.library.get(project.id)).slides.map(slide=>slide.id),before);await page.getByText('Fixture save failure',{exact:true}).waitFor();await page.unroute('**'+base+'/timeline');
  // New copies carry source notes/body, live immediately after the original,
  // while the outgoing transition is retained exactly once.
  await page.locator('#slide-menu').click();await page.locator('#duplicate-slide').click();await page.waitForFunction(()=>document.querySelectorAll('.slide-thumbnail').length===6);snapshot=await app.library.get(project.id);assert.equal(snapshot.slides[1].notes,snapshot.slides[0].notes);assert.equal(snapshot.slides[1].body,snapshot.slides[0].body);assert.equal(snapshot.timeline.filter(entry=>entry.id===transitionB.id).length,1);assert.equal(transitionForGap(snapshot,0),null);assert.equal(transitionForGap(snapshot,1).id,transitionB.id);
  await page.locator('#add-slide').click();await page.waitForFunction(()=>document.querySelectorAll('.slide-thumbnail').length===7);await page.locator('#slide-menu').click();await page.locator('#move-slide-left').click();await page.locator('#slide-actions-dialog').waitFor({state:'hidden'});assert.equal((await app.library.get(project.id)).slides.length,7);assert.equal(await page.locator('#slide-counter').textContent(),'6 / 7');
  await mkdir(path.join(root,'test-results'),{recursive:true});await page.screenshot({path:path.join(root,'test-results','timeline-editor.png')});assert.deepEqual(errors,[]);
  console.log('Timeline UI passed: mouse reorder and identity, notes/selection, standalone transition drag/swap/copy/config/delete, pending/error safety and full slide copy.');
}finally{await browser.close();await app.ai?.close?.();await app.renderer?.close?.();await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
