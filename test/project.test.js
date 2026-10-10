import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer,projectRoot} from '../backend/http/server.js';

test('project APIs retain feedback across restarts and reject stale updates atomically',async t=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'studio-api-'));let app=await createServer(projectRoot,{dataDir,authRequired:false});
  t.after(async()=>{await new Promise(r=>app.server.close(r));await rm(dataDir,{recursive:true,force:true});});
  async function request(url,method='GET',data){const response=await fetch(app.url+url,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});return {status:response.status,data:await response.json()};}
  const project=(await request('/api/projects','POST',{title:'API example'})).data,prefix='/api/projects/'+project.id;
  const second=(await request(prefix+'/slides','POST',{title:'Second',body:'<p>Example</p>'})).data;
  const [a,b]=await Promise.all([request(prefix+'/notes','PATCH',{changes:[{id:'slide-01',notes:'First notes',version:0}]}),request(prefix+'/notes','PATCH',{changes:[{id:second.id,notes:'Second notes',version:0}]})]);assert.equal(a.status,200);assert.equal(b.status,200);
  assert.equal((await request(prefix+'/notes','PATCH',{changes:[{id:'slide-01',notes:'Stale',version:0},{id:second.id,notes:'Must remain',version:1}]})).status,409);
  assert.equal((await request(prefix+'/slides/slide-01','PATCH',{version:0,notes:'Stale notes',notesVersion:0})).status,409);
  const comment={id:'feedback',slideId:second.id,x:.3,y:.5,comment:'Simplify',anchorText:'Example'};
  const saved=(await request(prefix+'/annotations','POST',comment)).data;assert.equal(saved.annotation.comment,'Simplify');assert.equal(saved.message.annotationId,'feedback');assert.equal((await request(prefix+'/annotations','POST',{...comment,x:2})).status,400);
  await new Promise(r=>app.server.close(r));app=await createServer(projectRoot,{dataDir,authRequired:false});
  const after=(await request(prefix)).data;assert.equal(after.slides[0].notes,'First notes');assert.equal(after.slides[1].notes,'Second notes');assert.equal(after.annotations.length,1);assert.equal((await request(prefix+'/chat')).data.messages.length,1);
  await request(prefix+'/annotations','POST',{...comment,comment:'Reword'});assert.equal((await request(prefix+'/chat')).data.messages.length,1);
  const slideFile=path.join(app.library.directory(project.id),'slides',second.id+'.html');await writeFile(slideFile,'<h1>Direct HTML</h1><script>bad()</script>');const snapshot=(await request(prefix)).data;assert(snapshot.slides[1].body.includes('Direct HTML'));assert(!snapshot.slides[1].body.includes('script'));
  const foreign=await fetch(app.url+prefix+'/notes',{method:'PATCH',headers:{Origin:'https://elsewhere.test','Content-Type':'application/json'},body:'{}'});assert.equal(foreign.status,403);
  const agentToken=(await readFile(path.join(dataDir,'agent-token'),'utf8')).trim();assert.equal((await request('/api/agent-tools','POST',{name:'list_projects'})).status,401);
  const agent=await fetch(app.url+'/api/agent-tools',{method:'POST',headers:{Authorization:'Bearer '+agentToken,'Content-Type':'application/json'},body:JSON.stringify({name:'read_project',arguments:{projectId:project.id},projectId:project.id})});assert.equal(agent.status,200);
  assert.equal((await request(prefix+'/annotations/feedback','DELETE')).status,200);assert.equal((await request(prefix)).data.annotations.length,0);
});
