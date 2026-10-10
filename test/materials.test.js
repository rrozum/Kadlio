import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readFile,stat,readdir} from 'node:fs/promises';
import JSZip from 'jszip';
import {Library} from '../backend/application/engine.js';
import {createProjectTools,createThemeTools} from '../backend/modules/mcp/tools.js';
import {materialLimits} from '../backend/modules/uploads/materials.js';
import {createServer,projectRoot} from '../backend/http/server.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'materials-'));t.after(()=>rm(directory,{recursive:true,force:true}));const library=await new Library(directory).init(),project=await library.create({title:'Sources',blank:true});return {directory,library,project};}
const source=(name,text,mime='text/plain')=>({name,mime,data:Buffer.from(text).toString('base64')});

test('persistent materials preserve private originals, bounded extracted text and explicit unsupported statuses across reloads',async t=>{
  const {directory,library,project}=await fixture(t),store=library.materials;
  const text=await store.create(project.id,source('brief.txt','Facts supplied by the owner.'));
  assert.equal(text.status,'ready');assert.equal((await store.readMaterial(project.id,text.id)).text,'Facts supplied by the owner.');
  assert.equal((await stat(path.join(library.directory(project.id),'materials',text.id+'.bin'))).mode&0o777,0o600);
  const binary=await store.create(project.id,source('unknown.dat','\0binary\0','application/octet-stream'));assert.equal(binary.kind,'binary');assert.equal(binary.status,'unsupported_format');assert.equal((await store.readMaterial(project.id,binary.id)).text,'');
  const claimedImage=await store.create(project.id,source('bad.png','not an image','image/png'));assert.equal(claimedImage.kind,'binary');assert.equal(claimedImage.status,'unsupported_format');
  const malformed=await store.create(project.id,source('broken.pdf','not PDF','application/pdf'));assert.equal(malformed.status,'unreadable_document');assert.equal((await store.read(project.id,malformed.id)).buffer.toString(),'not PDF');
  const large=await store.create(project.id,source('long.txt','A'.repeat(150000)));assert.equal(large.truncated,true);assert.equal((await store.readMaterial(project.id,large.id)).text.length,100000);
  const context=await store.promptContext(project.id);assert.equal(context.materials.length,5);assert.ok(context.texts.reduce((sum,item)=>sum+item.text.length,0)<=20000);
  const restarted=await new Library(directory).init();assert.equal((await restarted.materials.list(project.id)).length,5);assert.equal((await restarted.materials.read(project.id,text.id)).buffer.toString(),'Facts supplied by the owner.');
  await assert.rejects(()=>readFile(path.join(directory,'ai/attachments',project.id,text.id+'.bin')),error=>error.code==='ENOENT');
});

test('DOCX/PPTX extraction is reused and material tools stay project bound; image assets survive original deletion',async t=>{
  const {library,project}=await fixture(t),other=await library.create({title:'Unrelated'}),store=library.materials;
  const zip=new JSZip();zip.file('word/document.xml','<w:document><w:p><w:t>Actual source &amp; context</w:t></w:p></w:document>');
  const document=await store.create(project.id,{name:'source.docx',mime:'application/octet-stream',data:(await zip.generateAsync({type:'nodebuffer'})).toString('base64')});assert.equal((await store.readMaterial(project.id,document.id)).text,'Actual source & context');
  const slideZip=new JSZip();slideZip.file('ppt/slides/slide2.xml','<a:p><a:t>Second</a:t></a:p>');slideZip.file('ppt/slides/slide1.xml','<a:p><a:t>First</a:t></a:p>');const deck=await store.create(project.id,{name:'source.pptx',data:(await slideZip.generateAsync({type:'nodebuffer'})).toString('base64')});assert.equal((await store.readMaterial(project.id,deck.id)).text,'First\n\nSecond');
  const image=await store.create(project.id,{name:'photo.png',mime:'image/png',data:png}),tools=createProjectTools(library,{boundProjectId:project.id});assert.equal((await tools.execute('read_material',{materialId:image.id})).preview.mimeType,'image/png');assert.equal((await tools.execute('list_materials')).materials.length,3);
  await assert.rejects(()=>tools.execute('read_material',{projectId:other.id,materialId:image.id}),/ограничен/);await assert.rejects(()=>store.read(other.id,image.id),error=>error.status===404);
  await assert.rejects(()=>tools.execute('delete_material',{materialId:image.id}),/Неизвестный/);assert.equal(createThemeTools(library,{boundThemeId:'light'}).definitions.some(tool=>tool.name==='read_material'),false);
  const asset=await tools.execute('use_material_image',{materialId:image.id});assert.ok(asset.url.startsWith('/api/projects/'+project.id+'/assets/'));await store.remove(project.id,image.id);assert.deepEqual(await library.asset(project.id,path.basename(asset.url)),Buffer.from(png,'base64'));
  await assert.rejects(()=>store.read(project.id,image.id),error=>error.status===404);assert.equal((await store.list(project.id)).length,2);
});

