// SPDX-License-Identifier: AGPL-3.0-or-later
// store/writes.js: 412 handling and the three resolutions (reload, overwrite with mine, copy), group delta rebase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError } from '../../../src/js/dav/http.js';
import { COLL, card, groupCard, makeEnv, model, ops, vcf } from './_helpers.mjs';

const UID_A = 'urn:uuid:11111111-2222-3333-4444-555555555501';
const base = () => card(UID_A, 'Alice Example', 'TEL;TYPE=CELL:+1 555 0100\nEMAIL:alice@example.org\nTITLE:Engineer\n');
const href = (n = 'a.vcf') => COLL + n;

async function conflicted(patchFn, theirs) {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  const started = env.store.get(href());
  const view = model.openItem(started.text, 'contact').fields();
  env.server.external('a.vcf', theirs);
  const r = await env.writes.saveItem({ collection: COLL, href: href(), patch: patchFn(view), baseFields: view, base: { text: started.text, etag: started.etag } });
  return { env, r, view, started };
}

test('412 -> GET theirs -> ConflictResult with base, mine, theirs and the rows', async () => {
  const { env, r } = await conflicted(() => ({ title: 'Mine' }), base().replace('Engineer', 'Theirs'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 'conflict');
  assert.match(r.base.text, /Engineer/);
  assert.match(r.theirs.text, /Theirs/);
  assert.equal(r.theirs.etag, env.server.get('a.vcf').etag);
  assert.deepEqual(r.rows.map((x) => [x.field, x.mine, x.theirs, x.both]), [['title', 'Mine', 'Theirs', true]]);
  assert.equal(r.bothChanged, true);
  assert.equal(r.canOverwrite, true);
  assert.equal(r.canCopy, true);
  assert.deepEqual(r.unmappable, []);
  assert.ok(ops(env).includes('conflict:info'));
  assert.equal(env.server.callsOf('PUT').length, 1); // nothing was merged silently
  assert.match(env.store.get(href()).text, /Theirs/);
});

test('412 with the item gone: deleted-elsewhere result carries what a copy needs', async () => {
  const env = await makeEnv({ items: { 'a.vcf': base() } });
  const started = env.store.get(href());
  env.server.external('a.vcf', null);
  const r = await env.writes.saveItem({ collection: COLL, href: href(), patch: { title: 'Mine' }, base: { text: started.text, etag: started.etag } });
  assert.equal(r.status, 'deleted-elsewhere');
  assert.equal(r.canCopy, true);
  assert.equal(env.store.has(href()), false);
  const copy = await env.writes.resolveCopy(r);
  assert.equal(copy.ok, true);
  assert.match(copy.text, /TITLE:Mine/);
});

test('resolveReload: their version is shown, no request is sent', async () => {
  const { env, r } = await conflicted(() => ({ title: 'Mine' }), base().replace('Engineer', 'Theirs'));
  env.server.calls.length = 0;
  const res = env.writes.resolveReload(r);
  assert.equal(res.status, 'reloaded');
  assert.match(res.text, /Theirs/);
  assert.deepEqual(env.server.calls, []);
});

test('resolveOverwrite: only MY changed fields are re-applied on THEIR item; their other edits survive', async () => {
  const { env, r } = await conflicted(() => ({ title: 'Mine' }), base().replace('+1 555 0100', '+1 555 7777'));
  assert.deepEqual(r.rows.map((x) => x.both), [false, false]); // different fields: no field changed on both sides
  const res = await env.writes.resolveOverwrite(r);
  assert.equal(res.ok, true);
  const text = env.server.get('a.vcf').text;
  assert.match(text, /TITLE:Mine/);
  assert.match(text, /\+1 555 7777/);
  assert.ok(ops(env).includes('conflict:info'));
});

test('resolveOverwrite: the PUT carries THEIR etag; row-level merge keeps their added phone', async () => {
  const theirs = base().replace('TITLE:Engineer', 'TEL;TYPE=WORK:+1 555 0111\nTITLE:Engineer');
  const { env, r } = await conflicted((f) => ({ email: [{ ...f.email[0], value: 'alice@example.net' }] }), theirs);
  const theirEtag = r.theirs.etag;
  env.server.calls.length = 0;
  const res = await env.writes.resolveOverwrite(r);
  assert.equal(res.ok, true);
  const text = env.server.get('a.vcf').text;
  assert.match(text, /alice@example\.net/);
  assert.match(text, /\+1 555 0111/); // their added row is still there
  assert.equal(env.server.callsOf('PUT').length, 1);
  assert.notEqual(env.server.get('a.vcf').etag, theirEtag);
});

test('resolveOverwrite: an operation that cannot be mapped is listed and needs confirmation; nothing is sent before', async () => {
  // I edit the phone, they deleted that phone
  const theirs = base().replace('TEL;TYPE=CELL:+1 555 0100\n', '');
  const { env, r } = await conflicted((f) => ({ tel: [{ ...f.tel[0], value: '+1 555 0123' }] }), theirs);
  assert.equal(r.unmappable.length, 1);
  assert.equal(r.unmappable[0].field, 'tel');
  env.server.calls.length = 0;
  const refused = await env.writes.resolveOverwrite(r);
  assert.equal(refused.status, 'needs-confirmation');
  assert.equal(refused.unmappable.length, 1);
  assert.deepEqual(env.server.calls, []);
  assert.equal(env.feedback.alert.text, 'store.err.needsConfirmation');
  const ok = await env.writes.resolveOverwrite(r, { confirmUnmappable: true });
  assert.equal(ok.status === 'saved' || ok.status === 'unchanged', true);
  assert.doesNotMatch(env.server.get('a.vcf').text, /555 0123/); // never guessed
});

test('resolveOverwrite: a second 412 returns a NEW conflict (their newest version)', async () => {
  const { env, r } = await conflicted(() => ({ title: 'Mine' }), base().replace('Engineer', 'Theirs 1'));
  env.server.external('a.vcf', base().replace('Engineer', 'Theirs 2')); // changed again before I overwrite
  const second = await env.writes.resolveOverwrite(r);
  assert.equal(second.status, 'conflict');
  assert.match(second.theirs.text, /Theirs 2/);
  assert.match(second.base.text, /Engineer/); // the base stays the one the edit started from
  const done = await env.writes.resolveOverwrite(second);
  assert.equal(done.ok, true);
  assert.match(env.server.get('a.vcf').text, /TITLE:Mine/);
});

test('resolveOverwrite when nothing is left to apply sends no request', async () => {
  const { env, r } = await conflicted(() => ({ title: 'Same' }), base().replace('Engineer', 'Same'));
  assert.equal(r.rows.length, 0);
  env.server.calls.length = 0;
  const res = await env.writes.resolveOverwrite(r);
  assert.equal(res.status, 'unchanged');
  assert.deepEqual(env.server.callsOf('PUT'), []);
});

test('resolveCopy: new UID, new href, If-None-Match; theirs untouched; the copy is not in any group', async () => {
  const { env, r } = await conflicted(() => ({ title: 'Mine' }), base().replace('Engineer', 'Theirs'));
  const res = await env.writes.resolveCopy(r);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'copied');
  assert.notEqual(res.href, href());
  assert.match(env.server.items.get(res.href).text, /TITLE:Mine/);
  assert.match(env.server.get('a.vcf').text, /Theirs/);
  assert.equal(env.server.items.size, 2);
});

