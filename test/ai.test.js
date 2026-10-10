import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readFile,writeFile,stat,mkdir,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AIService} from '../backend/modules/ai/service.js';
import {ACPManager} from '../backend/modules/ai/acp.js';
import {createProjectTools} from '../backend/modules/mcp/tools.js';
import {parseModelJSON} from '../backend/modules/ai/model-json.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createServer} from '../backend/http/server.js';

const root=fileURLToPath(new URL('..',import.meta.url));
async function temporary(t) {const dir=await mkdtemp(path.join(os.tmpdir(),'rozum-ai-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function listening(t,callback) {const server=http.createServer(callback);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;}
async function jsonBody(req) {let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body);}
const library=()=>({async get(id){assert.equal(id,'demo');return {id,title:'Demo',slides:[{id:'slide-1',body:'<h1>Demo</h1>',version:1,notes:'Speech',notesVersion:2}],annotations:[]};},async list(){return [{id:'demo',title:'Demo'}];}});
const sse=(res,events)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));};
const imageFixture='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJi0AAAAASUVORK5CYII=';

test('model JSON extraction accepts fenced objects, rejects invalid or oversized data',()=>{
  assert.deepEqual(parseModelJSON('```json\n{"slideId":"slide-1"}\n```'),{slideId:'slide-1'});
  assert.throws(()=>parseModelJSON('{"invalid":'),/неверные/);
  assert.throws(()=>parseModelJSON('x'.repeat(30),20),/большой/);
});

test('API settings redact keys, keep blank key, restrict browser command settings and persist privately',async t=>{
  const dir=await temporary(t),service=new AIService({dataDir:dir,library:library(),root});t.after(()=>service.close());
  assert.equal((await service.settings()).hasApiKey,false);
  await service.saveSettings({provider:'openai',model:'fixture-model',apiKey:'not-a-real-key'});
  assert.equal((await service.saveSettings({apiKey:'',model:'next-model'})).hasApiKey,true);
  assert.equal(JSON.stringify(await service.settings()).includes('not-a-real-key'),false);
  await assert.rejects(()=>service.saveSettings({acpCommand:'rm'}),/Команда ACP/);
  assert.equal((await stat(path.join(dir,'ai/settings.json'))).mode&0o777,0o600);
  const restarted=new AIService({dataDir:dir,library:library(),root});t.after(()=>restarted.close());
  assert.equal((await restarted.settings()).model,'next-model');
  assert.equal((await restarted.settings()).hasApiKey,true);
});

test('Responses API streams text and executes versioned slide tools through the library',async t=>{
  const dir=await temporary(t),lib=library(),events=[],calls=[];
  lib.updateSlide=async(pid,sid,changes)=>{calls.push({pid,sid,changes});return {id:sid,body:changes.body,version:2};};
  let turn=0;
  const api=await listening(t,async(req,res)=>{
    assert.equal(req.url,'/v1/responses');assert.equal(req.headers.authorization,'Bearer not-a-real-key');
    const body=await jsonBody(req);assert.equal(body.store,false);assert.equal(body.stream,true);
    assert.ok(body.tools.some(tool=>tool.name==='update_slide'));
    turn++;
    if(turn===1){
      const call={type:'function_call',id:'item-1',call_id:'call-1',name:'update_slide',arguments:JSON.stringify({slideId:'slide-1',body:'<h1>Updated</h1>',version:1})};
      sse(res,[{type:'response.output_text.delta',delta:'Сначала обновлю заголовок.'},{type:'response.output_item.done',output_index:0,item:call},{type:'response.completed',response:{output:[call]}}]);
    }else{
      assert.equal(body.input.at(-1).type,'function_call_output');assert.equal(body.input.at(-1).call_id,'call-1');
      sse(res,[{type:'response.output_text.delta',delta:'Обновил '},{type:'response.output_text.delta',delta:'слайд.'},{type:'response.completed',response:{output:[{type:'message',id:'msg-1',role:'assistant',content:[{type:'output_text',text:'Обновил слайд.',annotations:[]}]}]}}]);
    }
  });
  const service=new AIService({dataDir:dir,library:lib,root});t.after(()=>service.close());
  await service.saveSettings({provider:'openai',apiMode:'responses',baseUrl:api+'/v1',model:'fixture-model',apiKey:'not-a-real-key'});
  const answer=await service.send({projectId:'demo',message:'Измени заголовок',onEvent:event=>events.push(event)});
  assert.equal(answer.content,'Обновил слайд.');assert.equal(turn,2);
  assert.deepEqual(calls,[{pid:'demo',sid:'slide-1',changes:{body:'<h1>Updated</h1>',version:1}}]);
  assert.deepEqual(events.filter(event=>event.type==='text').map(event=>event.text),['Обновил ','слайд.']);
  assert.deepEqual(events.filter(event=>event.type==='activity').map(event=>event.text),['Сначала обновлю заголовок.']);
  assert.ok(events.some(event=>event.type==='tool'&&event.status==='completed'));
  const history=await service.history('demo');assert.equal(history.messages.length,2);
  assert.equal(history.messages[1].content,'Обновил слайд.');assert.ok(history.messages[1].elapsedMs>=0);
  assert.ok(history.messages[1].activity.some(event=>event.text==='Сначала обновлю заголовок.'));
});

