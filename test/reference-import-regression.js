import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHTTPServer} from 'node:http';
import {mkdtemp,rm,readFile,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import JSZip from 'jszip';
import {createServer,projectRoot} from '../backend/http/server.js';
import {createProjectTools,createThemeTools} from '../backend/modules/mcp/tools.js';
import {DocumentPreviewStore} from '../backend/modules/previews/documents.js';
import {buildReferenceDocuments,referencePalette,referenceGeometry} from './fixtures/reference-documents.js';

const source=await buildReferenceDocuments();
const payload=(name,buffer)=>({name,mime:name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.presentationml.presentation',data:buffer.toString('base64')});
const request=(app,url,method='GET',value)=>fetch(app.url+url,{method,headers:value?{'Content-Type':'application/json'}:{},body:value?JSON.stringify(value):undefined});

async function fixture(t,{acp=false}={}){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'presentation-reference-regression-')),pdfFile=path.join(dataDir,'fixture.pdf'),audit=path.join(dataDir,'converter-audit.json'),preparedFile=path.join(dataDir,'prepared.pptx'),sandbox=path.join(dataDir,'sandbox-fixture');
  await writeFile(pdfFile,source.pdf);
  // Explicit mock of the trusted converter/sandbox boundary. PDF rendering,
  // PPTX inspection, MCP and HTML rendering below are real. This does not
  // establish LibreOffice's fidelity or OS isolation on this test machine.
  await writeFile(sandbox,`#!${process.execPath}\nimport{readFileSync,writeFileSync,copyFileSync}from'node:fs';import path from'node:path';const args=process.argv.slice(2),job=args[args.indexOf('--bind')+1];writeFileSync(${JSON.stringify(audit)},JSON.stringify(args));copyFileSync(path.join(job,'source.pptx'),${JSON.stringify(preparedFile)});copyFileSync(${JSON.stringify(pdfFile)},path.join(job,'source.pdf'));\n`,{mode:0o700});await chmod(sandbox,0o700);
  const aiOptions={};let script;
  if(acp){
    script=path.join(dataDir,'acp-fixture.mjs');
    await writeFile(script,acpScript());Object.assign(aiOptions,{acpCommand:process.execPath,acpArgs:[script],acpAuthHome:path.join(dataDir,'empty-auth')});
  }
  const app=await createServer(projectRoot,{authRequired:false,dataDir,documentPreviewOptions:{command:'/usr/bin/true',sandboxCommand:sandbox},aiOptions});
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const theme=await app.library.themes.create({title:'Copied visual reference',baseThemeId:'light'}),project=await app.library.create({title:'Source material scope'});
  return {app,dataDir,theme,project,audit,preparedFile};
}
async function pixels(preview){const buffer=Buffer.from(preview.data,'base64'),image=await loadImage(buffer),canvas=createCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);return {buffer,width:image.width,height:image.height,at(x,y){return [...context.getImageData(Math.round(x*image.width/1280),Math.round(y*image.height/720),1,1).data].slice(0,3);}};}
function nearColor(actual,color,tolerance=12){const expected=[1,3,5].map(offset=>parseInt(color.slice(offset,offset+2),16));assert(actual.every((value,index)=>Math.abs(value-expected[index])<=tolerance),`Expected ${color}, saw rgb(${actual.join(',')})`);}
function checkEvidence(reference){
  assert.equal(reference.canvas.width,1280);assert.equal(reference.canvas.height,720);assert(reference.usedFonts.includes('Arial'));assert(reference.usedColors.includes(referencePalette.background.toUpperCase()));
  assert.equal(reference.slides.length,2);assert.equal(reference.slides[0].background.provenance.role,'master');
  const master=reference.masters.find(item=>item.shapes.length),logo=master.shapes.find(shape=>shape.type==='image');assert(master);assert(logo);
  for(const [key,value]of Object.entries(referenceGeometry.logo))assert(Math.abs(logo.box[key]-value)<.1);
  assert.equal(reference.images.find(image=>image.assetId===logo.imageAssetId).supported,true);return {master,logo};
}

