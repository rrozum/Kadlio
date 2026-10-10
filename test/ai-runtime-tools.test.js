import test from 'node:test';import assert from 'node:assert/strict';import {createProjectTools,createThemeTools} from '../backend/modules/mcp/tools.js';

test('PPTX MCP import resolves exactly one owned source, forwards explicit mode/CAS and rejects invalid fields before reading files',async()=>{
  const calls=[],source={metadata:{id:'file',name:'reference.pptx'},buffer:Buffer.from('fixture')},library={materials:{read:async(...args)=>{calls.push(['material',...args]);return source;}},importPptxInto:async(...args)=>{calls.push(['import',...args]);return {id:'current',importReport:{slides:2}};}},attachments={read:async(...args)=>{calls.push(['attachment',...args]);return source;}};
  const tools=createProjectTools(library,{boundProjectId:'current',attachments});
  const result=await tools.execute('import_pptx',{attachmentId:'file',version:3,mode:'append',includeHidden:false});assert.equal(result.importReport.slides,2);assert.deepEqual(calls[0],['attachment','current','file']);assert.equal(calls[1][1],'current');assert.equal(calls[1][2].version,3);assert.equal(calls[1][2].mode,'append');assert.equal(calls[1][2].includeHidden,false);assert.strictEqual(calls[1][2].buffer,source.buffer);
  calls.length=0;await tools.execute('import_pptx',{materialId:'file',version:4,mode:'replace',includeHidden:true});assert.deepEqual(calls[0],['material','current','file']);assert.equal(calls[1][2].mode,'replace');
  for(const args of [{version:1},{version:1,attachmentId:'file',materialId:'file'},{version:1,attachmentId:'file',mode:'shell'},{version:1,attachmentId:'file',includeHidden:'yes'},{version:1,attachmentId:'file',projectId:'other'}]){calls.length=0;await assert.rejects(()=>tools.execute('import_pptx',args));assert.equal(calls.length,0);}
  await assert.rejects(()=>createThemeTools(library,{boundThemeId:'theme'}).execute('import_pptx',{attachmentId:'file',version:0}),/недоступен/);
});

test('video copy infers a bounded asset MIME from private file metadata while the library validates actual bytes and ownership',async()=>{
  const calls=[],source={metadata:{name:'recording.WEBM',kind:'binary',mime:'application/octet-stream'},buffer:Buffer.from('fixture')},library={uploadAsset:async(...args)=>{calls.push(args);return {url:'owned-video'};}},attachments={read:async(id,file)=>{assert.equal(id,'current');assert.equal(file,'clip');return source;}};
  const tools=createProjectTools(library,{boundProjectId:'current',attachments});assert.deepEqual(await tools.execute('use_attachment_video',{attachmentId:'clip'}),{url:'owned-video'});assert.equal(calls[0][1].mime,'video/webm');assert.equal(calls[0][1].data,source.buffer.toString('base64'));
  source.metadata.name='unknown.bin';await assert.rejects(()=>tools.execute('use_attachment_video',{attachmentId:'clip'}),/MP4 или WebM/);assert.equal(calls.length,1);
});
