import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,stat,readdir} from 'node:fs/promises';
import JSZip from 'jszip';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createCanvas} from '@napi-rs/canvas';
import {imageSize} from 'image-size';
import {AttachmentStore,attachmentLimits} from '../backend/modules/uploads/attachments.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJi0AAAAASUVORK5CYII=';
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'presentation-attachments-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new AttachmentStore({dataDir:directory,library:{async get(id){if(!['alpha','beta'].includes(id))throw Object.assign(new Error('Project not found'),{status:404});}}});
  return {store,directory};
}
const file=(name,text,mime='text/plain')=>({name,mime,data:Buffer.from(text).toString('base64')});

test('attachments preserve names and bytes privately; IDs are scoped to their project and never accept paths',async t=>{
  const {store,directory}=await fixture(t),image=await store.create('alpha',{name:'reference.png',mime:'image/png',data:png});
  assert.equal(image.kind,'image');assert.equal(image.previewUrl,`/api/projects/alpha/attachments/${image.id}`);
  assert.deepEqual((await store.read('alpha',image.id)).buffer,Buffer.from(png,'base64'));
  assert.equal((await stat(path.join(directory,'ai/attachments/alpha',image.id+'.bin'))).mode&0o777,0o600);
  assert.equal((await stat(path.join(directory,'ai/attachments/alpha'))).mode&0o777,0o700);
  await assert.rejects(()=>store.get('beta',image.id),error=>error.status===404);
  await assert.rejects(()=>store.create('../alpha',file('name.txt','x')),/projectId/);
  await assert.rejects(()=>store.create('missing',file('name.txt','x')),/Project not found/);
  await assert.rejects(()=>store.create('alpha',file('../secret.txt','x')),/без пути/);
  await assert.rejects(()=>store.get('alpha','../secret'),/ID/);
  assert.deepEqual((await readdir(path.join(directory,'ai/attachments/alpha'))).sort(),[image.id+'.bin',image.id+'.json'].sort());
});

test('strict uploads reject invalid encoding, oversized files, wrong image signatures and duplicate/context limits',async t=>{
  const {store}=await fixture(t);
  await assert.rejects(()=>store.create('alpha',{name:'x.txt',mime:'text/plain',data:'Z!==' }),/base64/);
  await assert.rejects(()=>store.create('alpha',{name:'x.txt',mime:'text/plain',data:'Zh=='}),/base64/);
  await assert.rejects(()=>store.create('alpha',{name:'x.png',mime:'image/png',data:Buffer.from('not an image').toString('base64')}),/формату/);
  const svg=await store.create('alpha',file('x.svg','<svg><script/></svg>','image/svg+xml'));
  assert.equal(svg.kind,'text');assert.equal(svg.mime,'text/plain');
  await assert.rejects(()=>store.create('alpha',file('x.txt','a'.repeat(attachmentLimits.fileBytes+1))),error=>error.status===413);
  const items=[];
  for(let i=0;i<4;i++)items.push(await store.create('alpha',file('large'+i+'.bin',Buffer.alloc(6*1024*1024,1),'application/octet-stream')));
  await assert.rejects(()=>store.context('alpha',items.map(item=>item.id)),error=>error.status===413);
  await assert.rejects(()=>store.context('alpha',[items[0].id,items[0].id]),/разных/);
  await assert.rejects(()=>store.context('alpha',Array(5).fill(items[0].id)),/до 4/);
});

test('text context is bounded across files; executable content is plain source, unsupported binaries stay explicit',async t=>{
  const {store}=await fixture(t);
  const html=await store.create('alpha',file('example.html','<script>throw "never execute"</script><h1>Example</h1>','text/html'));
  const large=await store.create('alpha',file('long.md','А'.repeat(attachmentLimits.textCharacters)));
  const binary=await store.create('alpha',file('archive.bin',Buffer.from([0,1,2]),'application/octet-stream'));
  const context=await store.context('alpha',[html.id,large.id,binary.id]);
  assert.equal(context.texts[0].text,'<script>throw "never execute"</script><h1>Example</h1>');
  assert.equal(context.texts.reduce((sum,item)=>sum+item.text.length,0),attachmentLimits.textCharacters);
  assert.equal(context.texts[1].truncated,true);assert.equal(context.texts[2].status,'unsupported_format');
  assert.equal(context.images.length,0);assert.equal(context.attachments.some(item=>'data' in item),false);
});

