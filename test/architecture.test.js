import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import babel from '../shared/vendor/prettier-3.9.9/babel.js';

const root = fileURLToPath(new URL('..', import.meta.url));
async function files(directory) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (['vendor', 'assets', 'fonts'].includes(entry.name)) continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(relative)));
    else if (entry.name.endsWith('.js')) result.push(relative);
  }
  return result;
}
function dependencies(ast) {
  const references = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      node.source
    )
      references.push(node.source.value);
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Import' &&
      node.arguments[0]?.type === 'StringLiteral'
    )
      references.push(node.arguments[0].value);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'leadingComments', 'trailingComments'].includes(key))
        continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast.program);
  return references.filter((value) => value.startsWith('.'));
}

test('границы слоёв и граф импортов сохраняются при развитии модулей', async () => {
  const sourceFiles = [
    ...(await files('backend')),
    ...(await files('frontend')),
    ...(await files('shared')),
  ];
  const graph = new Map();
  for (const relative of sourceFiles) {
    const file = path.join(root, relative),
      source = await readFile(file, 'utf8');
    const ast = await babel.parsers.babel.parse(source, {}),
      targets = [];
    for (const reference of dependencies(ast)) {
      const target = path.resolve(path.dirname(file), reference);
      await readFile(target);
      const destination = path.relative(root, target);
      if (relative.startsWith('backend/'))
        assert(
          !destination.startsWith('frontend/'),
          `${relative} импортирует интерфейс ${destination}`,
        );
      if (relative.startsWith('frontend/'))
        assert(
          !destination.startsWith('backend/'),
          `${relative} импортирует сервер ${destination}`,
        );
      if (relative.startsWith('backend/engine/'))
        assert(
          !/^backend\/(http|modules|application)\//.test(destination),
          `Движок зависит от внешнего модуля ${destination}`,
        );
      if (relative.startsWith('shared/'))
        assert(destination.startsWith('shared/'), `Общий код зависит от ${destination}`);
      targets.push(destination);
    }
    graph.set(relative, targets);
  }
  const visiting = new Set(),
    visited = new Set();
  function walk(file) {
    if (visited.has(file)) return;
    assert(!visiting.has(file), `Циклическая зависимость: ${file}`);
    visiting.add(file);
    for (const target of graph.get(file) || []) walk(target);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) walk(file);
});
