// SPDX-License-Identifier: AGPL-3.0-or-later
// store/itemstore.js: server text and ETag only, sync through syncStep, index hooks, events, races with writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createItemStore, createStores } from '../../../src/js/store/itemstore.js';
import { DavError } from '../../../src/js/dav/http.js';
import { createSession } from '../../../src/js/session.js';
import { COLL, FakeServer, card, createClock, fakeStorage, tick } from './_helpers.mjs';

const A = card('urn:uuid:a', 'Alice A');
const B = card('urn:uuid:b', 'Bob B');

function mk(opts = {}) {
  const server = new FakeServer();
  server.seed('a.vcf', A);
  server.seed('b.vcf', B);
  const clock = createClock();
  const store = createItemStore({ client: server.client, href: COLL, kind: 'addressbook', now: clock.now, ...opts });
  return { server, clock, store };
}

test('holds server text and etag only: entries are plain frozen records, never an Item', async () => {
  const { store, server } = mk();
  const r = await store.sync({ reason: 'load' });
  assert.equal(r.ok, true);
  assert.equal(store.size, 2);
  const e = store.get(server.href('a.vcf'));
  assert.deepEqual(Object.keys(e).sort(), ['etag', 'href', 'text']);
  assert.equal(e.text, A);
  assert.ok(Object.isFrozen(e));
  assert.equal(store.loaded, true);
  assert.equal(typeof e.fields, 'undefined');
  assert.deepEqual(store.hrefs().sort(), [server.href('a.vcf'), server.href('b.vcf')]);
});

test('incremental sync via sync-collection: only the changed item is fetched; removals drop items', async () => {
  const { store, server } = mk();
  await store.sync({ reason: 'load' });
  server.calls.length = 0;
  server.external('a.vcf', card('urn:uuid:a', 'Alice Changed'));
  server.external('b.vcf', null);
  server.external('c.vcf', card('urn:uuid:c', 'Carol'));
  const r = await store.sync({ reason: 'poll' });
  assert.equal(r.via, 'sync');
  assert.deepEqual(r.upserted.sort(), [server.href('a.vcf'), server.href('c.vcf')]);
  assert.deepEqual(r.removed, [server.href('b.vcf')]);
  assert.match(store.get(server.href('a.vcf')).text, /Alice Changed/);
  assert.equal(store.has(server.href('b.vcf')), false);
  assert.equal(server.callsOf('MULTIGET').length, 1);
});

test('ETag fallback when the server has no sync-collection', async () => {
  const { store, server } = mk();
  server.syncSupported = false;
  await store.sync({ reason: 'load' });
  server.external('a.vcf', card('urn:uuid:a', 'Alice Changed'));
  const r = await store.sync({ reason: 'poll' });
  assert.equal(r.via, 'etag-list');
  assert.deepEqual(r.upserted, [server.href('a.vcf')]);
});

test('never two syncs of one store at once: the second call gets the first promise', async () => {
  const { store, server } = mk();
  let release;
  const gateP = new Promise((r) => (release = r));
  const orig = server.client.syncCollection;
  server.client.syncCollection = async (...a) => {
    await gateP;
    return orig(...a);
  };
  const p1 = store.sync({ reason: 'a' });
  const p2 = store.sync({ reason: 'b' });
  assert.equal(p1, p2);
  assert.equal(store.syncing, true);
  release();
  await p1;
  assert.equal(store.syncing, false);
  assert.equal(store.syncCount, 1);
});

test('indexer: function form is called with (text, href) for every arriving item', async () => {
  const seen = [];
  const { store, server } = mk({ indexer: (text, href) => seen.push([href, text.length > 0]) });
  await store.sync({ reason: 'load' });
  assert.deepEqual(seen.map((s) => s[0]).sort(), [server.href('a.vcf'), server.href('b.vcf')]);
  assert.ok(seen.every((s) => s[1]));
});

test('indexer: object form gets upsert, remove and clear; a throwing indexer never breaks the sync', async () => {
  const log = [];
  const { store, server } = mk({
    indexer: {
      upsert: (t, h) => log.push('up ' + h),
      remove: (h) => log.push('rm ' + h),
      clear: () => log.push('clear'),
    },
  });
  await store.sync({ reason: 'load' });
  server.external('b.vcf', null);
  await store.sync({ reason: 'poll' });
  assert.ok(log.includes('rm ' + server.href('b.vcf')));
  await store.reload();
  assert.ok(log.includes('clear'));
  const bad = mk({ indexer: () => { throw new Error('index boom'); } });
  const r = await bad.store.sync({ reason: 'load' });
  assert.equal(r.ok, true);
  assert.equal(bad.store.size, 2);
  assert.equal(bad.store.indexErrors, 2);
});

test('change events: sync and write events with the affected hrefs', async () => {
  const { store, server } = mk();
  const events = [];
  store.subscribe((e) => events.push(e));
  await store.sync({ reason: 'load' });
  const syncEv = events.find((e) => e.type === 'sync');
  assert.equal(syncEv.ok, true);
  assert.equal(syncEv.changed, true);
  assert.equal(syncEv.reason, 'load');
  assert.ok(events.some((e) => e.type === 'state' && e.syncing === true));
  assert.ok(events.some((e) => e.type === 'state' && e.syncing === false));
  events.length = 0;
  store.applyWrite(server.href('a.vcf'), { etag: '"x"', text: A });
  store.applyDelete(server.href('b.vcf'));
  assert.deepEqual(events.map((e) => [e.type, e.op]), [['write', 'put'], ['write', 'delete']]);
  assert.equal(store.applyDelete(server.href('b.vcf')), false);
});

