import { readFile } from 'node:fs/promises';
import path from 'node:path';
import babel from '../../../shared/vendor/prettier-3.9.9/babel.js';

// В HTML-экспорт входят три собственных модуля просмотрщика. Убираем только
// служебный синтаксис ES-модуля по диапазонам AST: форматирование импортов
// и слово export внутри комментария/строки не должны менять готовый плеер.
export async function inlineModule(source) {
  const ast = await babel.parsers.babel.parse(source, {});
  const edits = [];
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') edits.push([node.start, node.end]);
    else if (node.type === 'ExportNamedDeclaration' && node.declaration)
      edits.push([node.start, node.declaration.start]);
    else if (node.type.startsWith('Export'))
      throw new Error('Неподдерживаемый экспорт модуля автономного плеера.');
  }
  for (const [start, end] of edits.reverse()) source = source.slice(0, start) + source.slice(end);
  return source;
}

export async function readPlayerModule(root, relative) {
  return inlineModule(await readFile(path.join(root, relative), 'utf8'));
}
