import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readFile,writeFile,access} from 'node:fs/promises';
import {Library} from '../backend/application/engine.js';
import {AIService} from '../backend/modules/ai/service.js';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
async function fixture(t){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'context-delete-test-')),library=await new Library(dataDir).init(),ai=new AIService({dataDir,library,root});await ai.ready;
  t.after(async()=>{await ai.close();await rm(dataDir,{recursive:true,force:true});});
  const project=await library.create({title:'Delete candidate'}),other=await library.create({title:'Other project'}),theme=await library.themes.create({title:'Delete theme',baseThemeId:'light'});
  return {dataDir,library,ai,project,other,theme};
}
const textFile={name:'brief.txt',mime:'text/plain',data:Buffer.from('Original source').toString('base64')};
const missing=async file=>assert.rejects(()=>access(file),error=>error.code==='ENOENT');

test('stale or failed project deletion preserves history, uploads and idle session; earlier CAS failure cannot poison later deletion',async t=>{
  const {dataDir,library,ai,project}=await fixture(t),upload=await ai.attachments.create(project.id,textFile);
  await ai.mutateChat(project.id,chat=>{chat.messages=[{role:'user',content:'Retain this'}];chat.acpSessionId='idle-fixture';});
  const chatFile=ai.chatFile(project.id),before=await readFile(chatFile,'utf8'),resets=[];ai.acp.reset=key=>resets.push(key);
  const updated=await library.rename(project.id,{title:'Changed after card loaded',version:project.version});
  await assert.rejects(()=>ai.deleteContext(project.id,'project',{version:project.version}),error=>error.status===409);
  assert.equal(await readFile(chatFile,'utf8'),before);assert.deepEqual(resets,[]);assert.deepEqual((await ai.attachments.read(project.id,upload.id)).buffer,Buffer.from('Original source'));
  // A failed mutation leaves ProjectStore.queue rejected. Removal must wait for
  // settled work and check current state, not inherit that earlier rejection.
  await assert.rejects(()=>library.updateSlide(project.id,project.slides[0].id,{version:999,title:'Stale'}),error=>error.status===409);
  assert.deepEqual(await ai.deleteContext(project.id,'project',{version:updated.version}),{ok:true});
  await assert.rejects(()=>library.get(project.id),error=>error.status===404);await missing(chatFile);await missing(path.join(dataDir,'ai/attachments',project.id));assert.deepEqual(resets,[project.id]);
});

test('successful theme deletion cleans only its own chat/upload/workspace and keeps settings, other contexts and authorisation',async t=>{
  const {dataDir,library,ai,project,other,theme}=await fixture(t),themeKey=ai.contextKey(theme.id,'theme');
  await ai.saveSettings({provider:'openai',model:'fixture-model',apiKey:'not-a-real-secret'});
  const settings=await readFile(ai.configFile,'utf8'),operatorAuth=path.join(dataDir,'operator-auth.json');await writeFile(operatorAuth,'operator-auth-fixture');
  await ai.mutateChat(theme.id,chat=>{chat.messages=[{role:'user',content:'Theme discussion'}];},'theme');
  await ai.mutateChat(other.id,chat=>{chat.messages=[{role:'user',content:'Keep this other chat'}];});
  const otherUpload=await ai.attachments.create(other.id,textFile);await ai.themeAttachments.create(theme.id,textFile);
  const workspace=await ai.workspace(themeKey);await writeFile(path.join(workspace,'private-runtime.json'),'runtime-fixture');
  const resets=[];ai.acp.reset=key=>resets.push(key);
  await assert.rejects(()=>ai.deleteContext('light','theme',{version:0}),error=>error.status===409);assert.deepEqual(resets,[]);
  assert.deepEqual(await ai.deleteContext(theme.id,'theme',{version:theme.version}),{ok:true});
  await missing(workspace);await missing(ai.chatFile(theme.id,'theme'));await missing(path.join(dataDir,'ai/attachments/themes',theme.id));
  assert.equal(await readFile(ai.configFile,'utf8'),settings);assert.equal(await readFile(operatorAuth,'utf8'),'operator-auth-fixture');
  assert.equal((await library.get(project.id)).title,'Delete candidate');assert.equal((await ai.history(other.id)).messages[0].content,'Keep this other chat');assert.equal((await ai.attachments.get(other.id,otherUpload.id)).name,'brief.txt');assert.deepEqual(resets,[themeKey]);
});