test('Chat Completions supports split tool arguments and preserves annotation context without duplicates',async t=>{
  const dir=await temporary(t),events=[];let turn=0;
  const api=await listening(t,async(req,res)=>{
    assert.equal(req.url,'/v1/chat/completions');const body=await jsonBody(req);turn++;
    if(turn===1){assert.match(body.messages.at(-1).content,/Комментарий к слайду slide-1/);sse(res,[{choices:[{index:0,delta:{content:'Прочитаю слайд.',tool_calls:[{index:0,id:'call-1',function:{name:'read_slide',arguments:'{"slideId":'}}]}}]},{choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"slide-1"}'}}]}}]}]);}
    else{assert.equal(body.messages.at(-1).role,'tool');assert.equal(JSON.parse(body.messages.at(-1).content).version,1);sse(res,[{choices:[{index:0,delta:{content:'Проверил.'},finish_reason:'stop'}]}]);}
  });
  const service=new AIService({dataDir:dir,library:library(),root});t.after(()=>service.close());
  await service.saveSettings({provider:'openai',apiMode:'chat-completions',baseUrl:api+'/v1',model:'fixture-model',apiKey:'not-a-real-key'});
  const annotation={id:'note-1',slideId:'slide-1',x:.2,y:.3,comment:'Сократи заголовок'};
  await service.appendAnnotation('demo',annotation);await service.appendAnnotation('demo',annotation);
  await service.appendAnnotation('demo',{...annotation,comment:'Сделай заголовок короче'});
  assert.match((await service.history('demo')).messages[0].content,/Сделай заголовок короче/);
  const answer=await service.send({projectId:'demo',annotationId:'note-1',onEvent:event=>events.push(event)});
  assert.equal(answer.content,'Проверил.');assert.equal((await service.history('demo')).messages.length,2);
  assert.deepEqual(events.filter(event=>event.type==='activity').map(event=>event.text),['Прочитаю слайд.']);
  await service.resetHistory('demo');assert.deepEqual(await service.history('demo'),{messages:[]});
});

test('bound project tools reject crossing projects and invalid tool fields before mutation',async()=>{
  const tools=createProjectTools(library());
  await assert.rejects(()=>tools.execute('read_project',{projectId:'other'},{projectId:'demo'}),/ограничен/);
  await assert.rejects(()=>tools.execute('update_slide',{slideId:'slide-1',body:'<h1>X</h1>'},{projectId:'demo'}),/version/);
  await assert.rejects(()=>tools.execute('update_slide',{slideId:'slide-1',body:'X',version:1,arbitraryCommand:'bad'},{projectId:'demo'}),/Неизвестный аргумент/);
});

test('real MCP stdio initialization lists tools and scoped calls reach the authenticated central storage proxy',async t=>{
  const endpoint=await listening(t,async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-token');const body=await jsonBody(req);
    assert.equal(body.projectId,'demo');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'demo',title:'Demo'}));
  });
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'backend/modules/mcp/server.js'),'--project','demo'],env:{PRESENTATIONS_MCP_URL:endpoint+'/api/agent-tools',PRESENTATIONS_MCP_TOKEN:'fixture-token'}});
  const client=new Client({name:'fixture-client',version:'1.0.0'});t.after(()=>client.close());
  await client.connect(transport);
  const listed=await client.listTools();assert.ok(listed.tools.some(tool=>tool.name==='update_slide'));
  const result=await client.callTool({name:'read_project',arguments:{}});assert.equal(JSON.parse(result.content[0].text).id,'demo');
  const denied=await client.callTool({name:'read_project',arguments:{projectId:'other'}});assert.equal(denied.isError,true);
  const prompts=await client.listPrompts();assert.ok(prompts.prompts.some(prompt=>prompt.name==='edit-presentation'));
});

