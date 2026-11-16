// SPDX-License-Identifier: AGPL-3.0-or-later
// The sharing dialog (administrator and owner variants) and its entry points on the collections list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openShareDialog } from '../../../src/js/views/collections/sharedialog.js';
import { mount as mountCollections } from '../../../src/js/views/collections/screen.js';
import { adminStoreFor } from '../../../src/js/views/users/adminstore.js';
import { acct, apiError, fixture, flush, grant, plain, reset, tFor, tid, tidAll, doc } from './users-helpers.mjs';
import { entry, fakeDav, fakeStore, makeCtx } from './collections-helpers.mjs';
import { change, choose, fire, pressEscape, type } from '../widgets/_dom.mjs';

const t = tFor('en');
const tp = (k, n, p) => t(`${k}.${n === 1 ? 'one' : 'other'}`, { n, ...(p || {}) });
const COLLECTION = { owner: 'alice', name: 'work', href: '/alice/work/', displayName: 'Work' };

function open(fx, { isAdmin = true, collection = COLLECTION } = {}) {
  reset();
  const admin = adminStoreFor({ app: fx.app, store: fx.store });
  const p = openShareDialog({ t, tp, app: fx.app, admin, isAdmin, collection });
  return p;
}
const row = (login) => tidAll('share-row').find((r) => r.getAttribute('data-login') === login);
const selOf = (login) => row(login).querySelector('[data-testid="share-select"]');
const resultOf = (login) => row(login).querySelector('[data-testid="share-result"]');
const putCalls = (fx) => fx.api.calls.filter((c) => c.startsWith('putGrant'));

test('administrator: current grants are listed, changes are a draft, the preview names each one, nothing is sent yet', async () => {
  const fx = fixture({ grants: [grant('alice', 'work', 'bob', 'read'), grant('alice', 'other', 'carol', 'read')] });
  const p = open(fx);
  assert.match(tid('share-status').textContent, /Loading who has access/);
  assert.equal(tid('share-apply').disabled, true);
  await flush(12);
  assert.equal(plain(doc.body.querySelector('#dialog-share-title').textContent), 'Share “Work”');
  assert.ok(tid('rights-limits-note'), 'the limits note is in the dialog');
  assert.equal(tid('share-table').tagName, 'TABLE');
  assert.deepEqual(tidAll('share-row').map((r) => r.getAttribute('data-login')), ['bob'], 'only grants on THIS collection');
  assert.equal(selOf('bob').value, 'read');
  assert.match(plain(tid('share-current').textContent), /Shared with: bob \(read access\)/);
  assert.match(tid('share-preview').textContent, /No change yet/);
  assert.equal(tid('share-apply').disabled, true);
  // the picker offers enabled accounts except the owner, the ones already listed and the administrators
  const offered = tid('field-share-grantee').querySelectorAll('option').map((o) => o.value);
  assert.deepEqual(offered, ['agent-1', 'carol']);
  choose(tid('field-share-grantee'), 'carol');
  tid('btn-share-add').click();
  assert.equal(selOf('carol').value, 'read');
  assert.deepEqual(tid('field-share-grantee').querySelectorAll('option').map((o) => o.value), ['agent-1']);
  selOf('bob').value = 'none';
  change(selOf('bob'));
  const changes = tidAll('share-change');
  assert.deepEqual(changes.map((c) => c.getAttribute('data-login')), ['bob', 'carol']);
  assert.match(plain(changes[0].textContent), /remove all access of bob to alice\/work/);
  assert.match(plain(changes[1].textContent), /give carol read access to alice\/work/);
  assert.equal(tid('share-apply').textContent, 'Apply 2 changes');
  assert.equal(tid('share-apply').disabled, false);
  assert.deepEqual(putCalls(fx), [], 'no request before Apply');
  tid('share-cancel').click();
  assert.deepEqual(await p, { applied: 0, failed: 0 });
  assert.deepEqual(putCalls(fx), []);
});

