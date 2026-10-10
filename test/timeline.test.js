import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import {parseHTML} from 'linkedom';
import {Library} from '../backend/application/engine.js';
import {createServer,projectRoot} from '../backend/http/server.js';
import {createProjectTools,createThemeTools} from '../backend/modules/mcp/tools.js';
import {exportHTML} from '../backend/modules/exports/html.js';
import {applyTimelineTransitions} from '../backend/modules/exports/index.js';
import {normalizeTimeline,validateTimeline,timelineForOrder,transitionForGap,boundaryTransition,timelineAfterSlideRemoval} from '../shared/presentation/timeline.js';

const slide=id=>({type:'slide',id}),transition=(preset='fade')=>({type:'transition',id:randomUUID(),preset,duration:600});
async function library(t){const dir=await mkdtemp(path.join(os.tmpdir(),'presentation-timeline-'));t.after(()=>rm(dir,{recursive:true,force:true}));return new Library(dir).init();}
async function threeSlides(lib){const project=await lib.create({title:'Timeline'});await lib.addSlide(project.id,{title:'Two',body:'<p>Two</p>'});await lib.addSlide(project.id,{title:'Three',body:'<p>Three</p>'});return lib.get(project.id);}

test('timeline preserves legacy boundaries and resolves the same transition in both directions',()=>{
  const project={slides:[{id:'slide-01',effects:{preset:'zoom',duration:700}},{id:'slide-02',effects:{preset:'slide',duration:500}},{id:'slide-03',effects:{preset:'fade',duration:600}}]};
  assert.deepEqual(normalizeTimeline(project),[slide('slide-01'),{type:'transition',id:'legacy-slide-02',preset:'slide',duration:500},slide('slide-02'),{type:'transition',id:'legacy-slide-03',preset:'fade',duration:600},slide('slide-03')]);
  assert.deepEqual(boundaryTransition(project,'slide-01','slide-02'),boundaryTransition(project,'slide-02','slide-01'));
  assert.equal(boundaryTransition(project,'slide-01','slide-03'),null);
  assert.equal(transitionForGap({slides:project.slides.slice(0,2).map(({effects,...s},i)=>i?s:{...s,effects:{preset:'zoom',duration:700}})},0).preset,'zoom');
  assert.deepEqual(normalizeTimeline({slides:[project.slides[0]]}),[slide('slide-01')]);
});

test('timeline rejects duplicates, lost slides, executable settings and extra transition cards',()=>{
  const slides=[{id:'slide-01'},{id:'slide-02'}],t=transition();
  for(const invalid of [[],[slide('slide-01')],[slide('slide-01'),slide('slide-01')],[t,...slides.map(s=>slide(s.id))],[slide('slide-01'),t,transition(),slide('slide-02')],[slide('slide-01'),{...t,preset:'javascript'},slide('slide-02')],[slide('slide-01'),{...t,id:'../../file'},slide('slide-02')],[slide('slide-01'),{...t,script:'bad'},slide('slide-02')]])assert.throws(()=>validateTimeline(invalid,slides));
  const checked=validateTimeline([slide('slide-01'),t,slide('slide-02')],slides);checked[1].duration=900;assert.equal(t.duration,600);
});

test('slide reorder retains gap slots; deletion cascades only the removed boundary',()=>{
  const a=transition('fade'),b=transition('slide'),project={slides:['slide-01','slide-02','slide-03'].map(id=>({id})),timeline:[slide('slide-01'),a,slide('slide-02'),b,slide('slide-03')]};
  assert.deepEqual(timelineForOrder(project,['slide-03','slide-01','slide-02']),[slide('slide-03'),a,slide('slide-01'),b,slide('slide-02')]);
  assert.deepEqual(timelineAfterSlideRemoval(project,'slide-02'),[slide('slide-01'),a,slide('slide-03')]);
  assert.deepEqual(timelineAfterSlideRemoval(project,'slide-01'),[slide('slide-02'),b,slide('slide-03')]);
  assert.deepEqual(timelineAfterSlideRemoval(project,'slide-03'),[slide('slide-01'),a,slide('slide-02')]);
});

