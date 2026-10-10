import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from '../backend/http/server.js';
import {AuthStore} from '../backend/modules/auth/service.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const dataDir=await mkdtemp(path.join(os.tmpdir(),'presentations-theme-loading-'));
const authFile=path.join(dataDir,'auth.sqlite');
const accounts=new AuthStore(authFile,{secure:false});
await accounts.setUser('fixture','ExampleOnly-TestPassword-123456');
const token=await accounts.login('fixture','ExampleOnly-TestPassword-123456','fixture');
accounts.close();
const app=await createServer(root,{dataDir,authFile,authRequired:true,publicOrigin:'http://127.0.0.1'});
const project=await app.library.create({title:'Theme loading fixture'});
const browser=await chromium.launch({headless:true,...(process.env.PRESENTATION_BROWSER_PATH?{executablePath:process.env.PRESENTATION_BROWSER_PATH}:{})});
try{
  for(const theme of ['light','dark']){
    for(const [route,authenticated] of [['/projects',true],['/projects/new',true],['/themes',true],['/themes/paper',true],['/projects/'+project.id,true],['/projects/'+project.id+'/view',true],['/login',false]]){
      const context=await browser.newContext();
      if(authenticated)await context.addCookies([{name:'rozum-session',value:token,url:app.url,httpOnly:true,sameSite:'Lax'}]);
      await context.addInitScript(value=>{if(window===window.top)localStorage.setItem('presentations.theme',value);},theme);
      // Hold application scripts until after the visible page has been checked.
      // A late theme.js initializer cannot make this regression test pass.
      let release;
      const gate=new Promise(resolve=>release=resolve);
      await context.route('**/*.js',async intercepted=>{
        if(!new URL(intercepted.request().url()).pathname.endsWith('/theme-init.js'))await gate;
        await intercepted.continue().catch(()=>{});
      });
      const page=await context.newPage();
      try{
        await page.goto(app.url+route,{waitUntil:'commit'});
        await page.locator('body').waitFor({state:'visible'});
        const early=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve({theme:document.documentElement.dataset.uiTheme,scheme:document.documentElement.style.colorScheme,background:getComputedStyle(document.body).backgroundColor}))));
        assert.equal(early.theme,theme,route+' before application initialization');
        assert.equal(early.scheme,theme,route+' native controls');
        const rgb=early.background.match(/\d+/g)?.slice(0,3).map(Number);
        assert(rgb&&rgb.every(channel=>theme==='light'?channel>200:channel<50),route+' first visible background: '+early.background);
        release();
        await page.waitForLoadState('domcontentloaded');
        await page.locator('[data-theme-toggle]').first().waitFor();
        assert.equal(await page.locator('html').getAttribute('data-ui-theme'),theme);
        await page.locator('[data-theme-toggle]').first().click();
        await page.waitForFunction(value=>document.documentElement.style.colorScheme===value,theme==='light'?'dark':'light');
        assert.equal(await page.evaluate(()=>document.documentElement.style.colorScheme),theme==='light'?'dark':'light');
      }finally{release();await context.close();}
    }
  }
  console.log('Theme loading UI passed: light/dark before application scripts on all seven pages, unauthenticated login and toggled native controls.');
}finally{
  await browser.close();
  await new Promise(resolve=>app.server.close(resolve));
  await rm(dataDir,{recursive:true,force:true});
}
