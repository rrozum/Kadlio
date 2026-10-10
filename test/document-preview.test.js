import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,writeFile,readFile,readdir,stat,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import JSZip from 'jszip';
import {DocumentPreviewStore,prepareOfficeDocument,documentNetworkFilter} from '../backend/modules/previews/documents.js';
import {AttachmentStore} from '../backend/modules/uploads/attachments.js';
import {createProjectTools,createThemeTools} from '../backend/modules/mcp/tools.js';
import {formatToolResult} from '../backend/modules/mcp/server.js';
import {buildReferenceDocuments,referencePalette} from './fixtures/reference-documents.js';

async function fixture(t,options={}){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'document-preview-test-'));
  const previews=new DocumentPreviewStore({dataDir,...options});
  t.after(async()=>{previews.close();await rm(dataDir,{recursive:true,force:true});});
  return {dataDir,previews,documents:await buildReferenceDocuments()};
}
async function pixel(preview,x,y){
  const image=await loadImage(Buffer.from(preview.data,'base64')),canvas=createCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);
  return '#'+[...context.getImageData(Math.round(x*image.width/1280),Math.round(y*image.height/720),1,1).data].slice(0,3).map(value=>value.toString(16).padStart(2,'0')).join('');
}
async function shim(directory,pdf,{delay=0}={}){
  const file=path.join(directory,'sandbox.mjs'),capture=path.join(directory,'capture.json');
  await writeFile(file,`#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2),job=args[args.indexOf('--bind')+1];\nfs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,profile:fs.readFileSync(job+'/profile/user/registrymodifications.xcu','utf8')}));\nawait new Promise(resolve=>setTimeout(resolve,${delay}));\nfs.writeFileSync(job+'/source.pdf',Buffer.from(${JSON.stringify(pdf.toString('base64'))},'base64'));\n`,{mode:0o700});
  return {file,capture};
}

test('actual PDF images preserve colours and geometry, select page 2 and reuse private cache',async t=>{
  const {dataDir,previews,documents}=await fixture(t),source={metadata:{name:'style.pdf'},buffer:documents.pdf};
  const first=await previews.render(source),second=await previews.render(source,2);
  assert.equal(first.document.status,'ready');assert.equal(first.document.renderer,'pdfjs');assert.equal(first.document.pageCount,2);
  assert.equal(first.width,1200);assert.equal(first.height,675);
  assert.equal(await pixel(first.preview,600,100),referencePalette.background);
  assert.equal(await pixel(first.preview,300,300),referencePalette.surface);
  assert.equal(await pixel(first.preview,300,6),referencePalette.accent);
  assert.equal(await pixel(second.preview,300,6),referencePalette.secondAccent);
  assert.ok(Buffer.from(first.preview.data,'base64').length<=1024*1024);
  const third=await previews.render(source,3);assert.equal(third.document.status,'page_not_found');assert.equal(third.preview,undefined);
  const restarted=new DocumentPreviewStore({dataDir,renderMs:100});t.after(()=>restarted.close());
  assert.deepEqual(await restarted.render(source),first);
  const directory=path.join(dataDir,'ai/document-previews'),names=await readdir(directory);
  assert.ok(names.every(name=>/^[a-f0-9]{64}$/.test(name)));
  assert.equal((await stat(directory)).mode&0o777,0o700);
  const entry=path.join(directory,names[0]);assert.equal((await stat(path.join(entry,'page-1.bin'))).mode&0o777,0o600);
});

test('Office conversion uses fixed isolated argv/profile, emits real PDF image and avoids repeating conversion',async t=>{
  const {dataDir,documents}=await fixture(t),converter=await shim(dataDir,documents.pdf),previews=new DocumentPreviewStore({dataDir,command:'/usr/bin/true',sandboxCommand:converter.file});t.after(()=>previews.close());
  const result=await previews.render({metadata:{name:'Unsafe $(echo secret).pptx'},buffer:documents.pptx});
  assert.equal(result.document.status,'ready');assert.equal(result.document.renderer,'libreoffice+pdfjs');assert.equal(result.document.pageCount,2);assert.match(result.document.warnings[0],/PowerPoint/);
  assert.equal(await pixel(result.preview,300,300),referencePalette.surface);
  const captured=JSON.parse(await readFile(converter.capture,'utf8'));
  assert.ok(captured.args.includes('--unshare-all'));assert.ok(captured.args.includes('--share-net'));assert.ok(captured.args.includes('--seccomp'));
  assert.ok(captured.args.includes('/work/source.pptx'));assert.equal(captured.args.some(arg=>arg.includes('$(')),false);
  assert.equal(captured.args.includes('/home'),false);assert.match(captured.profile,/MacroSecurityLevel/);assert.match(captured.profile,/<value>3<\/value>/);assert.match(captured.profile,/DisableMacrosExecution[^]*<value>true<\/value>/);
  const capturedText=await readFile(converter.capture,'utf8');await previews.render({metadata:{name:'same.pptx'},buffer:documents.pptx},2);
  assert.equal(await readFile(converter.capture,'utf8'),capturedText);
  assert.equal((await readdir(path.join(dataDir,'ai/document-previews'))).some(name=>name.startsWith('.job-')),false);
});

