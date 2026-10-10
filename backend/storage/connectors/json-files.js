import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function readJSON(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

// Сначала записываем соседний файл, затем атомарно заменяем основной.
// Ошибка callback/записи не должна публиковать частично изменённый документ.
export async function writeAtomic(file, content, options) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, options);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function writeJSONAtomic(file, value, options = { mode: 0o600 }) {
  return writeAtomic(file, JSON.stringify(value, null, 2) + '\n', options);
}
