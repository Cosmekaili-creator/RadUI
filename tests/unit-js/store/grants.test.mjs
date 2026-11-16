// SPDX-License-Identifier: AGPL-3.0-or-later
// api.js grants/putGrant and store/grants.js revocation helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi, normalizeGrants } from '../../../src/js/api.js';
import { revokeGrants } from '../../../src/js/store/grants.js';
import { FakeApi, apiError } from './_helpers.mjs';

function api(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = handler({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers || {} });
  };
  return { api: createApi({ apiBase: '/ui/api/', getAuth: () => 'Basic dGVzdDp0ZXN0', fetchImpl }), calls };
}

test('grants(): GET grants with the owner query; records are normalised, malformed ones dropped', async () => {
  const { api: a, calls } = api(() => ({ body: [{ owner: 'alice', collection: 'book', grantee: 'bob', level: 'readwrite', grantedBy: 'alice', created: 'x' }, { owner: 'alice' }, null, { owner: 'alice', collection: 'c', grantee: 'x', level: 'weird' }] }));
  const r = await a.grants({ owner: 'alice' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, '/ui/api/grants?owner=alice');
  assert.deepEqual(r.map((g) => [g.collection, g.grantee, g.level]), [['book', 'bob', 'readwrite'], ['c', 'x', null]]);
  await a.grants();
  assert.equal(calls[1].url, '/ui/api/grants');
  assert.throws(() => normalizeGrants({}), ApiError);
});

test('putGrant(): PUT grants with exactly the four fields and the X-RadUI header; revokeGrant sends level none', async () => {
  const { api: a, calls } = api(() => ({ body: { grant: null, generation: 3, active: true } }));
  const r = await a.putGrant({ owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' });
  assert.equal(r.generation, 3);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers['X-RadUI'], '1');
  assert.deepEqual(JSON.parse(calls[0].body), { owner: 'alice', collection: 'book', grantee: 'bob', level: 'read' });
  await a.revokeGrant({ owner: 'alice', collection: 'book', grantee: 'bob' });
  assert.equal(JSON.parse(calls[1].body).level, 'none');
  await assert.rejects(() => a.putGrant({ owner: 'alice', collection: 'book', grantee: 'bob', level: 'admin' }), TypeError);
  await assert.rejects(() => a.putGrant({ owner: 'alice', collection: '', grantee: 'bob', level: 'none' }), TypeError);
});

test('a 429 from the service carries retryAfter', async () => {
  const { api: a } = api(() => ({ status: 429, body: { error: { code: 'rate_limited' } }, headers: { 'retry-after': '12' } }));
  await assert.rejects(() => a.putGrant({ owner: 'alice', collection: 'book', grantee: 'bob', level: 'none' }), (e) => e.kind === 'ratelimited' && e.retryAfter === 12);
});

const g = (collection, grantee) => ({ owner: 'alice', collection, grantee, level: 'read' });

test('revokeGrants: lists fresh, revokes sequentially, confirms with a second read', async () => {
  const fake = new FakeApi({ grants: [g('book', 'bob'), g('book', 'carol'), g('other', 'dave')] });
  const r = await revokeGrants({ api: fake, owner: 'alice', collection: 'book', sleep: async () => {} });
  assert.deepEqual(r.revoked, ['bob', 'carol']);
  assert.equal(r.ok, true);
  assert.deepEqual(fake.calls, ['grants', 'putGrant', 'putGrant book bob none', 'putGrant', 'putGrant book carol none', 'grants']);
});

test('revokeGrants: nothing to do is one read and ok', async () => {
  const fake = new FakeApi({ grants: [g('other', 'dave')] });
  const r = await revokeGrants({ api: fake, owner: 'alice', collection: 'book', sleep: async () => {} });
  assert.deepEqual([r.ok, r.listed], [true, 0]);
  assert.deepEqual(fake.calls, ['grants']);
});

test('revokeGrants: Retry-After is honoured (capped at 60 s) and attempts are limited', async () => {
  const fake = new FakeApi({ grants: [g('book', 'bob')] });
  fake.fail('putGrant', apiError('ratelimited', { retryAfter: 500 }), 2);
  const waits = [];
  const r = await revokeGrants({ api: fake, owner: 'alice', collection: 'book', sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [60000, 60000]);
  assert.equal(r.ok, true);
  const f2 = new FakeApi({ grants: [g('book', 'bob')] });
  f2.fail('putGrant', apiError('ratelimited', { retryAfter: 1 }), 5);
  const r2 = await revokeGrants({ api: f2, owner: 'alice', collection: 'book', sleep: async () => {}, maxAttempts: 2 });
  assert.equal(r2.ok, false);
  assert.equal(r2.failed[0].kind, 'ratelimited');
});

test('revokeGrants: what is still listed afterwards is failed, even if the answer was an error; unrevokable names are flagged', async () => {
  const fake = new FakeApi({ grants: [g('book', 'bob'), g('book', 'carol')] });
  const put = fake.putGrant.bind(fake);
  fake.putGrant = async (x) => {
    if (x.grantee === 'bob') throw apiError('validation', { status: 422, code: 'unsupported_collection_name' });
    return put(x);
  };
  const r = await revokeGrants({ api: fake, owner: 'alice', collection: 'book', sleep: async () => {} });
  assert.deepEqual(r.revoked, ['carol']);
  assert.deepEqual(r.failed.map((f) => [f.grantee, f.unrevokable]), [['bob', true]]);
  // an error answer for a grant that is in fact gone (idempotent 422) is not a failure
  const fake2 = new FakeApi({ grants: [g('book', 'bob')] });
  fake2.putGrant = async () => {
    fake2.grantList = [];
    throw apiError('validation', { status: 422 });
  };
  assert.equal((await revokeGrants({ api: fake2, owner: 'alice', collection: 'book', sleep: async () => {} })).ok, true);
});

test('revokeGrants: a failing list is reported (listError), a failing confirmation read is "unverified"', async () => {
  const f1 = new FakeApi();
  f1.fail('grants', apiError('unavailable', { status: 503 }));
  const r1 = await revokeGrants({ api: f1, owner: 'alice', collection: 'book', sleep: async () => {} });
  assert.equal(r1.ok, false);
  assert.equal(r1.listError.kind, 'server');
  const f2 = new FakeApi({ grants: [g('book', 'bob')] });
  let n = 0;
  const lister = f2.grants.bind(f2);
  f2.grants = async (o) => {
    if (++n === 2) throw apiError('network');
    return lister(o);
  };
  const r2 = await revokeGrants({ api: f2, owner: 'alice', collection: 'book', sleep: async () => {} });
  assert.equal(r2.unverified, true);
  assert.equal(r2.ok, false);
});
