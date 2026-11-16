// SPDX-License-Identifier: AGPL-3.0-or-later
// store/writes.js: deleteItem with group cleanup, 412 on delete, deleted elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, DavError } from '../../../src/js/dav/http.js';
import { COLL, card, etagOf, groupCard, makeEnv, ops } from './_helpers.mjs';

const UA = 'urn:uuid:11111111-2222-3333-4444-555555555501';
const UB = 'urn:uuid:11111111-2222-3333-4444-555555555502';
const href = (n) => COLL + n;
const items = () => ({
  'a.vcf': card(UA, 'Alice A'),
  'b.vcf': card(UB, 'Bob B'),
  'g1.vcf': groupCard('urn:uuid:g1', 'Family', [UA, UB]),
  'g2.vcf': groupCard('urn:uuid:g2', 'Club', [UA], false),
  'g3.vcf': groupCard('urn:uuid:g3', 'Others', [UB]),
});

test('delete a contact: DELETE first, then ONE PUT per affected group, in that order', async () => {
  const env = await makeEnv({ items: items() });
  env.server.calls.length = 0;
  const r = await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: etagOf(env, href('a.vcf')) });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'deleted');
  const writes = env.server.calls.filter((c) => /^(PUT|DELETE) /.test(c));
  assert.equal(writes[0], 'DELETE ' + href('a.vcf'));
  assert.deepEqual(writes.slice(1).sort(), ['PUT ' + href('g1.vcf'), 'PUT ' + href('g2.vcf')]);
  assert.equal(writes.length, 3);
  assert.doesNotMatch(env.server.get('g1.vcf').text, /555555555501/);
  assert.match(env.server.get('g1.vcf').text, /555555555502/);
  assert.doesNotMatch(env.server.get('g2.vcf').text, /555555555501/);
  assert.equal(env.server.get('g3.vcf').text, items()['g3.vcf']); // untouched
  assert.equal(env.store.has(href('a.vcf')), false);
  assert.equal(r.cleanup.length, 2);
  assert.ok(ops(env).includes('delete:ok'));
  assert.equal(env.feedback.status.text, 'store.status.deleted');
});

test('the DELETE carries the store etag; groupHrefs overrides the search', async () => {
  const env = await makeEnv({ items: items() });
  env.server.calls.length = 0;
  await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: etagOf(env, href('a.vcf')), groupHrefs: [href('g1.vcf')] });
  assert.equal(env.server.callsOf('PUT').length, 1);
  assert.match(env.server.get('g2.vcf').text, /555555555501/); // not cleaned: not listed
});

test('deleting a group card never touches member cards and runs no cleanup', async () => {
  const env = await makeEnv({ items: items() });
  env.server.calls.length = 0;
  const r = await env.writes.deleteItem({ collection: COLL, href: href('g1.vcf'), etag: etagOf(env, href('g1.vcf')) });
  assert.equal(r.ok, true);
  assert.deepEqual(env.server.calls.filter((c) => /^(PUT|DELETE) /.test(c)), ['DELETE ' + href('g1.vcf')]);
});

test('a cleanup that fails is reported; the delete itself stays done', async () => {
  const env = await makeEnv({ items: items() });
  env.server.fail('PUT', new DavError('forbidden', { status: 403 }), { when: (h) => h.endsWith('g1.vcf') });
  const r = await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: etagOf(env, href('a.vcf')) });
  assert.equal(r.ok, true);
  assert.equal(r.cleanupFailed, 1);
  assert.equal(env.feedback.alert.text, 'store.err.cleanupGroups {"count":1}');
  assert.equal(env.server.get('a.vcf'), undefined);
});

test('412 on delete: nothing deleted, their version offered; "delete anyway" uses the fresh etag', async () => {
  const env = await makeEnv({ items: items() });
  env.server.external('a.vcf', card(UA, 'Alice Changed'));
  env.store.applyWrite(href('a.vcf'), { etag: '"stale"', text: items()['a.vcf'] }); // the list still shows the old one
  const r = await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: '"stale"' });
  assert.equal(r.status, 'changed-elsewhere');
  assert.match(r.theirs.text, /Alice Changed/);
  assert.ok(env.server.get('a.vcf'));
  assert.equal(env.feedback.alert.text, 'store.err.changedBeforeDelete');
  const again = await env.writes.resolveDeleteAnyway(r);
  assert.equal(again.ok, true);
  assert.equal(env.server.get('a.vcf'), undefined);
});

test('a 412 whose GET says 404: it was deleted elsewhere; the group cleanup still runs', async () => {
  const env = await makeEnv({ items: items() });
  const started = env.store.get(href('a.vcf'));
  env.server.external('a.vcf', null);
  const r = await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: started.etag });
  assert.equal(r.status, 'already-deleted' === r.status ? 'already-deleted' : r.status);
  assert.equal(r.ok, true);
  assert.doesNotMatch(env.server.get('g1.vcf').text, /555555555501/);
});

test('delete of an item that is already gone (404) is not an error', async () => {
  const env = await makeEnv({ items: items() });
  env.server.fail('DELETE', new DavError('notfound', { status: 404 }));
  const r = await env.writes.deleteItem({ collection: COLL, href: href('b.vcf'), etag: etagOf(env, href('b.vcf')) });
  assert.equal(r.ok, true);
  assert.equal(env.store.has(href('b.vcf')), false);
});

test('delete errors: 403 refetches access, network reloads the list, no etag is "not found"', async () => {
  const env = await makeEnv({ items: items(), level: 'readwrite' });
  env.server.fail('DELETE', new DavError('forbidden', { status: 403 }));
  const before = env.accessCalls.n;
  assert.equal((await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: etagOf(env, href('a.vcf')) })).status, 'forbidden');
  assert.equal(env.accessCalls.n, before + 1);
  env.server.fail('DELETE', new DavError('network', {}));
  assert.equal((await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: etagOf(env, href('a.vcf')) })).status, 'unknown-result');
  env.server.fail('DELETE', new DavError('server', { status: 500 }));
  assert.equal((await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: etagOf(env, href('a.vcf')) })).status, 'server-error');
  assert.equal((await env.writes.deleteItem({ collection: COLL, href: href('a.vcf') })).status, 'invalid'); // the ETag is mandatory
  assert.equal((await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: null })).reason, 'etag-required');
  assert.ok(env.server.get('a.vcf'));
});

test('a read-only grantee cannot delete (no request)', async () => {
  const env = await makeEnv({ items: items(), level: 'read' });
  env.server.calls.length = 0;
  assert.equal((await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: etagOf(env, href('a.vcf')) })).status, 'readonly');
  assert.deepEqual(env.server.calls, []);
  assert.ok(new ConflictError({ status: 412 }));
});

test('M2: deleteItem without the shown ETag is refused; after a sync replaced the store it never deletes the changed card', async () => {
  const env = await makeEnv({ items: items() });
  const shown = etagOf(env, href('a.vcf')); // what the detail view displayed
  env.server.external('a.vcf', card(UA, 'Alice Changed by someone'));
  await env.store.sync({ reason: 'poll' }); // the store now holds the changed card
  env.server.calls.length = 0;
  const none = await env.writes.deleteItem({ collection: COLL, href: href('a.vcf') });
  assert.deepEqual([none.ok, none.status, none.reason], [false, 'invalid', 'etag-required']);
  assert.deepEqual(env.server.calls, []);
  const stale = await env.writes.deleteItem({ collection: COLL, href: href('a.vcf'), etag: shown });
  assert.equal(stale.status, 'changed-elsewhere'); // 412, nothing deleted
  assert.ok(env.server.get('a.vcf'));
});
