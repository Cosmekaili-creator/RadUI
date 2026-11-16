// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, DavError } from '../../../src/js/dav/http.js';
import { createClient } from '../../../src/js/dav/client.js';
import { discoverAccessible } from '../../../src/js/dav/discovery.js';
import { makeFetch, recorded, ORIGIN, AUTH } from './_helpers.mjs';

// Bob's view: his own (empty) home plus grants on two of alice's collections.
function bobClient(overrides = {}) {
  const handler = (call) => {
    const key = call.path;
    if (overrides[key]) return overrides[key](call);
    if (key === '/') return recorded('propfind-principal', (b) => b.replace('/alice/', '/bob/'));
    if (key === '/bob/' && call.headers.depth === '0') return recorded('propfind-homesets', (b) => b.replace(/\/alice\//g, '/bob/'));
    if (key === '/bob/') return recorded('propfind-bob-home');
    if (key === '/alice/shared-rw/') return recorded('propfind-bob-rw-grant');
    if (key === '/alice/shared-ro/') return recorded('propfind-bob-ro-grant');
    if (key === '/alice/work/') return recorded('propfind-bob-forbidden');
    return recorded('propfind-missing');
  };
  const fetchImpl = makeFetch(handler);
  const transport = createTransport({ origin: ORIGIN, getAuth: () => AUTH, fetchImpl, timeoutMs: 2000 });
  return { client: createClient(transport), fetchImpl };
}

const GRANTS = {
  login: 'bob',
  grants: [
    { href: '/alice/shared-rw/', owner: 'alice', collection: 'shared-rw', level: 'readwrite' },
    { href: '/alice/shared-ro/', owner: 'alice', collection: 'shared-ro', level: 'read' },
  ],
};

test('own collections and grants are merged with their access level', async () => {
  const { client } = bobClient();
  const r = await discoverAccessible(client, { meAccess: async () => GRANTS });
  assert.equal(r.apiError, null);
  assert.equal(r.ownError, null);
  const byHref = Object.fromEntries(r.collections.map((c) => [c.href, c]));
  assert.deepEqual(Object.keys(byHref).sort(), ['/alice/shared-ro/', '/alice/shared-rw/']);
  assert.equal(byHref['/alice/shared-rw/'].source, 'grant');
  assert.equal(byHref['/alice/shared-rw/'].status, 'ok');
  assert.equal(byHref['/alice/shared-rw/'].owner, 'alice');
  assert.equal(byHref['/alice/shared-rw/'].level, 'readwrite');
  assert.equal(byHref['/alice/shared-rw/'].displayName, 'Shared RW');
  assert.deepEqual(byHref['/alice/shared-ro/'].privileges, ['read', 'read-free-busy']);
  assert.equal(byHref['/alice/shared-ro/'].grant.level, 'read');
});

test('a grant that is also an own collection is listed once, as own', async () => {
  const { client } = bobClient({ '/bob/': (call) => (call.headers.depth === '0' ? recorded('propfind-homesets', (b) => b.replace(/\/alice\//g, '/bob/')) : recorded('propfind-home-depth1')) });
  const r = await discoverAccessible(client, { meAccess: async () => ({ grants: [{ href: '/alice/work/', owner: 'alice', collection: 'work', level: 'read' }] }) });
  const work = r.collections.filter((c) => c.href === '/alice/work/');
  assert.equal(work.length, 1);
  assert.equal(work[0].source, 'own');
  assert.ok(r.collections.length >= 6);
});

test('a missing collection is flagged missing (404), a refused one inaccessible (403)', async () => {
  const { client } = bobClient();
  const r = await discoverAccessible(client, {
    meAccess: async () => [
      { href: '/alice/gone/', owner: 'alice', collection: 'gone', level: 'read' },
      { href: '/alice/work/', owner: 'alice', collection: 'work', level: 'read' },
      { href: '/alice/shared-ro/', owner: 'alice', collection: 'shared-ro', level: 'read' },
    ],
  });
  const st = Object.fromEntries(r.collections.map((c) => [c.href, c.status]));
  assert.deepEqual(st, { '/alice/gone/': 'missing', '/alice/work/': 'inaccessible', '/alice/shared-ro/': 'ok' });
  const gone = r.collections.find((c) => c.href === '/alice/gone/');
  assert.equal(gone.owner, 'alice');
  assert.equal(gone.grant.collection, 'gone');
});

test('other errors on a grant are reported per entry; a 401 aborts discovery', async () => {
  const { client } = bobClient({ '/alice/shared-rw/': () => ({ status: 502, body: 'bad gateway' }) });
  const r = await discoverAccessible(client, { meAccess: async () => GRANTS });
  const rw = r.collections.find((c) => c.href === '/alice/shared-rw/');
  assert.equal(rw.status, 'error');
  assert.deepEqual(rw.error, { kind: 'server', status: 502 });
  const unauth = bobClient({ '/alice/shared-rw/': () => ({ status: 401, body: '' }) });
  await assert.rejects(discoverAccessible(unauth.client, { meAccess: async () => GRANTS }), (e) => e instanceof DavError && e.kind === 'auth');
  const unauthOwn = bobClient({ '/': () => ({ status: 401, body: '' }) });
  await assert.rejects(discoverAccessible(unauthOwn.client, { meAccess: async () => GRANTS }), (e) => e.kind === 'auth');
});

test('if the backend fails or is absent, own collections are still listed', async () => {
  const own = { '/bob/': (call) => (call.headers.depth === '0' ? recorded('propfind-homesets', (b) => b.replace(/\/alice\//g, '/bob/')) : recorded('propfind-home-depth1')) };
  for (const api of [{ meAccess: async () => { throw new DavError('network', { message: 'down' }); } }, { meAccess: () => { throw new Error('sync throw'); } }, null, undefined, {}]) {
    const { client } = bobClient(own);
    const r = await discoverAccessible(client, api);
    assert.ok(r.collections.length >= 6, 'own collections listed');
    assert.ok(r.collections.every((c) => c.source === 'own'));
    assert.equal(r.apiError !== null, !!(api && api.meAccess));
  }
});

test('if the own home cannot be listed, grants are still returned', async () => {
  const { client } = bobClient({ '/': () => ({ status: 500, body: 'x' }) });
  const r = await discoverAccessible(client, { meAccess: async () => GRANTS });
  assert.equal(r.ownError.kind, 'server');
  assert.equal(r.collections.length, 2);
});

test('malformed or foreign grant records are ignored, never followed', async () => {
  const { client, fetchImpl } = bobClient();
  const r = await discoverAccessible(client, {
    meAccess: async () => ({
      grants: [
        { href: 'http://evil.example.net/alice/x/', owner: 'alice', collection: 'x', level: 'read' },
        { href: '//evil.example.net/x/', owner: 'alice', collection: 'x', level: 'read' },
        { href: '/alice/../root/', owner: 'alice', collection: 'x', level: 'read' },
        null, 'string', { owner: 'a/b', collection: 'c' },
        { href: '/alice/shared-ro/', owner: 'alice', collection: 'shared-ro', level: 'read' },
      ],
    }),
  });
  assert.deepEqual(r.collections.map((c) => c.href), ['/alice/shared-ro/']);
  assert.ok(fetchImpl.calls.every((c) => !c.url.includes('evil')));
});

test('a grant without href is built from owner and collection with encoding', async () => {
  const { client, fetchImpl } = bobClient();
  await discoverAccessible(client, { meAccess: async () => [{ owner: 'alice', collection: 'My Cal +é @~x', level: 'read' }] });
  assert.ok(fetchImpl.calls.some((c) => c.path === '/alice/My%20Cal%20%2B%C3%A9%20%40~x/'));
});

test('grant probes run with bounded parallelism', async () => {
  let live = 0;
  let peak = 0;
  const grants = Array.from({ length: 12 }, (_, i) => ({ href: '/alice/c' + i + '/', owner: 'alice', collection: 'c' + i, level: 'read' }));
  const fetchImpl = makeFetch(async (call) => {
    if (call.path === '/') return recorded('propfind-principal');
    if (call.path === '/alice/') return call.headers.depth === '0' ? recorded('propfind-homesets') : { status: 207, body: '<multistatus xmlns="DAV:"/>' };
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return recorded('propfind-missing');
  });
  const client = createClient(createTransport({ origin: ORIGIN, getAuth: () => AUTH, fetchImpl, timeoutMs: 2000 }));
  const r = await discoverAccessible(client, { meAccess: async () => grants });
  assert.equal(r.collections.length, 12);
  assert.ok(r.collections.every((c) => c.status === 'missing'));
  assert.ok(peak <= 4, 'peak ' + peak);
});
