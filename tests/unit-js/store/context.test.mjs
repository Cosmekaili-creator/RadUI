// SPDX-License-Identifier: AGPL-3.0-or-later
// store/index.js: one context per session; sign-out / expiry (session.dispose) stops every timer and drops every store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../../../src/js/session.js';
import { createActivityLog, createFeedback, createWriteGate } from '../../../src/js/ui.js';
import { createStoreContext } from '../../../src/js/store/index.js';
import { COLL, FakeApi, FakeServer, card, createClock, fakeDoc, fakeStorage, fakeTarget, model, tick } from './_helpers.mjs';

function build() {
  const clock = createClock();
  const server = new FakeServer();
  server.seed('a.vcf', card('urn:uuid:a', 'Alice'));
  const session = createSession({ login: 'alice', storage: fakeStorage(), timers: clock });
  const doc = fakeDoc();
  const win = fakeTarget();
  const activity = createActivityLog();
  const feedback = createFeedback();
  const api = new FakeApi();
  const ctx = createStoreContext({ session, client: server.client, api, activity, feedback, t: (k) => k, gate: createWriteGate(), doc, win, now: clock.now, model, random: () => '00000000-0000-4000-8000-000000000001' });
  return { clock, server, session, doc, win, activity, feedback, api, ctx };
}

test('a context wires access, stores, scheduler, writes, import and export together', async () => {
  const { ctx, server, clock } = build();
  const store = ctx.stores.open({ href: COLL, kind: 'addressbook' });
  ctx.scheduler.register(store);
  await ctx.scheduler.enter(store);
  assert.equal(store.size, 1);
  const r = await ctx.writes.createItem({ collection: COLL, fields: { fn: 'New' } });
  assert.equal(r.ok, true);
  assert.equal(store.size, 2);
  await clock.advance(1000); // the write asked the scheduler for a sync
  assert.ok(server.callsOf('SYNC').length >= 2);
  const e = await ctx.exportCollection({ collection: { href: COLL, kind: 'addressbook', displayName: 'Book' }, now: () => new Date(2026, 0, 2) });
  assert.equal(e.count, 2);
  assert.equal(e.filename, 'book-2026-01-02.vcf');
  const one = ctx.exportItem({ text: card('u', 'X'), displayName: 'X' });
  assert.equal(one.count, 1);
});

test('sign-out: disposing the session stops all timers and listeners and drops the stores', async () => {
  const { ctx, session, clock, doc, win, server } = build();
  const store = ctx.stores.open({ href: COLL, kind: 'addressbook' });
  await ctx.scheduler.enter(store);
  ctx.scheduler.afterWrite(store);
  assert.ok(clock.pending > 0);
  assert.equal(store.size, 1);
  session.dispose();
  assert.equal(clock.pending, 0);
  assert.equal(doc.count('visibilitychange'), 0);
  assert.equal(win.count('focus'), 0);
  assert.equal(ctx.stores.all().length, 0);
  assert.equal(store.size, 0);
  assert.equal(store.disposed, true);
  assert.equal(ctx.access.list().length, 0);
  server.calls.length = 0;
  await clock.advance(10 * 60_000);
  win.fire('focus');
  await tick();
  assert.deepEqual(server.calls, []); // nothing is polled any more
});

test('after dispose a late sync result is dropped and nothing is stored', async () => {
  const { ctx, session, server } = build();
  const store = ctx.stores.open({ href: COLL, kind: 'addressbook' });
  let release;
  const hold = new Promise((r) => (release = r));
  const orig = server.client.syncCollection;
  server.client.syncCollection = async (...a) => {
    await hold;
    return orig(...a);
  };
  const p = store.sync({ reason: 'load' });
  session.dispose();
  release();
  const r = await p;
  assert.equal(r.skipped, 'disposed');
  assert.equal(store.size, 0);
});

test('a second login gets a fresh context: no store, no last book of the first login', async () => {
  const clock = createClock();
  const storage = fakeStorage();
  const server = new FakeServer();
  server.seed('a.vcf', card('u', 'A'));
  const mk = (login) => {
    const session = createSession({ login, storage, timers: clock });
    return { session, ctx: createStoreContext({ session, client: server.client, api: new FakeApi({ login }), doc: fakeDoc(), win: fakeTarget(), now: clock.now, model }) };
  };
  const one = mk('alice');
  one.ctx.stores.open({ href: COLL, kind: 'addressbook' });
  one.ctx.access.setLastBook(COLL);
  one.session.dispose();
  const two = mk('bob');
  assert.equal(two.ctx.stores.all().length, 0);
  assert.equal(two.session.lastBook, null);
});

test('the translator can be replaced when the language changes', async () => {
  const { ctx, feedback } = build();
  ctx.setTranslator((k) => `fr:${k}`);
  ctx.reporter.status('store.status.saved');
  assert.equal(feedback.status.text, 'fr:store.status.saved');
});

test('M5 through the context: disposing the session cancels a running import', async () => {
  const { ctx, session, server } = build();
  const store = ctx.stores.open({ href: COLL, kind: 'addressbook' });
  await store.sync({ reason: 'load' });
  const text = Array.from({ length: 8 }, (_, i) => card(`urn:uuid:imp-${i}`, `Imp ${i}`)).join('');
  const { planImport } = await import('../../../src/js/model/importplan.js');
  const plan = planImport(text, [], { collectionHref: COLL });
  let n = 0;
  let release;
  const hold = new Promise((r) => (release = r));
  const put = server.client.putItem;
  server.client.putItem = async (...a) => {
    if (++n <= 3) await hold;
    return put(...a);
  };
  const h = ctx.startImport({ collection: COLL, plan, chunkSize: 8 });
  await tick();
  session.dispose();
  release();
  const rep = await h.done;
  assert.equal(n, 3);
  assert.equal(rep.cancelled, true);
});

test('minor 12 through the context: the sleep of a disposed session rejects instead of hanging', async () => {
  const { ctx, session, api, server } = build();
  const hold = (collection, grantee) => ({ owner: 'alice', collection, grantee, level: 'read' });
  api.grantList = [hold('book', 'bob')];
  api.fail('putGrant', Object.assign(new Error('rate'), { name: 'ApiError', kind: 'ratelimited', retryAfter: 30 }));
  const origGet = server.client.deleteCollection;
  server.client.deleteCollection = async (...a) => {
    const r = await origGet(...a);
    queueMicrotask(() => session.dispose()); // the session ends while the revoke loop waits for Retry-After
    return r;
  };
  const r = await Promise.race([ctx.writes.deleteCollection({ href: COLL, kind: 'addressbook' }), new Promise((res) => setTimeout(() => res('HUNG'), 500))]);
  assert.notEqual(r, 'HUNG');
});

test('createStoreContext needs a session', () => {
  assert.throws(() => createStoreContext({}), TypeError);
});