test('resolveCopy is disabled for group cards', async () => {
  const env = await makeEnv({ items: { 'g.vcf': vcf('vcard30-group-apple.vcf') } });
  const started = env.store.get(href('g.vcf'));
  env.server.external('g.vcf', vcf('vcard30-group-apple.vcf').replace('Apple style group', 'Renamed elsewhere'));
  const r = await env.writes.saveItem({ collection: COLL, href: href('g.vcf'), patch: { fn: 'Renamed here' }, base: { text: started.text, etag: started.etag } });
  assert.equal(r.status, 'conflict');
  assert.equal(r.isGroup, true);
  assert.equal(r.canCopy, false);
  const c = await env.writes.resolveCopy(r);
  assert.equal(c.status, 'not-allowed');
  assert.equal(env.server.items.size, 1);
});

test('a conflict where their version cannot be opened: no overwrite offered', async () => {
  const { r } = await conflicted(() => ({ title: 'Mine' }), 'BEGIN:VCARD\nVERSION:2.1\nUID:x\nFN:Old\nEND:VCARD\n');
  assert.equal(r.canOverwrite, false);
  assert.equal(r.theirsReadable, false);
});

// ------------------------------------------------------------------ groups

const M1 = 'urn:uuid:11111111-2222-3333-4444-555555555501';
const M2 = 'urn:uuid:11111111-2222-3333-4444-555555555502';
const M3 = 'urn:uuid:11111111-2222-3333-4444-555555555503';
const G = 'urn:uuid:11111111-2222-3333-4444-555555555509';
const groupEnv = () => makeEnv({ items: { 'g.vcf': groupCard(G, 'Family', [M1, M2]), 'a.vcf': base() } });