test('canonical storage migrates legacy effects on timeline edit and preserves slide CAS',async t=>{
  const lib=await library(t),project=await threeSlides(lib),store=await lib.getStore(project.id);
  await store.mutate(p=>{delete p.timeline;p.slides[1].effects={preset:'fade',duration:600};});
  const derived=await lib.get(project.id);assert.equal(derived.timeline[1].preset,'fade');assert.equal(derived.slides[1].effects,undefined);assert.ok((await store.read()).slides[1].effects);
  const saved=await lib.updateTimeline(project.id,{timeline:derived.timeline,version:derived.version});assert.equal((await store.read()).slides.some(s=>'effects'in s),false);
  await assert.rejects(()=>lib.updateTimeline(project.id,{timeline:derived.timeline,version:derived.version}),e=>e.status===409);
  await assert.rejects(()=>lib.updateTimeline(project.id,{timeline:[slide('slide-01')],version:saved.version}),e=>e.status===400);
  assert.deepEqual((await lib.get(project.id)).timeline,saved.timeline);
  const edited=await lib.updateSlide(project.id,'slide-01',{body:'<p>Preserved</p>',version:saved.slides[0].version});
  assert.equal(edited.version,1);assert.deepEqual((await lib.get(project.id)).timeline,saved.timeline);
  await assert.rejects(()=>lib.updateSlide(project.id,'slide-01',{body:'<p>Invalid must not replace file</p>',effects:{preset:'execute',duration:600},version:1}),e=>e.status===400);
  assert.equal((await lib.get(project.id)).slides[0].body,'<p>Preserved</p>');
});

test('duplicate slide has independent HTML, notes and annotation IDs; transition stays after the copy',async t=>{
  const lib=await library(t),project=await threeSlides(lib),edge=transition('zoom'),store=await lib.getStore(project.id);
  await store.saveNotes([{id:'slide-01',notes:'Original speech',version:0}]);
  await store.saveAnnotation({id:'original-comment',slideId:'slide-01',x:.2,y:.3,comment:'Feedback'});
  let current=await lib.updateTimeline(project.id,{timeline:[slide('slide-01'),edge,slide('slide-02'),slide('slide-03')],version:project.version});
  const copied=await lib.duplicateSlide(project.id,'slide-01',{version:current.version}),copy=copied.slides.find(s=>s.id===copied.createdSlideId);
  assert.deepEqual(copied.timeline,[slide('slide-01'),slide(copy.id),edge,slide('slide-02'),slide('slide-03')]);assert.equal(copy.notes,'Original speech');assert.equal(copy.effects,undefined);
  const annotations=copied.annotations.filter(a=>a.slideId===copy.id);assert.equal(annotations.length,1);assert.notEqual(annotations[0].id,'original-comment');assert.equal(annotations[0].comment,'Feedback');
  await assert.rejects(()=>lib.duplicateSlide(project.id,'slide-01',{version:current.version}),e=>e.status===409);
  await lib.updateSlide(project.id,copy.id,{body:'<p>Independent copy</p>',version:copy.version});await(await lib.getStore(project.id)).saveNotes([{id:copy.id,notes:'Copied speech',version:copy.notesVersion}]);
  current=await lib.get(project.id);assert.notEqual(current.slides[0].body,current.slides[1].body);assert.equal(current.slides[0].notes,'Original speech');
  current=await lib.reorder(project.id,[copy.id,'slide-01','slide-02','slide-03']);assert.equal(transitionForGap(current,1).id,edge.id);
  current=await lib.removeSlide(project.id,'slide-01');assert.equal(transitionForGap(current,0),null);assert.equal(current.annotations.some(a=>a.id==='original-comment'),false);assert.ok(current.annotations.some(a=>a.id===annotations[0].id));
  await lib.addSlide(project.id,{title:'Four',body:'<p>Four</p>'});assert.equal(normalizeTimeline(await lib.get(project.id)).at(-1).type,'slide');
});

test('duplicated SVG definitions and HTML IDs are independent while block IDs and local references survive',async t=>{
  const lib=await library(t),project=await lib.create({title:'SVG copy'}),source=await lib.updateSlide(project.id,'slide-01',{version:0,body:'<style>#heading{color:#ff0000}.paint{fill:url("#gradient")}</style><h2 id="heading" data-block-id="headline">Editable heading</h2><svg data-block-id="illustration" aria-labelledby="heading"><defs><linearGradient id="gradient"><stop stop-color="#ff0000"/></linearGradient><clipPath id="clip"><rect width="90" height="90"/></clipPath><path id="path" d="M0 0L90 90"/></defs><rect fill="url(#gradient)" clip-path="url( \'#clip\' )" style="stroke:url(\'#gradient\')" width="90" height="90"/><use href="#path" xlink:href="#path"/></svg>'});
  const current=await lib.get(project.id),copied=await lib.duplicateSlide(project.id,'slide-01',{version:current.version}),copy=copied.slides.find(s=>s.id===copied.createdSlideId),original=parseHTML('<html><body>'+source.body+'</body></html>').document.body,clone=parseHTML('<html><body>'+copy.body+'</body></html>').document.body;
  const oldIds=new Set([...original.querySelectorAll('[id]')].map(n=>n.id)),newIds=new Set([...clone.querySelectorAll('[id]')].map(n=>n.id));assert.equal(newIds.size,4);assert.ok([...newIds].every(id=>!oldIds.has(id)));
  assert.equal(clone.querySelector('h2').dataset.blockId,'headline');assert.equal(clone.querySelector('svg').dataset.blockId,'illustration');assert.equal(clone.querySelector('svg').getAttribute('aria-labelledby'),clone.querySelector('h2').id);
  assert.equal(clone.querySelector('use').getAttribute('href'),'#'+clone.querySelector('path').id);assert.equal(clone.querySelector('use').getAttribute('xlink:href'),'#'+clone.querySelector('path').id);
  const gradient=clone.querySelector('linearGradient').id,clip=clone.querySelector('clipPath').id,paint=clone.querySelector('svg > rect');assert.equal(paint.getAttribute('fill'),'url(#'+gradient+')');assert.equal(paint.getAttribute('clip-path'),"url('#"+clip+"')");assert.equal(paint.getAttribute('style'),"stroke:url('#"+gradient+"')");
  assert.ok(clone.querySelector('style').textContent.includes('#'+clone.querySelector('h2').id+'{'));assert.ok(clone.querySelector('style').textContent.includes('#ff0000'));assert.ok(clone.querySelector('style').textContent.includes('url("#'+gradient+'")'));
  assert.equal(copied.slides[0].body,source.body);
});