test('website MCP HTTP requires its own token; SDK calls share storage with browser API and expose real skills',async t=>{
  const dir=await temporary(t),{server,library,url}=await createServer(root,{authRequired:false,dataDir:dir});
  let client;
  t.after(async()=>{await client?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const project=await library.create({title:'Protocol fixture'});
  assert.equal((await fetch(url+'/mcp')).status,401);
  assert.equal((await fetch(url+'/api/agent-tools',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const token=(await readFile(path.join(dir,'agent-token'),'utf8')).trim();
  client=new Client({name:'http-fixture',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const current=await client.callTool({name:'read_slide',arguments:{projectId:project.id,slideId:project.slides[0].id}});
  const slide=JSON.parse(current.content[0].text);
  const changed=await client.callTool({name:'update_slide',arguments:{projectId:project.id,slideId:slide.id,version:slide.version,body:'<h1>Changed via MCP</h1>'}});
  assert.equal(changed.isError,undefined);
  assert.match((await(await fetch(url+'/api/projects/'+project.id)).json()).slides[0].body,/Changed via MCP/);
  const stale=await client.callTool({name:'update_slide',arguments:{projectId:project.id,slideId:slide.id,version:slide.version,body:'<h1>Stale edit</h1>'}});
  assert.equal(stale.isError,true);assert.equal(JSON.parse(stale.content[0].text).status,409);
  const skills=await client.callTool({name:'list_skills',arguments:{}});
  assert.ok(JSON.parse(skills.content[0].text).some(skill=>skill.name==='edit-html-slides'));
  const skill=await client.callTool({name:'read_skill',arguments:{name:'edit-html-slides'}});assert.match(JSON.parse(skill.content[0].text).content,/name:\s*edit-html-slides/);
});

const mockACP=`
import readline from 'node:readline';import{writeFileSync}from'node:fs';
writeFileSync('process-config.json',JSON.stringify({mode:process.env.INITIAL_AGENT_MODE,config:JSON.parse(process.env.CODEX_CONFIG),home:process.env.HOME,codexHome:process.env.CODEX_HOME}));
let active,permission;const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
readline.createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);
if(msg.method==='initialize')reply(msg.id,{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:process.argv[2]!=='no-images'}},authMethods:[]});
else if(msg.method==='session/new'){writeFileSync('session-config.json',JSON.stringify(msg.params));if(process.argv[2]==='auth')send({jsonrpc:'2.0',id:msg.id,error:{code:-32000,message:'Authentication required'}});else reply(msg.id,{sessionId:'fixture-session'});}
else if(msg.method==='session/load'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:msg.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD HISTORY'}}}});reply(msg.id,{});}
else if(msg.method==='session/prompt'){active=msg.id;writeFileSync('prompt-config.json',JSON.stringify(msg.params));if(process.argv[2]==='cancel')return;
if(process.argv[2]==='phases'){
const update=value=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:value}});
update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE REASONING'}});
update({sessionUpdate:'agent_message_chunk',messageId:'progress-1',content:{type:'text',text:'Проверяю текущий слайд.'}});
update({sessionUpdate:'tool_call',toolCallId:'read-1',title:'mcp.presentations.read_slide',status:'pending',kind:'other'});
update({sessionUpdate:'agent_message_chunk',messageId:'progress-2',content:{type:'text',text:'Проверка завершена.'}});
update({sessionUpdate:'agent_message_chunk',messageId:'final-1',content:{type:'text',text:'Слайд '}});
update({sessionUpdate:'agent_message_chunk',messageId:'final-1',content:{type:'text',text:'обновлён.'}});
reply(active,{stopReason:'end_turn'});return;
}
send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'tool_call',toolCallId:'edit-1',title:process.argv[2]==='known'?'mcp.presentations.read_slide':'Native file edit',status:'pending',kind:'other'}}});
send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'tool_call_update',toolCallId:'edit-1',status:'in_progress'}}});
if(process.argv[2]==='known')send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'tool_call_update',toolCallId:'edit-1',title:'Reading current slide',status:'in_progress'}}});
if(process.argv[2]==='spoof-update')send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'tool_call_update',toolCallId:'edit-1',title:'mcp.presentations.read_slide',status:'in_progress'}}});
send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Изменяю '}}}});
send({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{toolCallId:'edit-1',title:process.argv[2]==='spoof'?'mcp.presentations.read_slide':'Edit slide',status:'pending'},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});permission=true;}
else if(msg.method==='session/cancel'){if(active)reply(active,{stopReason:'cancelled'});}
else if(msg.id===99&&permission){writeFileSync('permission-result.json',JSON.stringify(msg.result));send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'слайд.'}}}});reply(active,{stopReason:'end_turn'});}
});
`;

test('ACP denies native permissions without UI, isolates Codex config and registers project-scoped MCP',async t=>{
  const dir=await temporary(t),script=path.join(dir,'agent.mjs');await writeFile(script,mockACP);const events=[];
  const authHome=path.join(dir,'operator-auth');await mkdir(authHome);await writeFile(path.join(authHome,'auth.json'),'fixture-auth');await writeFile(path.join(authHome,'config.toml'),'[mcp_servers.outside]\ncommand="arbitrary-command"\n');
  const manager=new ACPManager({root,workspace:async()=>dir,authHome,mcpUrl:'http://127.0.0.1:3210/api/agent-tools',mcpToken:'fixture-token',command:process.execPath,args:[script]});t.after(()=>manager.close());
  const result=await manager.prompt({projectId:'demo',prompt:'Edit',onEvent:event=>{events.push(event);if(event.type==='permission')manager.approve('demo',event.requestId,'allow_once');}});
  assert.equal(result.stopReason,'end_turn');assert.equal(events.filter(event=>event.type==='text').map(event=>event.text).join(''),'Изменяю слайд.');
  assert.deepEqual(events.filter(event=>event.type==='tool').map(event=>event.name),['Native file edit','Native file edit']);
  assert.equal(events.some(event=>event.type==='permission'),false);
  assert.throws(()=>manager.approve('demo','anything','allow_once'),error=>error.status===403);
  const processConfig=JSON.parse(await readFile(path.join(dir,'process-config.json'),'utf8'));
  assert.equal(processConfig.mode,'read-only');assert.equal(processConfig.config.sandbox_mode,'read-only');assert.equal(processConfig.config.approval_policy,'never');
  for(const feature of ['shell_tool','unified_exec','shell_snapshot','apps','plugins','browser_use','view_image','hooks','memories','multi_agent','code_mode_host','artifact'])assert.equal(processConfig.config.features[feature],false,feature);
  assert.equal(processConfig.config.web_search,'disabled');assert.equal(processConfig.config.project_doc_max_bytes,0);assert.deepEqual(processConfig.config.notify,[]);
  assert.equal(processConfig.home,path.join(dir,'.host'));assert.equal(processConfig.codexHome,path.join(dir,'.codex'));
  assert.deepEqual(await readdir(processConfig.codexHome),['auth.json']);assert.equal(await readFile(path.join(processConfig.codexHome,'auth.json'),'utf8'),'fixture-auth');
  assert.equal((await stat(path.join(processConfig.codexHome,'auth.json'))).mode&0o777,0o600);
  const setup=JSON.parse(await readFile(path.join(dir,'session-config.json'),'utf8'));
  assert.equal(setup.cwd,dir);assert.deepEqual(setup.mcpServers[0].args,[path.join(root,'backend/modules/mcp/server.js'),'--project','demo']);
  assert.equal(setup.mcpServers[0].env.find(item=>item.name==='PRESENTATIONS_MCP_TOKEN').value,'fixture-token');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'permission-result.json'),'utf8')),{outcome:{outcome:'selected',optionId:'no'}});
  await writeFile(path.join(processConfig.codexHome,'auth.json'),'refreshed-fixture-auth');
  manager.reset('demo');const resumed=[];
  await manager.prompt({projectId:'demo',prompt:'Next edit',previousSessionId:'fixture-session',onEvent:event=>{resumed.push(event);if(event.type==='permission')manager.approve('demo',event.requestId,'reject_once');}});
  assert.equal(resumed.some(event=>event.text?.includes('OLD HISTORY')),false);
  assert.equal(resumed.some(event=>event.type==='permission'),false);
  assert.equal(await readFile(path.join(processConfig.codexHome,'auth.json'),'utf8'),'refreshed-fixture-auth');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'permission-result.json'),'utf8')),{outcome:{outcome:'selected',optionId:'no'}});
});

