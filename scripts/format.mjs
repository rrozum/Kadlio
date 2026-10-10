import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from '../shared/vendor/prettier-3.9.9/standalone.js';
import babel from '../shared/vendor/prettier-3.9.9/babel.js';
import estree from '../shared/vendor/prettier-3.9.9/estree.js';
import postcss from '../shared/vendor/prettier-3.9.9/postcss.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const inputs = process.argv.slice(2).filter((arg) => arg !== '--check');
let changed = 0;

async function visit(relative) {
  const file = path.resolve(root, relative);
  if (
    relative
      .split(path.sep)
      .some((part) =>
        ['vendor', 'node_modules', '.git', 'assets', 'fonts', 'test-results'].includes(part),
      )
  )
    return;
  const entries = await readdir(file, { withFileTypes: true }).catch((error) => {
    if (error.code !== 'ENOTDIR') throw error;
    return null;
  });
  if (entries) {
    for (const entry of entries) await visit(path.join(relative, entry.name));
    return;
  }
  const ext = path.extname(file);
  if (!['.js', '.mjs', '.css'].includes(ext)) return;
  const source = await readFile(file, 'utf8');
  const formatted = await prettier.format(source, {
    parser: ext === '.css' ? 'css' : 'babel',
    plugins: [babel, estree, postcss],
    singleQuote: true,
    printWidth: 100,
    tabWidth: 2,
  });
  if (source === formatted) return;
  changed++;
  if (check) console.log(relative);
  else await writeFile(file, formatted);
}

for (const input of inputs.length ? inputs : ['backend', 'frontend', 'shared', 'scripts'])
  await visit(input);
console.log(check ? `Файлов без форматирования: ${changed}` : `Отформатировано файлов: ${changed}`);
if (check && changed) process.exitCode = 1;
