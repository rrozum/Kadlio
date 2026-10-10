import test from 'node:test';import assert from 'node:assert/strict';import os from 'node:os';import path from 'node:path';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {Library} from '../backend/application/engine.js';import {slideRuntimeDocument} from '../backend/modules/addons/runtime.js';import {createProjectTools,createThemeTools} from '../backend/modules/mcp/tools.js';import {exportWarnings} from '../backend/modules/exports/index.js';
const root=fileURLToPath(new URL('..',import.meta.url));
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'slide-runtime-')),library=await new Library(dir).init(),project=await library.create({title:'Runtime fixture',blank:true});t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,library,project};}

test('JS source remains inert on the server, syntax/CAS failures preserve HTML, snippet applications are independent copies',async t=>{
  const {library,project}=await fixture(t),id=project.id,sid=project.slides[0].id;
  const slide=await library.updateSlide(id,sid,{version:0,body:'<div data-block-id="box" style="position:absolute;left:-200px">Box</div>',script:'globalThis.__userScriptExecuted=true;'});
  assert.equal(globalThis.__userScriptExecuted,undefined);
  const snippet=await library.snippets.create({name:'Fixture',code:'element.style.color="red";',defaults:{duration:100}});
  const applied=await library.applyElementEffect(id,sid,{snippetId:snippet.id,blockId:'box',version:slide.version});
  await assert.rejects(()=>library.applyElementEffect(id,sid,{snippetId:snippet.id,blockId:'box',version:applied.version,options:'not JSON object'}),error=>error.status===400);
  await library.snippets.update(snippet.id,{version:0,code:'element.style.color="green";'});
  assert.equal((await library.get(id)).slides[0].elementEffects[0].code,'element.style.color="red";');
  await assert.rejects(()=>library.updateSlide(id,sid,{version:applied.version,body:'<p>Must not replace</p>',script:'const =;'}),error=>error.status===400);
  await assert.rejects(()=>library.updateSlide(id,sid,{version:0,script:'console.log(1)'}),error=>error.status===409);
  assert.equal((await library.get(id)).slides[0].body,slide.body);
  const locked=await library.updateSlide(id,sid,{version:applied.version,body:'<div data-locked="true"><div data-block-id="box">Locked by parent</div></div>'});
  await assert.rejects(()=>library.applyElementEffect(id,sid,{snippetId:snippet.id,blockId:'box',version:locked.version}),error=>error.status===400);
  for(const preset of ['none','fade','rise','zoom','slide','blur','stagger'])assert((await library.snippets.list()).some(item=>item.id===preset));
});

