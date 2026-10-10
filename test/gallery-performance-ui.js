import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from '../backend/http/server.js';

const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=await mkdtemp(path.join(os.tmpdir(),'presentations-gallery-perf-'));
const app=await createServer(root,{dataDir,authRequired:false});
for(let i=0;i<16;i++)await app.library.create({title:'Gallery fixture '+i});
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(app.url+'/projects');await page.locator('.project-card').nth(15).waitFor({state:'attached'});await page.locator('.project-cover iframe').first().waitFor({state:'attached'});
  assert.equal(await page.locator('.projects-loading').count(),0,'Project loading placeholder is removed after data arrives');
  const mounted=await page.locator('.project-cover iframe').count();assert(mounted<16,'Offscreen covers must not eagerly create every browsing context');
  await page.evaluate(()=>window.firstCover=document.querySelector('.project-cover iframe'));
  const firstTitle=await page.locator('.project-card h2').first().textContent();await page.locator('#project-search').fill(firstTitle);await page.locator('#project-search').fill('No such fixture');await page.locator('.search-empty').waitFor({state:'visible'});await page.locator('#project-search').fill('');assert.equal(await page.evaluate(()=>firstCover===document.querySelector('.project-cover iframe')&&firstCover.isConnected),true,'Search keeps existing preview frames');
  await page.locator('.project-card').last().scrollIntoViewIfNeeded();await page.locator('.project-card').last().locator('iframe').waitFor({state:'attached'});
  await page.goto(app.url+'/themes');await page.locator('.theme-card').first().waitFor();await page.evaluate(()=>window.firstTheme=document.querySelector('.theme-card iframe'));await page.locator('#theme-search').fill('not-found');await page.locator('#theme-search').fill('');assert.equal(await page.evaluate(()=>firstTheme===document.querySelector('.theme-card iframe')&&firstTheme.isConnected),true);
  assert.equal(await page.locator('.projects-loading').count(),0,'Theme loading placeholder is removed after data arrives');
  assert.deepEqual(errors,[]);console.log('Gallery UI passed: offscreen project previews lazy; project/theme search preserves preview DOM and empty/search results.');
}finally{await browser.close();await new Promise(resolve=>app.server.close(resolve));await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