test('apply runs the changes one after the other, shows a result per row and stays open until Close', async () => {
  const fx = fixture({ grants: [grant('alice', 'work', 'bob', 'read')] });
  const p = open(fx);
  await flush(12);
  choose(tid('field-share-grantee'), 'carol');
  tid('btn-share-add').click();
  selOf('carol').value = 'readwrite';
  change(selOf('carol'));
  selOf('bob').value = 'none';
  change(selOf('bob'));
  tid('share-apply').click();
  await flush(20);
  assert.deepEqual(putCalls(fx), ['putGrant(real:alice/work:bob:none)', 'putGrant(real:alice/work:carol:readwrite)']);
  assert.equal(resultOf('bob').getAttribute('data-result'), 'ok');
  assert.equal(resultOf('bob').textContent, 'Removed');
  assert.equal(resultOf('carol').textContent, 'Applied');
  assert.equal(tid('dialog-share').open, true, 'the results stay readable');
  assert.match(plain(tid('share-status').textContent), /2 access changes applied to “Work”/);
  assert.match(plain(fx.feedback.status.text), /2 access changes applied/);
  assert.equal(tid('share-apply').disabled, true, 'nothing left to apply');
  assert.equal(tid('share-cancel').textContent, 'Close');
  assert.match(plain(tid('share-current').textContent), /Shared with: carol \(read \+ write access\)/);
  assert.equal(fx.activity.filter((a) => a.op === 'grant').length, 2);
  tid('share-cancel').click();
  assert.deepEqual(await p, { applied: 2, failed: 0 });
});

test('a refused change is marked on its row, the others still go through, and the failed one stays a pending change', async () => {
  const fx = fixture({ grants: [], fail: { putGrant: (g, dry) => (!dry && g.grantee === 'agent-1' ? apiError('conflict', { status: 409, code: 'grantee_disabled' }) : null) } });
  const p = open(fx);
  await flush(12);
  for (const who of ['agent-1', 'carol']) {
    choose(tid('field-share-grantee'), who);
    tid('btn-share-add').click();
  }
  tid('share-apply').click();
  await flush(20);
  assert.equal(resultOf('agent-1').getAttribute('data-result'), 'error');
  assert.match(resultOf('agent-1').textContent, /disabled and cannot receive access/);
  assert.equal(resultOf('carol').getAttribute('data-result'), 'ok');
  assert.match(plain(tid('share-status').textContent), /1 applied, 1 failed/);
  assert.equal(tid('share-status').getAttribute('role'), 'alert');
  assert.deepEqual(tidAll('share-change').map((c) => c.getAttribute('data-login')), ['agent-1'], 'it can be retried or removed');
  tid('share-cancel').click();
  assert.deepEqual(await p, { applied: 1, failed: 1 });
});

test('owner who is not an administrator: a typed login, no directory, the uniform refusal text, no account probing', async () => {
  const fx = fixture({
    login: 'alice',
    admin: false,
    grants: [],
    fail: { putGrant: (g, dry) => (g.grantee === 'ghost' ? apiError('validation', { status: 422, code: 'validation', field: 'grantee' }) : null) },
  });
  const p = open(fx, { isAdmin: false });
  await flush(12);
  assert.equal(tid('field-share-grantee'), null);
  assert.ok(tid('field-share-login'));
  assert.deepEqual(fx.api.calls.filter((c) => c === 'directory' || c === 'accounts'), [], 'admin-only reads are never made');
  assert.ok(tid('share-nobody'), 'nobody yet');
  // client-side checks
  type(tid('field-share-login'), 'Ali CE');
  assert.equal(tid('field-share-login').value, 'ali ce', 'lower-cased');
  tid('btn-share-add').click();
  assert.match(tid('share-add-error').textContent, /not a valid login/);
  type(tid('field-share-login'), 'alice');
  tid('btn-share-add').click();
  assert.match(tid('share-add-error').textContent, /You own this collection already/);
  type(tid('field-share-login'), 'bob');
  tid('btn-share-add').click();
  type(tid('field-share-login'), 'bob');
  tid('btn-share-add').click();
  assert.match(plain(tid('share-add-error').textContent), /bob is already in the list/);
  assert.deepEqual(tidAll('share-row').map((r) => r.getAttribute('data-login')), ['bob']);
  type(tid('field-share-login'), 'ghost');
  tid('btn-share-add').click();
  tid('share-apply').click();
  await flush(20);
  assert.equal(resultOf('bob').getAttribute('data-result'), 'ok');
  assert.equal(resultOf('ghost').getAttribute('data-result'), 'error');
  assert.equal(resultOf('ghost').textContent, 'No such account, or it cannot receive access.');
  tid('share-cancel').click();
  assert.deepEqual(await p, { applied: 1, failed: 1 });
});

