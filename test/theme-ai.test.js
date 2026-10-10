import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {AIService} from '../backend/modules/ai/service.js';
import {createThemeTools,themeToolDefinitions} from '../backend/modules/mcp/tools.js';
import {Library} from '../backend/application/engine.js';
import {createServer,projectRoot} from '../backend/http/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function temporary(t){const directory=await mkdtemp(path.join(os.tmpdir(),'theme-ai-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
async function fixture(t){const directory=await temporary(t),library=await new Library(directory).init(),theme=await library.themes.create({title:'Editable theme',baseThemeId:'light'});return {directory,library,theme};}
async function* stream(events){yield* events;}
function finalClient(apiMode='responses',inspect=()=>{}){
  return apiMode==='responses'?{responses:{create:async request=>{inspect(request);return stream([{type:'response.output_text.delta',delta:'Готово.'},{type:'response.completed',response:{output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Готово.'}]}]}}]);}}}:{chat:{completions:{create:async request=>{inspect(request);return stream([{choices:[{delta:{content:'Готово.'}}]}]);}}}};
}

test('theme tools expose only current-theme operations, reject cross-context edits and preserve CAS/builtins',async t=>{
  const {library,theme}=await fixture(t),other=await library.themes.create({title:'Unrelated',baseThemeId:'dark'}),tools=createThemeTools(library,{boundThemeId:theme.id});
  for(const name of ['read_project','update_slide','create_theme','apply_theme','list_projects','list_themes'])assert.equal(tools.definitions.some(tool=>tool.name===name),false);
  assert.equal((await tools.execute('read_theme')).id,theme.id);
  await assert.rejects(()=>tools.execute('update_theme',{themeId:other.id,version:0,title:'Forbidden'}),/ограничен/);
  await assert.rejects(()=>tools.execute('read_theme',{projectId:'foreign'}),/Неизвестный аргумент/);
  await assert.rejects(()=>tools.execute('read_project',{}),/недоступен/);
  await assert.rejects(()=>tools.execute('update_theme',{title:'Missing version'}),/version/);
  const next=await tools.execute('update_theme',{title:'Changed',version:theme.version});assert.equal(next.version,1);
  await assert.rejects(()=>tools.execute('update_theme',{title:'Stale',version:theme.version}),error=>error.status===409);
  assert.equal((await library.themes.get(other.id)).title,'Unrelated');
  await assert.rejects(()=>createThemeTools(library,{boundThemeId:'light'}).execute('update_theme',{title:'Builtin',version:0}),error=>error.status===409);
});

for(const apiMode of ['responses','chat-completions'])test(`${apiMode}: theme chat reads/updates source, sees native preview and keeps a separate persisted history`,async t=>{
  const {directory,library,theme}=await fixture(t),events=[],snapshots=await library.list();let turn=0;
  library.renderer={renderTheme:async id=>{assert.equal(id,theme.id);return {themeId:id,version:1,preview:{mimeType:'image/png',data:png},warnings:[]};}};
  const create=async request=>{
    const input=request.input||request.messages;
    const names=request.tools.map(tool=>tool.name||tool.function.name);assert.ok(names.includes('render_theme'));assert.equal(names.includes('update_slide'),false);
    assert.match(input[0].content,/Current theme ID:/);assert.equal(input[0].content.includes('Current presentation ID:'),false);
    const current=turn++;
    if(current===3){
      const image=input.at(-1).content.find(block=>['input_image','image_url'].includes(block.type));assert.ok(image);assert.equal(typeof(image.image_url)==='string'?image.image_url:image.image_url.url,'data:image/png;base64,'+png);
      return apiMode==='responses'?stream([{type:'response.output_text.delta',delta:'Обновил тему.'},{type:'response.completed',response:{output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Обновил тему.'}]}]}}]):stream([{choices:[{delta:{content:'Обновил тему.'}}]}]);
    }
    if(current===1){const previous=input.at(-1);assert.equal(JSON.parse(previous.output||previous.content).id,theme.id);}
    const namesByTurn=['read_theme','update_theme','render_theme'],args=current===1?{version:0,design:{...theme.design,template:{...theme.design.template,html:'<p data-block-id="theme-author" data-block-type="text" style="color:#2244ee">{{author}}</p>',css:'.presentation-template{font-size:30px}'}}}:{};
    const call={type:'function_call',id:'item-'+current,call_id:'call-'+current,name:namesByTurn[current],arguments:JSON.stringify(args)};
    return apiMode==='responses'?stream([{type:'response.completed',response:{output:[call]}}]):stream([{choices:[{delta:{tool_calls:[{index:0,id:call.call_id,function:{name:call.name,arguments:call.arguments}}]}}]}]);
  };
  const client=apiMode==='responses'?{responses:{create}}:{chat:{completions:{create}}},service=new AIService({dataDir:directory,library,root:projectRoot,clientFactory:()=>client});t.after(()=>service.close());
  await service.saveSettings({provider:'openai',apiMode,model:'fixture',apiKey:'fixture-key'});
  const answer=await service.send({themeId:theme.id,message:'Измени цвет автора',onEvent:event=>events.push(event)});assert.equal(answer.content,'Обновил тему.');assert.equal(turn,4);
  assert.ok((await library.themes.get(theme.id)).design.template.html.includes('{{author}}'));
  assert.deepEqual(await library.list(),snapshots);assert.equal((await service.history(theme.id,'theme')).messages.length,2);
  assert.ok(events.some(event=>event.type==='tool'&&event.name==='render_theme'&&event.status==='completed'));assert.ok(events.some(event=>event.type==='done'));assert.equal(events.some(event=>event.type==='permission'),false);
  const persisted=JSON.parse(await readFile(path.join(directory,'ai/chats/themes',theme.id+'.json'),'utf8'));assert.equal(persisted.messages[1].content,'Обновил тему.');assert.equal(JSON.stringify(persisted).includes(png),false);
  const restarted=new AIService({dataDir:directory,library,root:projectRoot});t.after(()=>restarted.close());assert.equal((await restarted.settings()).hasApiKey,true);assert.deepEqual(await restarted.history(theme.id,'theme'),await service.history(theme.id,'theme'));
  await service.resetHistory(theme.id,'theme');assert.deepEqual(await service.history(theme.id,'theme'),{messages:[]});
});

test('theme attachments remain separate from presentations and other themes; image copying produces theme assets',async t=>{
  const {directory,library,theme}=await fixture(t),project=await library.create({title:'Actual project'}),other=await library.themes.create({title:'Other theme',baseThemeId:'paper'});
  const service=new AIService({dataDir:directory,library,root:projectRoot,clientFactory:()=>finalClient('responses',request=>{assert.ok(request.input.at(-1).content.some(block=>block.type==='input_image'));})});t.after(()=>service.close());
  const image=await service.themeAttachments.create(theme.id,{name:'Reference.png',mime:'image/png',data:png}),projectFile=await service.attachments.create(project.id,{name:'Private.txt',mime:'text/plain',data:Buffer.from('project secret fixture').toString('base64')});
  assert.ok(image.previewUrl.startsWith('/api/themes/'+theme.id+'/attachments/'));
  await assert.rejects(()=>service.themeAttachments.get(other.id,image.id),error=>error.status===404);await assert.rejects(()=>service.themeAttachments.get(theme.id,projectFile.id),error=>error.status===404);
  const tools=createThemeTools(library,{boundThemeId:theme.id,attachments:service.themeAttachments});assert.equal((await tools.execute('read_attachment',{attachmentId:image.id})).preview.mimeType,'image/png');
  const copied=await tools.execute('use_attachment_image',{attachmentId:image.id});assert.ok(copied.url.startsWith('/api/themes/'+theme.id+'/assets/'));assert.deepEqual(await library.themes.asset(theme.id,path.basename(copied.url)),Buffer.from(png,'base64'));
  await service.saveSettings({provider:'openai',model:'fixture',apiKey:'fixture-key'});const result=await service.send({themeId:theme.id,message:'',attachmentIds:[image.id]});assert.equal(result.content,'Готово.');
  const history=await service.history(theme.id,'theme');assert.equal(history.messages[0].attachments[0].id,image.id);assert.equal(JSON.stringify(history).includes(png),false);
});

test('active theme sessions cancel and reset by their own context without colliding with project IDs',async t=>{
  const {directory,library,theme}=await fixture(t),service=new AIService({dataDir:directory,library,root:projectRoot});t.after(()=>service.close());
  let started,modelSignal;const ready=new Promise(resolve=>{started=resolve;});service.acp.prompt=async({signal})=>{modelSignal=signal;started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));signal.throwIfAborted();};
  const events=[],pending=service.send({themeId:theme.id,message:'Проверь тему',onEvent:event=>events.push(event)});await ready;
  const status=await service.status();assert.deepEqual(status.activeThemes,[theme.id]);assert.deepEqual(status.activeProjects,[]);
  await assert.rejects(()=>service.resetHistory(theme.id,'theme'),error=>error.status===409);
  service.cancel(theme.id);assert.equal(modelSignal.aborted,false);service.cancel(theme.id,'theme');assert.equal((await pending).cancelled,true);assert.ok(events.some(event=>event.type==='done'&&event.cancelled));
  assert.equal((await service.history(theme.id,'theme')).messages.length,1);await service.resetHistory(theme.id,'theme');assert.deepEqual(await service.history(theme.id,'theme'),{messages:[]});
});

const mockACP=`
import readline from 'node:readline';import{writeFileSync}from'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n'),reply=(id,result)=>send({jsonrpc:'2.0',id,result});let promptId,permission=0;const outcomes=[];
const names=['mcp.presentations.read_theme','mcp.presentations.read_slide','Native shell'];
function next(){if(permission===names.length){writeFileSync('permission-outcomes.json',JSON.stringify(outcomes));send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'theme-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Проверил текущую тему.'}}}});reply(promptId,{stopReason:'end_turn'});return;}
const toolCallId='tool-'+permission;send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'theme-session',update:{sessionUpdate:'tool_call',toolCallId,title:names[permission],status:'pending'}}});send({jsonrpc:'2.0',id:900+permission,method:'session/request_permission',params:{sessionId:'theme-session',toolCall:{toolCallId,title:names[permission]},options:[{optionId:'yes',name:'Once',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});}
readline.createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);if(msg.method==='initialize')reply(msg.id,{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true}},authMethods:[]});else if(msg.method==='session/new'){writeFileSync('session-config.json',JSON.stringify(msg.params));reply(msg.id,{sessionId:'theme-session'});}else if(msg.method==='session/prompt'){writeFileSync('prompt-config.json',JSON.stringify(msg.params));promptId=msg.id;next();}else if(msg.id>=900&&msg.result){outcomes.push(msg.result);permission++;next();}});
`;
test('actual ACP protocol config uses isolated theme workspace and --theme MCP; other operations have no approval escape hatch',async t=>{
  const {directory,library,theme}=await fixture(t),script=path.join(directory,'agent.mjs');await writeFile(script,mockACP);
  const service=new AIService({dataDir:directory,library,root:projectRoot,acpCommand:process.execPath,acpArgs:[script],acpAuthHome:path.join(directory,'empty-auth'),mcpUrl:'http://127.0.0.1:3210/api/agent-tools',mcpToken:'fixture-token'});t.after(()=>service.close());const events=[];
  const result=await service.send({themeId:theme.id,message:'Посмотри текущую тему',onEvent:event=>events.push(event)});assert.equal(result.content,'Проверил текущую тему.');
  const workspace=path.join(directory,'ai/workspaces/themes',theme.id),setup=JSON.parse(await readFile(path.join(workspace,'session-config.json'),'utf8'));
  assert.equal(setup.cwd,workspace);assert.deepEqual(setup.mcpServers[0].args,[path.join(projectRoot,'backend/modules/mcp/server.js'),'--theme',theme.id]);assert.deepEqual(await library.list(),[]);
  const outcomes=JSON.parse(await readFile(path.join(workspace,'permission-outcomes.json'),'utf8'));assert.deepEqual(outcomes.map(item=>item.outcome.optionId),['yes','no','no']);assert.equal(events.some(item=>item.type==='permission'),false);
  const prompt=JSON.parse(await readFile(path.join(workspace,'prompt-config.json'),'utf8'));assert.match(prompt.prompt[0].text,/theme editor, not a presentation project/);assert.match(prompt.prompt[0].text,/render_theme/);assert.match(prompt.prompt[0].text,/JavaScript orchestration wrapper \(exec\).*only to invoke the bound presentations MCP tools/);assert.match(prompt.prompt[0].text,/Do not use exec_command, shell or filesystem tools/);
  assert.equal((await service.readChat(theme.id,'theme')).acpSessionId,'theme-session');await service.resetHistory(theme.id,'theme');assert.equal(service.acp.sessions.has('theme:'+theme.id),false);
});

test('real MCP stdio theme binding lists only theme tools and refuses cross-theme/project calls before HTTP',async t=>{
  const directory=await temporary(t),running=await createServer(projectRoot,{authRequired:false,dataDir:directory});t.after(async()=>{running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));});
  const theme=await running.library.themes.create({title:'MCP theme',baseThemeId:'light'}),token=(await readFile(path.join(directory,'agent-token'),'utf8')).trim();
  const client=new Client({name:'theme-fixture',version:'1'});t.after(()=>client.close());await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(projectRoot,'backend/modules/mcp/server.js'),'--theme',theme.id],env:{PRESENTATIONS_MCP_URL:running.url+'/api/agent-tools',PRESENTATIONS_MCP_TOKEN:token}}));
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),themeToolDefinitions.map(tool=>tool.name));const prompts=await client.listPrompts();assert.equal(prompts.prompts[0].name,'edit-theme');
  const read=await client.callTool({name:'read_theme',arguments:{}});assert.equal(JSON.parse(read.content[0].text).id,theme.id);
  const changed=await client.callTool({name:'update_theme',arguments:{version:0,title:'Changed via theme MCP'}});assert.equal(changed.isError,undefined);assert.equal((await running.library.themes.get(theme.id)).title,'Changed via theme MCP');
  assert.equal((await client.callTool({name:'read_theme',arguments:{themeId:'light'}})).isError,true);assert.equal((await client.callTool({name:'read_project',arguments:{projectId:'anything'}})).isError,true);
  running.library.renderer.renderTheme=async id=>({themeId:id,preview:{mimeType:'image/png',data:png},warnings:[]});const visual=await client.callTool({name:'render_theme',arguments:{}});assert.equal(visual.content[1].type,'image');assert.equal(JSON.parse(visual.content[0].text).themeId,theme.id);
});

test('theme HTTP chat/uploads/preview are authenticated, persist separately, support attachment-only sends and cancellation',async t=>{
  const directory=await temporary(t),running=await createServer(projectRoot,{authRequired:false,dataDir:directory,aiOptions:{clientFactory:()=>finalClient()}});t.after(async()=>{running.server.closeAllConnections();await new Promise(resolve=>running.server.close(resolve));});
  const theme=await running.library.themes.create({title:'HTTP theme',baseThemeId:'light'}),other=await running.library.themes.create({title:'Other',baseThemeId:'dark'}),base=running.url+'/api/themes/'+theme.id;
  const request=(url,method='GET',value)=>fetch(url,{method,headers:value?{'Content-Type':'application/json'}:{},body:value?JSON.stringify(value):undefined});await running.ai.saveSettings({provider:'openai',model:'fixture',apiKey:'fixture-key'});
  const uploaded=await request(base+'/attachments','POST',{name:'image.png',mime:'image/png',data:png});assert.equal(uploaded.status,200);const image=await uploaded.json();
  for(const suffix of ['', '/file']){const read=await request(base+'/attachments/'+image.id+suffix);assert.equal(read.headers.get('Content-Type'),'image/png');assert.deepEqual(Buffer.from(await read.arrayBuffer()),Buffer.from(png,'base64'));}
  assert.equal((await request(running.url+'/api/themes/'+other.id+'/attachments/'+image.id)).status,404);
  const answer=await request(base+'/chat','POST',{attachmentIds:[image.id]});const events=await answer.text();assert.match(events,/event: accepted/);assert.match(events,/event: done/);assert.equal(events.includes('event: permission'),false);
  const history=await(await request(base+'/chat')).json();assert.equal(history.messages.length,2);assert.equal(history.messages[0].attachments[0].id,image.id);
  running.library.renderer.renderTheme=async id=>({themeId:id,preview:{mimeType:'image/png',data:png},warnings:[]});assert.equal((await(await request(base+'/preview','POST',{})).json()).themeId,theme.id);
  assert.deepEqual(await(await request(base+'/chat/cancel','POST',{})).json(),{ok:true});assert.deepEqual(await(await request(base+'/chat','DELETE')).json(),{messages:[]});assert.deepEqual(await running.library.list(),[]);
  const privateDir=await temporary(t),privateServer=await createServer(projectRoot,{authRequired:true,publicOrigin:'https://presentations.example',dataDir:privateDir});t.after(async()=>{privateServer.server.closeAllConnections();await new Promise(resolve=>privateServer.server.close(resolve));});
  assert.equal((await fetch(privateServer.url+'/api/themes/light/chat')).status,401);assert.equal((await fetch(privateServer.url+'/api/themes/light/preview')).status,401);
  await assert.rejects(()=>readFile(path.join(directory,'ai/chats',theme.id+'.json')),error=>error.code==='ENOENT');
  assert.deepEqual((await readdir(path.join(directory,'ai/chats/themes'))).filter(name=>name.endsWith('.json')),[theme.id+'.json']);
});