test('ACP separates visible activity by tools and message IDs, persists final only, and never forwards thought chunks',async t=>{
  const dir=await temporary(t),script=path.join(dir,'agent.mjs');await writeFile(script,mockACP);const events=[];
  const service=new AIService({dataDir:dir,library:library(),root,workspace:async()=>dir,acpAuthHome:path.join(dir,'empty-auth'),mcpUrl:'http://127.0.0.1:3210/api/agent-tools',mcpToken:'fixture-token',acpCommand:process.execPath,acpArgs:[script,'phases']});t.after(()=>service.close());
  const answer=await service.send({projectId:'demo',message:'Проверь слайд',onEvent:event=>events.push(event)});
  assert.equal(answer.content,'Слайд обновлён.');
  assert.deepEqual(events.filter(event=>event.type==='activity').map(event=>event.text),['Проверяю текущий слайд.','Проверка завершена.']);
  assert.deepEqual(events.filter(event=>event.type==='text').map(event=>event.text),['Слайд обновлён.']);
  assert.equal(JSON.stringify(events).includes('PRIVATE REASONING'),false);
  const saved=(await service.history('demo')).messages.at(-1);
  assert.equal(saved.content,'Слайд обновлён.');assert.ok(saved.elapsedMs>=0);assert.equal(saved.activity.filter(event=>event.type==='activity').length,2);
  assert.equal(JSON.stringify(saved).includes('PRIVATE REASONING'),false);
  const prompt=JSON.parse(await readFile(path.join(dir,'prompt-config.json'),'utf8')).prompt[0].text;
  assert.match(prompt,/Native filesystem access, shell commands, native program execution, browser tools and additional permissions are disabled/);
  assert.match(prompt,/JavaScript orchestration wrapper \(exec\).*only to invoke the bound presentations MCP tools/);
  assert.match(prompt,/Do not use apply_patch, exec_command/);
  assert.doesNotMatch(prompt,/Do not use [^.]*\bexec\b/);
  assert.match(prompt,/After changing HTML, styling, design or images, call render_slide and inspect/);
});

