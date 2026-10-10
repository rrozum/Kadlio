import path from 'node:path';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { readJSON, writeJSONAtomic, writeAtomic } from '../connectors/json-files.js';

export class ThemeRepository {
  constructor(root) {
    this.root = root;
    this.queues = new Map();
  }
  directory(id) {
    return path.join(this.root, id);
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  ids() {
    return readdir(this.root);
  }
  read(id) {
    return readJSON(path.join(this.directory(id), 'theme.json'));
  }
  write(id, record) {
    return writeJSONAtomic(path.join(this.directory(id), 'theme.json'), record);
  }
  async ensureDirectory(id, { assets = false } = {}) {
    await mkdir(path.join(this.directory(id), assets ? 'assets' : ''), {
      recursive: true,
      mode: 0o700,
    });
  }
  remove(id) {
    return rm(this.directory(id), { recursive: true, force: true });
  }
  readAsset(id, name) {
    return readFile(path.join(this.directory(id), 'assets', name));
  }
  writeAsset(id, name, data) {
    return writeAtomic(path.join(this.directory(id), 'assets', name), data, { mode: 0o600 });
  }
  queue(id, action) {
    const task = (this.queues.get(id) || Promise.resolve()).then(action, action);
    this.queues.set(
      id,
      task.catch(() => {}),
    );
    return task;
  }
}
