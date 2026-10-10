import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { inlineModule } from '../backend/modules/exports/player-bundle.js';

test('автономный плеер сохраняет строки и комментарии после форматирования ES-модулей', async () => {
  const source = `import {
    normalizeEffects,
  } from './motion.js';
  // export и import здесь — обычный текст.
  export const label = 'export const source = 1;';
  export function example() { return label; }
  `;
  const result = await inlineModule(source);
  assert.match(result, /export const source = 1;/);
  assert.match(result, /export и import здесь/);
  const context = {};
  new Script(result + '; globalThis.actual = example();').runInNewContext(context);
  assert.equal(context.actual, 'export const source = 1;');
});
