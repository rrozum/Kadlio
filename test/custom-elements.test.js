import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseHTML} from 'linkedom';
import {Library} from '../backend/application/engine.js';
import {createProjectTools,createThemeTools} from '../backend/modules/mcp/tools.js';

const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function setup(t){const data=await mkdtemp(path.join(os.tmpdir(),'custom-elements-'));t.after(()=>rm(data,{recursive:true,force:true}));return new Library(data).init();}
test('reusable HTML element owns its images, survives source deletion, and inserts independent SVG/text at dropped coordinates',async t=>{
  const library=await setup(t),source=await library.create({title:'Element source'}),asset=await library.uploadAsset(source.id,{name:'logo.png',mime:'image/png',data:pixel.toString('base64')});
  const element=await library.elements.create(source.id,{name:'Reusable card',description:'Original fixture',width:320,height:220,body:`<div style="border-radius:16px;background:#234567"><svg viewBox="0 0 100 100"><defs><linearGradient id="paint"><stop stop-color="#ff0088"/></linearGradient></defs><path style="fill:url(#paint)" d="M0 0H100V100Z"/></svg><p>Editable text</p><img src="${asset.url}" style="width:24px;height:24px"></div>`});
  assert.equal(element.body,undefined);assert.equal((await library.elements.list()).find(item=>item.id===element.id).body,undefined);const template=await library.elements.get(element.id);assert(template.body.includes('/api/elements/'+element.id+'/assets/'));assert(!template.body.includes(source.id));await library.remove(source.id);
  const reopened=await new Library(library.dataDir).init();assert.deepEqual(await reopened.elements.asset(element.id,path.basename(asset.url)),pixel);
  const first=await reopened.create({title:'First destination'}),second=await reopened.create({title:'Second destination'}),slide=first.slides[0];
  const a=await reopened.insertElement(first.id,slide.id,{elementId:element.id,values:{x:240,y:130},version:slide.version}),b=await reopened.insertElement(second.id,second.slides[0].id,{elementId:element.id,values:{x:400,y:260},version:0});
  const document=html=>parseHTML('<html><body>'+html+'</body></html>').document,da=document(a.body),db=document(b.body),root=da.querySelector('[data-element-id]');
  assert.equal(root.style.left,'240px');assert.equal(root.style.top,'130px');assert(a.body.includes('Editable text'));assert(a.body.includes('/api/projects/'+first.id+'/assets/'));assert(b.body.includes('/api/projects/'+second.id+'/assets/'));assert.notEqual(da.querySelector('linearGradient').id,db.querySelector('linearGradient').id);assert(da.querySelector('path').getAttribute('style').includes(da.querySelector('linearGradient').id));
  const again=await reopened.insertElement(first.id,slide.id,{elementId:element.id,values:{x:4000,y:-40},version:a.version});assert.equal(document(again.body).querySelectorAll('[data-element-id]')[1].style.left,'960px');
  const before=await readFile(path.join(reopened.directory(first.id),'slides',slide.id+'.html'));await assert.rejects(reopened.insertElement(first.id,slide.id,{elementId:element.id,version:a.version}),e=>e.status===409);assert.deepEqual(await readFile(path.join(reopened.directory(first.id),'slides',slide.id+'.html')),before);
});
test('catalog creation rejects programs and foreign resources; project/theme MCP bindings remain enforced',async t=>{
  const library=await setup(t),a=await library.create({title:'A'}),b=await library.create({title:'B'}),tools=createProjectTools(library,{boundProjectId:a.id}),payload={name:'Safe element',width:100,height:100,body:'<div><p>Source content</p></div>'};
  for(const body of ['<div onclick="run()">x</div>','<div><script>run()</script></div>','<div style="background:url(https://example.test/image.png)">x</div>',`<div><img src="/api/projects/${b.id}/assets/private.png"></div>`,'<div><svg><foreignObject/></svg></div>','<p>A</p><p>B</p>',`<div><svg><path style="fill:url( '#another-element' )"/></svg></div>`,'<div><svg><use href="#another-element"/></svg></div>'])await assert.rejects(library.elements.create(a.id,{...payload,body}),e=>e.status===400);
  await assert.rejects(tools.execute('create_design_element',{...payload,projectId:b.id}),/ограничен/);assert.equal((await library.elements.list()).filter(item=>!item.builtin).length,0);
  const element=await tools.execute('create_design_element',payload);assert((await tools.execute('list_elements')).elements.some(item=>item.id===element.id));
  const theme=await library.themes.create({title:'Own theme',baseThemeId:'paper'}),themeTools=createThemeTools(library,{boundThemeId:theme.id});assert(themeTools.definitions.some(item=>item.name==='create_design_element'));
  await assert.rejects(themeTools.execute('create_design_element',{...payload,themeId:'paper'}),/ограничен/);
  const own=await themeTools.execute('create_design_element',{...payload,name:'Theme shape'});const inserted=await library.insertThemeElement(theme.id,{elementId:own.id,version:theme.version,values:{x:50,y:60}});assert(inserted.design.template.html.includes('data-element-id="'+own.id+'"'));assert(inserted.design.template.html.includes('left:50px'));
});

test('second insertion remaps quoted and spaced SVG URLs, links and accessible labels to its own definitions',async t=>{
  const library=await setup(t),project=await library.create({title:'SVG copies'});
  const element=await library.elements.create(project.id,{name:'Quoted SVG',width:240,height:160,body:'<div><svg aria-labelledby="label"><title id="label">Editable illustration</title><defs><linearGradient id="paint"><stop stop-color="#cc3344"/></linearGradient><clipPath id="clip"><rect width="80" height="80"/></clipPath><path id="path" d="M0 0H80V80Z"/></defs><path d="M0 0H80V80Z" fill="url( \'#paint\' )" clip-path="url( &quot;#clip&quot; )" style="stroke:url( \'#paint\' )"/><use href="#path" xlink:href="#path"/></svg><p>Editable text</p></div>'});
  const first=await library.insertElement(project.id,'slide-01',{elementId:element.id,version:0}),second=await library.insertElement(project.id,'slide-01',{elementId:element.id,version:first.version});
  const document=parseHTML('<html><body>'+second.body+'</body></html>').document,roots=[...document.querySelectorAll('[data-element-id]')];assert.equal(roots.length,2);
  const firstIds=new Set([...roots[0].querySelectorAll('[id]')].map(node=>node.id));
  for(const root of roots){const gradient=root.querySelector('linearGradient').id,clip=root.querySelector('clipPath').id,path=root.querySelector('defs > path').id,label=root.querySelector('title').id,paint=root.querySelector('svg > path');
    assert.equal(paint.getAttribute('fill'),"url('#"+gradient+"')");assert.equal(paint.getAttribute('clip-path'),'url("#'+clip+'")');assert.equal(paint.getAttribute('style'),"stroke:url('#"+gradient+"')");assert.equal(root.querySelector('use').getAttribute('href'),'#'+path);assert.equal(root.querySelector('use').getAttribute('xlink:href'),'#'+path);assert.equal(root.querySelector('svg').getAttribute('aria-labelledby'),label);assert.match(root.textContent,/Editable text/);
  }
  assert.ok([...roots[1].querySelectorAll('[id]')].every(node=>!firstIds.has(node.id)));assert.notEqual(roots[0].dataset.blockId,roots[1].dataset.blockId);
  assert.match((await library.elements.get(element.id)).body,/id="paint"/);
});
