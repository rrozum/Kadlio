import assert from 'node:assert/strict';
import test from 'node:test';
import { preserveLocalDrafts } from '../frontend/engine/editor-drafts.js';

// Новая серверная тема/эффекты не должны затирать локальный текст или сбрасывать
// версии речи. Тест использует разные версии HTML и речи, как реальное сохранение.
test('серверный снимок сохраняет локальные HTML и речь, оставляя остальные изменения', () => {
  const local = {
    slides: [
      { id: 'one', body: '<h1>Мой HTML</h1>', version: 4, notes: 'Моя речь', notesVersion: 7 },
      { id: 'two', body: '<p>Старый текст</p>', version: 1, notes: 'Без правок', notesVersion: 2 },
    ],
  };
  const original = structuredClone(local);
  const incoming = {
    css: '.slide{background:white}',
    timeline: [
      { type: 'slide', id: 'two' },
      { type: 'slide', id: 'one' },
    ],
    slides: [
      {
        id: 'two',
        body: '<p>Серверный текст</p>',
        version: 2,
        notes: 'Новая речь',
        notesVersion: 3,
      },
      {
        id: 'one',
        body: '<h1>До ввода</h1>',
        version: 4,
        notes: 'До правки речи',
        notesVersion: 9,
      },
    ],
  };
  const dirtySlides = new Set(['one']),
    dirtyNotes = new Set(['one']);
  preserveLocalDrafts(local, incoming, { dirtySlides, dirtyNotes });
  assert.deepEqual(local, original);
  assert.equal(incoming.slides[1].body, '<h1>Мой HTML</h1>');
  assert.equal(incoming.slides[1].notes, 'Моя речь');
  assert.equal(incoming.slides[1].notesVersion, 7);
  assert.equal(incoming.slides[0].body, '<p>Серверный текст</p>');
  assert.equal(incoming.slides[0].notesVersion, 3);
  assert.equal(incoming.css, '.slide{background:white}');
  assert.deepEqual(incoming.timeline, [
    { type: 'slide', id: 'two' },
    { type: 'slide', id: 'one' },
  ]);
  assert.deepEqual([...dirtySlides], ['one']);
  assert.deepEqual([...dirtyNotes], ['one']);
});

test('конфликт HTML останавливает принятие снимка и сохраняет локальный черновик', () => {
  const local = { slides: [{ id: 'one', body: '<p>Неотправленный ввод</p>', version: 3 }] };
  const incoming = { slides: [{ id: 'one', body: '<p>Правка агента</p>', version: 4 }] };
  assert.throws(
    () =>
      preserveLocalDrafts(local, incoming, {
        dirtySlides: new Set(['one']),
        dirtyNotes: new Set(),
      }),
    /локальный HTML сохранён/,
  );
  assert.equal(local.slides[0].body, '<p>Неотправленный ввод</p>');
  assert.equal(local.slides[0].version, 3);
  assert.equal(incoming.slides[0].body, '<p>Правка агента</p>');
});
