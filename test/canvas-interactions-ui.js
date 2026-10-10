import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer,projectRoot} from '../backend/http/server.js';
import {renderDesignElement} from '../shared/addons/design-elements/catalog.js';

const directory=await mkdtemp(path.join(os.tmpdir(),'presentation-pointer-'));
const app=await createServer(projectRoot,{authRequired:false,dataDir:directory});
const project=await app.library.create({title:'Canvas interaction fixture',themeId:'light'});
const drawing=renderDesignElement('underline',{blockId:'new-drawing',values:{color:'#9966dd'}});
const detached=renderDesignElement('underline',{blockId:'legacy-drawing',values:{color:'#9966dd'}})
  .replace('left:96px;top:180px','left:740px;top:350px')
  .replace('inset:0;display:block','inset:0;left:-70px;top:-65px;width:400px;height:42px;display:block');
const body='<div id="behind-legacy" style="position:absolute;left:740px;top:350px;width:400px;height:42px;background:#99bbdd"></div>'+drawing+detached+
  '<div id="ordinary" style="position:absolute;left:540px;top:90px;width:140px;height:95px;background:#337799"></div>'+
  '<div id="locked" data-locked="true" style="position:absolute;left:90px;top:65px;width:250px;height:55px;background:#ddeeff">Locked block</div>'+
  '<p id="editable" style="position:absolute;left:110px;top:470px;width:420px;height:60px;margin:0;font:30px Arial">Editable text</p>'+
  '<img id="picture" alt="Drag image" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" style="position:absolute;left:600px;top:450px;width:140px;height:100px">';
