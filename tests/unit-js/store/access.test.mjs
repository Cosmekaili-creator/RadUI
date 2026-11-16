// SPDX-License-Identifier: AGPL-3.0-or-later
// store/access.js: accessible collections and levels, own space (m10), no privilege inference, refetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccessList, canManage, canWrite, createAccess } from '../../../src/js/store/access.js';
import { createSession } from '../../../src/js/session.js';
import { FakeApi, apiError, fakeStorage } from './_helpers.mjs';

const own = { href: '/alice/book/', kind: 'addressbook', name: 'book', displayName: 'Book', source: 'own', owner: 'alice', status: 'ok', components: ['VCARD'], privileges: [] };
const rw = { href: '/bob/shared/', kind: 'addressbook', name: 'shared', displayName: null, source: 'grant', owner: 'bob', status: 'ok', level: 'readwrite', privileges: ['read'], components: ['VCARD'] };
const ro = { href: '/bob/cal/', kind: 'calendar', name: 'cal', displayName: 'Cal', color: '#336699', source: 'grant', owner: 'bob', status: 'ok', level: 'read', privileges: ['write', 'all'], components: ['VEVENT'] };

test('own collections are level own, grants keep their level', () => {
  const r = buildAccessList({ me: { ownSpace: true }, discovery: { collections: [own, rw, ro] } });
  assert.deepEqual(r.collections.map((c) => [c.href, c.level]), [['/alice/book/', 'own'], ['/bob/shared/', 'readwrite'], ['/bob/cal/', 'read']]);
  assert.equal(r.collections[0].ownerIsMe, true);
  assert.equal(r.collections[2].readOnly, true);
  assert.equal(r.collections[1].label, 'shared');
});

test('m10: with ownSpace off an own collection is not offered at all', () => {
  const r = buildAccessList({ me: { ownSpace: false }, discovery: { collections: [own, rw] } });
  assert.deepEqual(r.collections.map((c) => c.href), ['/bob/shared/']);
  assert.deepEqual(r.problems.map((p) => p.reason), ['own-space-disabled']);
  assert.equal(r.ownSpace, false);
});

test('permissions are never inferred from the DAV privilege list', () => {
  const r = buildAccessList({ me: { ownSpace: true }, discovery: { collections: [own, rw, ro] } });
  const by = Object.fromEntries(r.collections.map((c) => [c.href, c]));
  assert.equal(canWrite(by['/alice/book/']), true); // privileges: []
  assert.equal(canWrite(by['/bob/shared/']), true); // privileges: ['read']
  assert.equal(canWrite(by['/bob/cal/']), false); // privileges: ['write','all']
  assert.equal('privileges' in by['/bob/cal/'], false);
});

test('canManage is owner only; canWrite is own or readwrite; null is false', () => {
  assert.equal(canManage({ level: 'own' }), true);
  assert.equal(canManage({ level: 'readwrite' }), false);
  assert.equal(canWrite({ level: 'readwrite' }), true);
  assert.equal(canWrite({ level: 'read' }), false);
  assert.equal(canWrite(null), false);
  assert.equal(canManage(undefined), false);
});

test('a grant without a usable level is read; limited sign-in (no me) assumes own space; problems are listed', () => {
  const odd = { ...rw, href: '/bob/odd/', level: null };
  const missing = { href: '/bob/gone/', source: 'grant', owner: 'bob', status: 'missing' };
  const r = buildAccessList({ me: null, discovery: { collections: [own, odd, missing] } });
  assert.deepEqual(r.collections.map((c) => c.level), ['own', 'read']);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].status, 'missing');
});

async function make({ api = new FakeApi(), collections = [own, rw, ro], session = null } = {}) {
  let calls = 0;
  const discover = async () => {
    calls++;
    return { collections: collections.map((c) => ({ ...c })), apiError: null, ownError: null };
  };
  const access = createAccess({ api, client: {}, session, discover });
  return { access, api, get calls() { return calls; } };
}

test('createAccess: load, lookups, levels', async () => {
  const { access } = await make();
  assert.equal(access.loaded, false);
  const r = await access.load();
  assert.equal(r.ok, true);
  assert.equal(access.list().length, 3);
  assert.equal(access.get('/alice/book/').level, 'own');
  assert.equal(access.get('/alice/book').level, 'own'); // trailing slash is optional
  assert.equal(access.get('/nope/'), null);
  assert.equal(access.levelOf('/bob/cal/'), 'read');
  assert.equal(access.levelOf('/unknown/'), null);
  assert.equal(access.canWrite('/bob/shared/'), true);
  assert.equal(access.canManage('/bob/shared/'), false);
  assert.deepEqual(access.addressbooks().map((c) => c.href), ['/alice/book/', '/bob/shared/']);
  assert.deepEqual(access.calendars().map((c) => c.href), ['/bob/cal/']);
  assert.deepEqual(access.writable('addressbook').map((c) => c.href), ['/alice/book/', '/bob/shared/']);
  assert.equal(access.me.login, 'alice');
  assert.equal(access.canCreateCollections(), true);
});

