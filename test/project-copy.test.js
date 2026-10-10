import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Library} from '../backend/application/engine.js';
import {copyProject} from '../backend/engine/presentations/copy.js';
import {slideRuntimeDocument} from '../backend/modules/addons/runtime.js';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('copy owns HTML, styles, images, notes and materials without changing source or sharing it',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'presentation-copy-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const lib=await new Library(dataDir).init();
 let original=await lib.create({title:'Independent deck',description:'Private brief',themeId:'paper'});
 const asset=await lib.uploadAsset(original.id,{name:'pixel.png',mime:'image/png',data:pixel.toString('base64')});
 await lib.updateSlide(original.id,original.slides[0].id,{version:0,body:'<img data-block-id="image" src="'+asset.url+'"><p>Private source text</p>',notes:'Private spoken notes',notesVersion:0});
 await lib.addSlide(original.id,{title:'Second',body:'<h1>Second slide</h1>'});
 await (await lib.getStore(original.id)).saveAnnotation({id:'comment',slideId:original.slides[0].id,x:.4,y:.5,comment:'Private feedback'});
 const sourceText='/api/projects/'+original.id+'/materials/excerpt is literal source data';
 const material=await lib.materials.create(original.id,{name:'brief.md',mime:'text/markdown',data:Buffer.from(sourceText).toString('base64')});
 const image=await lib.materials.create(original.id,{name:'image.png',mime:'image/png',data:pixel.toString('base64')});
 await lib.share(original.id);original=await lib.get(original.id);const sourceFile=path.join(lib.directory(original.id),'presentation.json'),before=await readFile(sourceFile);
 await writeFile(path.join(lib.directory(original.id),'auth.json'),'PRIVATE-AUTH-NEVER-COPY');
 const copy=await copyProject(lib,original.id,{version:original.version});assert.notEqual(copy.id,original.id);assert.equal(copy.title,original.title+' — копия');assert.equal(copy.description,'Private brief');assert.equal(copy.slides.length,2);assert.equal(copy.slides[0].notes,'Private spoken notes');assert.equal(copy.annotations[0].comment,'Private feedback');assert.notEqual(copy.annotations[0].id,original.annotations[0].id);assert.equal(copy.shareToken,null);assert.equal(copy.version,0);assert.equal(copy.creation.status,'ready');
 assert(copy.slides[0].body.includes('/api/projects/'+copy.id+'/assets/'));assert(!copy.slides[0].body.includes(original.id));assert.deepEqual(await lib.asset(copy.id,asset.url.split('/').at(-1)),pixel);
 const copiedMaterials=await lib.materials.list(copy.id);assert.equal(copiedMaterials.length,2);assert.equal(copiedMaterials.find(m=>m.id===image.id).previewUrl,'/api/projects/'+copy.id+'/materials/'+image.id);assert.equal((await lib.materials.readMaterial(copy.id,material.id)).text,sourceText);assert.equal((await lib.materials.read(copy.id,material.id)).buffer.toString(),sourceText);
 assert.deepEqual(await readFile(sourceFile),before);assert.equal((await readdir(lib.directory(copy.id))).includes('auth.json'),false);
 await lib.updateSlide(copy.id,copy.slides[0].id,{version:0,body:'<p>Changed copy</p>'});assert.equal((await lib.get(original.id)).slides[0].body,original.slides[0].body);
 await lib.remove(original.id);assert.deepEqual(await lib.asset(copy.id,asset.url.split('/').at(-1)),pixel);assert.equal((await lib.materials.list(copy.id)).length,2);
});
test('stale copy rejects atomically and creates no project or staging leftovers',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'presentation-copy-cas-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const lib=await new Library(dataDir).init(),source=await lib.create({title:'Original'});await lib.rename(source.id,{title:'Changed',version:source.version});
 await assert.rejects(copyProject(lib,source.id,{version:source.version}),e=>e.status===409);assert.equal((await lib.list()).length,1);assert.equal((await readdir(lib.projectsDir)).some(p=>p.startsWith('.copy-')),false);
});
test('copied slide and timeline programs embed their own assets after the source is deleted',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'presentation-copy-programs-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const lib=await new Library(dataDir).init();
 let source=await lib.create({title:'Interactive source',blank:true});const sid=source.slides[0].id,asset=await lib.uploadAsset(source.id,{name:'pixel.png',mime:'image/png',data:pixel.toString('base64')});
 await lib.updateSlide(source.id,sid,{version:0,body:'<img data-block-id="image" src="'+asset.url+'">',script:'slide.querySelector("img").src="'+asset.url+'";',elementEffects:[{id:'image-effect',blockId:'image',snippetId:'custom',code:'element.src=params.image; element.dataset.source="'+asset.url+'";',options:{image:asset.url,nested:{poster:asset.url}}}]});
 await lib.addSlide(source.id,{body:'<p>Next</p>'});source=await lib.get(source.id);
 source=await lib.updateTimeline(source.id,{version:source.version,timeline:[{type:'slide',id:sid},{type:'transition',id:randomUUID(),preset:'fade',duration:600,snippet:{snippetId:'custom',code:'slide.dataset.image="'+asset.url+'";',options:{image:asset.url}}},{type:'slide',id:source.slides[1].id}]});
 const originalJSON=await readFile(path.join(lib.directory(source.id),'presentation.json'),'utf8'),copy=await copyProject(lib,source.id,{version:source.version}),copiedURL=asset.url.replace(source.id,copy.id),slide=copy.slides[0],transition=copy.timeline[1];
 assert.match(slide.script,new RegExp(copy.id));assert.equal(slide.elementEffects[0].options.image,copiedURL);assert.equal(slide.elementEffects[0].options.nested.poster,copiedURL);assert.equal(transition.snippet.options.image,copiedURL);assert.match(transition.snippet.code,new RegExp(copy.id));
 assert.equal(await readFile(path.join(lib.directory(source.id),'presentation.json'),'utf8'),originalJSON);
 await lib.remove(source.id);
 const html=await slideRuntimeDocument({root:fileURLToPath(new URL('..',import.meta.url)),project:await lib.get(copy.id),slideId:sid,transitionId:transition.id,readAsset:name=>lib.asset(copy.id,name)});
 const program=Buffer.from(html.match(/<script src="data:text\/javascript;base64,([A-Za-z0-9+/=]+)"/)[1],'base64').toString();
 assert.match(html,/data:image\/png;base64,/);assert.match(program,/data:image\/png;base64,/);assert.doesNotMatch(html+program,/\/api\/projects\//);assert.doesNotMatch(html+program,new RegExp(source.id));
});
