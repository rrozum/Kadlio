import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Library} from '../backend/application/engine.js';
import {renderProject} from '../backend/engine/html/render.js';
import {createPresentationDesign} from '../shared/presentation/design.js';
import {createServer,projectRoot} from '../backend/http/server.js';

test('design stays separate from slide HTML; template variables follow metadata and slide ordering',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'presentation-design-'));
  try{
    const library=await new Library(directory).init(),initial=await library.create({title:'Title <safe>'});
    const second=await library.addSlide(initial.id,{title:'Second',body:'<h2>Second content</h2>'});
    let p=await library.get(initial.id);const originalBody=p.slides[0].body;
    const design=createPresentationDesign('light');design.metadata.author='Author <safe>';design.template.header='{{slideTitle}} — {{section}}';design.template.footer='{{author}} / {{projectTitle}}';
    p=await library.updateDesign(p.id,{design,version:p.version});
    assert.equal(p.slides[0].body,originalBody);
    assert.equal(p.design.tokens.background,'#f8fafc');
    await assert.rejects(library.updateDesign(p.id,{design,version:0}),e=>e.status===409);
    const html=await renderProject(projectRoot,p);
    assert.match(html,/Author &lt;safe&gt;/);assert.match(html,/Title &lt;safe&gt;/);
    assert.match(html,/template-page">01 \/ 2/);
    const reordered=await library.reorder(p.id,[second.id,p.slides[0].id]);
    const nextHTML=await renderProject(projectRoot,reordered);
    assert.match(nextHTML,new RegExp(`id="${second.id}"[\\s\\S]*?template-page">01 \\/ 2`));
    assert.doesNotMatch(await readFile(path.join(library.directory(p.id),'slides/slide-01.html'),'utf8'),/data-template-layer/);
    await assert.rejects(library.updateDesign(p.id,{design:{...design,tokens:{...design.tokens,font:'Arial; color:red'}},version:reordered.version}),e=>e.status===400);
    await assert.rejects(library.updateDesign(p.id,{design:{...design,background:{type:'image',value:'/api/projects/other/assets/a.png'}},version:reordered.version}),e=>e.status===400);
    const reset=await library.updateDesign(p.id,{design:null,version:reordered.version});assert.equal(reset.design,null);assert.equal(reset.slides[1].body,originalBody);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('preset insertion uses slide versions and public template backgrounds use only share asset URLs',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'presentation-preset-'));
  const running=await createServer(projectRoot,{authRequired:false,dataDir:directory});
  try{
    const response=async(url,method='GET',data)=>fetch(running.url+url,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});
    const p=await running.library.create({title:'Visible title'}),prefix='/api/projects/'+p.id;
    const catalog=await(await response('/api/presets')).json();assert.equal(catalog.blocks.length,12);assert.equal(catalog.themes.length,5);
    const insert=await response(prefix+'/slides/slide-01/preset','POST',{presetId:'comparison',values:{leftTitle:'Before <plain>'},version:0});assert.equal(insert.status,200);const slide=await insert.json();assert.match(slide.body,/Before &lt;plain&gt;/);assert.match(slide.body,/data-preset-id="comparison"/);
    assert.equal((await response(prefix+'/slides/slide-01/preset','POST',{presetId:'metrics',version:0})).status,409);
    const asset=await running.library.uploadAsset(p.id,{name:'background',mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='});
    const design=createPresentationDesign('dark');design.background={type:'image',value:asset.url};
    const current=await running.library.get(p.id);assert.equal((await response(prefix+'/design','PATCH',{design,version:current.version})).status,200);
    const token=await running.library.share(p.id),shared=await(await response('/s/'+token)).text();
    assert.ok(shared.includes('/s/'+token+'/assets/'));assert.ok(!shared.includes(asset.url));assert.match(shared,/data-template-layer/);
    assert.equal((await response('/s/'+token+'/assets/'+path.basename(asset.url))).status,200);
  }finally{await new Promise(resolve=>running.server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