test('Esc closes the dialog without applying; a failed read says so and offers nothing to apply', async () => {
  let fx = fixture({ grants: [grant('alice', 'work', 'bob', 'read')] });
  let p = open(fx);
  await flush(12);
  selOf('bob').value = 'none';
  change(selOf('bob'));
  assert.equal(pressEscape(tid('dialog-share')), 'closed');
  assert.deepEqual(await p, { applied: 0, failed: 0 });
  assert.deepEqual(putCalls(fx), []);
  fx = fixture({ fail: { grants: apiError('network', {}) } });
  p = open(fx);
  await flush(12);
  assert.match(tid('share-status').textContent, /could not be read/);
  assert.equal(tid('share-status').getAttribute('role'), 'alert');
  assert.equal(tid('share-apply').disabled, true);
  tid('share-cancel').click();
  await p;
});

// ------------------------------------------------------------------ the collections list

function collectionsFixture({ grants = [], route = { name: 'collections', query: {}, params: {} }, putFail = null } = {}) {
  const root = reset();
  const own = entry();
  const sharedWithMe = entry({ href: '/bob/team/', name: 'team', displayName: 'Team', owner: 'bob', source: 'grant', level: 'read', ownerIsMe: false, readOnly: true });
  const store = fakeStore({ list: [own, sharedWithMe] });
  const state = { grants: grants.slice() };
  const calls = [];
  const api = {
    async grants(q) {
      calls.push('grants');
      return state.grants.filter((g) => !q || !q.owner || g.owner === q.owner).map((g) => ({ ...g }));
    },
    async directory() {
      return [];
    },
    async putGrant(g, { dryRun = false } = {}) {
      calls.push(`putGrant(${dryRun ? 'dry' : 'real'}:${g.grantee}:${g.level})`);
      if (putFail) throw putFail;
      if (dryRun) return { dryRun: true, generation: 3, active: true };
      state.grants = state.grants.filter((x) => !(x.collection === g.collection && x.grantee === g.grantee));
      if (g.level !== 'none') state.grants.push({ ...g, grantedBy: 'alice', created: '2026-03-07T12:00:00Z' });
      return { grant: g.level === 'none' ? null : { ...g, grantedBy: 'alice', created: '2026-03-07T12:00:00Z' }, generation: 4, active: true };
    },
  };
  store.session = { login: 'alice', data: new Map(), disposed: false };
  store.reporter = { text: (k, p) => t(k, p), log() {}, status: (k, p) => t(k, p), alert: (k, p) => t(k, p) };
  const ctx = makeCtx({ root, store, dav: fakeDav(), api, route });
  const ctl = mountCollections(ctx);
  return { root, ctx, ctl, store, api, calls, state };
}

test('collections list: Share only on the rows you own; it goes to ?dialog=share&href=', async () => {
  const f = collectionsFixture();
  await flush(12);
  const rows = tidAll('collection-row');
  const own = rows.find((r) => r.getAttribute('data-href') === '/alice/cal/');
  const shared = rows.find((r) => r.getAttribute('data-href') === '/bob/team/');
  const btn = own.querySelector('[data-testid="btn-share"]');
  assert.ok(btn);
  assert.equal(plain(btn.getAttribute('aria-label')), 'Share “Family”');
  assert.equal(shared.querySelector('[data-testid="btn-share"]'), null);
  btn.click();
  assert.deepEqual(f.ctx.app.nav.at(-1), { hash: '#/collections?dialog=share&href=%2Falice%2Fcal%2F', opts: undefined });
});

test('collections list: the share route opens the dialog, and an applied change refreshes the "Shared with" line', async () => {
  const f = collectionsFixture({ route: { name: 'collections', query: { dialog: 'share', href: '/alice/cal/' }, params: {} } });
  await flush(20);
  assert.ok(tid('dialog-share'));
  const own = () => tidAll('collection-row').find((r) => r.getAttribute('data-href') === '/alice/cal/');
  assert.match(own().querySelector('[data-testid="shared-with"]').textContent, /Private to you/);
  type(tid('field-share-login'), 'bob');
  tid('btn-share-add').click();
  tid('share-apply').click();
  await flush(20);
  assert.deepEqual(f.calls.filter((c) => c.startsWith('putGrant')), ['putGrant(real:bob:read)']);
  tid('share-cancel').click();
  await flush(20);
  assert.match(plain(own().querySelector('[data-testid="shared-with"]').textContent), /Shared with: bob \(read\)/);
  assert.deepEqual(f.ctx.app.nav.at(-1), { hash: '#/collections', opts: { replace: true } });
});

test('collections list: share for a collection you do not own is refused with a text', async () => {
  const f = collectionsFixture({ route: { name: 'collections', query: { dialog: 'share', href: '/bob/team/' }, params: {} } });
  await flush(20);
  assert.equal(tid('dialog-share'), null);
  assert.match(f.ctx.app.feedback.alert.text, /not allowed/);
});
