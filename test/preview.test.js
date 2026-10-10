import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createSlideRenderer} from '../backend/modules/previews/slides.js';
import {formatToolResult,createProxyTools} from '../backend/modules/mcp/server.js';
import {createPresentationDesign} from '../shared/presentation/design.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const model={id:'owned',slides:[{id:'slide-01',title:'Preview',body:'<h1>Visible</h1>'}],css:''};

test('MCP returns a native image plus compact metadata, never base64 inside its text block',()=>{
  const result=formatToolResult({slideId:'slide-01',warnings:[],preview:{mimeType:'image/png',data:png.toString('base64')}});
  assert.equal(result.content[1].type,'image');assert.equal(result.content[1].mimeType,'image/png');assert.equal(result.content[1].data,png.toString('base64'));
  assert.deepEqual(JSON.parse(result.content[0].text),{slideId:'slide-01',warnings:[],preview:{mimeType:'image/png'}});
  assert.equal(result.content[0].text.includes(png.toString('base64')),false);
  assert.throws(()=>formatToolResult({preview:{mimeType:'image/svg+xml',data:'bad'}}),/изображение/);
});

test('renderer confines network/assets, disables page scripts, remains read-only and limits concurrency',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'preview-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'frontend'));await writeFile(path.join(root,'frontend/deck.css'),'.slide{color:white}');
  let contextOptions,routeHandler,release,closed=0;const assetReads=[],fulfilled=[],aborted=[];
  const route=(url)=>({request:()=>({url:()=>url}),fulfill:async reply=>fulfilled.push({url,reply}),abort:async()=>aborted.push(url)});
  const page={setDefaultTimeout(){},route:async(_,handler)=>{routeHandler=handler;},goto:async()=>{
    await routeHandler(route('http://presentation.local/'));await routeHandler(route('http://presentation.local/deck.css'));await routeHandler(route('http://presentation.local/api/projects/owned/assets/a.png'));
    await routeHandler(route('http://presentation.local/api/projects/other/assets/private.png'));await routeHandler(route('https://example.invalid/tracker'));await routeHandler(route('file:///etc/passwd'));
  },evaluate:async fn=>fn.name==='inspectCanvas'?{blocks:[],warnings:[]}:undefined,screenshot:async()=>png};
  const browser={newContext:async options=>{contextOptions=options;return {newPage:async()=>page};},close:async()=>{closed++;}};
  const library={get:async id=>{assert.equal(id,'owned');return structuredClone(model);},asset:async(id,name)=>{assetReads.push([id,name]);return png;}};
  const renderer=createSlideRenderer({root,library,launchBrowser:()=>new Promise(resolve=>{release=()=>resolve(browser);})}),before=JSON.stringify(model);
  const first=renderer.render('owned','slide-01');while(!release)await new Promise(resolve=>setImmediate(resolve));await assert.rejects(()=>renderer.render('owned','slide-01'),error=>error.status===429);release();
  const result=await first;assert.equal(result.width,1280);assert.equal(result.height,720);assert.equal(result.preview.mimeType,'image/png');assert.equal(contextOptions.javaScriptEnabled,false);
  assert.deepEqual(assetReads,[['owned','a.png']]);assert.equal(fulfilled.length,3);assert.equal(aborted.length,3);assert.ok(result.warnings.some(item=>item.code==='external-resource'));assert.equal(closed,1);assert.equal(JSON.stringify(model),before);
});

