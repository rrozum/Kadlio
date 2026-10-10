import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Library} from '../backend/application/engine.js';
import {createServer,projectRoot} from '../backend/http/server.js';
import {createProjectTools} from '../backend/modules/mcp/tools.js';
import {themeTemplateSource,renderThemePreview,renderPresentationTemplate,presentationDesignCSS} from '../shared/presentation/design.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function library(t){const dir=await mkdtemp(path.join(os.tmpdir(),'presentation-themes-'));t.after(()=>rm(dir,{recursive:true,force:true}));return new Library(dir).init();}
async function server(t,options={}){const dir=await mkdtemp(path.join(os.tmpdir(),'presentation-theme-api-')),running=await createServer(projectRoot,{authRequired:false,dataDir:dir,...options});t.after(async()=>{running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));await rm(dir,{recursive:true,force:true});});return running;}
async function request(running,url,method='GET',data){return fetch(running.url+url,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});}

test('theme library stores immutable builtins, custom CAS and independent presentation snapshots',async t=>{
  const lib=await library(t),themes=await lib.themes.list();assert.equal(themes.length,5);assert.ok(themes.every(theme=>theme.builtin));
  await assert.rejects(()=>lib.themes.update('light',{version:0,title:'Override'}),error=>error.status===409);
  await assert.rejects(()=>lib.themes.remove('light',{version:0}),error=>error.status===409);
  const copy=await lib.themes.create({title:'My light theme',baseThemeId:'light'}),project=await lib.create({title:'Deck',themeId:copy.id});
  assert.equal(copy.builtin,false);assert.equal(copy.design.themeId,copy.id);assert.equal(project.design.tokens.accent,'#2563eb');
  const design=structuredClone(copy.design);design.tokens.accent='#cc3344';
  const updated=await lib.themes.update(copy.id,{design,version:copy.version});assert.equal(updated.version,1);
  await assert.rejects(()=>lib.themes.update(copy.id,{design,version:0}),error=>error.status===409);
  assert.equal((await lib.get(project.id)).design.tokens.accent,'#2563eb');
  const applied=await lib.applyTheme(project.id,{themeId:copy.id,version:project.version});assert.equal(applied.design.tokens.accent,'#cc3344');assert.equal(applied.slides[0].body,project.slides[0].body);
  await assert.rejects(()=>lib.applyTheme(project.id,{themeId:copy.id,version:project.version}),error=>error.status===409);
  await lib.themes.remove(copy.id,{version:updated.version});assert.equal((await lib.get(project.id)).design.tokens.accent,'#cc3344');
  assert.equal((await new Library(lib.dataDir).init().then(instance=>instance.themes.list())).length,5);
});

test('theme asset snapshots rebase background, template HTML and CSS and remain publicly viewable after theme deletion',async t=>{
  const running=await server(t),lib=running.library,theme=await lib.themes.create({title:'Image theme',baseThemeId:'dark'});
  const asset=await lib.themes.uploadAsset(theme.id,{name:'image',mime:'image/png',data:png});
  const design=structuredClone(theme.design);design.background={type:'image',value:asset.url};design.template.html=`<img data-block-id="logo" data-block-type="image" src="${asset.url}"><p>{{author}} / {{slideNumber}}</p>`;design.template.css=`.brand{background-image:url("${asset.url}")}`;
  const updated=await lib.themes.update(theme.id,{design,version:0}),project=await lib.create({title:'Image deck',themeId:theme.id}),prefix='/api/projects/'+project.id+'/assets/';
  assert.ok(project.design.background.value.startsWith(prefix));assert.ok(project.design.template.html.includes(prefix));assert.ok(project.design.template.css.includes(prefix));assert.equal(JSON.stringify(project.design).includes('/api/themes/'),false);
  assert.deepEqual(await lib.asset(project.id,path.basename(asset.url)),Buffer.from(png,'base64'));
  await lib.themes.remove(theme.id,{version:updated.version});
  const token=await lib.share(project.id),html=await(await request(running,'/s/'+token)).text();assert.equal(html.includes('/api/projects/'+project.id+'/assets/'),false);assert.equal(html.includes('/api/themes/'),false);assert.ok(html.includes('/s/'+token+'/assets/'));
  assert.equal((await request(running,'/s/'+token+'/assets/'+path.basename(asset.url))).status,200);
});

test('snapshotting original presentation preserves editable literal HTML/CSS without changing the deck',async t=>{
  const lib=await library(t),project=await lib.create({title:'Original deck'});
  const asset=await lib.uploadAsset(project.id,{name:'backdrop',mime:'image/png',data:png});
  await writeFile(path.join(lib.directory(project.id),'theme.css'),`.slide{background-image:url("${asset.url}");color:#ffffff}.slide:before{content:"";border-top:2px solid red}.footer>strong{font-weight:700}`);
  const copy=await lib.themes.create({title:'Original theme',projectId:project.id});
  assert.equal((await lib.get(project.id)).design,undefined);assert.equal((await lib.get(project.id)).version,0);
  assert.match(copy.design.sourceCSS,/background-image/);assert.equal(copy.design.sourceCSS.includes(asset.url),false);assert.ok(copy.design.sourceCSS.includes('/api/themes/'+copy.id+'/assets/'));
  const source=themeTemplateSource(copy.design);assert.match(source.html,/\{\{author\}\}/);assert.match(source.html,/\{\{slideNumber\}\}/);
  const preview=renderThemePreview(copy,{author:'A <safe>',slideNumber:3});assert.match(preview.html,/A &lt;safe&gt;/);assert.match(preview.html,/03 \/ 12/);assert.match(preview.css,/\.slide\.presentation-designed:before/);assert.doesNotMatch(preview.css,/display:none!important/);
  assert.equal(source.html.includes('A &lt;safe&gt;'),false);
});

