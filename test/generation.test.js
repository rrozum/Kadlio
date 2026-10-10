import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {Library} from '../backend/application/engine.js';
import {AIService} from '../backend/modules/ai/service.js';
import {createServer,projectRoot} from '../backend/http/server.js';

async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'generation-'));t.after(()=>rm(directory,{recursive:true,force:true}));const library=await new Library(directory).init();return {directory,library};}
async function* stream(events){yield* events;}
function callsEvent(calls){return stream([{type:'response.completed',response:{output:calls.map((call,index)=>({type:'function_call',id:'item-'+index,call_id:'call-'+index+'-'+Math.random(),name:call.name,arguments:JSON.stringify(call.arguments||{})}))}}]);}
const finalEvent=()=>stream([{type:'response.output_text.delta',delta:'Создал презентацию по материалам.'},{type:'response.completed',response:{output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Создал презентацию по материалам.'}]}]}}]);
function clientFor(library,projectId,{count=6,materialId,inspect=()=>{},preserveFirst=false}={}){
  let turn=0;return {responses:{create:async request=>{
    inspect(request,turn);const current=await library.get(projectId);
    if(turn++===0)return callsEvent([{name:'read_project'},{name:'list_materials'}]);
    if(turn===2&&materialId)return callsEvent([{name:'read_material',arguments:{materialId}}]);
    const mutationTurn=materialId?3:2;
    if(turn===mutationTurn){
      const calls=[];if(!preserveFirst)calls.push({name:'update_slide',arguments:{slideId:current.slides[0].id,version:current.slides[0].version,body:'<h1 data-block-id="title">Owner source fact</h1>'}});
      for(let index=current.slides.length;index<count;index++)calls.push({name:'add_slide',arguments:{title:'Section '+(index+1),body:'<h2 data-block-id="heading">Source section '+(index+1)+'</h2>'}});return callsEvent(calls);
    }
    if(turn===mutationTurn+1)return callsEvent(current.slides.map(slide=>({name:'update_notes',arguments:{slideId:slide.id,notes:'Spoken explanation from the supplied source.',notesVersion:slide.notesVersion}})));
    if(turn===mutationTurn+2)return callsEvent([{name:'render_slide',arguments:{slideId:current.slides[0].id}}]);
    return finalEvent();
  }}};
}
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function renderer(library){library.renderer={render:async(pid,slideId)=>({slideId,preview:{mimeType:'image/png',data:image},warnings:[]})};}

test('project creation preserves legacy title slides and stores blank/manual/smart metadata with CAS and materials',async t=>{
  const {library}=await fixture(t),legacy=await library.create({title:'Legacy title'});assert.match(legacy.slides[0].body,/Legacy title/);
  const project=await library.create({title:'Wizard',description:' Owner brief ',creationMode:'smart',blank:true});assert.equal(project.slides[0].body,'');assert.equal(project.description,'Owner brief');assert.equal(project.creation.status,'pending');
  const material=await library.materials.create(project.id,{name:'brief.txt',mime:'text/plain',data:Buffer.from('Original remains').toString('base64')});
  let next=await library.rename(project.id,{title:'Updated',description:'New brief',creationMode:'manual',version:project.version});assert.equal(next.creation.status,'ready');assert.equal(next.creationMode,'manual');
  await assert.rejects(()=>library.rename(project.id,{title:'Stale',version:project.version}),error=>error.status===409);next=await library.rename(project.id,{creationMode:'smart',version:next.version});assert.equal(next.creation.status,'pending');assert.equal((await library.materials.read(project.id,material.id)).buffer.toString(),'Original remains');
  assert.ok((await library.list()).find(item=>item.id===project.id).creation);await assert.rejects(()=>library.create({title:'Bad',description:'x'.repeat(10001)}),error=>error.status===400);
  await assert.rejects(()=>library.create({title:'Bad',creationMode:'automatic'}),error=>error.status===400);
});

test('manual creation never invokes the provider; smart preflight failures leave pending status/history unchanged',async t=>{
  const {directory,library}=await fixture(t);let modelCalls=0,availableCalls=0;
  const service=new AIService({dataDir:directory,library,root:projectRoot,clientFactory:()=>{modelCalls++;throw new Error('Must not invoke');}});t.after(()=>service.close());service.acp.available=async()=>{availableCalls++;return false;};
  const manual=await library.create({title:'Manual',creationMode:'manual',blank:true});await assert.rejects(()=>service.generate({projectId:manual.id}),error=>error.status===409);assert.equal(modelCalls,0);assert.equal(availableCalls,0);assert.equal((await library.get(manual.id)).creation.status,'ready');
  const smart=await library.create({title:'Smart',creationMode:'smart',blank:true});await service.saveSettings({provider:'openai',model:'fixture',clearApiKey:true});await assert.rejects(()=>service.generate({projectId:smart.id}),error=>error.status===409);assert.equal((await library.get(smart.id)).creation.status,'pending');assert.equal((await library.get(smart.id)).creation.attempts,0);assert.deepEqual(await service.history(smart.id),{messages:[]});assert.equal(service.generations.size,0);
  await service.saveSettings({provider:'acp'});await assert.rejects(()=>service.generate({projectId:smart.id}),error=>error.status===409);assert.equal((await library.get(smart.id)).creation.status,'pending');
});

for(const count of [3,6])test(`real tool loop produces ${count} slides, spoken notes and persisted ready state; sources reach every project prompt`,async t=>{
  const {directory,library}=await fixture(t),project=await library.create({title:'Source-based deck',description:count===3?'Сделай ровно 3 слайда для коллег.':'Explain source facts to colleagues.',creationMode:'smart',blank:true}),material=await library.materials.create(project.id,{name:'owner-facts.txt',mime:'text/plain',data:Buffer.from('Owner source fact: verified project fact.').toString('base64')});renderer(library);
  let requests=0,mode='generate';const client=clientFor(library,project.id,{count,materialId:material.id,inspect:request=>{requests++;assert.match(request.input[0].content,/owner-facts\.txt/);assert.match(request.input[0].content,/verified project fact/);assert.ok(request.tools.some(tool=>tool.name==='read_material'));}}),service=new AIService({dataDir:directory,library,root:projectRoot,clientFactory:()=>mode==='generate'?client:{responses:{create:async request=>{assert.match(request.input[0].content,/owner-facts\.txt/);assert.match(request.input[0].content,/verified project fact/);return finalEvent();}}}});t.after(()=>service.close());await service.saveSettings({provider:'openai',model:'fixture',apiKey:'fixture-key'});
  const events=[],result=await service.generate({projectId:project.id,onEvent:event=>events.push(event)});assert.equal(result.creation.status,'ready');assert.ok(requests>1);
  const current=await library.get(project.id);assert.equal(current.slides.length,count);assert.equal(current.slides[0].id,project.slides[0].id);assert.ok(current.slides.every(slide=>slide.body.trim()&&slide.notes.trim()));assert.equal(current.creation.status,'ready');assert.equal(current.creation.attempts,1);assert.ok(current.creation.completedAt);
  assert.equal(events[0].creation.status,'generating');assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).creation.status,'ready');assert.ok(events.some(event=>event.type==='tool'&&event.name==='read_material'&&event.status==='completed'));
  assert.equal((await library.materials.list(project.id))[0].id,material.id);assert.equal((await service.history(project.id)).messages.length,2);
  const before=requests;await assert.rejects(()=>service.generate({projectId:project.id}),error=>error.status===409);assert.equal(requests,before);await assert.rejects(()=>library.rename(project.id,{creationMode:'manual',version:current.version}),error=>error.status===409);
  mode='chat';assert.equal((await service.send({projectId:project.id,message:'Review these sources again'})).content,'Создал презентацию по материалам.');
});

test('provider errors retain partial slides/materials; retry continues current content without duplicates or overwriting manual edits',async t=>{
  const {directory,library}=await fixture(t),project=await library.create({title:'Retry',creationMode:'smart',blank:true}),material=await library.materials.create(project.id,{name:'source.txt',data:Buffer.from('Keep original').toString('base64')});renderer(library);
  let failTurn=0,mode='fail';const failing={responses:{create:async()=>{if(failTurn++===0)return callsEvent([{name:'update_slide',arguments:{slideId:'slide-01',version:0,body:'<h1>Partial title</h1>'}},{name:'add_slide',arguments:{title:'Partial section',body:'<h2>Partial section</h2>'}}]);throw new Error('Fixture provider failure');}}};
  const continuing=clientFor(library,project.id,{count:6,preserveFirst:true,inspect:(request,turn)=>{if(!turn){assert.match(request.input.at(-1).content,/продолжение прерванной попытки/);assert.match(request.input.at(-1).content,/Не добавляй дубли/);}}});
  const service=new AIService({dataDir:directory,library,root:projectRoot,clientFactory:()=>mode==='fail'?failing:continuing});t.after(()=>service.close());await service.saveSettings({provider:'openai',model:'fixture',apiKey:'fixture-key'});
  assert.equal((await service.generate({projectId:project.id})).creation.status,'error');let partial=await library.get(project.id);assert.equal(partial.slides.length,2);assert.match(partial.creation.error,/Fixture provider failure/);assert.equal((await library.materials.list(project.id)).length,1);
  await library.updateSlide(project.id,'slide-01',{version:partial.slides[0].version,body:'<h1>Manual revision to preserve</h1>'});mode='continue';assert.equal((await service.generate({projectId:project.id})).creation.status,'ready');
  const completed=await library.get(project.id);assert.equal(completed.slides.length,6);assert.equal(completed.creation.attempts,2);assert.equal(completed.slides[0].body,'<h1>Manual revision to preserve</h1>');assert.equal(completed.slides[1].id,partial.slides[1].id);assert.equal((await library.materials.read(project.id,material.id)).buffer.toString(),'Keep original');
});

test('generation cancellation and restart recovery retain data and reject duplicate runs while active',async t=>{
  const {directory,library}=await fixture(t),project=await library.create({title:'Cancel',creationMode:'smart',blank:true});let started;const ready=new Promise(resolve=>{started=resolve;});
  const service=new AIService({dataDir:directory,library,root:projectRoot,clientFactory:()=>({responses:{create:async(request,{signal})=>{started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));signal.throwIfAborted();}}})});t.after(()=>service.close());await service.saveSettings({provider:'openai',model:'fixture',apiKey:'fixture-key'});
  const pending=service.generate({projectId:project.id});await ready;await assert.rejects(()=>service.generate({projectId:project.id}),error=>error.status===409);await assert.rejects(async()=>library.rename(project.id,{description:'Too late',version:(await library.get(project.id)).version}),error=>error.status===409);
  service.cancel(project.id);assert.equal((await pending).creation.status,'interrupted');assert.equal((await library.get(project.id)).slides.length,1);
  const attempt=await library.beginGeneration(project.id);assert.equal(attempt.resume,true);const restarted=await new Library(directory).init();assert.equal((await restarted.get(project.id)).creation.status,'interrupted');assert.equal((await restarted.get(project.id)).creation.attempts,2);
});

