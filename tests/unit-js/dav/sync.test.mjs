// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSyncState, syncStep, resetStatus } from '../../../src/js/dav/sync.js';
import { DavError } from '../../../src/js/dav/http.js';

const HREF = '/alice/work/';
const INVALID_TOKEN_BODY = '<?xml version="1.0"?><error xmlns="DAV:"><valid-sync-token /></error>';

/** In-memory stand-in for the DAV client, with a change log for sync-collection. */
function fakeServer({ kind = 'calendar', sync = true, ctag = true } = {}) {
  const s = {
    items: new Map(), version: 0, log: [], n: 0,
    sync, ctag, calls: [], mode: { invalidTokens: false, rejectEmpty: false, denied: false, gone: false, offline: false, unauthorized: false },
    put(name, text = 'text of ' + name) {
      const href = HREF + name;
      const etag = '"e' + ++s.n + '"';
      s.items.set(href, { etag, text });
      s.log.push({ v: ++s.version, href, op: 'set' });
      return etag;
    },
    remove(name) {
      s.items.delete(HREF + name);
      s.log.push({ v: ++s.version, href: HREF + name, op: 'del' });
    },
    gate(name) {
      s.calls.push(name);
      const m = s.mode;
      if (m.unauthorized) throw new DavError('auth', { status: 401 });
      if (m.offline) throw new DavError('network', { message: 'offline' });
      if (m.denied) throw new DavError('forbidden', { status: 403, body: 'Access to the requested resource forbidden.' });
      if (m.gone) throw new DavError('notfound', { status: 404, body: 'gone' });
    },
    async syncCollection(href, token) {
      s.gate('sync');
      if (!s.sync) throw new DavError('invalid', { status: 400, body: 'unsupported REPORT' });
      const m = s.mode;
      if ((token && (m.invalidTokens || !/^t\d+$/.test(token))) || (!token && m.rejectEmpty)) {
        throw new DavError('forbidden', { status: 403, body: INVALID_TOKEN_BODY });
      }
      const since = token ? Number(token.slice(1)) : -1;
      const last = new Map();
      for (const e of s.log) if (e.v > since) last.set(e.href, e);
      const changed = [];
      const removed = [];
      for (const e of last.values()) {
        if (e.op === 'set') changed.push({ href: e.href, etag: s.items.get(e.href).etag });
        else if (token) removed.push(e.href);
      }
      return { token: 't' + s.version, changed, removed };
    },
    async getCollection() {
      s.gate('getCollection');
      return { href: HREF, kind, ctag: s.ctag ? '"c' + s.version + '"' : null, syncToken: null };
    },
    async listItemEtags() {
      s.gate('list');
      return [...s.items].map(([href, v]) => ({ href, etag: v.etag }));
    },
    async multiget(_href, hrefs) {
      s.gate('multiget');
      s.calls.push(...hrefs.map((h) => 'get:' + h));
      const items = [];
      const missing = [];
      for (const h of hrefs) (s.items.has(h) ? items.push({ href: h, etag: s.items.get(h).etag, text: s.items.get(h).text }) : missing.push(h));
      return { items, missing };
    },
  };
  s.calendarMultiget = kind === 'calendar' ? s.multiget : () => { throw new Error('wrong multiget'); };
  s.addressbookMultiget = kind === 'addressbook' ? s.multiget : () => { throw new Error('wrong multiget'); };
  return s;
}

const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
const hrefs = (list) => list.map((i) => i.href).sort();
const kinds = (s) => s.calls.filter((c) => !c.startsWith('get:'));

test('createSyncState validates the kind', () => {
  assert.deepEqual(createSyncState({ href: HREF, kind: 'calendar' }), { href: HREF, kind: 'calendar', status: 'ok', mode: 'sync', token: null, ctag: null, etags: {} });
  assert.throws(() => createSyncState({ href: HREF, kind: 'folder' }), TypeError);
});

