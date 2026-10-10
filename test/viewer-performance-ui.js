import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {randomUUID} from 'node:crypto';
import {createServer} from '../backend/http/server.js';

const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=await mkdtemp(path.join(os.tmpdir(),'viewer-performance-'));
const app=await createServer(root,{authRequired:false,dataDir}),browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1660,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const pixels='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJi0AAAAASUVORK5CYII=';
try{
  let project=await app.library.create({title:'Viewer performance fixture'});
  const asset=await app.library.uploadAsset(project.id,{name:'pixel.png',mime:'image/png',data:pixels});
  const body=index=>'<div style="position:absolute;inset:0">'+Array.from({length:64},(_,i)=>`<article data-block-id="card-${i}" style="position:absolute;left:${(i%8)*142}px;top:${Math.floor(i/8)*71}px;width:136px;border:1px solid #456;border-radius:5px;padding:4px;background:#17212c"><h3 style="font-size:14px">${index}: ${i}</h3><p style="font-size:11px"><span>Text </span><b>value</b></p><img width="8" height="8" src="${asset.url}"></article>`).join('')+'</div>';
  await app.library.updateSlide(project.id,project.slides[0].id,{body:body(0),version:project.slides[0].version});
  const notes=await app.library.getStore(project.id);await notes.saveNotes([{id:project.slides[0].id,notes:'PRIVATE_NOTES_PERF_FIXTURE',version:0}]);
  for(let i=1;i<60;i++)await app.library.addSlide(project.id,{title:'Fixture '+i,body:body(i)});
  project=await app.library.get(project.id);await app.library.updateTimeline(project.id,{timeline:project.slides.flatMap((slide,index)=>index?[{type:'transition',id:randomUUID(),preset:'fade',duration:650},{type:'slide',id:slide.id}]:[{type:'slide',id:slide.id}]),version:project.version});
  await page.route('**/shared/addons/motion/runtime.js',async route=>{await new Promise(resolve=>setTimeout(resolve,200));await route.continue();});
  await page.addInitScript(()=>{
    window.viewerStats={clones:0,attributes:0,frames:[]};const clone=Node.prototype.cloneNode;
    Node.prototype.cloneNode=function(deep){if(this.matches?.('.slide'))viewerStats.clones++;return clone.call(this,deep);};
    new MutationObserver(records=>viewerStats.attributes+=records.filter(record=>record.target.matches?.('#deck-stage > .slide')).length).observe(document,{subtree:true,attributes:true});
    function frame(time){const slide=document.querySelector('#deck-stage > .slide.active');if(slide)viewerStats.frames.push(Number(getComputedStyle(slide).opacity));if(time<1000)requestAnimationFrame(frame);}requestAnimationFrame(frame);
  });
  await page.goto(app.url+'/projects/'+project.id+'/view');await page.evaluate(()=>import('/shared/addons/motion/runtime.js'));await page.waitForTimeout(1000);
  assert.equal(await page.locator('#overview-grid .slide').count(),0);
  const initial=await page.evaluate(()=>({clones:viewerStats.clones,flash:viewerStats.frames.some((opacity,index)=>opacity<.99&&viewerStats.frames.slice(0,index).includes(1))}));
  assert.equal(initial.clones,0);assert.equal(initial.flash,false,'Loading the effects module must not hide an already visible slide');
  const navigation=await page.evaluate(async()=>{
    viewerStats.clones=0;viewerStats.attributes=0;const costs=[];
    for(let i=0;i<30;i++){const start=performance.now();document.getElementById('next').click();costs.push(performance.now()-start);}
    await new Promise(resolve=>requestAnimationFrame(resolve));
    return {clones:viewerStats.clones,attributes:viewerStats.attributes,totalMs:costs.reduce((a,b)=>a+b,0),stageSlides:document.querySelectorAll('#deck-stage>.slide').length};
  });
  assert.equal(navigation.clones,0);assert.equal(navigation.stageSlides,60);
  assert.ok(navigation.attributes<30*20,'Navigation must mutate the two affected slides, not the entire deck');
  await page.waitForFunction(()=>!document.querySelector('#deck-stage [data-effect-running]'));
  const noOp=await page.evaluate(async()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));await new Promise(resolve=>requestAnimationFrame(resolve));viewerStats.attributes=0;document.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));await new Promise(resolve=>requestAnimationFrame(resolve));return viewerStats.attributes;});
  assert.equal(noOp,0,'Going to the current slide must not cancel or redraw it');
  await page.waitForFunction(()=>!document.querySelector('#deck-stage [data-effect-running]'));
  const coverage=await page.evaluate(async()=>{
    document.getElementById('next').click();let minimum=1,samples=0;
    await new Promise(resolve=>{function sample(){const incoming=document.querySelector('#deck-stage>.slide.active'),outgoing=document.querySelector('#deck-stage>[data-effect-ghost]');if(!outgoing){resolve();return;}const a=Number(getComputedStyle(incoming).opacity),b=Number(getComputedStyle(outgoing).opacity);minimum=Math.min(minimum,a+(1-a)*b);samples++;requestAnimationFrame(sample);}requestAnimationFrame(sample);});
    return {minimum,samples};
  });
  assert.ok(coverage.samples>0);assert.ok(coverage.minimum>.999,'Dissolve must retain an opaque outgoing layer rather than expose the dark stage');
  assert.equal(await page.locator('#deck-stage>.slide').count(),60);assert.equal(await page.locator('[data-effect-ghost]').count(),0);
  const unchanged=await page.evaluate(async()=>{const effects=await import('/shared/addons/motion/runtime.js');document.getElementById('next').click();const current=document.querySelector('#deck-stage>.slide.active'),before=current.getAnimations().length;await effects.playSlideEffect(current,{preset:'fade',duration:650},{previous:current});return {before,after:current.getAnimations().length};});
  assert.ok(unchanged.before>0);assert.equal(unchanged.after,unchanged.before,'The effect helper must preserve an active transition on a no-op');
  await page.locator('#overview-toggle').click();assert.equal(await page.locator('.overview-card').count(),60);
  await page.waitForFunction(()=>document.querySelector('#overview-grid .thumb>.slide'));
  assert.ok(await page.locator('#overview-grid .slide').count()<60,'Overview should hydrate nearby thumbnails, not all slide trees');
  await page.locator('.overview-card').last().scrollIntoViewIfNeeded();await page.locator('.overview-card').last().locator('.thumb>.slide').waitFor();
  await page.locator('.overview-card').last().click();assert.equal(await page.locator('#counter').textContent(),'60 / 60');
  await page.waitForFunction(()=>!document.querySelector('#deck-stage [data-effect-running]'));
  assert.equal(await page.locator('#overview-grid [data-effect-running],#overview-grid [data-effect-ghost]').count(),0);
  await page.locator('#fullscreen-toggle').click();await page.waitForFunction(()=>document.fullscreenElement);await page.evaluate(()=>document.exitFullscreen());
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#prev').click();assert.equal(await page.locator('[data-effect-running]').count(),0);
  const token=await app.library.share(project.id),shared=await browser.newPage();shared.on('pageerror',error=>errors.push(error.message));
  await shared.goto(app.url+'/s/'+token);assert.equal((await shared.content()).includes('PRIVATE_NOTES_PERF_FIXTURE'),false);assert.equal(await shared.locator('#notes-toggle').isVisible(),false);
  await shared.locator('#next').click();assert.equal(await shared.locator('#counter').textContent(),'2 / 60');await shared.close();
  // Effects preview may replay in the same iframe; unchanged HTML must not navigate it again.
  await page.goto(app.url+'/projects/'+project.id);await page.locator('#canvas-loading').waitFor({state:'hidden'});
  await page.locator('#effects-tool').click();await page.waitForFunction(()=>document.querySelector('#effects-dialog iframe')?.style.visibility!=='hidden'&&document.querySelector('#effects-dialog iframe')?.contentDocument.querySelector('.slide'));
  await page.evaluate(()=>{document.querySelector('#effects-dialog iframe').contentWindow.previewSentinel='same-document';});
  await page.locator('#effects-dialog .dialog-heading button').click();await page.locator('#effects-tool').click();
  assert.equal(await page.evaluate(()=>document.querySelector('#effects-dialog iframe').contentWindow.previewSentinel),'same-document');
  await page.locator('#effect-replay').click();await page.waitForFunction(()=>document.querySelector('#effects-dialog iframe').contentDocument.querySelector('.slide').dataset.effectRunning==='fade');
  await page.locator('#effects-dialog .dialog-heading button').click();
  project=await app.library.get(project.id);
  await app.library.updateSlide(project.id,project.slides[1].id,{body:'<h2 data-block-id="fresh">Fresh preview</h2>',version:project.slides[1].version});
  await page.frameLocator('.slide-thumbnail[data-slide-id="'+project.slides[1].id+'"] iframe').getByText('Fresh preview',{exact:true}).waitFor();
  await page.locator('#effects-tool').click();await page.frameLocator('#effects-dialog iframe').getByText('Fresh preview',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.querySelector('#effects-dialog iframe').contentWindow.previewSentinel),undefined,'Changed source must invalidate the cached preview');
  await page.locator('#effects-dialog .dialog-heading button').click();
  const response=await fetch(app.url+'/api/projects/'+project.id+'/export/html',{method:'POST'});assert.equal(response.status,200);const file=path.join(dataDir,'offline.html');await writeFile(file,Buffer.from(await response.arrayBuffer()));
  const offline=await browser.newPage(),requests=[];offline.on('pageerror',error=>errors.push(error.message));offline.on('request',request=>requests.push(request.url()));
  await offline.goto('file://'+file);await offline.locator('#next').click();await offline.waitForFunction(()=>!document.querySelector('[data-effect-running]'));assert.equal(await offline.locator('#counter').textContent(),'2 / 60');assert.equal(await offline.locator('#deck-stage>.slide').count(),60);assert.equal(await offline.locator('[data-effect-ghost]').count(),0);
  assert.ok(requests.every(url=>url.startsWith('file:')||url.startsWith('data:')));await offline.close();
  assert.deepEqual(errors,[]);console.log('Viewer performance regression passed:',JSON.stringify({initial,navigation,coverage}));
}finally{await browser.close();app.server.closeAllConnections();await app.ai.close();await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true});}