test('owned video assets and backgrounds copy into theme/project snapshots; invalid media cannot become runtime assets',async t=>{
  const {library,project}=await fixture(t),bytes=Buffer.from([0,0,0,20,...Buffer.from('ftypisom'),0,0,0,0,...Buffer.from('isom')]);
  const video=await library.uploadAsset(project.id,{name:'fixture.mp4',mime:'video/mp4',data:bytes.toString('base64')});
  await assert.rejects(()=>library.uploadAsset(project.id,{mime:'video/mp4',data:Buffer.from('<script>bad</script>').toString('base64')}),error=>error.status===400);
  const theme=await library.themes.create({title:'Video theme',baseThemeId:'light'}),themeVideo=await library.themes.uploadAsset(theme.id,{mime:'video/mp4',data:bytes.toString('base64')});
  const saved=await library.themes.update(theme.id,{version:theme.version,design:{...theme.design,background:{type:'video',value:themeVideo.url}}});
  const applied=await library.applyTheme(project.id,{themeId:theme.id,version:project.version});
  assert.match(applied.design.background.value,new RegExp('/api/projects/'+project.id+'/assets/'));assert.deepEqual(await library.asset(project.id,path.basename(applied.design.background.value)),bytes);
  assert.equal(saved.design.background.value,themeVideo.url);
  const document=await slideRuntimeDocument({root,project:applied,slideId:applied.slides[0].id,readAsset:name=>library.asset(project.id,name)});
  assert.match(document,/data:video\/mp4;base64,/);assert.doesNotMatch(document,/\/api\/(projects|themes)\//);assert.match(document,/sandbox|connect-src/);
});

test('runtime includes only visible source, blocks cross-project assets and accepts adjacent custom timeline snapshots',async t=>{
  const {library,project}=await fixture(t),id=project.id,sid=project.slides[0].id;
  await library.updateSlide(id,sid,{version:0,body:'<div data-block-id="box">Visible</div>',script:'slide.dataset.changed="yes";',notes:'PRIVATE SPOKEN NOTES',notesVersion:0});
  await library.addSlide(id,{body:'<p>Next</p>'});let current=await library.get(id);const snippet=await library.snippets.get('fade'),transition={type:'transition',id:crypto.randomUUID(),preset:'fade',duration:600,snippet:{snippetId:snippet.id,code:snippet.code,options:{duration:600}}};
  current=await library.updateTimeline(id,{version:current.version,timeline:[{type:'slide',id:sid},transition,{type:'slide',id:current.slides[1].id}]});
  const html=await slideRuntimeDocument({root,project:current,slideId:sid,transitionId:transition.id,readAsset:name=>library.asset(id,name)});
  assert.doesNotMatch(html,/PRIVATE SPOKEN NOTES|annotations|apiKey/);assert.match(html,/data:text\/javascript;base64,/);assert.doesNotMatch(html,/<script>.*slide\.dataset/s);
  await assert.rejects(()=>slideRuntimeDocument({root,project:current,slideId:sid,transitionId:crypto.randomUUID()}),error=>error.status===400);
  await library.updateSlide(id,sid,{version:current.slides[0].version,body:'<img src="/api/projects/another/assets/photo.png">'});
  const invalidProject=await library.get(id);await assert.rejects(()=>slideRuntimeDocument({root,project:invalidProject,slideId:sid,readAsset:name=>library.asset(id,name)}),error=>error.status===400);
  assert.equal(exportWarnings(current,'pdf').length,1);assert.deepEqual(exportWarnings(current,'html'),[]);
});

test('effect tools are bound to the current presentation; rendering options reach the renderer and theme scope excludes slide scripts',async t=>{
  const {library,project}=await fixture(t),other=await library.create({title:'Other'}),tools=createProjectTools(library,{boundProjectId:project.id}),calls=[];
  library.renderer={render:async(...args)=>{calls.push(args);return {preview:{mimeType:'image/png',data:'fixture'}};}};
  const snippet=await tools.execute('create_effect_snippet',{name:'Model effect',code:'element.style.opacity=.5;'});
  const slide=await tools.execute('update_slide',{slideId:project.slides[0].id,version:0,body:'<div data-block-id="target">Box</div>',script:'slide.dataset.test="yes";'});
  await tools.execute('apply_effect_snippet',{slideId:slide.id,version:slide.version,snippetId:snippet.id,blockId:'target'});
  await tools.execute('render_slide',{slideId:slide.id,atMs:450});assert.equal(calls[0][2].atMs,450);
  await assert.rejects(()=>tools.execute('update_slide',{projectId:other.id,slideId:other.slides[0].id,version:0,script:'void 0;'}),/текущей презентацией/);
  const themeTools=createThemeTools(library,{boundThemeId:'light'});await assert.rejects(()=>themeTools.execute('update_slide',{}),/недоступен/);
});

test('large repeated video references are rejected before expanding an otherwise small source into gigabytes',async t=>{
  const {project}=await fixture(t),url='/api/projects/'+project.id+'/assets/large.mp4';
  project.slides[0].body=Array.from({length:100},()=>'<video src="'+url+'"></video>').join('');
  await assert.rejects(()=>slideRuntimeDocument({root,project,slideId:project.slides[0].id,readAsset:async()=>Buffer.alloc(16*1024*1024)}),error=>error.status===413);
});