await app.library.updateSlide(project.id,'slide-01',{version:0,body});
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1660,height:1020}}),errors=[];
page.setDefaultTimeout(15000);
page.on('pageerror',error=>errors.push(error.message));
const frame=()=>page.frameLocator('#slide-canvas');
const source=async()=>(await app.library.get(project.id)).slides[0];
const saved=()=>page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Сохранено',null,{timeout:15000});
async function drag(locator,dx,dy,position={x:.5,y:.5}){
  const box=await locator.boundingBox();
  const x=box.x+box.width*position.x,y=box.y+box.height*position.y;
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x+dx,y+dy,{steps:8});await page.mouse.up();
}
function moved(before,after,dx,dy){assert(Math.abs(after.x-before.x-dx)<2);assert(Math.abs(after.y-before.y-dy)<2);}
try{
  await page.goto(app.url+'/projects/'+project.id);
  await frame().locator('[data-block-id="new-drawing"] svg').waitFor();
  await page.locator('#canvas-loading').waitFor({state:'hidden'});
  const initial=await source();
  // The painted SVG and the empty part of its catalog wrapper are one target.
  const drawingNode=frame().locator('[data-block-id="new-drawing"]');
  await drawingNode.locator('path').first().click();
  assert.equal(await page.locator('#block-type').textContent(),'Элемент');
  const selected=await page.locator('#selection-layer').boundingBox();
  const drawingBounds=await drawingNode.boundingBox();
  await page.mouse.click(drawingBounds.x+drawingBounds.width*.05,drawingBounds.y+drawingBounds.height*.92);
  assert.equal(await page.locator('#block-type').textContent(),'Элемент');
  const selectedAgain=await page.locator('#selection-layer').boundingBox();
  moved(selected,selectedAgain,0,0);
  assert.deepEqual(await source(),initial,'Click-only selection must not save attributes or versions');
  const before=await drawingNode.boundingBox();
  await drag(drawingNode,42,25,{x:.4,y:.9});await saved();
  moved(before,await drawingNode.boundingBox(),42,25);
  assert.equal(await drawingNode.locator('svg').getAttribute('data-block-id'),null);
  assert.equal(await drawingNode.locator('svg').evaluate(node=>node.style.left),'0px');
  // Explicit deep selection remains available.
  await drawingNode.locator('path').first().click({modifiers:['Alt']});
  assert.equal(await page.locator('#block-type').textContent(),'Иконка');
  // Previously detached SVGs keep saved IDs/styles, but their old empty shell
  // no longer intercepts a real block underneath it.
  const old=frame().locator('[data-block-id="legacy-drawing"]'),svg=old.locator('svg');
  await svg.locator('path').first().click();
  assert.equal(await page.locator('#block-type').textContent(),'Иконка');
  const oldBox=await old.boundingBox();
  await page.mouse.click(oldBox.x+oldBox.width*.7,oldBox.y+oldBox.height*.5);
  assert.equal(await page.locator('#block-type').textContent(),'Фигура');
  assert.equal(await page.locator('#prop-background').inputValue(),'#99bbdd');
  const artBefore=await svg.boundingBox();
  await drag(svg.locator('path').first(),28,18);await saved();
  moved(artBefore,await svg.boundingBox(),28,18);
  assert.equal(await old.evaluate(node=>node.style.left),'740px');
  // Body-drag also works for ordinary unmarked HTML and native images.
  for(const id of ['ordinary','picture']){
    const node=frame().locator('#'+id),before=await node.boundingBox();
    await drag(node,24,15);await saved();moved(before,await node.boundingBox(),24,15);
    assert(await node.getAttribute('data-block-id'));
  }
  // Tiny pointer motion is a click, not a saved move.
  const clickVersion=(await source()).version;
  await drag(frame().locator('#ordinary'),1,1);
  assert.equal((await source()).version,clickVersion);
  const locked=frame().locator('#locked'),lockedBefore=await locked.boundingBox(),lockedSource=await source();
  await drag(locked,35,20);moved(lockedBefore,await locked.boundingBox(),0,0);
  assert.deepEqual(await source(),lockedSource);
  // A double click edits text; pointer text selection does not move the block.
  const text=frame().locator('#editable');await text.dblclick();
  assert.equal(await text.getAttribute('contenteditable'),'true');
  const textBefore=await text.boundingBox();
  await text.evaluate(node=>{for(const [type,clientX] of [['pointerdown',120],['pointermove',155],['pointerup',155]])node.dispatchEvent(new PointerEvent(type,{bubbles:true,isPrimary:true,pointerId:1,button:type==='pointermove'?-1:0,clientX,clientY:490,view:window}));});
  moved(textBefore,await text.boundingBox(),0,0);
  await text.fill('Edited in place');await page.keyboard.press('Escape');await saved();
  assert((await source()).body.includes('Edited in place'));
  // Cross-document pointer motion uses the same slide coordinate system.
  const node=frame().locator('#ordinary'),bounds=await node.boundingBox();
  const x=bounds.x+20,y=bounds.y+20;await page.mouse.move(x,y);await page.mouse.down();
  await page.evaluate(({x,y})=>window.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:x+30,clientY:y+20,view:window})),{x,y});
  await page.mouse.up();await saved();moved(bounds,await node.boundingBox(),30,20);
  // Reload confirms the actual HTML survived, including the legacy nested SVG.
  const stored=await source();await page.reload();await frame().locator('#ordinary').waitFor();
  assert.deepEqual(await source(),stored);
  assert.equal(await frame().locator('[data-block-id="new-drawing"] svg').getAttribute('data-block-id'),null);
  await mkdir(path.join(projectRoot,'test-results'),{recursive:true});
  await page.screenshot({path:path.join(projectRoot,'test-results','canvas-interactions.png')});
  assert.deepEqual(errors,[]);
  console.log('Canvas interactions passed: one catalog selection, legacy ghost pass-through, body drag, click threshold, locks, text editing, native image drag, cross-document coordinates and persisted HTML.');
}catch(error){
  console.error('Canvas regression failed:',error.message);
  console.error('Page errors:',errors);
  await mkdir(path.join(projectRoot,'test-results'),{recursive:true});
  await page.screenshot({path:path.join(projectRoot,'test-results','canvas-interactions-failed.png')}).catch(()=>{});
  throw error;
}finally{
  await browser.close();await app.ai.close();
  await new Promise(resolve=>app.server.close(resolve));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