test('AIService uses a neutral private workspace and validates project identity before directory creation',async t=>{
  const dir=await temporary(t),script=path.join(dir,'agent.mjs');await writeFile(script,mockACP);
  const lib=library();lib.directory=()=>{throw new Error('Imported presentation must never be the agent cwd');};
  const service=new AIService({dataDir:dir,library:lib,root,acpAuthHome:path.join(dir,'empty-auth'),mcpUrl:'http://127.0.0.1:3210/api/agent-tools',mcpToken:'fixture-token',acpCommand:process.execPath,acpArgs:[script,'phases']});t.after(()=>service.close());
  await assert.rejects(()=>service.workspace('../outside'),/projectId/);
  await assert.rejects(()=>service.workspace('missing'),/demo/);
  const answer=await service.send({projectId:'demo',message:'Read the presentation',onEvent:()=>{}});
  assert.equal(answer.content,'Слайд обновлён.');
  const workspace=path.join(dir,'ai/workspaces/demo'),setup=JSON.parse(await readFile(path.join(workspace,'session-config.json'),'utf8'));
  assert.equal(setup.cwd,workspace);assert.equal((await stat(workspace)).mode&0o777,0o700);
});

test('ACP auto-approves only recognized project MCP calls and retains their tool name across updates',async t=>{
  const dir=await temporary(t),script=path.join(dir,'agent.mjs');await writeFile(script,mockACP);const events=[];
  const manager=new ACPManager({root,workspace:async()=>dir,authHome:path.join(dir,'empty-auth'),mcpUrl:'http://127.0.0.1:3210/api/agent-tools',mcpToken:'fixture-token',command:process.execPath,args:[script,'known']});t.after(()=>manager.close());
  const result=await manager.prompt({projectId:'demo',prompt:'Read slide',onEvent:event=>events.push(event)});
  assert.equal(result.stopReason,'end_turn');
  assert.equal(events.some(event=>event.type==='permission'),false);
  assert.deepEqual(events.filter(event=>event.type==='tool').map(event=>event.name),['mcp.presentations.read_slide','mcp.presentations.read_slide','mcp.presentations.read_slide']);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'permission-result.json'),'utf8')),{outcome:{outcome:'selected',optionId:'yes'}});
});