test('refresh({reason}) is a sync; reload() lists everything again and drops what is gone', async () => {
  const { store, server } = mk();
  await store.sync({ reason: 'load' });
  const r = await store.refresh({ reason: 'focus' });
  assert.equal(r.reason, 'focus');
  assert.equal(r.changed, false);
  server.items.delete(server.href('b.vcf')); // vanished without a tombstone: only a full reload sees it
  const rr = await store.reload();
  assert.equal(rr.ok, true);
  assert.equal(store.size, 1);
});

test('errors: the sync resolves with ok:false, keeps the old data, counts the streak and recovers', async () => {
  const { store, server } = mk();
  await store.sync({ reason: 'load' });
  server.fail('SYNC', new DavError('network', { message: 'offline' }));
  const r = await store.sync({ reason: 'poll' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'network');
  assert.equal(store.size, 2);
  assert.equal(store.errorStreak, 1);
  assert.equal(store.lastError.kind, 'network');
  const ok = await store.sync({ reason: 'poll' });
  assert.equal(ok.ok, true);
  assert.equal(ok.recovered, true);
  assert.equal(store.errorStreak, 0);
  assert.equal(store.lastError, null);
});

test('a 401 is reported as fatal', async () => {
  const { store, server } = mk();
  server.fail('SYNC', new DavError('auth', { status: 401 }));
  const r = await store.sync({ reason: 'load' });
  assert.equal(r.fatal, true);
});

test('access signals: a 404 on the collection marks it missing and tells the access layer', async () => {
  const signals = [];
  const { store, server } = mk({ onAccessSignal: (s) => signals.push(s) });
  await store.sync({ reason: 'load' });
  server.fail('SYNC', new DavError('notfound', { status: 404 }));
  const r = await store.sync({ reason: 'poll' });
  assert.equal(r.status, 'missing');
  assert.equal(store.status, 'missing');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].refetchAccess, true);
  store.revive();
  assert.equal(store.status, 'ok');
});

test('a local write during a running sync is not overwritten by that sync\'s older view', async () => {
  const { store, server } = mk();
  await store.sync({ reason: 'load' });
  server.external('a.vcf', card('urn:uuid:a', 'Alice Server Change'));
  let release;
  const hold = new Promise((r) => (release = r));
  const orig = server.client.addressbookMultiget;
  server.client.addressbookMultiget = async (...a) => {
    const res = await orig(...a); // reads the OLD view now ...
    await hold; // ... and delivers it late
    return res;
  };
  const p = store.sync({ reason: 'poll' });
  await tick();
  store.applyWrite(server.href('a.vcf'), { etag: '"mine"', text: card('urn:uuid:a', 'Alice Local Write') });
  release();
  await p;
  assert.match(store.get(server.href('a.vcf')).text, /Local Write/);
  assert.equal(store.get(server.href('a.vcf')).etag, '"mine"');
  // the next sync sees the server's etag differs from the one we hold and fetches the real text
  server.client.addressbookMultiget = orig;
  await store.sync({ reason: 'poll' });
  assert.match(store.get(server.href('a.vcf')).text, /Server Change/);
});

test('a delete written during a running sync is not undone by that sync', async () => {
  const { store, server } = mk();
  await store.sync({ reason: 'load' });
  server.external('b.vcf', card('urn:uuid:b', 'Bob changed'));
  let release;
  const hold = new Promise((r) => (release = r));
  const orig = server.client.addressbookMultiget;
  server.client.addressbookMultiget = async (...a) => {
    const res = await orig(...a);
    await hold;
    return res;
  };
  const p = store.sync({ reason: 'poll' });
  await tick();
  store.applyDelete(server.href('b.vcf'));
  release();
  await p;
  assert.equal(store.has(server.href('b.vcf')), false);
});

test('dispose: items dropped, listeners gone, later syncs are skipped', async () => {
  const { store } = mk();
  await store.sync({ reason: 'load' });
  let n = 0;
  store.subscribe(() => n++);
  store.dispose();
  assert.equal(store.size, 0);
  assert.equal(store.disposed, true);
  const r = await store.sync({ reason: 'x' });
  assert.equal(r.skipped, 'disposed');
  assert.equal(n, 0);
  assert.equal(store.applyWrite('/x', { etag: '"e"', text: 'x' }), null);
});

test('createStores: one store per collection, registered with the session; disposing the session drops them all', async () => {
  const server = new FakeServer();
  server.seed('a.vcf', A);
  const clock = createClock();
  const session = createSession({ login: 'alice', storage: fakeStorage(), timers: clock });
  const stores = createStores({ client: server.client, session, now: clock.now });
  const s1 = stores.open({ href: COLL, kind: 'addressbook' });
  assert.equal(stores.open({ href: COLL.slice(0, -1), kind: 'addressbook' }), s1);
  assert.equal(stores.get(COLL), s1);
  await s1.sync({ reason: 'load' });
  assert.equal(s1.size, 1);
  stores.open({ href: '/alice/other/', kind: 'addressbook' });
  assert.equal(stores.all().length, 2);
  assert.equal(stores.drop('/alice/other/'), true);
  assert.equal(stores.drop('/alice/other/'), false);
  session.dispose();
  assert.equal(stores.all().length, 0);
  assert.equal(s1.disposed, true);
  assert.equal(s1.size, 0);
});
