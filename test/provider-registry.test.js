import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AIService } from '../backend/modules/ai/service.js';
import {
  ProviderRegistry,
  createProviderRegistry,
} from '../backend/modules/ai/providers/registry.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const adapter = (id) => ({ id, validate() {}, preflight() {}, async run() {} });

async function serviceFixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'presentation-provider-'));
  const library = {
    async get(id) {
      assert.equal(id, 'demo');
      return { id, title: 'Registry fixture', slides: [], annotations: [] };
    },
  };
  const service = new AIService({ dataDir, library, root });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await service.ready;
  return service;
}

test('реестр содержит существующие провайдеры и отклоняет неизвестные или повторные адаптеры', () => {
  const registry = createProviderRegistry({ acp: {} });
  assert.equal(registry.has('openai'), true);
  assert.equal(registry.has('acp'), true);
  assert.equal(registry.has('uploaded-command'), false);
  assert.throws(
    () => registry.get('uploaded-command'),
    (error) => error.status === 400,
  );
  assert.throws(() => registry.register(adapter('openai')), /уже зарегистрирован/);
  assert.throws(() => new ProviderRegistry([{ id: 'broken', run() {} }]), /Неверный адаптер/);
});

test('AIService проводит новый зарегистрированный адаптер через общие контекст, события и историю', async (t) => {
  const service = await serviceFixture(t);
  const calls = [],
    events = [];
  service.providers.register({
    id: 'fixture-api',
    validate(settings) {
      calls.push('validate');
      assert.equal(settings.model, 'fixture-model');
    },
    preflight(settings) {
      calls.push('preflight');
      assert.equal(settings.provider, 'fixture-api');
    },
    async run(turn) {
      calls.push('run');
      assert.equal(turn.key, 'demo');
      assert.equal(turn.scope, 'project');
      assert.equal(turn.selected.content, 'Проверь содержимое.');
      assert.deepEqual(
        (await turn.tools.execute('read_project', {}, { projectId: turn.id })).slides,
        [],
      );
      assert.equal(turn.signal.aborted, false);
      turn.onEvent({ type: 'activity', text: 'Проверяю.' });
      turn.onEvent({ type: 'text', text: 'Проверено.' });
    },
  });
  await assert.rejects(
    () => service.saveSettings({ provider: 'not-registered' }),
    /Неверный провайдер/,
  );
  await service.saveSettings({ provider: 'fixture-api', model: 'fixture-model' });
  await service.preflightProvider();
  const answer = await service.send({
    projectId: 'demo',
    message: 'Проверь содержимое.',
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(calls, ['preflight', 'validate', 'run']);
  assert.equal(answer.content, 'Проверено.');
  assert.equal(answer.provider, 'fixture-api');
  assert.equal(answer.activity[0].text, 'Проверяю.');
  assert.deepEqual(
    events.map((event) => event.type),
    ['accepted', 'activity', 'text', 'done'],
  );
  assert.deepEqual(
    (await service.history('demo')).messages.map((item) => item.role),
    ['user', 'assistant'],
  );
});

test('отмена зарегистрированного адаптера использует существующий общий AbortSignal', async (t) => {
  const service = await serviceFixture(t);
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  service.providers.register({
    ...adapter('fixture-api'),
    async run({ signal }) {
      entered();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted();
    },
  });
  await service.saveSettings({ provider: 'fixture-api' });
  const result = service.send({ projectId: 'demo', message: 'Ожидай.' });
  await started;
  assert.equal(service.active.has('demo'), true);
  service.cancel('demo');
  assert.deepEqual(await result, { cancelled: true });
  assert.equal(service.active.size, 0);
  assert.equal((await service.history('demo')).messages.length, 1);
});

test('очистка чата и остановка сервиса вызывают lifecycle hooks зарегистрированных адаптеров', async (t) => {
  const service = await serviceFixture(t);
  const calls = [];
  service.providers.register({
    ...adapter('fixture-acp'),
    reset(key) {
      calls.push(['reset', key]);
    },
    close() {
      calls.push(['close']);
    },
  });
  // Провайдер мог использоваться раньше: его сессия должна закрыться и после
  // переключения настроек обратно на один из стандартных адаптеров.
  await service.mutateChat('demo', (chat) => {
    chat.messages.push({ role: 'user', content: 'История' });
  });
  await service.resetHistory('demo');
  assert.deepEqual(calls, [['reset', 'demo']]);
  assert.deepEqual(await service.history('demo'), { messages: [] });
  await service.close();
  assert.deepEqual(calls, [['reset', 'demo'], ['close']]);
});