test('ACP permission title alone cannot turn a native file tool into an auto-approved MCP call',async t=>{
  const dir=await temporary(t),script=path.join(dir,'agent.mjs');await writeFile(script,mockACP);const events=[];
  const manager=new ACPManager({root,workspace:async()=>dir,authHome:path.join(dir,'empty-auth'),mcpUrl:'http://127.0.0.1:3210/api/agent-tools',mcpToken:'fixture-token',command:process.execPath,args:[script,'spoof']});t.after(()=>manager.close());
  await manager.prompt({projectId:'demo',prompt:'Edit',onEvent:event=>{events.push(event);if(event.type==='permission')manager.approve('demo',event.requestId,'reject_once');}});
  assert.equal(events.some(event=>event.type==='permission'),false);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'permission-result.json'),'utf8')),{outcome:{outcome:'selected',optionId:'no'}});
});

test('ACP tool display updates cannot upgrade native calls into trusted MCP permissions',async t=>{
  const dir=await temporary(t),script=path.join(dir,'agent.mjs');await writeFile(script,mockACP);const events=[];
  const manager=new ACPManager({root,workspace:async()=>dir,authHome:path.join(dir,'empty-auth'),mcpUrl:'http://127.0.0.1:3210/api/agent-tools',mcpToken:'fixture-token',command:process.execPath,args:[script,'spoof-update']});t.after(()=>manager.close());
  await manager.prompt({projectId:'demo',prompt:'Edit',onEvent:event=>events.push(event)});
  assert.equal(events.some(event=>event.type==='permission'),false);
  assert.ok(events.filter(event=>event.type==='tool').every(event=>event.name==='Native file edit'));
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'permission-result.json'),'utf8')),{outcome:{outcome:'selected',optionId:'no'}});
});

test('ACP rejects unregistered, unbound and inactive permissions even when an allow option exists',()=>{
  const manager=new ACPManager({root,workspace:async()=>root,authHome:null});
  const entry={active:true,sessionId:'session',toolNames:new Map([['unknown','mcp.outside.execute'],['native','Native file edit'],['known','mcp.presentations.read_slide']])};
  const request=toolCallId=>({sessionId:'session',toolCall:{toolCallId,title:'mcp.presentations.read_slide'},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]});
  for(const id of ['unknown','native','unbound'])assert.deepEqual(manager.permission(entry,request(id)),{outcome:{outcome:'selected',optionId:'no'}});
  assert.deepEqual(manager.permission(entry,{...request('native'),options:[{optionId:'yes',kind:'allow_once'}]}),{outcome:{outcome:'cancelled'}});
  assert.deepEqual(manager.permission({...entry,active:false},request('known')),{outcome:{outcome:'cancelled'}});
  assert.deepEqual(manager.permission(entry,{...request('known'),sessionId:'other'}),{outcome:{outcome:'cancelled'}});
});

