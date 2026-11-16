// SPDX-License-Identifier: AGPL-3.0-or-later
// store/writes.js: the owner of a collection is the first path segment of its href, never the signed-in login
// (an administrator deleting another account's collection must not touch the grants of their own same-named one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeApi, makeEnv } from './_helpers.mjs';

const g = (owner, collection, grantee) => ({ owner, collection, grantee, level: 'readwrite' });

test('C2: deleteCollection of /carol/book/ by alice lists and revokes only carol\'s grants; alice\'s same-named ones stay', async () => {
  const api = new FakeApi({ grants: [g('alice', 'book', 'dave'), g('carol', 'book', 'bob'), g('carol', 'book', 'erin')] });
  const env = await makeEnv({ items: {}, api });
  env.server.otherCollections.add('/carol/book/');
  env.server.client.deleteCollection = async (href, etag) => {
    env.server.calls.push(`DELETECOLL ${href} ${etag}`);
    return { href };
  };
  const listed = [];
  const orig = api.grants.bind(api);
  api.grants = async (q) => { listed.push(q && q.owner); return orig(q); };
  const r = await env.writes.deleteCollection({ href: '/carol/book/', kind: 'addressbook', expectedEtag: '"o1"' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 'deleted');
  assert.ok(listed.length >= 1 && listed.every((o) => o === 'carol'), String(listed));
  assert.deepEqual(api.calls.filter((c) => c.startsWith('putGrant ')).sort(), ['putGrant book bob none', 'putGrant book erin none']);
  assert.deepEqual(api.grantList.map((x) => `${x.owner}/${x.collection}/${x.grantee}`), ['alice/book/dave']);
  assert.ok(env.server.calls.some((c) => c === 'DELETECOLL /carol/book/ "o1"'));
});

test('C2: a stale expectedEtag (the listing one) answers "changed" and deletes nothing', async () => {
  const api = new FakeApi({ grants: [g('carol', 'book', 'bob')] });
  const env = await makeEnv({ items: {}, api });
  env.server.otherCollections.add('/carol/book/');
  const r = await env.writes.deleteCollection({ href: '/carol/book/', kind: 'addressbook', expectedEtag: '"old"' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'changed');
  assert.equal(env.server.callsOf('DELETECOLL').length, 0);
  assert.equal(api.grantList.length, 1);
});

test('C2: create-time orphan check uses the home\'s owner, not the signed-in login', async () => {
  const api = new FakeApi({ grants: [g('alice', 'new-book', 'dave'), g('carol', 'new-book', 'bob')] });
  const env = await makeEnv({ items: {}, api });
  const r = await env.writes.mkcol({ home: '/carol/', name: 'new-book', displayName: 'New' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(api.calls.filter((c) => c.startsWith('putGrant ')), ['putGrant new-book bob none']);
  assert.deepEqual(api.grantList.map((x) => x.owner), ['alice']);
});

test('m8: with a non-root Radicale base path the owner is the segment after the base (/radicale/carol/book/ -> carol, not "radicale")', async () => {
  const api = new FakeApi({ grants: [g('radicale', 'book', 'zed'), g('carol', 'book', 'bob')] });
  const env = await makeEnv({ items: {}, api });
  env.server.client.transport = { basePath: '/radicale/' };
  env.server.otherCollections.add('/radicale/carol/book/');
  env.server.client.deleteCollection = async (href) => ({ href });
  const r = await env.writes.deleteCollection({ href: '/radicale/carol/book/', kind: 'addressbook', expectedEtag: '"o1"' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(api.calls.filter((c) => c.startsWith('putGrant ')), ['putGrant book bob none']);
  assert.deepEqual(api.grantList.map((x) => x.owner), ['radicale']);
  const m = await env.writes.mkcol({ home: '/radicale/carol/', name: 'other', displayName: 'Other' });
  assert.equal(m.ok, true, JSON.stringify(m));
});
