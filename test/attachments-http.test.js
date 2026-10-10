import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer,projectRoot} from '../backend/http/server.js';
import {createProjectTools} from '../backend/modules/mcp/tools.js';
import {formatToolResult} from '../backend/modules/mcp/server.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function application(t,options={}){const directory=await mkdtemp(path.join(os.tmpdir(),'attachment-http-')),running=await createServer(projectRoot,{authRequired:false,dataDir:directory,...options});t.after(async()=>{running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));await rm(directory,{recursive:true,force:true});});return running;}
const request=(running,url,method='GET',value)=>fetch(running.url+url,{method,headers:value?{'Content-Type':'application/json'}:{},body:value?JSON.stringify(value):undefined});

test('owner attachments upload and aliases preserve bytes; text downloads safely and cross-project reads fail',async t=>{
  const running=await application(t),p=await running.library.create({title:'Files'}),other=await running.library.create({title:'Other'}),base='/api/projects/'+p.id;
  const uploaded=await request(running,base+'/attachments','POST',{name:'пример.png',mime:'image/png',data:png});assert.equal(uploaded.status,200);const image=await uploaded.json();
  for(const suffix of ['', '/file']){const response=await request(running,base+'/attachments/'+image.id+suffix);assert.equal(response.headers.get('Content-Type'),'image/png');assert.match(response.headers.get('Content-Disposition'),/^inline;/);assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(png,'base64'));}
  assert.equal((await request(running,'/api/projects/'+other.id+'/attachments/'+image.id)).status,404);
  const text=await(await request(running,base+'/attachments','POST',{name:'source.html',mime:'text/html',data:Buffer.from('<script>alert(1)</script>').toString('base64')})).json();
  const downloaded=await request(running,base+'/attachments/'+text.id+'/file');assert.equal(downloaded.headers.get('Content-Type'),'text/plain');assert.match(downloaded.headers.get('Content-Disposition'),/^attachment;/);assert.equal(await downloaded.text(),'<script>alert(1)</script>');
  const tools=createProjectTools(running.library),read=await tools.execute('read_attachment',{attachmentId:image.id},{projectId:p.id}),formatted=formatToolResult(read);assert.equal(formatted.content[1].type,'image');assert.equal(formatted.content[0].text.includes(read.preview.data),false);
  const copied=await tools.execute('use_attachment_image',{attachmentId:image.id},{projectId:p.id});assert.ok(copied.url.startsWith(base+'/assets/'));assert.deepEqual(await running.library.asset(p.id,path.basename(copied.url)),Buffer.from(png,'base64'));
  await assert.rejects(()=>tools.execute('use_attachment_image',{attachmentId:text.id},{projectId:p.id}),error=>error.status===400);
  await assert.rejects(()=>tools.execute('read_attachment',{projectId:other.id,attachmentId:image.id},{projectId:p.id}),/ограничен/);
});

test('private attachment and preview APIs require a session and do not become public-share routes',async t=>{
  const running=await application(t,{authRequired:true,publicOrigin:'https://presentations.example'}),p=await running.library.create({title:'Protected files'}),base='/api/projects/'+p.id;
  const image=await running.ai.attachments.create(p.id,{name:'private.png',mime:'image/png',data:png});
  assert.equal((await request(running,base+'/attachments/'+image.id)).status,401);assert.equal((await request(running,base+'/slides/slide-01/preview')).status,401);
  const token=await running.library.share(p.id),shared=await request(running,'/s/'+token);assert.equal(shared.status,200);assert.equal((await shared.text()).includes(image.id),false);
  const notPublic=await request(running,'/s/'+token+'/attachments/'+image.id);assert.ok(notPublic.url.includes('/login'));assert.equal(notPublic.headers.get('Content-Type'),'text/html; charset=utf-8');
});
