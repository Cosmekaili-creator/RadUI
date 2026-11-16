// SPDX-License-Identifier: AGPL-3.0-or-later
// store/writes.js: mkcol / mkcalendar (create-time grant check), proppatch, deleteCollection (revocation order and 429).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, DavError } from '../../../src/js/dav/http.js';
import { validateCollectionName } from '../../../src/js/store/writes.js';
import { createWrites } from '../../../src/js/store/writes.js';
import { COLL, FakeApi, apiError, card, makeEnv, model, ops } from './_helpers.mjs';

const createWritesWithSleep = (env, sleep) => createWrites({ client: env.server.client, api: env.api, stores: env.stores, access: env.access, reporter: env.reporter, gate: env.gate, login: 'alice', model, sleep });

const grant = (collection, grantee = 'bob') => ({ owner: 'alice', collection, grantee, level: 'readwrite' });
const NEW = '/alice/new-book/';

test('validateCollectionName mirrors the backend and refuses the reserved prefix', () => {
  assert.equal(validateCollectionName('contacts-2026'), null);
  assert.equal(validateCollectionName('a'), null);
  assert.equal(validateCollectionName(''), 'empty');
  assert.equal(validateCollectionName('bad~'), 'pattern'); // a name ending in ~ is refused by the server too
  assert.equal(validateCollectionName('with space'), 'pattern');
  assert.equal(validateCollectionName('radui-gen-x'), 'reserved');
  assert.equal(validateCollectionName('.hidden'), 'pattern');
  assert.equal(validateCollectionName('x'.repeat(129)), 'pattern');
});

