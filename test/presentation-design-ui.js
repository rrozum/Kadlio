import assert from 'node:assert/strict';
import {createServer as createHTTPServer} from 'node:http';
import {mkdtemp,rm,mkdir,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import JSZip from 'jszip';
import {PDFDocument} from 'pdf-lib';
import {createServer} from '../backend/http/server.js';
import {createPresentationDesign} from '../shared/presentation/design.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const dataDir=await mkdtemp(path.join(os.tmpdir(),'presentations-design-ui-'));
const screenshots=path.join(root,'test-results');await mkdir(screenshots,{recursive:true});
const application=await createServer(root,{authRequired:false,dataDir});
const fixture=await application.library.create({title:'Design browser fixture'});
const provider=createHTTPServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=delta=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'browser-fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  if(input.messages.at(-1)?.role==='tool'){
    await new Promise(resolve=>setTimeout(resolve,1800));send({content:'Тема прочитана. Слайды сохранены.'});
  }else{
    send({content:'Сейчас проверю устройство презентации.'});
    send({tool_calls:[{index:0,id:'fixture-project',type:'function',function:{name:'read_project',arguments:'{}'}}]});
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1660,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
const canvas=()=>page.frameLocator('#slide-canvas');
const settled=()=>page.waitForFunction(()=>document.getElementById('save-status')?.textContent==='Сохранено');
const block=async(id,newSlide=false)=>{
  await page.locator('#blocks-tool').click();await page.locator('#blocks-dialog').waitFor({state:'visible'});
  await page.locator('[data-preset-id="'+id+'"]').locator('[data-preset-action="'+(newSlide?'new-slide':'insert')+'"]').click();
  await page.locator('#blocks-dialog').waitFor({state:'hidden'});await settled();
};
const pixel={name:'pixel.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')};
try{
  await page.goto(application.url+'/projects/'+fixture.id);await page.locator('#canvas-loading').waitFor({state:'hidden'});
  await page.locator('#design-tab').click();await page.locator('[data-theme-id="original"]').waitFor();
  assert.equal((await application.library.get(fixture.id)).design??null,null);
  await block('comparison');
  assert.equal(await canvas().locator('[data-preset-id="comparison"]').count(),1);
  assert.equal(await page.locator('#block-type').textContent(),'Композиция');assert.equal(await page.locator('#text-properties').isVisible(),false);
  await canvas().locator('[data-preset-field="leftTitle"]').click();await page.locator('#prop-text').fill('Понятный первый подход');await settled();
  assert((await application.library.get(fixture.id)).slides[0].body.includes('Понятный первый подход'));
  await block('image-caption',true);assert.equal(await page.locator('#slide-counter').textContent(),'2 / 2');
  const second=(await application.library.get(fixture.id)).slides[1];assert(!second.body.includes('Новый слайд'));
  await canvas().locator('[data-preset-placeholder="image"]').click();await page.locator('#image-file').setInputFiles(pixel);await page.locator('#image-alt').fill('A tiny example');await page.locator('#image-form button[type=submit]').click();await page.locator('#image-dialog').waitFor({state:'hidden'});await settled();
  assert.equal(await canvas().locator('[data-preset-field="image"] img').count(),0);assert.equal(await canvas().locator('img[data-preset-field="image"]').count(),1);
  await page.locator('#design-tab').click();await page.locator('[data-theme-id="light"]').click();
  assert.equal((await application.library.get(fixture.id)).design??null,null,'Choosing a theme previews without rewriting the deck');
  assert.equal(await canvas().locator('.slide').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(248, 250, 252)');
  await page.locator('#design-apply').click();await page.getByText('Тема сохранена в презентации.',{exact:true}).waitFor();
  let designed=await application.library.get(fixture.id);const design=structuredClone(designed.design);
  design.metadata={author:'Example author',brand:'Example brand'};design.template.header='{{slideTitle}}';design.template.footer='{{brand}}';
  await application.library.updateDesign(fixture.id,{design,version:designed.version});
  await canvas().getByText('Example author',{exact:true}).waitFor();await canvas().getByText('02 / 2',{exact:true}).waitFor();
  assert.equal(await canvas().locator('[data-template-layer]').count(),1);
  await canvas().locator('[data-preset-field="title"]').click();await page.locator('#prop-text').fill('Пример остаётся HTML');await settled();
  const edited=await application.library.get(fixture.id);assert(!edited.slides[1].body.includes('data-template-layer'));assert(!edited.slides[1].body.includes('slide-body'));assert(edited.slides[1].body.includes('Пример остаётся HTML'));
  await canvas().locator('[data-template-layer]').evaluate(element=>element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,isPrimary:true,pointerId:1})));assert.equal(await page.locator('#selection-layer').isVisible(),false);
  const slideBackground=await canvas().locator('.slide').evaluate(element=>getComputedStyle(element).backgroundColor);
  await page.locator('#theme-toggle').click();assert.equal(await canvas().locator('.slide').evaluate(element=>getComputedStyle(element).backgroundColor),slideBackground);
  const image=await application.library.uploadAsset(fixture.id,{name:pixel.name,mime:pixel.mimeType,data:pixel.buffer.toString('base64')});
  designed=await application.library.get(fixture.id);const imageDesign=structuredClone(designed.design);imageDesign.background={type:'image',value:image.url};
  await application.library.updateDesign(fixture.id,{design:imageDesign,version:designed.version});
  await page.waitForFunction(()=>document.getElementById('slide-canvas')?.contentDocument.querySelector('.slide')?.style!==undefined);
  await page.locator('#export-button').click();
  const waitPDF=page.waitForEvent('download');await page.locator('[data-export="pdf"]').click();const pdf=await waitPDF;assert.equal((await PDFDocument.load(await readFile(await pdf.path()))).getPageCount(),2);
  const waitPPTX=page.waitForEvent('download');await page.locator('[data-export="pptx"]').click();const pptx=await waitPPTX,zip=await JSZip.loadAsync(await readFile(await pptx.path()));
  const nativeText=[...(await zip.file('ppt/slides/slide2.xml').async('string')).matchAll(/<a:t>(.*?)<\/a:t>/gs)].map(match=>match[1]).join(' ');assert.match(nativeText,/Пример\s+остаётся\s+HTML/);await page.locator('[data-close="export-dialog"]').click();
  await page.locator('#design-tab').click();await page.locator('[data-theme-id="warm"]').click();
  const current=await application.library.get(fixture.id);await application.library.updateDesign(fixture.id,{design:createPresentationDesign('dark'),version:current.version});
  await page.locator('#design-apply').click();await page.getByText(/Тему презентации изменили в другом окне/).waitFor();assert.equal((await application.library.get(fixture.id)).design.themeId,'dark');assert.equal(await page.locator('[data-theme-id="warm"]').getAttribute('aria-pressed'),'true');
  await page.reload();await page.locator('#canvas-loading').waitFor({state:'hidden'});await page.locator('#design-tab').click();await page.locator('[data-theme-id="original"]').click();await page.locator('#design-apply').click();await page.getByText('Тема сохранена в презентации.',{exact:true}).waitFor();assert.equal((await application.library.get(fixture.id)).design??null,null);
  await application.ai.saveSettings({provider:'openai',apiMode:'chat-completions',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',model:'browser-fixture',apiKey:'fixture-only'});
  await page.reload();await page.locator('#canvas-loading').waitFor({state:'hidden'});await page.locator('#chat-input').fill('Посмотри презентацию');await page.locator('#chat-send').click();
  await page.locator('.chat-message.assistant .message-content').filter({hasText:/Работает/}).waitFor();
  await page.locator('.chat-activity').waitFor();assert.equal(await page.locator('.chat-activity').getAttribute('open'),null);assert.equal(await page.getByText('Сейчас проверю устройство презентации.',{exact:true}).isVisible(),false);
  await page.getByText('Тема прочитана. Слайды сохранены.',{exact:true}).waitFor();await page.locator('#chat-stop').waitFor({state:'hidden'});
  assert.equal(await page.locator('.chat-message.assistant .message-content').textContent(),'Тема прочитана. Слайды сохранены.');
  await page.reload();await page.locator('#canvas-loading').waitFor({state:'hidden'});assert.equal(await page.locator('.chat-activity').getAttribute('open'),null);
  await page.locator('#design-tab').click();await page.locator('[data-theme-id="paper"]').click();await page.locator('#design-apply').click();await page.getByText('Тема сохранена в презентации.',{exact:true}).waitFor();await page.screenshot({path:path.join(screenshots,'presentation-design.png')});
  await page.locator('#blocks-tool').click();await page.locator('#blocks-dialog').waitFor({state:'visible'});await page.screenshot({path:path.join(screenshots,'presentation-blocks.png')});await page.locator('#blocks-dialog .dialog-heading button').click();
  await block('code-card',true);
  for(const themeId of ['light','dark']){
    await page.locator('#design-tab').click();await page.locator('[data-theme-id="'+themeId+'"]').click();await page.locator('#design-apply').click();await page.getByText('Тема сохранена в презентации.',{exact:true}).waitFor();
    const contrast=await canvas().locator('pre[data-preset-field="code"]').evaluate(element=>{
      const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(n=>Number(n)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
      const ink=luminance(getComputedStyle(element).color);let parent=element,bg;
      do{bg=getComputedStyle(parent).backgroundColor;parent=parent.parentElement;}while(bg==='rgba(0, 0, 0, 0)'&&parent);
      const surface=luminance(bg);return (Math.max(ink,surface)+.05)/(Math.min(ink,surface)+.05);
    });assert(contrast>=4.5,'Code must remain readable in '+themeId+' theme');
  }
  await page.setViewportSize({width:390,height:844});await page.locator('#properties-toggle').click();await page.locator('#design-tab').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(screenshots,'presentation-design-mobile.png')});
  assert.deepEqual(errors,[]);console.log('Presentation design UI passed: preset/group/text/media editing, new-slide insertion, themes/background/template protection, CAS conflict, editable exports, folded agent activity and responsive panels.');
}finally{await browser.close();await application.ai.close();await new Promise(resolve=>application.server.close(resolve));await new Promise(resolve=>provider.close(resolve));await rm(dataDir,{recursive:true,force:true});}
