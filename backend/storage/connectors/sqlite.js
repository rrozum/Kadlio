import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

export function openSQLite(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  chmodSync(file, 0o600);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  return database;
}