test('createAccess: load() uses the cache, refetch() recomputes (a 403 changes the level)', async () => {
  const h = await make();
  await h.access.load();
  await h.access.load();
  assert.equal(h.calls, 1);
  assert.equal(h.access.levelOf('/bob/shared/'), 'readwrite');
  // the grant was reduced on the server; a refetch after the 403 picks it up
  const r = await h.access.refetch({ reason: '403' });
  assert.equal(r.ok, true);
  assert.equal(h.calls, 2);
});

test('refetch recomputes the level from the fresh discovery', async () => {
  let level = 'readwrite';
  const access = createAccess({ api: new FakeApi(), client: {}, discover: async () => ({ collections: [{ ...rw, level }], apiError: null, ownError: null }) });
  await access.refetch();
  assert.equal(access.levelOf('/bob/shared/'), 'readwrite');
  level = 'read';
  await access.refetch({ reason: '403' });
  assert.equal(access.levelOf('/bob/shared/'), 'read');
  assert.equal(access.canWrite('/bob/shared/'), false);
});

test('concurrent refetches share one run; errors never reject', async () => {
  const h = await make();
  const [a, b] = await Promise.all([h.access.refetch(), h.access.refetch()]);
  assert.equal(h.calls, 1);
  assert.equal(a, b);
  const failing = createAccess({ api: new FakeApi(), client: {}, discover: async () => { throw new Error('boom'); } });
  const r = await failing.refetch();
  assert.equal(r.ok, false);
  assert.ok(failing.lastError);
});

test('me failing (backend absent) still lists the collections; a 401 on me is an error result', async () => {
  const api = new FakeApi();
  api.fail('me', apiError('network'));
  const { access } = await make({ api });
  const r = await access.refetch();
  assert.equal(r.ok, true);
  assert.equal(access.me, null);
  assert.equal(access.levelOf('/alice/book/'), 'own');
  const api2 = new FakeApi();
  api2.fail('me', apiError('auth', { status: 401 }));
  const h2 = await make({ api: api2 });
  const r2 = await h2.access.refetch();
  assert.equal(r2.ok, false);
});

test('ownSpace=false from me: own collections vanish, creation is refused', async () => {
  const { access } = await make({ api: new FakeApi({ ownSpace: false }) });
  await access.load();
  assert.deepEqual(access.list().map((c) => c.href), ['/bob/shared/', '/bob/cal/']);
  assert.equal(access.canCreateCollections(), false);
});

test('defaultBook: last book of THIS login, else first own, else first grant', async () => {
  const storage = fakeStorage();
  const timers = { setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} };
  const s1 = createSession({ login: 'alice', storage, timers });
  const a = createAccess({ api: new FakeApi(), client: {}, session: s1, discover: async () => ({ collections: [rw, own], apiError: null, ownError: null }) });
  await a.load();
  assert.equal(a.defaultBook().href, '/alice/book/'); // first own, even though the grant is listed first
  a.setLastBook('/bob/shared/');
  assert.equal(a.defaultBook().href, '/bob/shared/');
  const s2 = createSession({ login: 'bob', storage, timers });
  const b = createAccess({ api: new FakeApi(), client: {}, session: s2, discover: async () => ({ collections: [rw, own], apiError: null, ownError: null }) });
  await b.load();
  assert.equal(b.defaultBook().href, '/alice/book/'); // another login does not see alice's preference
  s1.setLastBook('/gone/');
  assert.equal(a.defaultBook().href, '/alice/book/'); // a remembered book that is no longer accessible is ignored
  const none = createAccess({ api: new FakeApi(), client: {}, discover: async () => ({ collections: [ro], apiError: null, ownError: null }) });
  await none.load();
  assert.equal(none.defaultBook(), null);
  const grantOnly = createAccess({ api: new FakeApi(), client: {}, discover: async () => ({ collections: [rw], apiError: null, ownError: null }) });
  await grantOnly.load();
  assert.equal(grantOnly.defaultBook().href, '/bob/shared/');
});

test('patchCollection / remove update the list and notify; dispose empties it', async () => {
  const { access } = await make();
  await access.load();
  const events = [];
  access.subscribe((e) => events.push(e.reason));
  assert.equal(access.patchCollection('/alice/book/', { displayName: 'New', color: null }), true);
  assert.equal(access.get('/alice/book/').label, 'New');
  assert.equal(access.patchCollection('/missing/', { displayName: 'x' }), false);
  assert.equal(access.remove('/alice/book/'), true);
  assert.equal(access.remove('/alice/book/'), false);
  assert.deepEqual(events, ['patch', 'remove']);
  access.dispose();
  assert.equal(access.list().length, 0);
  const r = await access.refetch();
  assert.equal(r.ok, false);
});