test('a final model message cannot mark an untouched empty slide ready',async t=>{
  const {directory,library}=await fixture(t),project=await library.create({title:'Incomplete',creationMode:'smart',blank:true}),service=new AIService({dataDir:directory,library,root:projectRoot,clientFactory:()=>({responses:{create:async()=>finalEvent()}})});t.after(()=>service.close());await service.saveSettings({provider:'openai',model:'fixture',apiKey:'fixture-key'});
  const events=[],result=await service.generate({projectId:project.id,onEvent:event=>events.push(event)});assert.equal(result.creation.status,'error');assert.match(result.error,/пустые слайды/);assert.equal(events.at(-1).type,'error');assert.equal((await library.get(project.id)).slides[0].body,'');
});

test('HTTP preflight uses normal errors before SSE and tour frames permit only authenticated scoped previews',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'generation-http-')),running=await createServer(projectRoot,{authRequired:false,dataDir:directory});t.after(async()=>{running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const project=await running.library.create({title:'Preflight',creationMode:'smart',blank:true}),request=(url,method='GET',value)=>fetch(running.url+url,{method,headers:value?{'Content-Type':'application/json'}:{},body:value?JSON.stringify(value):undefined});
  await running.ai.saveSettings({provider:'openai',model:'fixture',clearApiKey:true});const failed=await request('/api/projects/'+project.id+'/generate','POST',{});assert.equal(failed.status,409);assert.match(failed.headers.get('Content-Type'),/application\/json/);assert.equal((await running.library.get(project.id)).creation.status,'pending');
  for(const url of ['/themes/light?embed=tour','/projects/'+project.id+'/view?embed=tour']){const response=await request(url);assert.equal(response.status,200);assert.equal(response.headers.get('X-Frame-Options'),'SAMEORIGIN');assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'self'/);}
  for(const url of ['/themes/light','/projects/'+project.id+'/view','/projects/'+project.id+'?embed=tour'])assert.equal((await request(url)).headers.get('X-Frame-Options'),'DENY');
  const saved=JSON.parse(await readFile(path.join(directory,'projects',project.id,'presentation.json'),'utf8'));assert.equal(saved.creation.status,'pending');
});
