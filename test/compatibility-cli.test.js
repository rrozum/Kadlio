import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);

async function failedCLI(file, args = [], overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.PRESENTATIONS_MCP_TOKEN;
  try {
    await execute(process.execPath, [path.join(root, file), ...args], {
      cwd: root,
      env,
      timeout: 10000,
    });
    assert.fail('CLI должен завершиться с прежней ошибкой валидации.');
  } catch (error) {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    return error.stderr;
  }
}

test('старый и новый stdio MCP entrypoint требуют token и возвращают одинаковую ошибку', async () => {
  const options = { PRESENTATIONS_MCP_URL: 'http://127.0.0.1:3210/api/agent-tools' };
  const current = await failedCLI('backend/modules/mcp/server.js', ['--project', 'demo'], options);
  const compatible = await failedCLI('src/mcp/server.js', ['--project', 'demo'], options);
  assert.equal(current, 'Задайте PRESENTATIONS_MCP_TOKEN.\n');
  assert.equal(compatible, current);
});

test('старый и новый user CLI по-прежнему валидируют логин до открытия базы', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'presentation-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { AUTH_DB: path.join(directory, 'auth.sqlite'), PROJECTS_DATA_DIR: directory };
  for (const file of ['backend/cli/user.js', 'src/user-cli.js']) {
    const error = await failedCLI(file, [], options);
    assert.match(error, /Передайте логин: npm run user -- owner\. Пароль читается из stdin\./);
  }
});

test('старый и новый server CLI запускают приложение и сохраняют startup exit code', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'presentation-server-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    PORT: '-1',
    PUBLIC_ORIGIN: 'https://presentations.example',
    AUTH_DB: path.join(directory, 'auth.sqlite'),
    PROJECTS_DATA_DIR: directory,
  };
  for (const file of ['backend/main.js', 'src/server.js']) {
    const error = await failedCLI(file, [], options);
    assert.match(error, /(?:port|Port).*65536/);
  }
});