test('active generation/chat and concurrent deletion are rejected; chat cannot recreate files while canonical deletion is pending',async t=>{
  const {library,ai,project}=await fixture(t);
  const controller=new AbortController();ai.active.set(project.id,controller);await assert.rejects(()=>ai.deleteContext(project.id),error=>error.status===409);ai.active.delete(project.id);
  ai.generations.set(project.id,controller);await assert.rejects(()=>ai.deleteContext(project.id),error=>error.status===409);ai.generations.delete(project.id);
  const actualRemove=library.remove.bind(library);let release,entered;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  library.remove=async(...args)=>{entered();await gate;return actualRemove(...args);};
  const pending=ai.deleteContext(project.id);await started;
  await assert.rejects(()=>ai.deleteContext(project.id),error=>error.status===409);
  await assert.rejects(()=>ai.send({projectId:project.id,message:'Do not revive'}),error=>error.status===409);
  await assert.rejects(()=>ai.generate({projectId:project.id}),error=>error.status===409);
  await assert.rejects(()=>ai.resetHistory(project.id),error=>error.status===409);
  release();assert.deepEqual(await pending,{ok:true});assert.equal(ai.deleting.size,0);
  await assert.rejects(()=>ai.send({projectId:project.id,message:'Gone'}),error=>error.status===404);
});

test('deletion acquired while attachment validation waits prevents provider invocation and message creation',async t=>{
  const {library,ai,project}=await fixture(t);let release,started,providerCalls=0;
  ai.clientFactory=()=>{providerCalls++;throw new Error('Should not reach provider');};
  const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve),actualContext=ai.attachments.context.bind(ai.attachments);
  ai.attachments.context=async(...args)=>{const context=await actualContext(...args);started();await gate;return context;};
  const send=ai.send({projectId:project.id,message:'Wait for source validation'});await entered;
  const actualRemove=library.remove.bind(library);let finishDelete,removeStarted;
  const deleteGate=new Promise(resolve=>finishDelete=resolve),deleting=new Promise(resolve=>removeStarted=resolve);
  library.remove=async(...args)=>{removeStarted();await deleteGate;return actualRemove(...args);};
  const removal=ai.deleteContext(project.id);await deleting;release();
  await assert.rejects(()=>send,error=>error.status===409);assert.equal(providerCalls,0);assert.deepEqual((await ai.readChat(project.id)).messages,[]);
  finishDelete();await removal;
});

test('deletion waits for an owned ACP group after its wrapper exits and a Codex-like journal writer ignores SIGTERM',{skip:process.platform==='win32'},async t=>{
  const {dataDir,library,ai,theme,project}=await fixture(t),script=path.join(dataDir,'agent-with-writer.mjs'),heartbeat=path.join(dataDir,'writer-heartbeat');
  const writer=`const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>{fs.mkdirSync('.codex',{recursive:true});fs.writeFileSync('.codex/journal',String(Date.now()));fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now()));},8);`;
  await writeFile(script,`
import readline from 'node:readline';import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';
const writer=spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{const msg=JSON.parse(line);
if(msg.method==='initialize')reply(msg.id,{protocolVersion:1,agentCapabilities:{},authMethods:[]});
if(msg.method==='session/new')reply(msg.id,{sessionId:'owned-writer'});
if(msg.method==='session/prompt'){while(!existsSync(${JSON.stringify(heartbeat)}))await new Promise(resolve=>setTimeout(resolve,5));reply(msg.id,{stopReason:'end_turn'});}
});`);
  ai.acp.command=process.execPath;ai.acp.args=[script];ai.acp.authHome=null;ai.acp.mcpUrl='http://127.0.0.1/api/agent-tools';ai.acp.mcpToken='fixture-token';
  const key=ai.contextKey(theme.id,'theme');await ai.acp.prompt({projectId:key,themeId:theme.id,prompt:'Fixture only',onEvent:()=>{}});
  const entry=ai.acp.sessions.get(key),workspace=entry.cwd;assert(entry.processGroup>1&&entry.processGroup!==process.pid);
  t.after(()=>{try{process.kill(-entry.processGroup,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}});
  assert.deepEqual(await ai.deleteContext(theme.id,'theme',{version:theme.version}),{ok:true});
  assert.notEqual(entry.child.exitCode,null,'the ACP wrapper exited before group cleanup completed');assert.equal(ai.acp.draining.size,0);await missing(workspace);
  const finalHeartbeat=await readFile(heartbeat,'utf8');await new Promise(resolve=>setTimeout(resolve,160));
  assert.equal(await readFile(heartbeat,'utf8'),finalHeartbeat,'the orphaned writer was killed, not merely disconnected');await missing(workspace);
  assert.doesNotThrow(()=>process.kill(process.pid,0),'the presentation service remains alive');assert.equal((await library.get(project.id)).title,'Delete candidate');
});