test('first sync fetches everything with multiget and stores token and etags', async () => {
  const srv = fakeServer();
  srv.put('a.ics'); srv.put('b.ics');
  const st = deepFreeze(createSyncState({ href: HREF, kind: 'calendar' }));
  const r = await syncStep(srv, st);
  assert.equal(r.via, 'sync');
  assert.deepEqual(hrefs(r.upserted), [HREF + 'a.ics', HREF + 'b.ics']);
  assert.deepEqual(r.removed, []);
  assert.equal(r.state.token, 't2');
  assert.deepEqual(r.state.etags, { [HREF + 'a.ics']: '"e1"', [HREF + 'b.ics']: '"e2"' });
  assert.deepEqual(r.signals, { refetchAccess: false, inaccessible: false, missing: false, tokenReset: false, fellBack: false });
  assert.equal(st.token, null, 'the input state is untouched');
});

test('no change: one sync request, no multiget', async () => {
  const srv = fakeServer();
  srv.put('a.ics');
  const s1 = (await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }))).state;
  srv.calls.length = 0;
  const r = await syncStep(srv, deepFreeze(s1));
  assert.deepEqual(srv.calls, ['sync']);
  assert.deepEqual([r.upserted, r.removed], [[], []]);
});

test('incremental sync: new, changed and deleted items', async () => {
  const srv = fakeServer();
  srv.put('a.ics'); srv.put('b.ics'); srv.put('c.ics');
  const s1 = (await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }))).state;
  srv.put('a.ics', 'new text'); srv.put('d.ics'); srv.remove('b.ics');
  srv.calls.length = 0;
  const r = await syncStep(srv, deepFreeze(s1));
  assert.deepEqual(hrefs(r.upserted), [HREF + 'a.ics', HREF + 'd.ics']);
  assert.equal(r.upserted.find((i) => i.href === HREF + 'a.ics').text, 'new text');
  assert.deepEqual(r.removed, [HREF + 'b.ics']);
  assert.deepEqual(Object.keys(r.state.etags).sort(), [HREF + 'a.ics', HREF + 'c.ics', HREF + 'd.ics']);
  assert.deepEqual(srv.calls.filter((c) => c.startsWith('get:')).sort(), ['get:' + HREF + 'a.ics', 'get:' + HREF + 'd.ics']);
});

test('an item created then deleted between two syncs is neither fetched nor reported', async () => {
  const srv = fakeServer();
  srv.put('a.ics');
  const s1 = (await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }))).state;
  srv.put('tmp.ics'); srv.remove('tmp.ics');
  const r = await syncStep(srv, s1);
  assert.deepEqual(r.upserted, []);
  assert.deepEqual(r.state.etags, s1.etags);
});

test('an item the server lists but multiget reports missing (race) becomes a removal', async () => {
  const srv = fakeServer();
  srv.put('a.ics');
  const orig = srv.calendarMultiget;
  srv.calendarMultiget = async (h, list) => { srv.items.delete(HREF + 'a.ics'); return orig(h, list); };
  const r = await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }));
  assert.deepEqual(r.removed, [HREF + 'a.ics']);
  assert.deepEqual(r.state.etags, {});
});

test('address books use addressbook-multiget', async () => {
  const srv = fakeServer({ kind: 'addressbook' });
  srv.put('c.vcf');
  const r = await syncStep(srv, createSyncState({ href: HREF, kind: 'addressbook' }));
  assert.deepEqual(hrefs(r.upserted), [HREF + 'c.vcf']);
});

test('D5: 403 valid-sync-token drops the token and resyncs once with an empty token', async () => {
  const srv = fakeServer();
  srv.put('a.ics'); srv.put('b.ics');
  const s1 = (await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }))).state;
  srv.put('c.ics'); srv.remove('a.ics');
  srv.mode.invalidTokens = true;
  srv.calls.length = 0;
  const r = await syncStep(srv, deepFreeze({ ...s1, token: 'stale' }));
  assert.equal(r.via, 'resync');
  assert.equal(r.signals.tokenReset, true);
  assert.equal(r.signals.fellBack, false);
  assert.equal(r.signals.refetchAccess, false);
  assert.equal(srv.calls.filter((c) => c === 'sync').length, 2);
  // only the real difference is fetched, and the deletion is derived from the full listing
  assert.deepEqual(hrefs(r.upserted), [HREF + 'c.ics']);
  assert.deepEqual(r.removed, [HREF + 'a.ics']);
  assert.equal(r.state.token, 't4');
  assert.deepEqual(Object.keys(r.state.etags).sort(), [HREF + 'b.ics', HREF + 'c.ics']);
});

