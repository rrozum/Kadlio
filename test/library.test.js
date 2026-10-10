import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Library} from '../backend/application/engine.js';
import {sanitizeHTML} from '../backend/engine/html/sanitize.js';

test('HTML-first projects preserve notes, reject stale edits, reorder and revoke public links',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-library-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const library=await new Library(dir).init(),first=await library.create({title:'HTML studio'}),second=await library.create({title:'Second'});
  assert.equal((await library.list()).length,2);const slide=first.slides[0];
  const result=await library.updateSlide(first.id,slide.id,{version:0,body:'<h1 data-block-id="title">Edited</h1><script>bad()</script>',notes:'Speaker text',notesVersion:0});assert.equal(result.version,1);assert.equal(result.notesVersion,1);assert(!result.body.includes('script'));
  await assert.rejects(library.updateSlide(first.id,slide.id,{version:0,body:'old'}),error=>error.status===409);
  const extra=await library.addSlide(first.id,{title:'Details',body:'<p>Body</p>'});await library.reorder(first.id,[extra.id,slide.id]);assert.equal((await library.get(first.id)).slides[0].id,extra.id);
  await assert.rejects(library.reorder(first.id,[slide.id,slide.id]),error=>error.status===400);
  const store=await library.getStore(first.id);await store.saveAnnotation({id:'comment',slideId:slide.id,x:.5,y:.6,comment:'Review'});await store.saveAnnotation({id:'comment',slideId:slide.id,x:.5,y:.6,comment:'Review',resolved:true});
  assert.equal((await library.get(first.id)).annotations[0].resolved,true);
  const token=await library.share(first.id);assert.equal((await library.findShare(token)).id,first.id);await library.share(first.id,false);await assert.rejects(library.findShare(token),e=>e.status===404);
  const restarted=await new Library(dir).init();assert.equal((await restarted.get(first.id)).slides[1].notes,'Speaker text');assert.equal((await restarted.get(second.id)).slides[0].title,'Second');
  assert.equal(JSON.parse(await readFile(path.join(library.directory(first.id),'presentation.json'))).slides.length,2);
});
test('slide markup cannot inject scripts, event handlers or remote URLs',()=>{
  const html=sanitizeHTML('<h1 onclick="bad()">Text</h1><iframe src="/login"></iframe><img src="https://elsewhere.test/x" onerror="bad()"><svg><a xlink:href="javascript:bad()">X</a></svg>');
  assert(!html.includes('onclick'));assert(!html.includes('iframe'));assert(!html.includes('elsewhere'));assert(!html.includes('javascript'));
});
