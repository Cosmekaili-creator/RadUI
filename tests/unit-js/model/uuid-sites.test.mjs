// SPDX-License-Identifier: AGPL-3.0-or-later
// The model creates UIDs through uuid.js: without a secure random source it fails loudly, with a UUID otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCard } from '../../../src/js/model/vcard.js';
import { createEvent } from '../../../src/js/model/event.js';
import { createTodo } from '../../../src/js/model/todo.js';
import { fileNameFor } from '../../../src/js/model/importplan.js';

function noCrypto(fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis, 'crypto', saved);
  }
}

test('createCard / createEvent / createTodo / fileNameFor throw "no secure random source" instead of guessing', () => {
  noCrypto(() => {
    assert.throws(() => createCard({ fn: 'A' }), /no secure random source/);
    assert.throws(() => createEvent({ summary: 'x', start: { kind: 'date', iso: '2026-01-01' } }), /no secure random source/);
    assert.throws(() => createTodo({ summary: 'x' }), /no secure random source/);
    assert.throws(() => fileNameFor('has space'), /no secure random source/);
  });
});

test('with a UID given nothing random is needed; without, a v4 UUID is used', () => {
  noCrypto(() => assert.match(createCard({ fn: 'A' }, { uid: 'u1' }).prop('UID').value, /u1/));
  assert.match(createCard({ fn: 'A' }).prop('UID').value, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  assert.match(fileNameFor('has space'), /^[0-9a-f-]{36}\.vcf$/);
});