test('real PDF pixels and bounded PPTX reference pipeline preserve pages, inherited style and owned source access',async t=>{
  const {app,theme,project,audit,preparedFile}=await fixture(t),themeTools=createThemeTools(app.library,{boundThemeId:theme.id}),projectTools=createProjectTools(app.library,{boundProjectId:project.id});
  const uploaded=await(await request(app,'/api/themes/'+theme.id+'/attachments','POST',payload('reference.pptx',source.pptx))).json();
  const read=await themeTools.execute('read_attachment',{attachmentId:uploaded.id});assert.equal(read.document.status,'ready');assert.equal(read.document.renderer,'libreoffice+pdfjs');assert.equal(read.document.pageCount,2);assert(read.preview);nearColor((await pixels(read.preview)).at(20,5),referencePalette.accent);
  const second=await themeTools.execute('render_document_page',{attachmentId:uploaded.id,page:2});assert.equal(second.page,2);nearColor((await pixels(second.preview)).at(20,5),referencePalette.secondAccent);
  assert(second.width<=1200&&second.height<=1200);assert(Buffer.from(second.preview.data,'base64').length<=1024*1024);
  const argv=JSON.parse(await readFile(audit,'utf8'));assert(argv.includes('--unshare-all'));assert(argv.includes('--die-with-parent'));assert(argv.includes('-env:UserInstallation=file:///work/profile'));assert.equal(argv.at(-1),'/work/source.pptx');
  const prepared=await JSZip.loadAsync(await readFile(preparedFile));assert(prepared.file('ppt/presentation.xml'));
  const inspected=await themeTools.execute('inspect_presentation_reference',{attachmentId:uploaded.id});checkEvidence(inspected.reference);
  const material=await(await request(app,'/api/projects/'+project.id+'/materials','POST',payload('reference.pdf',source.pdf))).json();
  const materialRead=await projectTools.execute('read_material',{materialId:material.id});assert.equal(materialRead.document.status,'ready');assert.equal(materialRead.document.renderer,'pdfjs');nearColor((await pixels(materialRead.preview)).at(1100,430),referencePalette.surface);
  const materialPage=await projectTools.execute('render_document_page',{materialId:material.id,page:2});nearColor((await pixels(materialPage.preview)).at(20,5),referencePalette.secondAccent);
  const other=await app.library.create({title:'Other context'}),otherTools=createProjectTools(app.library,{boundProjectId:other.id});await assert.rejects(()=>otherTools.execute('render_document_page',{materialId:material.id,page:1}),error=>error.status===404);
  await assert.rejects(()=>themeTools.execute('render_document_page',{materialId:material.id,page:1}),/аргумент|attachmentId/);await assert.rejects(()=>projectTools.execute('read_attachment',{attachmentId:uploaded.id}),error=>error.status===404);
  const missingPage=await projectTools.execute('render_document_page',{materialId:material.id,page:3});assert.equal(missingPage.document.status,'page_not_found');assert.equal(missingPage.preview,undefined);
  const unavailable=new DocumentPreviewStore({dataDir:path.join(app.library.dataDir,'unavailable-fixture'),command:path.join(app.library.dataDir,'missing-converter'),sandboxCommand:path.join(app.library.dataDir,'missing-sandbox')});t.after(()=>unavailable.close());
  const unavailableResult=await unavailable.render({metadata:uploaded,buffer:source.pptx});assert.equal(unavailableResult.document.status,'converter_unavailable');assert.equal(unavailableResult.preview,undefined);
});

function copiedDesign(theme,reference,logoURL){
  const {master}=checkEvidence(reference),elements=master.shapes.map((shape,index)=>{
    const box=shape.box,position=`position:absolute;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;box-sizing:border-box;`;
    if(shape.type==='image')return `<img data-block-id="reference-logo" data-block-type="image" alt="Reference logo" src="${logoURL}" style="${position}">`;
    if(shape.text)return `<p class="reference-footer" data-block-id="reference-footer" data-block-type="text" style="${position}margin:0;font-family:Arial,sans-serif;font-size:${shape.textStyle.fontSize}px;color:${shape.textStyle.color.resolved}">{{projectTitle}}</p>`;
    return `<div data-block-id="reference-shape-${index}" data-block-type="element" style="${position}background:${shape.fill?.color?.resolved||'transparent'};border:${shape.line?.width||0}px solid ${shape.line?.fill?.color?.resolved||'transparent'}"></div>`;
  });
  return {...theme.design,tokens:{background:referencePalette.background,text:referencePalette.text,muted:referencePalette.muted,accent:referencePalette.accent,surface:referencePalette.surface,border:referencePalette.border,font:reference.usedFonts[0]+', sans-serif'},background:{type:'solid',value:master.background.color.resolved},decorations:[],template:{...theme.design.template,header:'',footer:'',showAuthor:false,showProjectTitle:false,showSlideNumber:false,html:elements.join('\n'),css:'.reference-footer { line-height: 1.1; }'}};
}
const nativeImages=input=>input.flatMap(item=>Array.isArray(item.content)?item.content.filter(block=>['input_image','image_url'].includes(block.type)):[]);
const imageData=block=>{const url=typeof block.image_url==='string'?block.image_url:block.image_url.url;const [,mime,data]=/^data:([^;]+);base64,(.+)$/.exec(url);return {mimeType:mime,data};};