test('ACP reports authentication required and settles cancellation without claiming live login',async t=>{
  const dir=await temporary(t),script=path.join(dir,'agent.mjs');await writeFile(script,mockACP);const events=[];
  const auth=new ACPManager({root,workspace:async()=>dir,authHome:path.join(dir,'empty-auth'),mcpUrl:'http://127.0.0.1:3210/api/agent-tools',mcpToken:'fixture-token',command:process.execPath,args:[script,'auth']});t.after(()=>auth.close());
  await assert.rejects(()=>auth.prompt({projectId:'demo',prompt:'Hello',onEvent:event=>events.push(event)}),/авторизации/);
  assert.ok(events.some(event=>event.status==='auth-required'));assert.equal(auth.state,'auth-required');
  const controller=new AbortController(),cancel=new ACPManager({root,workspace:async()=>dir,authHome:path.join(dir,'empty-auth'),mcpUrl:'http://127.0.0.1:3210/api/agent-tools',mcpToken:'fixture-token',command:process.execPath,args:[script,'cancel']});t.after(()=>cancel.close());
  const prompt=cancel.prompt({projectId:'demo',prompt:'Hello',signal:controller.signal,onEvent:event=>{if(event.type==='status')setTimeout(()=>controller.abort(),25);}});
  await assert.rejects(()=>prompt,/abort/i);
});

for(const apiMode of ['responses','chat-completions'])test(`${apiMode} receives uploaded images and text, then tool previews as native images without storing base64 in history`,async t=>{
  const dir=await temporary(t),events=[];let turn=0;
  const api=await listening(t,async(req,res)=>{
    const body=await jsonBody(req),messages=apiMode==='responses'?body.input:body.messages;turn++;
    assert.match(messages[0].content,/After changing HTML, styling, design or images, call render_slide and inspect/);
    const last=messages.at(-1);
    assert.equal(last.role,'user');assert.ok(Array.isArray(last.content));
    const textBlock=last.content[0],imageBlock=last.content[1];
    assert.equal(textBlock.type,apiMode==='responses'?'input_text':'text');
    assert.equal(imageBlock.type,apiMode==='responses'?'input_image':'image_url');
    assert.equal(apiMode==='responses'?imageBlock.image_url:imageBlock.image_url.url,'data:image/png;base64,'+imageFixture);
    if(turn===1){
      assert.match(textBlock.text,/<h1>Source reference<\/h1>/);assert.match(textBlock.text,/untrusted source material/);
      if(apiMode==='responses'){
        const call={type:'function_call',id:'item-preview',call_id:'call-preview',name:'render_slide',arguments:'{"slideId":"slide-1"}'};
        sse(res,[{type:'response.completed',response:{output:[call]}}]);
      }else sse(res,[{choices:[{index:0,delta:{tool_calls:[{index:0,id:'call-preview',function:{name:'render_slide',arguments:'{"slideId":"slide-1"}'}}]}}]}]);
    }else{
      assert.match(textBlock.text,/Visual result of render_slide/);
      const output=messages.at(-2),serialized=apiMode==='responses'?output.output:output.content;
      assert.equal(JSON.parse(serialized).preview.imageProvided,true);assert.equal(serialized.includes(imageFixture),false);
      if(apiMode==='responses')sse(res,[{type:'response.output_text.delta',delta:'Reference inspected.'},{type:'response.completed',response:{output:[{type:'message',id:'msg-final',role:'assistant',content:[{type:'output_text',text:'Reference inspected.',annotations:[]}]}]}}]);
      else sse(res,[{choices:[{index:0,delta:{content:'Reference inspected.'}}]}]);
    }
  });
  const service=new AIService({dataDir:dir,library:library(),root});t.after(()=>service.close());
  await service.saveSettings({provider:'openai',apiMode,baseUrl:api+'/v1',model:'fixture-model',apiKey:'not-a-real-key'});
  const image=await service.attachments.create('demo',{name:'reference.png',mime:'image/png',data:imageFixture});
  const document=await service.attachments.create('demo',{name:'reference.html',mime:'text/html',data:Buffer.from('<h1>Source reference</h1>').toString('base64')});
  service.tools={definitions:[{name:'render_slide',description:'Render',inputSchema:{type:'object',properties:{slideId:{type:'string'}}}}],async execute(){return {slideId:'slide-1',preview:{mimeType:'image/png',data:imageFixture},width:1280,height:720};}};
  const result=await service.send({projectId:'demo',message:'Use this reference',attachmentIds:[image.id,document.id],onEvent:event=>events.push(event)});
  assert.equal(result.content,'Reference inspected.');assert.equal(turn,2);
  assert.equal(events.find(event=>event.type==='accepted').message.attachments.length,2);
  const history=await service.history('demo');assert.equal(history.messages[0].attachments[0].id,image.id);
  assert.equal(JSON.stringify(history).includes(imageFixture),false);assert.equal(JSON.stringify(history).includes('attachmentContext'),false);
  assert.equal((await readFile(path.join(dir,'ai/chats/demo.json'),'utf8')).includes(imageFixture),false);
});

