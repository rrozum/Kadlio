import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,utimes} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from '../backend/http/server.js';
import {AuthStore} from '../backend/modules/auth/service.js';

test('static files revalidate without stale code or caching authenticated presentation data',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'presentations-http-cache-')),dataDir=path.join(root,'data');
  await mkdir(path.join(root,'frontend/vendor/prismjs-1.30.0'),{recursive:true});
  const file=path.join(root,'frontend/check.js');await writeFile(file,'window.fixture=1;');await writeFile(path.join(root,'frontend/vendor/prismjs-1.30.0/core.js'),'window.pinned=true;');await writeFile(path.join(root,'frontend/login.css'),'body{color:black}');
  const authFile=path.join(dataDir,'auth.sqlite'),auth=new AuthStore(authFile,{secure:false});await auth.setUser('fixture','ExampleOnly-TestPassword-123456');const token=await auth.login('fixture','ExampleOnly-TestPassword-123456','fixture');auth.close();
  const app=await createServer(root,{dataDir,authFile,authRequired:true,publicOrigin:'http://127.0.0.1'}),headers={Cookie:'rozum-session='+token};
  try{
    const first=await fetch(app.url+'/check.js',{headers});assert.equal(first.status,200);assert.equal(await first.text(),'window.fixture=1;');assert.equal(first.headers.get('cache-control'),'private, no-cache');const etag=first.headers.get('etag');assert(etag);
    const cached=await fetch(app.url+'/check.js',{headers:{...headers,'If-None-Match':etag}});assert.equal(cached.status,304);assert.equal(await cached.text(),'');
    const head=await fetch(app.url+'/check.js',{method:'HEAD',headers});assert.equal(head.headers.get('etag'),etag);assert.equal(await head.text(),'');
    await writeFile(file,'window.fixture=2;');await utimes(file,new Date(),new Date(Date.now()+2000));const changed=await fetch(app.url+'/check.js',{headers:{...headers,'If-None-Match':etag}});assert.equal(changed.status,200);assert.equal(await changed.text(),'window.fixture=2;');assert.notEqual(changed.headers.get('etag'),etag);
    const vendor=await fetch(app.url+'/vendor/prismjs-1.30.0/core.js',{headers});assert.match(vendor.headers.get('cache-control'),/immutable/);
    const privateAPI=await fetch(app.url+'/api/projects',{headers:{...headers,'If-None-Match':etag}});assert.equal(privateAPI.status,200);assert.equal(privateAPI.headers.get('cache-control'),'no-store');assert.equal(privateAPI.headers.get('etag'),null);
    assert.equal((await fetch(app.url+'/check.js',{redirect:'manual',headers:{'If-None-Match':etag}})).status,303);assert.equal((await fetch(app.url+'/api/projects')).status,401);
    assert.equal((await fetch(app.url+'/login.css')).headers.get('cache-control'),'private, no-cache');
  }finally{await new Promise(resolve=>app.server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