test('DOCX and PPTX extraction preserves text order and decodes XML entities without loading external resources',async t=>{
  const {store}=await fixture(t),docx=new JSZip(),pptx=new JSZip();
  docx.file('word/document.xml','<w:document xmlns:w="urn:w"><w:p><w:r><w:t>First &amp; second</w:t></w:r></w:p><w:p><w:r><w:t>Next &#x41;</w:t></w:r></w:p></w:document>');
  pptx.file('ppt/slides/slide10.xml','<a:p xmlns:a="urn:a"><a:r><a:t>Slide ten</a:t></a:r></a:p>');
  pptx.file('ppt/slides/slide2.xml','<a:p xmlns:a="urn:a"><a:r><a:t>Slide two</a:t></a:r></a:p>');
  const word=await store.create('alpha',{name:'brief.docx',mime:'',data:await docx.generateAsync({type:'base64'})});
  const slides=await store.create('alpha',{name:'reference.pptx',mime:'',data:await pptx.generateAsync({type:'base64'})});
  const context=await store.context('alpha',[word.id,slides.id]);
  assert.equal(context.texts[0].text,'First & second\nNext A');assert.equal(context.texts[1].text,'Slide two\n\nSlide ten');
  assert.ok(context.texts.every(item=>item.status==='ready'));
});

test('compressed oversized Office XML is rejected before full inflation',async t=>{
  const {store}=await fixture(t),archive=new JSZip();
  archive.file('word/document.xml','<w:t>'+'x'.repeat(3*1024*1024)+'</w:t>');
  const uploaded=await store.create('alpha',{name:'too-large.docx',mime:'',data:await archive.generateAsync({type:'base64',compression:'DEFLATE'})});
  const context=await store.context('alpha',[uploaded.id]);
  assert.equal(context.texts[0].status,'unreadable_document');assert.equal(context.texts[0].text,'');
});

test('PDF text is extracted by a parser without executing commands; scanned or malformed documents have explicit status',async t=>{
  const {store}=await fixture(t),document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText('Readable PDF reference',{font,x:30,y:300});
  const pdf=await store.create('alpha',{name:'reference.pdf',mime:'application/pdf',data:Buffer.from(await document.save()).toString('base64')});
  const context=await store.context('alpha',[pdf.id]);
  assert.equal(context.texts[0].status,'ready');assert.match(context.texts[0].text,/Readable PDF reference/);
  const empty=await PDFDocument.create();empty.addPage();
  const scanned=await store.create('alpha',{name:'scanned.pdf',mime:'application/pdf',data:Buffer.from(await empty.save()).toString('base64')});
  assert.equal((await store.context('alpha',[scanned.id])).texts[0].status,'no_text');
  const malformed=await store.create('alpha',file('invalid.pdf','not PDF','application/pdf'));
  assert.equal((await store.context('alpha',[malformed.id])).texts[0].status,'unreadable_document');
});

test('model image copies are resized and bounded while originals stay unchanged; huge dimensions fail before decoding',async t=>{
  const {store}=await fixture(t),canvas=createCanvas(3600,1200),drawing=canvas.getContext('2d');
  drawing.fillStyle='#3b5cff';drawing.fillRect(0,0,3600,1200);drawing.fillStyle='#fff';drawing.font='70px sans-serif';drawing.fillText('Reference image',80,300);
  const original=canvas.encodeSync('png'),uploaded=await store.create('alpha',{name:'large.png',mime:'image/png',data:original.toString('base64')});
  const context=await store.context('alpha',[uploaded.id]),image=Buffer.from(context.images[0].data,'base64'),size=imageSize(image);
  assert.equal(Math.max(size.width,size.height),1600);assert.ok(image.length<=attachmentLimits.imageBytes);
  assert.deepEqual((await store.read('alpha',uploaded.id)).buffer,original);
  const oversized=Buffer.from(png,'base64');oversized.writeUInt32BE(7000,16);oversized.writeUInt32BE(7000,20);
  await assert.rejects(()=>store.create('alpha',{name:'huge.png',mime:'image/png',data:oversized.toString('base64')}),/25 миллионов/);
});

test('large noisy PNG input falls back to bounded JPEG, and GIF is a still image for the model',async t=>{
  const {store}=await fixture(t),canvas=createCanvas(1200,1200),drawing=canvas.getContext('2d'),pixels=drawing.createImageData(1200,1200);let seed=123;
  for(let i=0;i<pixels.data.length;i+=4){for(let channel=0;channel<3;channel++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i+channel]=seed>>>24;}pixels.data[i+3]=255;}
  drawing.putImageData(pixels,0,0);
  const uploaded=await store.create('alpha',{name:'noise.png',mime:'image/png',data:canvas.encodeSync('png').toString('base64')});
  const image=(await store.context('alpha',[uploaded.id])).images[0];
  assert.equal(image.mime,'image/jpeg');assert.ok(Buffer.from(image.data,'base64').length<=attachmentLimits.imageBytes);
  const gif=await store.create('alpha',{name:'animation.gif',mime:'image/gif',data:'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'});
  assert.equal((await store.context('alpha',[gif.id])).images[0].mime,'image/png');
});