test('custom template sanitization confines variables and assets, scopes CSS and preserves stable IDs',async t=>{
  const lib=await library(t),theme=await lib.themes.create({title:'Safe source',baseThemeId:'light'}),design=structuredClone(theme.design);
  design.template.html='<script>alert(1)</script><p onclick="alert(1)">{{projectTitle}}</p><img src="https://example.invalid/a.png">';
  design.template.css='body{color:red}@media(min-width:10px){.label{color:blue}}';
  const saved=await lib.themes.update(theme.id,{design,version:0});assert.doesNotMatch(saved.design.template.html,/script|onclick|https:/);assert.match(saved.design.template.html,/data-block-id=/);
  const ids=saved.design.template.html;const again=await lib.themes.update(theme.id,{design:saved.design,version:1});assert.equal(again.design.template.html,ids);
  const css=presentationDesignCSS(again.design);assert.match(css,/\.presentation-template\{color:red\}/);assert.match(css,/@media\(min-width:10px\)\{\.presentation-template \.label/);
  assert.match(renderPresentationTemplate({title:'<Title>',design:again.design,slides:[{}]},{}),/&lt;Title&gt;/);
  for(const change of [{html:'<p>{{unknown}}</p>'},{html:'<img alt="{{author}}">'},{html:'<p data-block-id="same">One</p><p data-block-id="same">Two</p>'},{css:'@import "https://example.invalid/spy.css";'},{css:'p{background:u\\72l(https://example.invalid/spy)}'}]){
    await assert.rejects(()=>lib.themes.update(theme.id,{version:2,design:{...again.design,template:{...again.design.template,...change}}}),error=>error.status===400);
  }
});

test('canonical APIs and MCP theme/element/CSS calls use the same storage and CAS boundaries',async t=>{
  const running=await server(t),lib=running.library,tools=createProjectTools(lib),project=await lib.create({title:'Canonical deck'});
  assert.equal((await(await request(running,'/api/themes')).json()).themes.length,5);assert.equal((await(await request(running,'/api/elements')).json()).elements.length,16);
  const theme=await(await request(running,'/api/themes','POST',{title:'Theme via API',baseThemeId:'warm'})).json();
  assert.equal((await tools.execute('read_theme',{themeId:theme.id})).title,'Theme via API');
  const applied=await tools.execute('apply_theme',{themeId:theme.id,version:0},{projectId:project.id});assert.equal(applied.design.themeId,theme.id);
  await assert.rejects(()=>tools.execute('create_theme',{title:'Forbidden cross-project',projectId:'other'},{projectId:project.id}),/ограничен/);
  const element=await tools.execute('insert_element',{slideId:'slide-01',elementId:'arrow-right',values:{color:'#cc3344'},version:0},{projectId:project.id});assert.match(element.body,/data-element-id="arrow-right"/);assert.match(element.body,/svg/);
  assert.equal((await request(running,'/api/projects/'+project.id+'/slides/slide-01/element','POST',{elementId:'arrow-right',version:0})).status,409);
  const current=await lib.get(project.id),css='.slide{background:#123456}.slide h1{font-size:56px}';
  await tools.execute('update_project_css',{css,version:current.version},{projectId:project.id});assert.equal((await lib.get(project.id)).css,css);
  await assert.rejects(()=>tools.execute('update_project_css',{css:'.slide{color:red}',version:current.version},{projectId:project.id}),error=>error.status===409);assert.equal((await lib.get(project.id)).css,css);
  await assert.rejects(()=>tools.execute('update_project_css',{css:'.slide{background:url(https://example.invalid/a.png)}',version:current.version+1},{projectId:project.id}),error=>error.status===400);
  const second=await lib.addSlide(project.id,{body:'<p>Second slide</p>'});
  const effect=await lib.updateSlide(project.id,second.id,{effects:{preset:'fade',duration:600},version:second.version});
  const timeline=(await lib.get(project.id)).timeline;assert.deepEqual(timeline[1],{type:'transition',id:timeline[1].id,preset:'fade',duration:600});assert.equal(effect.effects,undefined);
  await assert.rejects(()=>lib.updateSlide(project.id,second.id,{effects:{preset:'execute',duration:600},version:effect.version}),error=>error.status===400);
});

test('theme APIs require authentication, and live events are project scoped and include notes/annotation revisions',async t=>{
  const unauth=await server(t,{authRequired:true,publicOrigin:'https://presentations.example'});assert.equal((await request(unauth,'/api/themes')).status,401);
  const running=await server(t),lib=running.library,project=await lib.create({title:'Observed deck'}),other=await lib.create({title:'Other deck'}),controller=new AbortController();
  const response=await fetch(running.url+'/api/projects/'+project.id+'/events',{signal:controller.signal}),reader=response.body.getReader();
  await lib.updateSlide(other.id,'slide-01',{body:'<p>Unrelated</p>',version:0});
  await(await lib.getStore(project.id)).saveNotes([{id:'slide-01',notes:'A note',version:0}]);
  const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/"version":0/);assert.match(first,/"revision":/);assert.doesNotMatch(first,/Unrelated/);
  await(await lib.getStore(project.id)).saveAnnotation({id:'feedback',slideId:'slide-01',x:.2,y:.3,comment:'A comment'});
  const second=new TextDecoder().decode((await reader.read()).value);assert.notEqual(first,second);assert.match(second,/"version":0/);
  controller.abort();await reader.cancel().catch(()=>{});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(lib.events.listenerCount('projectChanged'),0);
});
