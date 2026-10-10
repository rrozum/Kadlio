import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEffects,pptxTransitionXML} from '../shared/addons/motion/runtime.js';

test('motion presets reject code and preserve a bounded simple configuration',()=>{
  assert.equal(normalizeEffects(null),null);
  assert.deepEqual(normalizeEffects({preset:'stagger',duration:650}),{preset:'stagger',duration:650});
  for(const invalid of [{preset:'script',duration:650},{preset:'fade',duration:1},{preset:'zoom',duration:650,script:'bad'},{preset:'slide',duration:'650'}])assert.throws(()=>normalizeEffects(invalid));
});
test('PowerPoint receives safe standard transition approximations and no transition for old slides',()=>{
  assert.equal(pptxTransitionXML(undefined),'');
  assert.equal(pptxTransitionXML({preset:'none',duration:650}),'');
  assert.match(pptxTransitionXML({preset:'slide',duration:400}),/<p:push dir="l"/);
  assert.match(pptxTransitionXML({preset:'zoom',duration:1100}),/spd="slow".*<p:zoom dir="in"/);
  assert.match(pptxTransitionXML({preset:'stagger',duration:650}),/<p:fade/);
});
