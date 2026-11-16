// SPDX-License-Identifier: AGPL-3.0-or-later
// ctx.app.getStore(): one store context per login session, lazy, shared by concurrent callers, disposed with
// the session, re-translated on a language change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreGetter } from '../../../src/js/app.js';
import { createSession } from '../../../src/js/session.js';

function build(over = {}) {
  let session = createSession({ login: 'alice' });
  let created = 0;
  const contexts = [];
  const importStore = async () => ({
    createStoreContext: (o) => {
      created += 1;
      const ctx = { opts: o, translators: [], setTranslator(fn) { this.translators.push(fn); } };
      contexts.push(ctx);
      return ctx;
    },
  });
  const model = { openItem() {} };
  const get = createStoreGetter({ currentSession: () => session, loadModel: async () => model, deps: () => ({ client: 'dav', api: 'api', t: () => '', gate: 'gate', doc: 'doc', win: 'win', isOnline: () => true }), importStore, ...over });
  return { get, contexts, model, count: () => created, session: () => session, swap: (s) => (session = s) };
}

test('one context per session, created lazily, with the documented dependencies', async () => {
  const b = build();
  assert.equal(b.count(), 0);
  const [a, c] = await Promise.all([b.get(), b.get()]);
  assert.equal(a, c, 'concurrent callers share one context');
  assert.equal(await b.get(), a);
  assert.equal(b.count(), 1);
  assert.equal(a.opts.session, b.session());
  assert.equal(a.opts.model, b.model);
  for (const k of ['client', 'api', 't', 'gate', 'doc', 'win', 'isOnline']) assert.ok(k in a.opts, k);
});

test('another login gets a fresh context; a disposed session cannot be used', async () => {
  const b = build();
  const first = await b.get();
  b.session().dispose();
  assert.equal(b.session().data.size, 0);
  b.swap(createSession({ login: 'bob' }));
  const second = await b.get();
  assert.notEqual(first, second);
  b.session().dispose();
  await assert.rejects(b.get());
});

test('a failed start is not cached', async () => {
  let fail = true;
  const b = build({ loadModel: async () => { if (fail) throw new Error('no network'); return {}; } });
  await assert.rejects(b.get());
  await new Promise((r) => setImmediate(r));
  fail = false;
  assert.ok(await b.get());
});

test('no session: refused', async () => {
  const b = build({ currentSession: () => null });
  await assert.rejects(b.get(), /not signed in/);
});

test('a language change hands the new translator to the live context', async () => {
  const b = build();
  const ctx = await b.get();
  const t2 = () => 'x';
  b.get.setTranslator(t2);
  assert.deepEqual(ctx.translators, [t2]);
  build().get.setTranslator(t2); // no context yet: harmless
});