for(const apiMode of ['responses','chat-completions'])test(`${apiMode}: real HTTP model tools copy editable reference style and inspect native rendered pixels`,async t=>{
  const {app,theme}=await fixture(t),attachment=await app.ai.themeAttachments.create(theme.id,payload('style-reference.pptx',source.pptx));
  let phase=0,current,reference,logoURL,rendered,initialImage=false,pageImage=false,finalImage=false;const failures=[],calls=[];
  const provider=createHTTPServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw),messages=input.input||input.messages;
      const outputs=messages.filter(item=>item.type==='function_call_output'||item.role==='tool');
      const value=name=>{const output=outputs.findLast(item=>(item.call_id||item.tool_call_id||'').startsWith(name+'-'));assert(output,`Missing ${name} result`);return JSON.parse(output.output||output.content);};
      for(const item of outputs)assert.equal(JSON.parse(item.output||item.content).error,undefined);
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const emit=event=>res.write('data: '+JSON.stringify(event)+'\n\n');
      const call=items=>{
        calls.push(...items.map(item=>item[0]));const result=items.map(([name,args],index)=>({type:'function_call',id:name+'-item',call_id:name+'-'+phase+'-'+index,name,arguments:JSON.stringify(args)}));
        if(apiMode==='responses')emit({type:'response.completed',response:{output:result}});
        else emit({id:'reference-fixture',choices:[{index:0,delta:{tool_calls:result.map((item,index)=>({index,id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}}))},finish_reason:null}]});
      };
      if(phase===0){initialImage=nativeImages(messages).length>0;assert(initialImage);call([['read_theme',{}],['inspect_presentation_reference',{attachmentId:attachment.id}],['render_document_page',{attachmentId:attachment.id,page:2}]]);
      }else if(phase===1){current=value('read_theme');reference=value('inspect_presentation_reference').reference;const {logo}=checkEvidence(reference);pageImage=true;nearColor((await pixels(imageData(nativeImages(messages).at(-1)))).at(20,5),referencePalette.secondAccent);call([['use_reference_image',{attachmentId:attachment.id,assetId:logo.imageAssetId}]]);
      }else if(phase===2){logoURL=value('use_reference_image').url;assert(logoURL.startsWith('/api/themes/'+theme.id+'/assets/'));call([['update_theme',{version:current.version,design:copiedDesign(current,reference,logoURL)}]]);
      }else if(phase===3){assert.equal(value('update_theme').version,1);call([['render_theme',{}]]);
      }else{
        rendered=value('render_theme');assert.equal(rendered.preview.imageProvided,true);assert(!rendered.warnings.some(warning=>['outside-canvas','clipped-content','missing-image'].includes(warning.code)));
        const preview=imageData(nativeImages(messages).at(-1)),actual=await pixels(preview);nearColor(actual.at(20,5),referencePalette.accent);nearColor(actual.at(30,400),referencePalette.background);nearColor(actual.at(1100,430),referencePalette.surface);nearColor(actual.at(1148,46),referencePalette.accent);nearColor(actual.at(1164,62),referencePalette.background);finalImage=true;
        const text='Перенёс палитру, шрифт, общие фигуры и логотип. Сравнил изображение шаблона с образцом.';
        if(apiMode==='responses'){emit({type:'response.output_text.delta',delta:text});emit({type:'response.completed',response:{output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}});}else emit({id:'reference-fixture',choices:[{index:0,delta:{content:text},finish_reason:null}]});
      }
      phase++;res.end('data: [DONE]\n\n');
    }catch(error){failures.push(error.message);if(!res.headersSent)res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}
  });await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
  await app.ai.saveSettings({provider:'openai',apiMode,baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',model:'visual-copy-fixture',apiKey:'fixture-key-not-secret'});
  const response=await request(app,'/api/themes/'+theme.id+'/chat','POST',{message:'Перенеси оформление образца в текущую тему. Не копируй пример содержимого.',attachmentIds:[attachment.id]}),events=await response.text();assert.match(events,/event: done/);assert.doesNotMatch(events,/event: error/);assert.deepEqual(failures,[]);assert(initialImage&&pageImage&&finalImage);
  const saved=await app.library.themes.get(theme.id);assert.equal(saved.version,1);assert.match(saved.design.tokens.font,/Arial/);assert.match(saved.design.template.html,/\{\{projectTitle\}\}/);assert(!saved.design.template.html.includes('A clear visual system'));assert(!saved.design.template.html.includes('Synthetic speaker note'));
  const logo=rendered.blocks.find(block=>block.id==='reference-logo');for(const key of ['x','y','width','height'])assert(Math.abs(logo[key]-referenceGeometry.logo[key])<1);
  assert.deepEqual(await app.library.themes.asset(theme.id,path.basename(logoURL)),source.logo);assert(calls.includes('inspect_presentation_reference'));assert(calls.includes('render_document_page'));assert(calls.includes('use_reference_image'));
  const history=await app.ai.history(theme.id,'theme');assert.equal(JSON.stringify(history).includes(attachment.data||source.pptx.toString('base64')),false);
});

