import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ACPManager} from '../backend/modules/ai/acp.js';

const root=fileURLToPath(new URL('..',import.meta.url));
// The mock honours Codex's documented optional-MCP grace. These tests exercise
// policy and lifecycle through ACP transport, not a real model's tool catalog.
const fixture=`
import readline from 'node:readline';
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
const config=JSON.parse(process.env.CODEX_CONFIG),mode=process.argv[2];
let sessionId,turn=0,ready,starts=0;
const trace=value=>appendFileSync('trace.jsonl',JSON.stringify(value)+'\\n');
trace({kind:'process',grace:config.mcp_optional_startup_grace_ms,sandbox:config.sandbox_mode,features:config.features});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n'),reply=(id,result)=>send({jsonrpc:'2.0',id,result});
const update=value=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:value}});
const fail=()=>update({sessionUpdate:'tool_call',toolCallId:'mcp_startup.presentations.fixture',title:'mcp__presentations__startup',status:'failed',kind:'other',content:[{type:'content',content:{type:'text',text:'PRIVATE STARTUP DIAGNOSTIC'}}]});
readline.createInterface({input:process.stdin}).on('line',async line=>{
  const msg=JSON.parse(line);
  if(msg.method==='initialize')reply(msg.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
  else if(['session/new','session/load'].includes(msg.method)){
    sessionId=msg.params.sessionId||'lifecycle-fixture';trace({kind:msg.method,scope:msg.params.mcpServers[0].args.slice(-2)});
    ready=new Promise(resolve=>setTimeout(resolve,150));
    if(mode==='fail-load'&&msg.method==='session/load'){fail();return;}
    reply(msg.id,msg.method==='session/new'?{sessionId}:{});
  }else if(msg.method==='session/prompt'){
    turn++;if(config.mcp_optional_startup_grace_ms===0)await ready;
    trace({kind:'session/prompt',sessionId,turn,grace:config.mcp_optional_startup_grace_ms});
    if(mode==='fail-once'&&!existsSync('failed-once')){writeFileSync('failed-once','yes');fail();return;}
    if(mode==='spoof')update({sessionUpdate:'tool_call',toolCallId:'ordinary-call',title:'mcp__presentations__startup',status:'failed',kind:'other'});
    if(mode==='wrong-session')send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'unrelated-session',update:{sessionUpdate:'tool_call',toolCallId:'mcp_startup.presentations.fixture',title:'mcp__presentations__startup',status:'failed',kind:'other'}}});
    update({sessionUpdate:'tool_call',toolCallId:'read-'+turn,title:'mcp.presentations.read_project',status:'completed',kind:'other'});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:mode==='hallucination'&&turn===2?'Инструменты presentations MCP недоступны.':'Fixture tools are ready.'}});
    reply(msg.id,{stopReason:'end_turn'});
    if(mode==='fail-idle')setTimeout(fail,60);
  }
});
`;
async function setup(t,mode){
  const dir=await mkdtemp(path.join(os.tmpdir(),'presentations-acp-lifecycle-')),script=path.join(dir,'agent.mjs');await writeFile(script,fixture);
  const manager=new ACPManager({root,workspace:async()=>dir,authHome:null,mcpUrl:'http://127.0.0.1/api/agent-tools',mcpToken:'fixture-token',command:process.execPath,args:[script,mode]});
  t.after(async()=>{manager.close();await new Promise(resolve=>setTimeout(resolve,80));await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  return {manager,trace:async()=>JSON.parse('['+(await readFile(path.join(dir,'trace.jsonl'),'utf8')).trim().split('\n').join(',')+']')};
}
const prompt=(manager,extra={})=>manager.prompt({projectId:'demo',prompt:'Fixture request',onEvent:()=>{},...extra});

test('ACP waits for delayed optional MCP on new/reused/loaded sessions without changing execution policy',async t=>{
  const {manager,trace}=await setup(t,'healthy'),events=[];
  await prompt(manager,{onEvent:event=>events.push(event)});await prompt(manager,{onEvent:event=>events.push(event)});manager.reset('demo');await prompt(manager,{previousSessionId:'lifecycle-fixture',onEvent:event=>events.push(event)});
  const records=await trace();assert.deepEqual(records.filter(record=>record.kind!=='process').map(record=>record.kind),['session/new','session/prompt','session/prompt','session/load','session/prompt']);
  for(const record of records.filter(record=>record.kind==='process')){assert.equal(record.grace,0);assert.equal(record.sandbox,'read-only');for(const feature of ['shell_tool','unified_exec','code_mode','browser_use','hooks','plugins'])assert.equal(record.features[feature],false);}
  assert(records.filter(record=>record.kind==='session/prompt').every(record=>record.grace===0));assert.equal(events.filter(event=>event.type==='tool'&&event.name==='mcp.presentations.read_project').length,3);
  assert.deepEqual(events.filter(event=>event.type==='status').map(event=>event.message),['ACP подключён · новая сессия','ACP подключён · повторный запрос','ACP подключён · восстановленная сессия']);
});

test('a reported MCP startup failure rejects the turn, removes the broken process and permits a fresh attempt',async t=>{
  const {manager,trace}=await setup(t,'fail-once'),events=[];await assert.rejects(()=>prompt(manager,{onEvent:event=>events.push(event)}),error=>error.status===503&&/инструменты/.test(error.message));
  assert.equal(manager.sessions.has('demo'),false);assert.equal(manager.state,'mcp-unavailable');assert.equal(events.some(event=>event.type==='text'),false);assert.equal(JSON.stringify(events).includes('PRIVATE STARTUP DIAGNOSTIC'),false);
  const result=await prompt(manager);assert.equal(result.stopReason,'end_turn');assert.equal((await trace()).filter(record=>record.kind==='session/new').length,2);
});

test('a live startup failure during session/load is handled while history replay is suppressed',async t=>{
  const {manager}=await setup(t,'fail-load');await assert.rejects(()=>prompt(manager,{previousSessionId:'lifecycle-fixture'}),error=>error.status===503);assert.equal(manager.sessions.has('demo'),false);
});

test('a late startup failure removes an idle session before the next prompt',async t=>{
  const {manager}=await setup(t,'fail-idle');await prompt(manager);await new Promise(resolve=>setTimeout(resolve,120));assert.equal(manager.sessions.has('demo'),false);assert.equal(manager.state,'mcp-unavailable');
});

test('tool failures or events from another session do not masquerade as a presentation startup failure',async t=>{
  for(const mode of ['spoof','wrong-session']){const {manager}=await setup(t,mode);assert.equal((await prompt(manager)).stopReason,'end_turn');assert.equal(manager.sessions.has('demo'),true);}
});

test('an unsupported claim in final text never resets the session or retries mutations automatically',async t=>{
  const {manager,trace}=await setup(t,'hallucination'),events=[];await prompt(manager);await prompt(manager,{onEvent:event=>events.push(event)});assert(events.some(event=>event.text==='Инструменты presentations MCP недоступны.'));assert.equal(manager.sessions.has('demo'),true);assert.equal((await trace()).filter(record=>record.kind==='session/new').length,1);
});