test('theme renderer shares the job budget and confines theme assets without accessing project storage',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'theme-preview-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'frontend'));await writeFile(path.join(root,'frontend/deck.css'),'.slide{display:block}');
  const theme={id:'theme-owned',title:'Template',version:3,design:createPresentationDesign('light')},readAssets=[],aborted=[],fulfilled=[];theme.design.metadata.author='Visible author';theme.design.template.html='<p data-block-id="author">{{author}}</p>';
  let handler,release,html;
  const route=url=>({request:()=>({url:()=>url}),fulfill:async result=>{fulfilled.push(url);if(url.endsWith('/'))html=result.body;},abort:async()=>aborted.push(url)});
  const page={setDefaultTimeout(){},route:async(_,value)=>{handler=value;},goto:async()=>{for(const url of ['http://presentation.local/','http://presentation.local/deck.css','http://presentation.local/api/themes/theme-owned/assets/image.png','http://presentation.local/api/themes/foreign/assets/image.png','http://presentation.local/api/projects/foreign/assets/image.png','https://external.invalid/image.png'])await handler(route(url));},evaluate:async fn=>fn.name==='inspectCanvas'?{blocks:[],warnings:[]}:undefined,screenshot:async()=>png};
  const renderer=createSlideRenderer({root,library:{get:async()=>{throw new Error('No hidden project');},themes:{get:async id=>{assert.equal(id,theme.id);return theme;},asset:async(id,name)=>{readAssets.push([id,name]);return png;}}},launchBrowser:()=>new Promise(resolve=>{release=()=>resolve({newContext:async()=>({newPage:async()=>page}),close:async()=>{}});})});
  const pending=renderer.renderTheme(theme.id);while(!release)await new Promise(resolve=>setImmediate(resolve));await assert.rejects(()=>renderer.render('foreign','slide-01'),error=>error.status===429);release();
  const result=await pending;assert.equal(result.themeId,theme.id);assert.equal(result.version,3);assert.equal(result.slideId,undefined);assert.deepEqual(readAssets,[[theme.id,'image.png']]);assert.equal(fulfilled.length,3);assert.equal(aborted.length,3);assert.match(html,/Visible author/);assert.equal(html.includes('{{author}}'),false);assert.match(theme.design.template.html,/\{\{author\}\}/);
});

test('large slide images switch to bounded JPEG without changing canvas dimensions',async()=>{
  const captures=[],browser={close:async()=>{},newContext:async()=>({newPage:async()=>({setDefaultTimeout(){},route:async()=>{},goto:async()=>{},evaluate:async fn=>fn.name==='inspectCanvas'?{blocks:[],warnings:[]}:undefined,screenshot:async options=>{captures.push(options);return options.type==='png'?Buffer.alloc(800000):Buffer.alloc(100000);}})})};
  const result=await createSlideRenderer({root:'.',library:{get:async()=>model},launchBrowser:async()=>browser}).render('owned','slide-01');
  assert.equal(result.preview.mimeType,'image/jpeg');assert.equal(Buffer.from(result.preview.data,'base64').length,100000);assert.deepEqual(captures.map(item=>item.type),['png','jpeg']);assert.equal(captures[1].quality,85);assert.equal(result.width,1280);
});

test('MCP proxy accepts bounded native preview payloads and preserves project binding',async()=>{
  const proxy=createProxyTools({url:'http://127.0.0.1:3210/api/agent-tools',token:'fixture-token',projectId:'owned',fetchImpl:async(_,request)=>{assert.equal(JSON.parse(request.body).projectId,'owned');return {ok:true,text:async()=>JSON.stringify({preview:{mimeType:'image/png',data:png.toString('base64')}})};}});
  assert.equal((await proxy.execute('render_slide',{slideId:'slide-01'})).preview.mimeType,'image/png');
  await assert.rejects(()=>proxy.execute('render_slide',{projectId:'other',slideId:'slide-01'}),/ограничен/);
});

test('MCP cancellation reaches the bridge fetch and renderer shutdown releases an active job',async()=>{
  const controller=new AbortController(),proxy=createProxyTools({url:'http://127.0.0.1:3210/api/agent-tools',token:'fixture-token',fetchImpl:async(_,request)=>{request.signal.throwIfAborted();}});controller.abort();
  await assert.rejects(()=>proxy.execute('render_slide',{projectId:'owned',slideId:'slide-01'},{signal:controller.signal}),error=>error.name==='AbortError');
  let rejectNavigation,closed=0;
  const browser={newContext:async()=>({newPage:async()=>({setDefaultTimeout(){},route:async()=>{},goto:()=>new Promise((resolve,reject)=>{rejectNavigation=reject;})})}),close:async()=>{closed++;rejectNavigation?.(new Error('Closed'));}};
  const renderer=createSlideRenderer({root:'.',library:{get:async()=>model},launchBrowser:async()=>browser}),cancel=new AbortController(),pending=renderer.render('owned','slide-01',{signal:cancel.signal});
  while(!rejectNavigation)await new Promise(resolve=>setImmediate(resolve));cancel.abort();await assert.rejects(()=>pending,error=>error.name==='AbortError');assert.ok(closed>=1);
});
