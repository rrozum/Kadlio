import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import {parseHTML} from 'linkedom';
import {Library} from '../backend/application/engine.js';
import {importPptxDocument} from '../backend/modules/imports/pptx.js';
import {copyProject} from '../backend/engine/presentations/copy.js';
import {buildReferenceDocuments,referenceGeometry} from './fixtures/reference-documents.js';

const fixture=await buildReferenceDocuments(),options={assetPrefix:'/api/projects/import-fixture/assets/'};
const documentOf=body=>parseHTML('<html><body>'+body+'</body></html>').document;
async function altered(change){const zip=await JSZip.loadAsync(fixture.pptx);await change(zip);return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});}
async function withLibrary(action){const directory=await mkdtemp(path.join(os.tmpdir(),'pptx-import-test-')),library=new Library(directory);try{await library.init();await action(library,directory);}finally{await rm(directory,{recursive:true,force:true});}}

test('PPTX import preserves editable text, inherited geometry/style, logo, notes and stacking',async()=>{
  const imported=await importPptxDocument(fixture.pptx,options);assert.equal(imported.slides.length,2);assert.equal(imported.font,'Arial');assert.equal(imported.assets.length,1);assert.deepEqual(imported.assets[0].buffer,fixture.logo);assert(imported.importReport.canvas.scale>0);
  const doc=documentOf(imported.slides[0].body),bodyText=doc.body.textContent;assert.match(bodyText,/A clear visual system/);assert.equal(bodyText.split('A clear visual system').length,2,'Source text exists exactly once, without a screenshot copy');assert.match(imported.slides[0].notes,/Synthetic speaker note/);
  const background=doc.querySelector('[data-pptx-background]');assert.equal(background.style.background,'#13223d');const panel=doc.querySelector('[aria-label="Shape 1"]');assert.equal(parseFloat(panel.style.left),referenceGeometry.panel.x);assert.equal(parseFloat(panel.style.top),referenceGeometry.panel.y);assert.equal(panel.dataset.blockType,'shape');assert.equal(panel.style.background,'#263958');assert.equal(panel.querySelector('svg'),null,'Basic shapes use editable CSS instead of a bitmap');
  const logo=doc.querySelector('img');assert.equal(parseFloat(logo.style.left),referenceGeometry.logo.x);assert.equal(parseFloat(logo.style.top),referenceGeometry.logo.y);assert.equal(logo.dataset.blockType,'image');assert.equal(doc.querySelectorAll('img').length,1,'Only the original logo is an image');assert.match(doc.querySelector('[data-block-type="text"] span').getAttribute('style'),/Arial/);assert.equal(panel.dataset.locked,'true');const titleWrapper=[...doc.querySelectorAll('[data-pptx-layer="slide"]')].find(node=>node.textContent==='A clear visual system');assert.equal(titleWrapper.style.border,undefined,'An empty a:ln must not add a black text-box outline');assert.equal(titleWrapper.dataset.locked,undefined);
});