test('material quotas serialize simultaneous uploads and enforce file/count/project sizes without orphan files',async t=>{
  const {library,project}=await fixture(t),store=library.materials;
  for(let index=0;index<49;index++)await store.create(project.id,source('file-'+index+'.bin','x','application/octet-stream'));
  const results=await Promise.allSettled([store.create(project.id,source('a.bin','x','application/octet-stream')),store.create(project.id,source('b.bin','x','application/octet-stream'))]);assert.equal(results.filter(item=>item.status==='fulfilled').length,1);assert.equal(results.find(item=>item.status==='rejected').reason.status,413);assert.equal((await store.list(project.id)).length,50);
  const bytesProject=await library.create({title:'Bytes limit'}),full=Buffer.alloc(materialLimits.fileBytes).toString('base64');
  for(let index=0;index<12;index++)await store.create(bytesProject.id,{name:'large-'+index+'.bin',mime:'application/octet-stream',data:full});
  await store.create(bytesProject.id,{name:'remaining.bin',mime:'application/octet-stream',data:Buffer.alloc(4*1024*1024).toString('base64')});
  await assert.rejects(()=>store.create(bytesProject.id,source('too-much.bin','x','application/octet-stream')),error=>error.status===413);assert.equal((await store.list(bytesProject.id)).reduce((sum,item)=>sum+item.size,0),materialLimits.totalBytes);
  const empty=await library.create({title:'Oversize'});await assert.rejects(()=>store.create(empty.id,{name:'oversized.bin',data:Buffer.alloc(materialLimits.fileBytes+1).toString('base64')}),error=>error.status===413);assert.deepEqual(await store.list(empty.id),[]);
  assert.equal((await readdir(store.directory(bytesProject.id))).length,13*3);
});

test('material HTTP endpoints keep originals private, download executable text as data and allow only human deletion',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'materials-http-')),running=await createServer(projectRoot,{authRequired:false,dataDir:directory});t.after(async()=>{running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const project=await running.library.create({title:'HTTP materials'}),base=running.url+'/api/projects/'+project.id,request=(url,method='GET',value)=>fetch(url,{method,headers:value?{'Content-Type':'application/json'}:{},body:value?JSON.stringify(value):undefined});
  const response=await request(base+'/materials','POST',source('source.html','<script>must not run</script>','text/html'));assert.equal(response.status,200);const material=await response.json();
  for(const suffix of ['', '/file']){const file=await request(base+'/materials/'+material.id+suffix);assert.equal(file.headers.get('Content-Type'),'text/plain');assert.match(file.headers.get('Content-Disposition'),/^attachment;/);assert.equal(await file.text(),'<script>must not run</script>');}
  const listing=await(await request(base+'/materials')).json();assert.equal(listing.materials[0].id,material.id);assert.deepEqual(listing.limits,materialLimits);
  const token=await running.library.share(project.id),shared=await(await request(running.url+'/s/'+token)).text();assert.equal(shared.includes(material.id),false);assert.equal(shared.includes('source.html'),false);
  assert.equal((await request(running.url+'/s/'+token+'/materials/'+material.id)).status,404);assert.equal((await request(base+'/materials/'+material.id,'DELETE')).status,200);assert.equal((await request(base+'/materials/'+material.id)).status,404);
  const privateDir=await mkdtemp(path.join(os.tmpdir(),'private-materials-')),privateServer=await createServer(projectRoot,{authRequired:true,publicOrigin:'https://presentations.example',dataDir:privateDir});t.after(async()=>{privateServer.server.closeAllConnections();await new Promise(resolve=>privateServer.server.close(resolve));await rm(privateDir,{recursive:true,force:true});});assert.equal((await fetch(privateServer.url+'/api/projects/demo/materials')).status,401);
});
