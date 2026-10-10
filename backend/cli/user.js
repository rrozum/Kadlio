import path from 'node:path';
import { AuthStore } from '../modules/auth/service.js';
import { projectRoot } from '../http/server.js';
const username = process.argv[2];
if (!username) {
  console.error('Передайте логин: npm run user -- owner. Пароль читается из stdin.');
  process.exit(1);
}
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 512) throw new Error('Слишком длинный пароль');
}
const auth = new AuthStore(
  process.env.AUTH_DB ||
    path.join(process.env.PROJECTS_DATA_DIR || path.join(projectRoot, 'data'), 'auth.sqlite'),
);
try {
  await auth.setUser(username, input.replace(/\r?\n$/, ''));
  console.log(`Пользователь ${username} создан; прежние сессии отозваны.`);
} finally {
  auth.close();
}
