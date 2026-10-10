import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectTools} from '../backend/modules/mcp/tools.js';

test('MCP preset catalog is real and project-bound insertion/design mutations preserve versions',async()=>{
  const calls=[],library={async insertPreset(...args){calls.push(args);return {id:'slide-01',version:4};},async updateDesign(...args){calls.push(args);return {id:'demo',version:8};}};
  const tools=createProjectTools(library),catalog=await tools.execute('list_presets');
  assert.ok(catalog.blocks.some(block=>block.id==='quote'));
  assert.ok(catalog.themes.some(theme=>theme.id==='dark'));
  const inserted=await tools.execute('insert_preset',{slideId:'slide-01',presetId:'quote',values:{quote:'A quote',author:'Author'},version:3},{projectId:'demo'});
  assert.equal(inserted.version,4);
  await tools.execute('update_design',{design:{themeId:'dark'},version:7},{projectId:'demo'});
  await tools.execute('update_design',{design:null,version:8},{projectId:'demo'});
  assert.deepEqual(calls,[['demo','slide-01',{presetId:'quote',values:{quote:'A quote',author:'Author'},version:3}],['demo',{design:{themeId:'dark'},version:7}],['demo',{design:null,version:8}]]);
  await assert.rejects(()=>tools.execute('insert_preset',{slideId:'slide-01',presetId:'quote',values:[],version:4},{projectId:'demo'}),/values/);
  await assert.rejects(()=>tools.execute('update_design',{design:[],version:8},{projectId:'demo'}),/design/);
  await assert.rejects(()=>tools.execute('update_design',{projectId:'other',design:null,version:8},{projectId:'demo'}),/ограничен/);
  assert.equal(calls.length,3);
});