test('unsafe Office scripts/traversal/DTD are refused and remote links are removed before conversion',async t=>{
  const {documents}=await fixture(t),archive=await JSZip.loadAsync(documents.pptx);
  archive.file('ppt/slides/_rels/slide1.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="remote" TargetMode="External" Type="image" Target="https://example.invalid/private.png"/><Relationship Id="local" Type="image" Target="../media/image-1-1.png"/></Relationships>');
  const prepared=await prepareOfficeDocument(await archive.generateAsync({type:'nodebuffer'}),'pptx'),safe=await JSZip.loadAsync(prepared.buffer),relations=await safe.file('ppt/slides/_rels/slide1.xml.rels').async('string');
  assert.equal(prepared.externalBlocked,true);assert.equal(relations.includes('example.invalid'),false);assert.match(relations,/\.\.\/media/);
  archive.file('ppt/vbaProject.bin','macro');
  await assert.rejects(async()=>prepareOfficeDocument(await archive.generateAsync({type:'nodebuffer'}),'pptx'),/unsafe_document/);archive.remove('ppt/vbaProject.bin');
  archive.file('../escape.xml','x');await assert.rejects(async()=>prepareOfficeDocument(await archive.generateAsync({type:'nodebuffer'}),'pptx'),/unsafe_document/);archive.remove('../escape.xml');
  archive.file('ppt/slides/_rels/slide1.xml.rels','<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><Relationships/>');
  await assert.rejects(async()=>prepareOfficeDocument(await archive.generateAsync({type:'nodebuffer'}),'pptx'),/unsafe_document/);
  const odp=new JSZip();odp.file('content.xml','<office:document-content xmlns:office="urn:o" xmlns:draw="urn:d" xmlns:xlink="urn:x"><draw:image xlink:href="file:///etc/passwd"/></office:document-content>');
  const safeOdp=await prepareOfficeDocument(await odp.generateAsync({type:'nodebuffer'}),'odp');assert.equal(safeOdp.externalBlocked,true);assert.equal((await (await JSZip.loadAsync(safeOdp.buffer)).file('content.xml').async('string')).includes('file:///'),false);
});

test('conversion unavailable, bounded job contention, timeout and cancellation stay explicit and clean temp files',async t=>{
  const {dataDir,documents}=await fixture(t),unavailable=new DocumentPreviewStore({dataDir,command:'/definitely/missing'});t.after(()=>unavailable.close());
  const source={metadata:{name:'reference.pptx'},buffer:documents.pptx};
  const missing=await unavailable.render(source);assert.equal(missing.document.status,'converter_unavailable');assert.equal(missing.preview,undefined);
  const converter=await shim(dataDir,documents.pdf,{delay:2000}),previews=new DocumentPreviewStore({dataDir,command:'/usr/bin/true',sandboxCommand:converter.file,convertMs:150});t.after(()=>previews.close());
  const pending=previews.render(source);for(let attempt=0;!previews.active&&attempt<30;attempt++)await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(()=>previews.render(source),error=>error.status===429);
  const timeout=await pending;assert.equal(timeout.document.status,'preview_timeout');assert.equal(timeout.preview,undefined);
  const controller=new AbortController(),cancelled=previews.render(source,1,{signal:controller.signal});setTimeout(()=>controller.abort(),40);
  await assert.rejects(()=>cancelled,error=>error.name==='AbortError');
  assert.equal((await readdir(path.join(dataDir,'ai/document-previews'))).some(name=>name.startsWith('.job-')),false);
  const corrupt=await previews.render({metadata:{name:'bad.pdf'},buffer:Buffer.from('invalid')});assert.equal(corrupt.document.status,'unreadable_document');
});