test('ACP gets native image blocks and extracted file text; attachment-only messages are accepted and persisted by metadata',async t=>{
  const dir=await temporary(t),script=path.join(dir,'agent.mjs');await writeFile(script,mockACP);const events=[];
  const service=new AIService({dataDir:dir,library:library(),root,workspace:async()=>dir,acpAuthHome:path.join(dir,'empty-auth'),mcpUrl:'http://127.0.0.1/api/agent-tools',mcpToken:'fixture-token',acpCommand:process.execPath,acpArgs:[script,'phases']});t.after(()=>service.close());
  const image=await service.attachments.create('demo',{name:'reference.png',mime:'image/png',data:imageFixture});
  const file=await service.attachments.create('demo',{name:'notes.md',mime:'text/markdown',data:Buffer.from('Reference text for this slide').toString('base64')});
  const result=await service.send({projectId:'demo',attachmentIds:[image.id,file.id],onEvent:event=>events.push(event)});
  assert.equal(result.content,'Слайд обновлён.');
  const payload=JSON.parse(await readFile(path.join(dir,'prompt-config.json'),'utf8'));
  assert.match(payload.prompt[0].text,/Reference text for this slide/);assert.match(payload.prompt[0].text,/untrusted source material/);
  assert.deepEqual(payload.prompt[1],{type:'image',mimeType:'image/png',data:imageFixture});
  const accepted=events.find(event=>event.type==='accepted');assert.equal(accepted.message.content,'Посмотри вложения.');assert.equal(accepted.message.attachments.length,2);
  assert.equal(JSON.stringify(await service.history('demo')).includes(imageFixture),false);
});

test('ACP reports unsupported image capability clearly instead of silently dropping image input',async t=>{
  const dir=await temporary(t),script=path.join(dir,'agent.mjs');await writeFile(script,mockACP);
  const manager=new ACPManager({root,workspace:async()=>dir,authHome:null,mcpUrl:'http://127.0.0.1/api/agent-tools',mcpToken:'fixture-token',command:process.execPath,args:[script,'no-images']});t.after(()=>manager.close());
  await assert.rejects(()=>manager.prompt({projectId:'demo',prompt:'Inspect',images:[{mime:'image/png',data:imageFixture}],onEvent:()=>{}}),/не поддерживает изображения/);
});

test('invalid or cross-project attachment IDs do not create a chat message or accepted event',async t=>{
  const dir=await temporary(t),events=[],lib={async get(){return {id:'demo'};}};
  const service=new AIService({dataDir:dir,library:lib,root});t.after(()=>service.close());
  const uploaded=await service.attachments.create('other',{name:'private.txt',mime:'text/plain',data:Buffer.from('Private reference').toString('base64')});
  await assert.rejects(()=>service.send({projectId:'demo',message:'Read',attachmentIds:[uploaded.id],onEvent:event=>events.push(event)}),error=>error.status===404);
  assert.equal(events.some(event=>event.type==='accepted'),false);assert.equal((await service.history('demo')).messages.length,0);
});