test('Rich text beyond reference-inspection limits, paragraphs and transformed groups remain editable',async()=>{
  const long='Editable paragraph '.repeat(90),escaped=long.replaceAll('&','&amp;');
  const buffer=await altered(async zip=>{
    let source=await zip.file('ppt/slides/slide1.xml').async('string');source=source.replace('<a:t>A clear visual system</a:t>','<a:t>'+escaped+'</a:t>').replace('<a:t>Source text is content. Keep the reusable style.</a:t>','<a:t>First run</a:t></a:r><a:r><a:rPr sz="2400" b="1" u="sng"><a:solidFill><a:srgbClr val="42C9B0"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>Second run</a:t>');
    const group='<p:grpSp><p:nvGrpSpPr><p:cNvPr id="600" name="Rotated fixture group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm rot="5400000"><a:off x="1905000" y="1905000"/><a:ext cx="571500" cy="381000"/><a:chOff x="0" y="0"/><a:chExt cx="285750" cy="190500"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="601" name="Group square"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="95250" cy="47625"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="42C9B0"/></a:solidFill></p:spPr></p:sp></p:grpSp>';
    zip.file('ppt/slides/slide1.xml',source.replace('</p:spTree>',group+'</p:spTree>'));
  });
  const imported=await importPptxDocument(buffer,options),doc=documentOf(imported.slides[0].body);assert(doc.body.textContent.includes(long));const rich=[...doc.querySelectorAll('span')].find(node=>node.textContent==='Second run');assert.match(rich.getAttribute('style'),/font-weight:700/);assert.match(rich.getAttribute('style'),/text-decoration:underline/);assert.match(rich.getAttribute('style'),/color:#42c9b0/);
  const group=doc.querySelector('[aria-label="Group square"]');assert.equal(parseFloat(group.style.left),250);assert.equal(parseFloat(group.style.top),190);assert.match(group.style.transform,/matrix\(0,2,-2,0,0,0\)/);
});

test('Hidden slides are opt-in and non-wide aspect ratios are letterboxed',async()=>{
  const hidden=await altered(async zip=>{zip.file('ppt/slides/slide2.xml',(await zip.file('ppt/slides/slide2.xml').async('string')).replace('<p:sld ','<p:sld show="0" '));});
  const ordinary=await importPptxDocument(hidden,options);assert.equal(ordinary.slides.length,1);assert.equal(ordinary.importReport.hiddenSlideCount,1);assert.match(ordinary.importReport.warnings.join(' '),/Скрытые слайды пропущены/);assert.equal((await importPptxDocument(hidden,{...options,includeHidden:true})).slides.length,2);
  const square=await altered(async zip=>{zip.file('ppt/presentation.xml',(await zip.file('ppt/presentation.xml').async('string')).replace('cy="6858000"','cy="9144000"'));});
  const result=await importPptxDocument(square,options),background=documentOf(result.slides[0].body).querySelector('[data-pptx-background]');assert.equal(parseFloat(background.style.left),160);assert.equal(parseFloat(background.style.width),960);assert.equal(parseFloat(background.style.height),720);
});

test('Unsafe packages fail before any project is created, external media is never fetched',async()=>{
  for(const [name,change,pattern]of [
    ['traversal',zip=>zip.file('../escape.xml','<x/>'),/путь/],
    ['macros',zip=>zip.file('ppt/vbaProject.bin','macro fixture'),/макрос/],
    ['DTD',zip=>zip.file('docProps/extra.xml','<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>'),/DTD/],
    ['zip expansion',zip=>zip.file('unused.dat',Buffer.alloc(41*1024*1024)),/40 МБ/],
  ])await withLibrary(async library=>{const bytes=await altered(change);await assert.rejects(library.importPptx({name:name+'.pptx',data:bytes.toString('base64')}),pattern);assert.equal((await library.list()).length,0);});
  const external=await altered(async zip=>{const file='ppt/slideMasters/_rels/slideMaster1.xml.rels';zip.file(file,(await zip.file(file).async('string')).replace(/Target="\.\.\/media\/[^"]+"/,'Target="https://example.invalid/private-image.png" TargetMode="External"'));});
  const result=await importPptxDocument(external,options);assert.equal(result.assets.length,0);assert(!result.slides.some(slide=>slide.body.includes('https://')));assert.match(result.importReport.warnings.join(' '),/Внешние ссылки/);
});

test('New import publishes complete project with private original and supports CAS append/explicit replacement',async()=>withLibrary(async(library,directory)=>{
  const project=await library.importPptx({name:'source.pptx',title:'Imported fixture',data:fixture.pptx.toString('base64')});assert.equal(project.slides.length,2);assert.equal(project.title,'Imported fixture');assert.equal(project.slides[0].layout,'pptx-imported');const original=await library.materials.read(project.id,project.importReport.materialId);assert.deepEqual(original.buffer,fixture.pptx);assert.match((await library.materials.readMaterial(project.id,original.metadata.id)).text,/Source text is content/);assert.deepEqual(await readdir(path.join(directory,'import-staging')),[]);
  const firstId=project.slides[0].id,store=await library.getStore(project.id);await store.saveAnnotation({id:'keep-comment',slideId:firstId,x:.2,y:.3,comment:'Retain this annotation.'});
  const before=await library.get(project.id);await assert.rejects(library.importPptxInto(project.id,{buffer:fixture.pptx,name:'second.pptx',version:before.version+1}),error=>error.status===409);assert.equal((await library.materials.list(project.id)).length,1);
  const appended=await library.importPptxInto(project.id,{buffer:fixture.pptx,name:'second.pptx',version:before.version});assert.equal(appended.slides.length,4);assert.equal(appended.slides[0].body,before.slides[0].body);assert.deepEqual(appended.annotations,before.annotations);assert.deepEqual(appended.timeline.slice(0,before.timeline.length),before.timeline);
  const replaced=await library.importPptxInto(project.id,{buffer:fixture.pptx,name:'replacement.pptx',version:appended.version,mode:'replace'});assert.equal(replaced.slides.length,2);assert(!replaced.slides.some(slide=>slide.id===firstId));const archive=JSON.parse(await readFile(path.join(library.directory(project.id),replaced.importReport.previousMetadata),'utf8'));assert.deepEqual(archive.annotations,appended.annotations);assert.equal(archive.slides.length,4);assert.equal(await readFile(path.join(library.directory(project.id),'slides',firstId+'.html'),'utf8'),before.slides[0].body);
}));

test('A partial file-write failure rolls back only the new import files and keeps existing project intact',async()=>withLibrary(async(library)=>{
  const project=await library.create({title:'Existing fixture',blank:true}),target=library.directory(project.id);await mkdir(path.join(target,'slides','slide-03.html'));const before=await library.get(project.id);
  await assert.rejects(library.importPptxInto(project.id,{buffer:fixture.pptx,name:'failed.pptx',version:before.version}));const after=await library.get(project.id);assert.deepEqual(after,before);assert.equal((await library.materials.list(project.id)).length,0);assert.deepEqual((await readdir(path.join(target,'slides'))).sort(),['slide-01.html','slide-03.html']);
}));

test('Concurrent copy and import use the same project-before-material lock order',async()=>withLibrary(async library=>{
  const project=await library.create({title:'Concurrent fixture',blank:true}),queue=library.materials.queue.bind(library.materials);let release,entered,observed;const active=new Promise(resolve=>entered=resolve),requested=new Promise(resolve=>observed=resolve);
  const held=queue(project.id,()=>new Promise(resolve=>{release=resolve;entered();}));await active;
  library.materials.queue=(id,action)=>{observed();return queue(id,action);};
  const importing=library.importPptxInto(project.id,{buffer:fixture.pptx,name:'concurrent.pptx',version:project.version});await requested;const copying=copyProject(library,project.id,{version:project.version});release();await held;
  let timer;try{const results=await Promise.race([Promise.allSettled([importing,copying]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Project/material lock deadlock')),2000);})]);assert.equal(results[0].status,'fulfilled');if(results[1].status==='rejected')assert.equal(results[1].reason.status,409);assert.equal((await library.get(project.id)).slides.length,3);}finally{clearTimeout(timer);}
}));
