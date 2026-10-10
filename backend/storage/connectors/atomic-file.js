import { writeAtomic } from './json-files.js';
export const atomicFile = (file, content) => writeAtomic(file, content, { mode: 0o600 });