function acpScript(){
  const sdk=path.join(projectRoot,'node_modules/@modelcontextprotocol/sdk/dist/esm/client');
  return `import readline from'node:readline';import{writeFileSync}from'node:fs';import{Client}from${JSON.stringify(pathToFileURL(path.join(sdk,'index.js')).href)};import{StdioClientTransport}from${JSON.stringify(pathToFileURL(path.join(sdk,'stdio.js')).href)};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n'),reply=(id,result)=>send({jsonrpc:'2.0',id,result});let setup,client;
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const msg=JSON.parse(line);if(msg.method==='initialize')reply(msg.id,{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true}},authMethods:[]});else if(msg.method==='session/new'){setup=msg.params;client=new Client({name:'visual-reference-fixture',version:'1'});const server=setup.mcpServers[0];await client.connect(new StdioClientTransport({command:server.command,args:server.args,env:Object.fromEntries(server.env.map(item=>[item.name,item.value]))}));reply(msg.id,{sessionId:'reference-acp'});}else if(msg.method==='session/prompt'){writeFileSync('prompt-images.json',JSON.stringify(msg.params.prompt.filter(item=>item.type==='image')));const text=msg.params.prompt.find(item=>item.type==='text').text,attachment=/Attachment ([a-f0-9-]{36}):/.exec(text),material=attachment?null:JSON.parse(/Material catalog: (.*)\\n/.exec(text)[1])[0],source=attachment?{attachmentId:attachment[1]}:{materialId:material.id};const first=await client.callTool({name:attachment?'read_attachment':'read_material',arguments:source}),second=await client.callTool({name:'render_document_page',arguments:{...source,page:2}});for(const[name,result]of[['read',first],['second',second]]){if(result.isError)throw new Error(JSON.stringify(result));const image=result.content.find(item=>item.type==='image');if(!image)throw new Error('MCP native image missing');writeFileSync(name+'-preview.bin',Buffer.from(image.data,'base64'));writeFileSync(name+'-metadata.json',result.content.find(item=>item.type==='text').text);}send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'reference-acp',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Вижу оформление двух страниц через MCP.'}}}});await client.close();reply(msg.id,{stopReason:'end_turn'});}else if(msg.method==='session/cancel'){await client?.close();}}catch(error){send({jsonrpc:'2.0',id:JSON.parse(line).id,error:{code:-32603,message:error.message}});}});
`;
}
for(const scope of ['theme','project'])test(`actual ACP/MCP exchange supplies ${scope} document native images with the source binding`,async t=>{
  const {app,dataDir,theme,project}=await fixture(t,{acp:true});
  let id;
  if(scope==='theme'){
    const attachment=await app.ai.themeAttachments.create(theme.id,payload('acp-reference.pptx',source.pptx));id=attachment.id;
  }else{
    const material=await app.library.materials.create(project.id,payload('acp-reference.pdf',source.pdf));id=material.id;
  }
  const result=await app.ai.send({...(scope==='theme'?{themeId:theme.id,attachmentIds:[id]}:{projectId:project.id}),message:'Посмотри вторую страницу оформления.'});assert.equal(result.content,'Вижу оформление двух страниц через MCP.');
  const workspace=path.join(dataDir,'ai/workspaces',...(scope==='theme'?['themes',theme.id]:[project.id])),promptImages=JSON.parse(await readFile(path.join(workspace,'prompt-images.json'),'utf8'));assert.equal(promptImages.length,scope==='theme'?1:0);
  if(promptImages.length)nearColor((await pixels({mimeType:promptImages[0].mimeType,data:promptImages[0].data})).at(20,5),referencePalette.accent);
  const read=JSON.parse(await readFile(path.join(workspace,'read-metadata.json'),'utf8')),second=JSON.parse(await readFile(path.join(workspace,'second-metadata.json'),'utf8'));assert.equal(read.document.status,'ready');assert.equal(second.page,2);assert.equal(second.document.pageCount,2);
  nearColor((await pixels({data:(await readFile(path.join(workspace,'second-preview.bin'))).toString('base64')})).at(20,5),referencePalette.secondAccent);
});