test('bound tools supply native document images and structured reference assets, never read a different context',async t=>{
  const {dataDir,documents,previews}=await fixture(t),projects=new Set(['alpha','beta']),themes=new Set(['theme-a','theme-b']),uploads=[];
  const library={documentPreviews:previews,async get(id){if(!projects.has(id))throw new Error('missing project');return {id};},themes:{async get(id){if(!themes.has(id))throw new Error('missing theme');return {id};},async uploadAsset(id,file){uploads.push({id,file});return {url:'/api/themes/'+id+'/assets/logo.png'};}},async uploadAsset(id,file){uploads.push({id,file});return {url:'/api/projects/'+id+'/assets/logo.png'};}};
  library.attachments=new AttachmentStore({dataDir,library});library.themeAttachments=new AttachmentStore({dataDir,library,scope:'theme'});
  const file=(name,buffer)=>({name,mime:'',data:buffer.toString('base64')});
  const pdf=await library.attachments.create('alpha',file('source.pdf',documents.pdf)),pptx=await library.attachments.create('alpha',file('style.pptx',documents.pptx));
  const tools=createProjectTools(library,{boundProjectId:'alpha'}),first=await tools.execute('read_attachment',{attachmentId:pdf.id});
  assert.match(first.text,/clear visual system/);assert.equal(first.document.pageCount,2);assert.ok(first.preview.data);
  const native=formatToolResult(first);assert.equal(native.content[1].type,'image');assert.equal(native.content[1].data,first.preview.data);assert.equal(native.content[0].text.includes(first.preview.data),false);
  const context=await library.attachments.context('alpha',[pdf.id]);assert.equal(context.images.length,1);assert.equal(context.documents[0].document.pageCount,2);
  const page=await tools.execute('render_document_page',{attachmentId:pdf.id,page:2});assert.equal(await pixel(page.preview,300,6),referencePalette.secondAccent);
  await assert.rejects(()=>tools.execute('render_document_page',{attachmentId:pdf.id,materialId:'x',page:1}),/ровно один/);
  await assert.rejects(()=>tools.execute('render_document_page',{attachmentId:pdf.id,page:101}),/аргумент/);
  await assert.rejects(()=>tools.execute('render_document_page',{projectId:'beta',attachmentId:pdf.id,page:1}),/ограничен/);
  await assert.rejects(()=>createProjectTools(library,{boundProjectId:'beta'}).execute('render_document_page',{attachmentId:pdf.id,page:1}),error=>error.status===404);
  const reference=await tools.execute('inspect_presentation_reference',{attachmentId:pptx.id});assert.equal(reference.reference.slides.length,2);assert.ok(reference.reference.images.length);
  await tools.execute('use_reference_image',{attachmentId:pptx.id,assetId:reference.reference.images[0].assetId});assert.equal(uploads[0].id,'alpha');assert.equal(uploads[0].file.mime,'image/png');
  const themeFile=await library.themeAttachments.create('theme-a',file('source.pdf',documents.pdf)),themeTools=createThemeTools(library,{boundThemeId:'theme-a'});
  assert.equal((await themeTools.execute('read_attachment',{attachmentId:themeFile.id})).document.status,'ready');
  await assert.rejects(()=>themeTools.execute('render_document_page',{themeId:'theme-b',attachmentId:themeFile.id,page:1}),/ограничен/);
  await assert.rejects(()=>themeTools.execute('render_document_page',{materialId:'x',page:1}),/attachmentId/);
  await assert.rejects(()=>themeTools.execute('render_document_page',{attachmentId:pdf.id,page:1}),error=>error.status===404);
});

test('real Linux sandbox blocks internet sockets and cannot read the host private file',async t=>{
  if(process.platform!=='linux'||!['x64','arm64'].includes(process.arch))return t.skip('Linux seccomp test');
  try{await access('/usr/bin/bwrap');await access('/usr/bin/python3');}catch{return t.skip('bubblewrap/python not installed');}
  const {dataDir,previews}=await fixture(t),job=path.join(dataDir,'sandbox-job');await (await import('node:fs/promises')).mkdir(job,{mode:0o700});
  const secret=path.join(dataDir,'host-secret');await writeFile(secret,'must not be visible');
  await writeFile(path.join(job,'probe.py'),`import socket,errno,os\nfor family in (socket.AF_INET,socket.AF_INET6,socket.AF_NETLINK):\n try:\n  socket.socket(family,socket.SOCK_STREAM)\n  raise RuntimeError('internet socket allowed')\n except OSError as e:\n  assert e.errno == errno.EACCES\nsocket.socket(socket.AF_UNIX,socket.SOCK_STREAM).close()\nassert not os.path.exists(${JSON.stringify(secret)})\nprint('isolated')\n`);
  const args=await previews.sandboxArguments(job,'pptx'),separator=args.indexOf('--');args.splice(separator+1);args.push('/usr/bin/python3','/work/probe.py');
  const child=spawn('/usr/bin/bwrap',args,{stdio:['ignore','pipe','pipe','pipe']}),chunks=[],errors=[];child.stdio[3].on('error',()=>{});child.stdio[3].end(documentNetworkFilter());child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));
  const code=await new Promise(resolve=>child.on('close',resolve)),stderr=Buffer.concat(errors).toString();
  if(code&&/Operation not permitted|Permission denied|No permissions/.test(stderr))return t.skip('Host disallows user namespaces: '+stderr.trim());
  assert.equal(code,0,stderr);assert.equal(Buffer.concat(chunks).toString().trim(),'isolated');
});