test('D5: invalid token again on the empty-token resync falls back to ctag/etag comparison', async () => {
  const srv = fakeServer();
  srv.put('a.ics'); srv.put('b.ics');
  const s1 = (await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }))).state;
  srv.put('c.ics'); srv.remove('a.ics');
  srv.mode.invalidTokens = true;
  srv.mode.rejectEmpty = true;
  srv.calls.length = 0;
  const r = await syncStep(srv, deepFreeze(s1));
  assert.equal(r.via, 'etag-list');
  assert.equal(r.signals.fellBack, true);
  assert.equal(r.signals.tokenReset, true);
  assert.deepEqual(kinds(srv), ['sync', 'sync', 'getCollection', 'list', 'multiget']);
  assert.deepEqual(hrefs(r.upserted), [HREF + 'c.ics']);
  assert.deepEqual(r.removed, [HREF + 'a.ics']);
  assert.equal(r.state.token, null);
  assert.equal(r.state.mode, 'sync', 'sync is tried again on the next run');
  assert.equal(r.state.ctag, '"c4"');
  // next run: sync works again (server recovered)
  srv.mode.invalidTokens = false; srv.mode.rejectEmpty = false;
  const r2 = await syncStep(srv, r.state);
  assert.equal(r2.via, 'sync');
  assert.deepEqual(r2.upserted, []);
});

test('D5: a first sync (no token) that is rejected counts the empty token once, then falls back', async () => {
  const srv = fakeServer();
  srv.put('a.ics');
  srv.mode.rejectEmpty = true;
  const r = await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }));
  assert.equal(r.via, 'etag-list');
  assert.equal(r.signals.tokenReset, false, 'there was no token to drop');
  assert.equal(srv.calls.filter((c) => c === 'sync').length, 2);
  assert.deepEqual(hrefs(r.upserted), [HREF + 'a.ics']);
});

test('D5: any other 403 means access lost: inaccessible plus refetchAccess, no fallback', async () => {
  const srv = fakeServer();
  srv.put('a.ics');
  const s1 = (await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }))).state;
  srv.mode.denied = true;
  srv.calls.length = 0;
  const r = await syncStep(srv, deepFreeze(s1));
  assert.equal(r.state.status, 'inaccessible');
  assert.equal(r.state.token, null);
  assert.deepEqual(r.signals, { refetchAccess: true, inaccessible: true, missing: false, tokenReset: false, fellBack: false });
  assert.deepEqual(srv.calls, ['sync'], 'no fallback request');
  assert.deepEqual([r.upserted, r.removed], [[], []]);
  assert.deepEqual(r.state.etags, s1.etags, 'known items are kept for the caller to decide');
  // further steps do nothing until the caller resets the state
  srv.calls.length = 0;
  const r2 = await syncStep(srv, r.state);
  assert.deepEqual(srv.calls, []);
  assert.equal(r2.signals.inaccessible, true);
  assert.equal(r2.signals.refetchAccess, false);
  srv.mode.denied = false;
  const r3 = await syncStep(srv, resetStatus(r.state));
  assert.equal(r3.state.status, 'ok');
  assert.equal(r3.via, 'sync');
});

test('D5: a 403 during the fallback listing is also access lost', async () => {
  const srv = fakeServer({ sync: false });
  srv.put('a.ics');
  const s1 = (await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }))).state;
  srv.mode.denied = true;
  const r = await syncStep(srv, s1);
  assert.equal(r.state.status, 'inaccessible');
  assert.equal(r.signals.refetchAccess, true);
});

test('a 404 on the collection marks it missing and signals refetchAccess', async () => {
  const srv = fakeServer();
  srv.mode.gone = true;
  const r = await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }));
  assert.equal(r.state.status, 'missing');
  assert.deepEqual(r.signals, { refetchAccess: true, inaccessible: false, missing: true, tokenReset: false, fellBack: false });
});

test('network errors and 401 reject and leave the state to the caller', async () => {
  const srv = fakeServer();
  srv.put('a.ics');
  const st = deepFreeze(createSyncState({ href: HREF, kind: 'calendar' }));
  srv.mode.offline = true;
  await assert.rejects(syncStep(srv, st), (e) => e.kind === 'network');
  srv.mode.offline = false;
  srv.mode.unauthorized = true;
  await assert.rejects(syncStep(srv, st), (e) => e.kind === 'auth');
  srv.mode.unauthorized = false;
  const failing = fakeServer();
  failing.put('a.ics');
  failing.calendarMultiget = async () => { throw new DavError('server', { status: 503 }); };
  await assert.rejects(syncStep(failing, st), (e) => e.kind === 'server');
  const ok = await syncStep(srv, st);
  assert.equal(ok.upserted.length, 1);
});

