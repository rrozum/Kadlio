import assert from 'node:assert/strict';
import {createServer as createHTTPServer} from 'node:http';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from '../backend/http/server.js';

const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=await mkdtemp(path.join(os.tmpdir(),'presentations-theme-chat-ui-'));
const app=await createServer(root,{authRequired:false,dataDir}),stages=new Map();
const original=await app.library.themes.get('paper');
const provider=createHTTPServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw),id=input.messages[0].content.match(/Current theme ID: ([\w-]+)/)?.[1];
  assert(id);assert(input.tools.every(tool=>!['update_slide','read_project','create_theme','delete_theme'].includes(tool.function.name)));
  const stage=stages.get(id)||0;stages.set(id,stage+1);res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=delta=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'theme-fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  if(stage===0){
    await new Promise(resolve=>setTimeout(resolve,350));const theme=await app.library.themes.get(id);
    const design=structuredClone(theme.design);design.template.html+='<p data-block-id="agent-caption" data-block-type="text" style="position:absolute;left:100px;top:500px;width:900px;color:var(--pres-accent)">Правка агента · {{author}}</p>';design.tokens.accent='#e24488';
    send({tool_calls:[{index:0,id:'theme-edit',type:'function',function:{name:'update_theme',arguments:JSON.stringify({themeId:id,version:theme.version,design})}}]});
  }else if(stage===1)send({tool_calls:[{index:0,id:'theme-preview',type:'function',function:{name:'render_theme',arguments:JSON.stringify({themeId:id})}}]});
  else send({content:'Тема обновлена. Переменные сохранены, вид шаблона проверен.'});
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
await app.ai.saveSettings({provider:'openai',apiMode:'chat-completions',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',model:'theme-fixture',apiKey:'fixture-not-a-real-key'});
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1660,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>{window.SpeechRecognition=class{start(){}stop(){setTimeout(()=>{const result=[{transcript:'Продиктованные пожелания'}];result.isFinal=true;this.onresult?.({resultIndex:0,results:[result]});this.onend?.();},10);}abort(){this.onend?.();}};});
const screenshotDir=path.join(root,'test-results');await mkdir(screenshotDir,{recursive:true});
try{
  await page.goto(app.url+'/themes/paper');await page.locator('#theme-loading').waitFor({state:'hidden'});await page.getByText('theme-fixture',{exact:true}).waitFor();
  assert((await page.locator('#chat-empty-caption').textContent()).includes('копию'));await page.locator('#chat-input').fill('Сделай акцент заметнее и проверь шаблон.');await page.locator('#chat-send').click();await page.locator('#chat-stop').waitFor({state:'visible'});
  assert.match(await page.locator('.chat-message.assistant .message-content').last().textContent(),/^Работает/);
  assert.equal(await page.locator('#theme-copy').isDisabled(),true);assert.equal(await page.locator('#theme-save').isDisabled(),true);
  await page.getByText('Тема обновлена. Переменные сохранены, вид шаблона проверен.',{exact:true}).waitFor();await page.locator('#chat-stop').waitFor({state:'hidden'});const id=new URL(page.url()).pathname.split('/').at(-1);assert.notEqual(id,'paper');
  await page.frameLocator('#theme-canvas').locator('[data-block-id=agent-caption]').waitFor();assert.equal(await page.locator('.chat-activity').last().getAttribute('open'),null);assert.equal((await app.ai.history(id,'theme')).messages.length,2);assert.deepEqual(await app.library.themes.get('paper'),original);assert.equal((await app.library.list()).length,0);
  assert.equal((await app.library.themes.get(id)).design.tokens.accent,'#e24488');assert((await app.library.themes.get(id)).design.template.html.includes('{{author}}'));
  await page.locator('#chat-file-input').setInputFiles({name:'theme-brief.md',mimeType:'text/markdown',buffer:Buffer.from('Сохранить переменные темы.')});await page.locator('.attachment-chip.ready').waitFor();await page.locator('#chat-input').fill('Прочитай пожелания к теме.');await page.locator('#chat-send').click();await page.locator('#chat-stop').waitFor({state:'visible'});await page.locator('#chat-stop').waitFor({state:'hidden'});const history=await app.ai.history(id,'theme');assert.equal(history.messages.at(-2).attachments[0].name,'theme-brief.md');assert(history.messages.at(-2).attachments[0].previewUrl?.startsWith('/api/themes/'+id+'/attachments/')||history.messages.at(-2).attachments[0].kind==='text');
  await page.reload();await page.locator('#theme-loading').waitFor({state:'hidden'});await page.locator('.chat-message').nth(3).waitFor();assert.equal(await page.locator('.chat-message').count(),4);await page.screenshot({path:path.join(screenshotDir,'theme-chat-dark.png')});await page.locator('#theme-toggle').click();await page.screenshot({path:path.join(screenshotDir,'theme-chat-light.png')});
  await page.locator('#dictation-button').click();await page.waitForFunction(()=>document.getElementById('dictation-button').dataset.state==='recording');assert.equal(await page.locator('#chat-input').inputValue(),'');await page.locator('#chat-send').click();await page.waitForFunction(()=>document.querySelectorAll('.chat-message').length===6&&document.getElementById('chat-stop').hidden);assert.equal((await app.ai.history(id,'theme')).messages.at(-2).content,'Продиктованные пожелания');
  await page.setViewportSize({width:390,height:844});await page.locator('#theme-chat-toggle').click();await page.locator('#chat-panel').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(screenshotDir,'theme-chat-mobile.png')});
  await page.setViewportSize({width:1660,height:1000});await page.locator('#chat-panel').evaluate(el=>el.classList.remove('mobile-open'));
  const conflict=await app.library.themes.create({title:'Concurrent draft fixture',baseThemeId:'light'});await page.goto(app.url+'/themes/'+conflict.id);await page.getByText('theme-fixture',{exact:true}).waitFor();await page.locator('#chat-input').fill('Добавь подпись.');await page.locator('#chat-send').click();await page.locator('#chat-stop').waitFor({state:'visible'});assert.equal(await page.locator('#theme-copy').isDisabled(),true);await page.locator('#theme-copy').evaluate(button=>button.click());assert.equal(new URL(page.url()).pathname.split('/').at(-1),conflict.id);await page.locator('[data-theme-tab=appearance]').click();await page.locator('#theme-author').fill('Локальный черновик');await page.locator('#theme-author').dispatchEvent('input');await page.locator('#chat-stop').waitFor({state:'hidden'});
  assert.equal(await page.locator('#theme-author').inputValue(),'Локальный черновик');assert.equal(await page.locator('#theme-save-status').textContent(),'Есть изменения');assert.equal(await page.frameLocator('#theme-canvas').locator('[data-block-id=agent-caption]').count(),0);assert((await app.library.themes.get(conflict.id)).design.template.html.includes('agent-caption'));assert.deepEqual(errors,[]);
  console.log('Theme chat UI passed: editable builtin copy, theme-only HTTP/SSE tools, preview image, live canvas, persistent history/files, collapsed activity, concurrent draft preservation and mobile/light UI.');
}finally{await browser.close();await new Promise(resolve=>provider.close(resolve));await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
