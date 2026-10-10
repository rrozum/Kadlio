import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseHTML} from 'linkedom';
import {Library} from '../backend/application/engine.js';
import {insertPresentationIcon} from '../backend/modules/addons/icons.js';
import {presentationIcons,searchPresentationIcons,renderPresentationIcon} from '../shared/addons/icons/catalog.js';

test('native icon catalogue searches Russian/English and emits bounded executable-free SVG',()=>{
  assert(presentationIcons.length>1800);assert(searchPresentationIcons('сердце').some(item=>item.id==='heart'));assert(searchPresentationIcons('database').some(item=>item.id==='database'));assert.equal(searchPresentationIcons('missing fixture icon').length,0);assert.notEqual(searchPresentationIcons('',{limit:1,offset:0})[0].id,searchPresentationIcons('',{limit:1,offset:1})[0].id);
  const {document}=parseHTML('<html><body>'+renderPresentationIcon('heart',{blockId:'icon"quoted',color:'#aabbcc',x:125,y:200,width:180,height:120})+'</body></html>'),svg=document.querySelector('svg');assert.equal(svg.dataset.blockId,'icon"quoted');assert.equal(svg.dataset.blockType,'icon');assert.equal(svg.getAttribute('stroke'),'currentColor');assert.equal(svg.querySelectorAll('script,image,foreignObject').length,0);assert.equal(svg.style.color,'#aabbcc');assert(svg.querySelector('path'));assert.throws(()=>renderPresentationIcon('unknown'));assert.throws(()=>renderPresentationIcon('heart',{color:'red; background:url(https://example.test)'}));
});

test('icon insertion preserves content, uses CAS, rejects unsafe options and recovers after conflicts',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'presentation-icons-'));t.after(()=>rm(directory,{recursive:true,force:true}));const library=await new Library(directory).init(),project=await library.create({title:'Icons fixture'}),slide=project.slides[0],before=slide.body;
  await assert.rejects(()=>insertPresentationIcon(library,project.id,slide.id,{iconId:'heart',values:{script:'alert(1)'},version:0}),cause=>cause.status===400);await assert.rejects(()=>insertPresentationIcon(library,project.id,slide.id,{iconId:'heart',values:{x:'20'},version:0}),cause=>cause.status===400);await assert.rejects(()=>insertPresentationIcon(library,project.id,slide.id,{iconId:'heart',values:{color:'url(https://example.test)'},version:0}),cause=>cause.status===400);
  const saved=await insertPresentationIcon(library,project.id,slide.id,{iconId:'heart',values:{color:'#123456',x:270,y:150},version:0});assert(saved.body.startsWith(before));const {document}=parseHTML('<html><body>'+saved.body+'</body></html>');assert.equal(document.querySelector('svg').dataset.iconId,'heart');assert.equal(document.querySelector('svg').style.color,'#123456');
  await assert.rejects(()=>insertPresentationIcon(library,project.id,slide.id,{iconId:'star',version:0}),cause=>cause.status===409);assert.equal((await library.get(project.id)).slides[0].body,saved.body);
  const next=await insertPresentationIcon(library,project.id,slide.id,{iconId:'star',version:saved.version});assert(next.body.includes('data-icon-id="star"'));assert.equal(new Set([...parseHTML('<html><body>'+next.body+'</body></html>').document.querySelectorAll('svg')].map(element=>element.dataset.blockId)).size,2);
});