test('mkcol: grants are read FIRST, then MKCOL; no grants means no revoke call', async () => {
  const env = await makeEnv({ items: {} });
  const r = await env.writes.mkcol({ home: '/alice/', name: 'new-book', displayName: 'New', description: 'd' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'created');
  assert.equal(r.href, NEW);
  assert.deepEqual(env.api.calls.filter((c) => c === 'grants' || c.startsWith('putGrant')), ['grants']);
  assert.deepEqual(env.server.callsOf('MKCOL'), ['MKCOL ' + NEW]);
  assert.deepEqual(env.server.lastProps, { displayName: 'New', description: 'd' });
  assert.ok(ops(env).includes('mkcol:ok'));
  assert.equal(env.feedback.status.text, 'store.status.collectionCreated');
});

test('mkcalendar passes the component set and colour', async () => {
  const env = await makeEnv({ items: {} });
  const r = await env.writes.mkcalendar({ home: '/alice/', name: 'cal', displayName: 'Cal', color: '#0072b2', components: ['VEVENT'] });
  assert.equal(r.ok, true);
  assert.deepEqual(env.server.lastProps.components, ['VEVENT']);
  assert.ok(ops(env).includes('mkcalendar:ok'));
});

test('B4: grants left over for that name are revoked BEFORE the create', async () => {
  const api = new FakeApi({ grants: [grant('new-book', 'bob'), grant('new-book', 'carol'), grant('other', 'bob')] });
  const env = await makeEnv({ items: {}, api });
  const r = await env.writes.mkcol({ home: '/alice/', name: 'new-book', displayName: 'New' });
  assert.equal(r.ok, true);
  const seq = env.api.calls.filter((c) => c.startsWith('putGrant '));
  assert.deepEqual(seq, ['putGrant new-book bob none', 'putGrant new-book carol none']);
  assert.equal(env.api.grantList.length, 1); // the other collection's grant is untouched
  const firstPut = env.api.calls.indexOf('putGrant new-book bob none');
  assert.ok(firstPut > 0);
  assert.equal(env.server.callsOf('MKCOL').length, 1);
  assert.ok(ops(env).includes('revoke:ok'));
});

test('B4: when the revoke fails the create is REFUSED with a text error and nothing is created', async () => {
  const api = new FakeApi({ grants: [grant('new-book', 'bob')] });
  api.fail('putGrant', apiError('server', { status: 500 }), 3);
  const env = await makeEnv({ items: {}, api });
  const r = await env.writes.mkcol({ home: '/alice/', name: 'new-book', displayName: 'New' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'orphan-grants');
  assert.equal(r.failed[0].grantee, 'bob');
  assert.equal(env.server.callsOf('MKCOL').length, 0);
  assert.equal(env.feedback.alert.text, 'store.err.orphanGrants {"name":"new-book"}');
  assert.equal(env.feedback.alert.scope, null);
  assert.ok(ops(env).includes('revoke:error'));
});

test('B4: if the grant list itself cannot be read the create is refused; a 404 (no account service) proceeds', async () => {
  const api = new FakeApi();
  api.fail('grants', apiError('unavailable', { status: 503 }));
  const env = await makeEnv({ items: {}, api });
  const refused = await env.writes.mkcol({ home: '/alice/', name: 'new-book' });
  assert.equal(refused.status, 'grants-unchecked');
  assert.equal(env.server.callsOf('MKCOL').length, 0);
  const api2 = new FakeApi();
  api2.fail('grants', apiError('notfound', { status: 404 }));
  const env2 = await makeEnv({ items: {}, api: api2 });
  assert.equal((await env2.writes.mkcol({ home: '/alice/', name: 'new-book' })).ok, true);
});

test('B4: a 429 while revoking honours Retry-After, then succeeds', async () => {
  const api = new FakeApi({ grants: [grant('new-book')] });
  api.fail('putGrant', apiError('ratelimited', { status: 429, retryAfter: 7 }));
  const env = await makeEnv({ items: {}, api });
  const r = await env.writes.mkcol({ home: '/alice/', name: 'new-book' });
  assert.equal(r.ok, true);
  assert.deepEqual(env.slept, [7000]);
  assert.equal(api.grantList.length, 0);
});

test('create errors: existing name (405 and 409) is a field error; invalid names and a missing own space never reach the server', async () => {
  const env = await makeEnv({ items: {} });
  env.server.otherCollections.add(NEW);
  const a = await env.writes.mkcol({ home: '/alice/', name: 'new-book' });
  assert.deepEqual([a.status, a.field], ['exists', 'name']);
  assert.equal(env.feedback.alert.text, 'store.err.collectionExists');
  const c = await env.writes.mkcalendar({ home: '/alice/', name: 'new-book', components: ['VEVENT'] });
  assert.equal(c.status, 'exists');
  env.server.calls.length = 0;
  assert.equal((await env.writes.mkcol({ home: '/alice/', name: 'bad~' })).status, 'invalid');
  assert.deepEqual(env.server.calls, []);
  const off = await makeEnv({ items: {}, api: new FakeApi({ ownSpace: false }) });
  assert.equal((await off.writes.mkcol({ home: '/alice/', name: 'x1' })).status, 'forbidden');
  const g = await makeEnv({ items: {} });
  g.gate.setReason('offline', 'off');
  assert.equal((await g.writes.mkcol({ home: '/alice/', name: 'x1' })).status, 'blocked');
});

test('create: 403 refetches access; 5xx is reported', async () => {
  const env = await makeEnv({ items: {} });
  env.server.fail('MKCOL', new DavError('forbidden', { status: 403 }));
  const n = env.accessCalls.n;
  assert.equal((await env.writes.mkcol({ home: '/alice/', name: 'x1' })).status, 'forbidden');
  assert.equal(env.accessCalls.n, n + 1);
  env.server.fail('MKCOL', new DavError('server', { status: 500 }));
  assert.equal((await env.writes.mkcol({ home: '/alice/', name: 'x2' })).status, 'server-error');
});

test('proppatch: owner only; level checks before any request; access list updated', async () => {
  const env = await makeEnv({ items: {} });
  const r = await env.writes.proppatch({ href: COLL, kind: 'addressbook', changes: { displayName: 'Renamed', description: null } });
  assert.equal(r.ok, true);
  assert.deepEqual(env.server.lastPatch, { displayName: 'Renamed', description: null });
  assert.equal(env.access.get(COLL).label, 'Renamed');
  assert.ok(ops(env).includes('proppatch:ok'));
  const rw = await makeEnv({ items: {}, level: 'readwrite' });
  rw.server.calls.length = 0;
  assert.equal((await rw.writes.proppatch({ href: COLL, kind: 'addressbook', changes: { displayName: 'x' } })).status, 'readonly');
  assert.deepEqual(rw.server.calls, []);
  const f = await makeEnv({ items: {} });
  f.server.fail('PROPPATCH', new DavError('forbidden', { status: 403 }));
  const n = f.accessCalls.n;
  assert.equal((await f.writes.proppatch({ href: COLL, kind: 'addressbook', changes: { displayName: 'x' } })).status, 'forbidden');
  assert.equal(f.accessCalls.n, n + 1);
});

test('deleteCollection: ETag re-read just before, DELETE with the fresh one, THEN grants are read and revoked in order', async () => {
  const api = new FakeApi({ grants: [grant('book', 'bob'), grant('book', 'carol')] });
  const env = await makeEnv({ items: { 'a.vcf': card('u1', 'A') }, api });
  const log = [];
  const sc = env.server.client.deleteCollection;
  env.server.client.deleteCollection = async (...a) => { log.push('DELETECOLL'); return sc(...a); };
  const g = api.grants.bind(api);
  api.grants = async (...a) => { log.push('grants'); return g(...a); };
  const p = api.putGrant.bind(api);
  api.putGrant = async (x) => { log.push('revoke ' + x.grantee); return p(x); };
  env.server.calls.length = 0;
  const r = await env.writes.deleteCollection({ href: COLL, kind: 'addressbook' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'deleted');
  assert.deepEqual(env.server.calls.slice(0, 2), ['PROPFIND0 ' + COLL, 'DELETECOLL ' + COLL]);
  assert.deepEqual(log, ['DELETECOLL', 'grants', 'revoke bob', 'revoke carol', 'grants']);
  assert.equal(api.grantList.length, 0);
  assert.equal(env.stores.get(COLL), null); // the store was dropped
  assert.ok(ops(env).includes('delete:ok'));
  assert.equal(env.feedback.alert, null);
});

test('deleteCollection: expectedEtag that no longer matches answers "changed" with the fresh count and deletes nothing', async () => {
  const env = await makeEnv({ items: { 'a.vcf': card('u1', 'A') } });
  const shown = env.server.collEtag;
  env.server.external('b.vcf', card('u2', 'B'));
  const r = await env.writes.deleteCollection({ href: COLL, kind: 'addressbook', expectedEtag: shown });
  assert.equal(r.status, 'changed');
  assert.equal(r.itemCount, 2);
  assert.equal(r.etag, env.server.collEtag);
  assert.equal(env.server.callsOf('DELETECOLL').length, 0);
  assert.equal(env.feedback.alert.text, 'store.err.collectionChanged {"count":2}');
  const ok = await env.writes.deleteCollection({ href: COLL, kind: 'addressbook', expectedEtag: r.etag });
  assert.equal(ok.ok, true);
});

test('deleteCollection: a 412 in the window is "changed" too (stale etag handled)', async () => {
  const env = await makeEnv({ items: { 'a.vcf': card('u1', 'A') } });
  env.server.fail('DELETECOLL', new ConflictError({ status: 412, href: COLL, sentEtag: 'x' }));
  const r = await env.writes.deleteCollection({ href: COLL, kind: 'addressbook' });
  assert.equal(r.status, 'changed');
  assert.equal(r.itemCount, 1);
  assert.equal(env.server.exists, true);
});

test('deleteCollection: a 429 while revoking waits Retry-After; the grants are listed again first', async () => {
  const api = new FakeApi({ grants: [grant('book', 'bob')] });
  api.fail('putGrant', apiError('ratelimited', { status: 429, retryAfter: 4 }));
  const env = await makeEnv({ items: {}, api });
  const r = await env.writes.deleteCollection({ href: COLL, kind: 'addressbook' });
  assert.equal(r.ok, true);
  assert.deepEqual(env.slept, [4000]);
  assert.equal(r.grantsLeft, false);
  assert.equal(api.calls.filter((c) => c === 'grants').length, 2); // before and after
});

test('deleteCollection: grants that cannot be revoked give a persistent alert naming them; the delete stays done', async () => {
  const api = new FakeApi({ grants: [grant('book', 'bob'), grant('book', 'carol')] });
  const orig = api.putGrant.bind(api);
  api.putGrant = async (x) => {
    if (x.grantee === 'carol') throw apiError('validation', { status: 422, code: 'unsupported_collection_name' });
    return orig(x);
  };
  const env = await makeEnv({ items: {}, api });
  const r = await env.writes.deleteCollection({ href: COLL, kind: 'addressbook' });
  assert.equal(r.ok, true);
  assert.equal(r.grantsLeft, true);
  assert.equal(r.revoke.failed[0].grantee, 'carol');
  assert.equal(r.revoke.failed[0].unrevokable, true);
  assert.match(env.feedback.alert.text, /store\.err\.revokeLeft/);
  assert.match(env.feedback.alert.text, /carol/);
  assert.equal(env.feedback.alert.scope, null);
});

test('deleteCollection: if the grants cannot even be listed after the delete, a persistent alert says so', async () => {
  const api = new FakeApi({ grants: [grant('book')] });
  const env = await makeEnv({ items: {}, api });
  api.fail('grants', apiError('unavailable', { status: 503 }));
  const r = await env.writes.deleteCollection({ href: COLL, kind: 'addressbook' });
  assert.equal(r.ok, true);
  assert.equal(r.grantsLeft, true);
  assert.match(env.feedback.alert.text, /store\.err\.revokeCheck/);
});

test('deleteCollection: only the owner; a grantee is refused with no request; 403 and missing collection', async () => {
  const rw = await makeEnv({ items: {}, level: 'readwrite' });
  rw.server.calls.length = 0;
  assert.equal((await rw.writes.deleteCollection({ href: COLL, kind: 'addressbook' })).status, 'readonly');
  assert.deepEqual(rw.server.calls, []);
  const f = await makeEnv({ items: {} });
  f.server.fail('DELETECOLL', new DavError('forbidden', { status: 403 }));
  assert.equal((await f.writes.deleteCollection({ href: COLL, kind: 'addressbook' })).status, 'forbidden');
  const gone = await makeEnv({ items: {}, api: new FakeApi({ grants: [grant('book')] }) });
  gone.server.exists = false;
  const r = await gone.writes.deleteCollection({ href: COLL, kind: 'addressbook' });
  assert.equal(r.ok, true); // already deleted elsewhere: the grants are still cleaned up
  assert.equal(gone.api.grantList.length, 0);
});

test('C2: mkcol of a name that already exists and is shared sends NO putGrant (known to the access list)', async () => {
  const api = new FakeApi({ grants: [grant('book', 'bob')] });
  const env = await makeEnv({ items: {}, api });
  env.server.calls.length = 0;
  const r = await env.writes.mkcol({ home: '/alice/', name: 'book', displayName: 'Again' });
  assert.deepEqual([r.ok, r.status], [false, 'exists']);
  assert.equal(api.calls.filter((c) => c.startsWith('putGrant')).length, 0);
  assert.equal(api.calls.includes('grants'), false); // not even listed
  assert.deepEqual(env.server.callsOf('MKCOL'), []);
  assert.equal(api.grantList.length, 1); // bob keeps his access
});

test('C2: a name the access list does not know is probed first; an existing collection means exists, still no putGrant', async () => {
  const api = new FakeApi({ grants: [grant('hidden', 'bob')] });
  const env = await makeEnv({ items: {}, api });
  env.server.otherCollections.add('/alice/hidden/');
  const r = await env.writes.mkcalendar({ home: '/alice/', name: 'hidden', components: ['VEVENT'] });
  assert.equal(r.status, 'exists');
  assert.deepEqual(env.server.calls.filter((c) => c.startsWith('PROPFIND0 /alice/hidden/')), ['PROPFIND0 /alice/hidden/']);
  assert.equal(api.calls.filter((c) => c.startsWith('putGrant')).length, 0);
  assert.equal(env.server.callsOf('MKCALENDAR').length, 0);
});

test('C2: a 404 probe lets the orphan check run; a probe error is "grants-unchecked" and nothing is revoked or created', async () => {
  const api = new FakeApi({ grants: [grant('fresh', 'bob')] });
  const env = await makeEnv({ items: {}, api });
  env.server.fail('PROPFIND0', new DavError('server', { status: 500 }));
  const bad = await env.writes.mkcol({ home: '/alice/', name: 'fresh' });
  assert.equal(bad.status, 'grants-unchecked');
  assert.equal(api.calls.filter((c) => c.startsWith('putGrant')).length, 0);
  assert.equal(env.server.callsOf('MKCOL').length, 0);
  const ok = await env.writes.mkcol({ home: '/alice/', name: 'fresh' });
  assert.equal(ok.ok, true);
  assert.deepEqual(api.calls.filter((c) => c.startsWith('putGrant ')), ['putGrant fresh bob none']);
  const order = [...env.server.calls.filter((c) => c.startsWith('PROPFIND0 /alice/fresh/') || c.startsWith('MKCOL'))];
  assert.deepEqual(order.map((c) => c.split(' ')[0]), ['PROPFIND0', 'PROPFIND0', 'MKCOL']); // failed probe, probe, create
});

test('minor 12: a Retry-After wait that ends with the session rejects, so the revoke loop stops and sends nothing more', async () => {
  const api = new FakeApi({ grants: [grant('book', 'bob'), grant('book', 'carol')] });
  api.fail('putGrant', apiError('ratelimited', { status: 429, retryAfter: 30 }));
  const env = await makeEnv({ items: {}, api });
  const w = createWritesWithSleep(env, () => Promise.reject(new Error('session ended')));
  const r = await w.deleteCollection({ href: COLL, kind: 'addressbook' });
  assert.equal(r.ok, true); // the delete itself is done
  assert.equal(r.grantsLeft, true);
  assert.equal(api.calls.filter((c) => c.startsWith('putGrant ')).length, 0);
  assert.equal(env.feedback.alert, null); // nothing is shown into the next login's screen
});