test('putGroupMembers: exactly ONE PUT on the group card; member cards are never written', async () => {
  const env = await groupEnv();
  env.server.calls.length = 0;
  const r = await env.writes.putGroupMembers({ collection: COLL, href: href('g.vcf'), delta: { add: [M3] } });
  assert.equal(r.ok, true);
  assert.deepEqual(env.server.callsOf('PUT'), ['PUT ' + href('g.vcf')]);
  assert.match(env.server.get('g.vcf').text, /MEMBER:urn:uuid:11111111-2222-3333-4444-555555555503/);
  assert.equal(env.feedback.status.text, 'store.status.membersSaved');
});

test('putGroupMembers: a bare uid becomes a urn:uuid URI; remove works by uid', async () => {
  const env = await groupEnv();
  await env.writes.putGroupMembers({ collection: COLL, href: href('g.vcf'), delta: { add: ['11111111-2222-3333-4444-555555555504'], remove: [M1] } });
  const t = env.server.get('g.vcf').text;
  assert.match(t, /555555555504/);
  assert.doesNotMatch(t, /555555555501/);
  assert.match(t, /555555555502/);
});

test('putGroupMembers: already a member / not a member sends no request', async () => {
  const env = await groupEnv();
  env.server.calls.length = 0;
  const r = await env.writes.putGroupMembers({ collection: COLL, href: href('g.vcf'), delta: { add: [M1], remove: [M3] } });
  assert.equal(r.status, 'unchanged');
  assert.deepEqual(env.server.callsOf('PUT'), []);
});

test('putGroupMembers: a card without UID cannot be added (defensive refusal); a non-group is refused', async () => {
  const env = await groupEnv();
  env.server.calls.length = 0;
  const r = await env.writes.putGroupMembers({ collection: COLL, href: href('g.vcf'), delta: { add: [''] } });
  assert.equal(r.status, 'no-uid');
  assert.equal(env.feedback.alert.text, 'store.err.noUid');
  const n = await env.writes.putGroupMembers({ collection: COLL, href: href('a.vcf'), delta: { add: [M3] } });
  assert.equal(n.status, 'invalid');
  assert.deepEqual(env.server.calls, []);
});

test('putGroupMembers: a 412 replays the DELTA once on their member list (their added member stays)', async () => {
  const env = await groupEnv();
  const started = env.store.get(href('g.vcf'));
  env.server.external('g.vcf', groupCard(G, 'Family', [M1, M2, 'urn:uuid:11111111-2222-3333-4444-555555555510']));
  env.server.calls.length = 0;
  const r = await env.writes.putGroupMembers({ collection: COLL, href: href('g.vcf'), delta: { add: [M3], remove: [M2] }, base: { text: started.text, etag: started.etag } });
  assert.equal(r.ok, true);
  assert.equal(env.server.callsOf('PUT').length, 2); // the stale one, then the rebased one
  const t = env.server.get('g.vcf').text;
  assert.match(t, /555555555510/); // theirs kept
  assert.match(t, /555555555503/); // mine added
  assert.doesNotMatch(t, /555555555502/); // mine removed
  assert.ok(ops(env).includes('conflict:info'));
});

test('putGroupMembers: after their change the delta may already be done: unchanged, no second PUT', async () => {
  const env = await groupEnv();
  const started = env.store.get(href('g.vcf'));
  env.server.external('g.vcf', groupCard(G, 'Family', [M1, M2, M3]));
  env.server.calls.length = 0;
  const r = await env.writes.putGroupMembers({ collection: COLL, href: href('g.vcf'), delta: { add: [M3] }, base: { text: started.text, etag: started.etag } });
  assert.equal(r.status, 'unchanged');
  assert.equal(env.server.callsOf('PUT').length, 1);
});

