import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddonRegistry } from '../shared/addons/registry.js';
import { builtinAddonDefinitions } from '../shared/addons/builtins.js';
import { mountEditorAddons } from '../frontend/addons/registry.js';

test('новое дополнение получает контекст движка и подключается только в заданный слот', () => {
  const engine = { getProject: () => ({ id: 'fixture' }) },
    calls = [];
  const definition = {
    id: 'example',
    title: 'Пример',
    targets: ['slide'],
    capabilities: ['insert'],
    mount: (context) => {
      calls.push(context);
      return { project: context.getProject() };
    },
  };
  const registry = createAddonRegistry([...builtinAddonDefinitions, definition]);
  assert.equal(registry.get('example').targets[0], 'slide');
  const mounted = mountEditorAddons(engine, { example: { panel: 'fixture-panel' } }, [definition]);
  assert.deepEqual(Object.keys(mounted), ['example']);
  assert.equal(calls[0].panel, 'fixture-panel');
  assert.deepEqual(mounted.example.project, { id: 'fixture' });
  assert.deepEqual(mountEditorAddons(engine, {}, [definition]), {});
  assert.equal(calls.length, 1);
});

test('реестр отказывает в дубликатах и неизвестных дополнениях', () => {
  assert.throws(() => createAddonRegistry([{ id: 'example' }, { id: 'example' }]), /Повторный id/);
  assert.throws(() => createAddonRegistry(builtinAddonDefinitions).get('unknown'), /не подключено/);
});
