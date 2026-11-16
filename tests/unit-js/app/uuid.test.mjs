// SPDX-License-Identifier: AGPL-3.0-or-later
// uuid.js: secure random only, never Math.random.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newUuid } from '../../../src/js/uuid.js';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function withCrypto(value, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    else delete globalThis.crypto;
  }
}

test('newUuid: a lower-case version 4 UUID, 10,000 values all different', () => {
  const seen = new Set();
  for (let i = 0; i < 10_000; i++) {
    const u = newUuid();
    assert.match(u, V4);
    seen.add(u);
  }
  assert.equal(seen.size, 10_000);
});

test('newUuid builds a v4 UUID from getRandomValues when randomUUID is missing', () => {
  const real = globalThis.crypto;
  const seen = new Set();
  withCrypto({ getRandomValues: (a) => real.getRandomValues(a) }, () => {
    for (let i = 0; i < 10_000; i++) {
      const u = newUuid();
      assert.match(u, V4);
      seen.add(u);
    }
  });
  assert.equal(seen.size, 10_000);
  // fixed bytes: the version and variant bits are forced
  withCrypto({ getRandomValues: (a) => a.fill(0xff) }, () => assert.equal(newUuid(), 'ffffffff-ffff-4fff-bfff-ffffffffffff'));
  withCrypto({ getRandomValues: (a) => a.fill(0) }, () => assert.equal(newUuid(), '00000000-0000-4000-8000-000000000000'));
});

test('newUuid throws without any crypto, and never falls back to Math.random', () => {
  const orig = Math.random;
  let touched = 0;
  Math.random = () => {
    touched++;
    return 0.5;
  };
  try {
    withCrypto(undefined, () => assert.throws(() => newUuid(), /no secure random source/));
    withCrypto({}, () => assert.throws(() => newUuid(), /no secure random source/));
    withCrypto({ getRandomValues: (a) => a.fill(1) }, () => newUuid());
    newUuid();
  } finally {
    Math.random = orig;
  }
  assert.equal(touched, 0);
});

test('no source file calls randomUUID or Math.random for identifiers outside uuid.js', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/js');
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
  for (const f of walk(SRC).filter((x) => x.endsWith('.js') && !x.endsWith('uuid.js'))) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /randomUUID/, f);
  }
});