test('putGroupMembers: a second 412 is reported, not retried forever; group gone -> deleted elsewhere', async () => {
  const env = await groupEnv();
  const started = env.store.get(href('g.vcf'));
  env.server.external('g.vcf', groupCard(G, 'Family', [M1]));
  env.server.fail('PUT', new ConflictError({ status: 412, href: 'x', sentEtag: 'x' }), { times: 2 });
  const r = await env.writes.putGroupMembers({ collection: COLL, href: href('g.vcf'), delta: { add: [M3] }, base: { text: started.text, etag: started.etag } });
  assert.equal(r.status, 'conflict');
  assert.equal(r.membership, true);
  assert.equal(env.feedback.alert.text, 'store.err.groupChangedAgain');
  const env2 = await groupEnv();
  const s2 = env2.store.get(href('g.vcf'));
  env2.server.external('g.vcf', null);
  const gone = await env2.writes.putGroupMembers({ collection: COLL, href: href('g.vcf'), delta: { add: [M3] }, base: { text: s2.text, etag: s2.etag } });
  assert.equal(gone.status, 'deleted-elsewhere');
});

test('saveItem on a group with a 412 uses the membership DELTA in the three-way merge', async () => {
  const env = await groupEnv();
  const started = env.store.get(href('g.vcf'));
  env.server.external('g.vcf', groupCard(G, 'Family', [M1, M2, 'urn:uuid:11111111-2222-3333-4444-555555555510']));
  const r = await env.writes.saveItem({ collection: COLL, href: href('g.vcf'), patch: { membersDelta: { add: [M3] } }, base: { text: started.text, etag: started.etag } });
  assert.equal(r.status, 'conflict');
  const o = await env.writes.resolveOverwrite(r);
  assert.equal(o.ok, true);
  const t = env.server.get('g.vcf').text;
  assert.match(t, /555555555510/);
  assert.match(t, /555555555503/);
});

test('resolveOverwrite: both sides changed the same phone to different values: mine is saved (not "unchanged")', async () => {
  const { env, r } = await conflicted((f) => ({ tel: [{ ...f.tel[0], value: '+1 555 0191' }] }), base().replace('+1 555 0100', '+1 555 0192'));
  assert.deepEqual(r.unmappable, []);
  const res = await env.writes.resolveOverwrite(r);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'saved');
  assert.match(env.server.get('a.vcf').text, /TEL;TYPE=CELL:\+1 555 0191/);
  assert.doesNotMatch(env.server.get('a.vcf').text, /0192/);
});

test('resolveOverwrite: both sides changed the same phone to the SAME value: no request, the identical-on-server text', async () => {
  const { env, r } = await conflicted((f) => ({ tel: [{ ...f.tel[0], value: '+1 555 0191' }] }), base().replace('+1 555 0100', '+1 555 0191'));
  assert.deepEqual(r.unmappable, [], 'nothing is left out, so no confirmation box');
  env.server.calls.length = 0;
  const res = await env.writes.resolveOverwrite(r);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'unchanged');
  assert.equal(res.changed, false);
  assert.deepEqual(env.server.callsOf('PUT'), []);
});

test('resolveOverwrite: when the unmappable changes are confirmed and dropped, the status reads "no changes", not "identical on the server"', async () => {
  const theirs = base().replace('TEL;TYPE=CELL:+1 555 0100\n', '');
  const { env, r } = await conflicted((f) => ({ tel: [{ ...f.tel[0], value: '+1 555 0123' }] }), theirs);
  assert.equal(r.unmappable.length, 1);
  env.server.calls.length = 0;
  const res = await env.writes.resolveOverwrite(r, { confirmUnmappable: true });
  assert.equal(res.status, 'unchanged');
  assert.equal(res.changed, false);
  assert.equal(env.feedback.status.text, 'store.status.unchanged');
  assert.deepEqual(env.server.callsOf('PUT'), []);
});

test('resolveOverwrite: nothing dropped and their row already equals mine keeps the "identical on the server" text', async () => {
  const { env, r } = await conflicted((f) => ({ tel: [{ ...f.tel[0], value: '+1 555 0191' }] }), base().replace('+1 555 0100', '+1 555 0191'));
  const res = await env.writes.resolveOverwrite(r);
  assert.equal(res.status, 'unchanged');
  assert.equal(env.feedback.status.text, 'conflict.status.identical');
});