test('timeline HTTP and MCP share validated scoped mutations and public viewer exposes no private notes',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'presentation-timeline-api-')),running=await createServer(projectRoot,{authRequired:false,dataDir:dir});
  t.after(async()=>{running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));await running.ai.close();await rm(dir,{recursive:true,force:true});});
  const lib=running.library,project=await threeSlides(lib),base=running.url+'/api/projects/'+project.id,tools=createProjectTools(lib,{boundProjectId:project.id}),edge=transition();
  const patch=async(value)=>fetch(base+'/timeline',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  const response=await patch({timeline:[slide('slide-01'),edge,slide('slide-02'),slide('slide-03')],version:project.version});assert.equal(response.status,200);let current=await response.json();
  assert.equal((await patch({timeline:current.timeline,version:project.version})).status,409);
  const reversed=timelineForOrder(current,['slide-03','slide-02','slide-01']);current=await tools.execute('update_timeline',{timeline:reversed,version:current.version});assert.equal(current.slides[0].id,'slide-03');
  await assert.rejects(()=>tools.execute('update_timeline',{projectId:'other',timeline:reversed,version:current.version}),/ограничен/);
  await assert.rejects(()=>tools.execute('update_timeline',{timeline:['bad'],version:current.version}),/Неверный/);
  await assert.rejects(()=>createThemeTools(lib,{boundThemeId:'dark'}).execute('update_timeline',{timeline:reversed,version:current.version}),/недоступен/);
  const copied=await tools.execute('duplicate_slide',{slideId:'slide-03',version:current.version});assert.equal(copied.slides[1].id,copied.createdSlideId);
  const copyResponse=await fetch(base+'/slides/slide-03/copy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:copied.version})});assert.equal(copyResponse.status,200);assert.ok((await copyResponse.json()).createdSlideId);
  await(await lib.getStore(project.id)).saveNotes([{id:'slide-03',notes:'PRIVATE_SPEECH',version:0}]);const token=await lib.share(project.id),visible=await(await fetch(running.url+'/s/'+token)).text();assert.match(visible,new RegExp(edge.id));assert.doesNotMatch(visible,/PRIVATE_SPEECH/);
});

test('PowerPoint transitions belong to incoming boundary, and offline HTML embeds the same timeline without private state',async()=>{
  const edge=transition('slide'),project={id:randomUUID(),title:'Portable',css:'',annotations:[{comment:'PRIVATE_COMMENT'}],slides:[{id:'slide-01',title:'One',body:'<p>One</p>',notes:'PRIVATE_SPEECH'},{id:'slide-02',title:'Two',body:'<p>Two</p>'}],timeline:[slide('slide-02'),edge,slide('slide-01')]};
  const pptx=new PptxGenJS();pptx.addSlide().addText('Two',{x:1,y:1,w:1,h:1});pptx.addSlide().addText('One',{x:1,y:1,w:1,h:1});
  const zip=await JSZip.loadAsync(await applyTimelineTransitions(await pptx.write({outputType:'nodebuffer'}),project));
  assert.doesNotMatch(await zip.file('ppt/slides/slide1.xml').async('string'),/<p:transition/);assert.match(await zip.file('ppt/slides/slide2.xml').async('string'),/<p:transition[^>]*><p:push dir="l"/);
  const html=(await exportHTML({root:projectRoot,project})).toString();assert.ok(html.indexOf('<section id="slide-02"')<html.indexOf('<section id="slide-01"'));assert.match(html,/boundaryTransition\(project,data\[index\].id,data\[target\].id\)/);assert.doesNotMatch(html,/PRIVATE_SPEECH|PRIVATE_COMMENT|^import /m);
  const metadata=JSON.parse(html.match(/id="offline-data">([\s\S]*?)<\/script>/)[1]);assert.deepEqual(metadata.timeline,project.timeline);assert.deepEqual(Object.keys(metadata.slides[0]),['id','title']);
});
