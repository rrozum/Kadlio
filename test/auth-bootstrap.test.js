import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthStore } from '../backend/modules/auth/service.js';
import { createServer, projectRoot } from '../backend/http/server.js';

const password = 'ExampleOnly-BootstrapPassword-123456';
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('первый вход создаётся из конфигурации; перезапуск сохраняет пароль и сессию', async (t) => {
  const dataDir = await directory(t);
  const options = {
    dataDir,
    authRequired: true,
    publicOrigin: 'http://presentations.example.test',
    initialAdmin: { username: 'admin', password },
  };
  let app = await createServer(projectRoot, options);
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const login = (username, suppliedPassword) =>
    fetch(app.url + '/api/login', {
      method: 'POST',
      headers: { Origin: options.publicOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: suppliedPassword }),
    });
  const response = await login('admin', password);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  await new Promise((resolve) => app.server.close(resolve));
  app = await createServer(projectRoot, {
    ...options,
    initialAdmin: { username: 'another-admin', password: 'short' },
  });
  assert.equal(
    (await fetch(app.url + '/api/projects', { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal((await login('admin', password)).status, 200);
  assert.equal((await login('another-admin', 'short')).status, 401);
  assert(!(await readFile(path.join(dataDir, 'auth.sqlite'))).includes(Buffer.from(password)));
});

test('пустая установка требует оба поля и валидный пароль без раскрытия его в ошибке', async (t) => {
  const root = await directory(t);
  const auth = new AuthStore(path.join(root, 'auth.sqlite'));
  t.after(() => auth.close());
  assert.equal(await auth.bootstrapOwner(), false);
  await assert.rejects(
    auth.bootstrapOwner({ username: 'admin' }),
    /ADMIN_USERNAME и ADMIN_PASSWORD/,
  );
  await assert.rejects(auth.bootstrapOwner({ password }), /ADMIN_USERNAME и ADMIN_PASSWORD/);
  const invalid = 'SHORT-SECRET';
  await assert.rejects(auth.bootstrapOwner({ username: 'admin', password: invalid }), (error) => {
    assert(!error.message.includes(invalid));
    return /16–256/.test(error.message);
  });
  assert.equal(auth.repository.hasUsers(), false);
});

test('одновременная инициализация создаёт только одного владельца', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'auth.sqlite');
  const first = new AuthStore(file),
    second = new AuthStore(file);
  t.after(() => {
    first.close();
    second.close();
  });
  const results = await Promise.all([
    first.bootstrapOwner({ username: 'first', password }),
    second.bootstrapOwner({ username: 'second', password }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(
    Number(Boolean(first.repository.findUser('first'))) +
      Number(Boolean(first.repository.findUser('second'))),
    1,
  );
  assert.equal(await first.bootstrapOwner({ username: 'third', password }), false);
  assert.equal(first.repository.findUser('third'), undefined);
});