test('collection without sync support: ctag then ETag listing, deletions handled', async () => {
  const srv = fakeServer({ sync: false });
  srv.put('a.ics'); srv.put('b.ics');
  const r1 = await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }));
  assert.equal(r1.via, 'etag-list');
  assert.equal(r1.state.mode, 'ctag');
  assert.equal(r1.signals.fellBack, true);
  assert.equal(r1.state.ctag, '"c2"');
  assert.deepEqual(hrefs(r1.upserted), [HREF + 'a.ics', HREF + 'b.ics']);
  // unchanged ctag: one request only
  srv.calls.length = 0;
  const r2 = await syncStep(srv, deepFreeze(r1.state));
  assert.equal(r2.via, 'ctag');
  assert.deepEqual(srv.calls, ['getCollection']);
  assert.deepEqual([r2.upserted, r2.removed], [[], []]);
  assert.equal(r2.signals.fellBack, false);
  // changed ctag: list ETags, fetch only the difference
  srv.put('b.ics', 'edited'); srv.put('c.ics'); srv.remove('a.ics');
  srv.calls.length = 0;
  const r3 = await syncStep(srv, deepFreeze(r2.state));
  assert.equal(r3.via, 'etag-list');
  assert.deepEqual(kinds(srv), ['getCollection', 'list', 'multiget']);
  assert.deepEqual(hrefs(r3.upserted), [HREF + 'b.ics', HREF + 'c.ics']);
  assert.deepEqual(r3.removed, [HREF + 'a.ics']);
  assert.deepEqual(Object.keys(r3.state.etags).sort(), [HREF + 'b.ics', HREF + 'c.ics']);
  assert.equal(r3.state.ctag, '"c5"');
});

test('collection without ctag: ETag listing every time, no multiget when nothing differs', async () => {
  const srv = fakeServer({ sync: false, ctag: false });
  srv.put('a.ics');
  const r1 = await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }));
  assert.equal(r1.state.ctag, null);
  srv.calls.length = 0;
  const r2 = await syncStep(srv, r1.state);
  assert.deepEqual(kinds(srv), ['getCollection', 'list']);
  assert.deepEqual([r2.upserted, r2.removed], [[], []]);
});

test('an empty collection in ctag mode still lists ETags once (no false "unchanged")', async () => {
  const srv = fakeServer({ sync: false });
  const r1 = await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }));
  assert.deepEqual([r1.upserted, r1.removed], [[], []]);
  srv.put('a.ics');
  const r2 = await syncStep(srv, r1.state);
  assert.deepEqual(hrefs(r2.upserted), [HREF + 'a.ics']);
});

test('501 from the server is treated as "no sync support"', async () => {
  const srv = fakeServer();
  srv.put('a.ics');
  srv.syncCollection = async () => { throw new DavError('server', { status: 501 }); };
  const r = await syncStep(srv, createSyncState({ href: HREF, kind: 'calendar' }));
  assert.equal(r.state.mode, 'ctag');
  assert.equal(r.upserted.length, 1);
});

test('syncStep is deterministic and never mutates its inputs', async () => {
  const srv = fakeServer();
  srv.put('a.ics'); srv.put('b.ics');
  const st = deepFreeze(createSyncState({ href: HREF, kind: 'calendar' }));
  const a = await syncStep(srv, st);
  const b = await syncStep(srv, st);
  assert.deepEqual(a, b);
  deepFreeze(a.state);
  srv.put('c.ics');
  await syncStep(srv, a.state); // would throw on mutation (frozen, strict mode)
});

test('no timers or scheduling inside the sync and discovery modules', () => {
  for (const f of ['sync.js', 'discovery.js']) {
    const src = readFileSync(new URL('../../../src/js/dav/' + f, import.meta.url), 'utf8');
    assert.ok(!/setTimeout|setInterval|requestAnimationFrame|queueMicrotask/.test(src), f);
  }
});
