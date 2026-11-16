// SPDX-License-Identifier: AGPL-3.0-or-later
// The Users screens on the fake DOM: access states, the accounts table, the create form, the account view with its
// lock-out guards and flows, the permission matrix. The real admin store runs on a recording account-service fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../../../src/js/views/users/screen.js';
import { acct, apiError, coll, doc, fixture, flush, grant, plain, reset, tid, tidAll } from './users-helpers.mjs';
import { change, chooseRadio, choose, fire, type } from '../widgets/_dom.mjs';

async function open(fx, route, { restore = null } = {}) {
  const root = reset();
  const ctx = fx.ctxFor(root, route, restore);
  const ctl = mount(ctx);
  await flush(12);
  return { root, ctl, ctx };
}
const R = {
  users: { name: 'users', query: {}, params: {} },
  new: { name: 'user-new', query: {}, params: {} },
  matrix: (query = {}) => ({ name: 'users-permissions', query, params: {} }),
  user: (login, query = {}) => ({ name: 'user', query, params: { login } }),
};
const within = (row, id) => row.querySelector(`[data-testid="${id}"]`);
const ack = async () => {
  const box = tid('field-pw-saved');
  box.checked = true;
  fire(box, 'change');
  tid('btn-password-saved').click();
  await flush();
};

// ------------------------------------------------------------------ access states

test('a non-administrator sees access-required (role=alert) and the service is never called', async () => {
  const fx = fixture({ login: 'bob', admin: false });
  for (const route of [R.users, R.new, R.matrix(), R.user('alice')]) {
    await open(fx, route);
    const box = tid('access-required');
    assert.ok(box, route.name);
    assert.equal(box.getAttribute('role'), 'alert');
    assert.match(plain(box.textContent), /The account bob is not an administrator/);
    assert.equal(tid('users-screen').getAttribute('data-state'), 'ready');
  }
  assert.deepEqual(fx.api.calls, []);
});

test('a read error shows users-error with a working Try again', async () => {
  let fail = true;
  const fx = fixture({ fail: { accounts: () => (fail ? apiError('network', { message: 'down' }) : null) } });
  await open(fx, R.users);
  assert.equal(tid('users-screen').getAttribute('data-state'), 'error');
  assert.equal(tid('users-error').hidden, false);
  assert.match(tid('users-error-text').textContent, /could not be reached|could not be loaded/);
  fail = false;
  tid('btn-retry').click();
  await flush(12);
  assert.equal(tid('users-screen').getAttribute('data-state'), 'ready');
  assert.equal(tid('users-error').hidden, true);
  assert.equal(tidAll('account-row').length, 4);
});

test('m5: when the second read (the collection counts) fails, the cells show "?" with the reason and are no longer busy', async () => {
  let n = 0;
  const fx = fixture({ fail: { accounts: () => (++n >= 2 ? apiError('network', { message: 'down' }) : null) } });
  await open(fx, R.users);
  await flush(12);
  const cells = tidAll('own-count');
  assert.ok(cells.length >= 4);
  for (const c of cells) {
    assert.equal(c.getAttribute('aria-busy'), 'false');
    assert.equal(plain(c.textContent), '?');
    assert.match(c.querySelector('span').getAttribute('title'), /could not be counted/);
  }
});

// ------------------------------------------------------------------ accounts table

test('accounts table: a real table, one row per account, chips, status line, lazy own-collection counts', async () => {
  const accounts = [acct('alice', { admin: true }), acct('bob'), acct('carol', { disabled: true }), acct('agent-1', { type: 'bot' }), acct('dave', { ownSpace: false })];
  const fx = fixture({ accounts });
  await open(fx, R.users);
  assert.equal(tid('users-screen').getAttribute('data-state'), 'ready');
  assert.equal(tid('accounts-table').tagName, 'TABLE');
  assert.equal(tid('users-status').getAttribute('role'), 'status');
  assert.equal(tid('users-status').textContent, '5 accounts · 1 disabled');
  const rows = tidAll('account-row');
  assert.deepEqual(rows.map((r) => r.getAttribute('data-login')), ['agent-1', 'alice', 'bob', 'carol', 'dave']);
  const bob = rows.find((r) => r.getAttribute('data-login') === 'bob');
  assert.equal(within(bob, 'chip-type').getAttribute('data-type'), 'person');
  assert.equal(within(bob, 'chip-admin').getAttribute('data-admin'), 'no');
  assert.equal(within(bob, 'chip-status').getAttribute('data-status'), 'active');
  assert.equal(within(rows[1], 'chip-admin').getAttribute('data-admin'), 'yes');
  assert.equal(within(rows[0], 'chip-type').getAttribute('data-type'), 'bot');
  assert.equal(within(rows[3], 'chip-status').getAttribute('data-status'), 'disabled');
  assert.equal(within(bob, 'account-link').getAttribute('href'), '#/users/bob');
  assert.equal(plain(within(bob, 'account-link').getAttribute('aria-label')), 'Open bob: what can it access?');
  assert.equal(tid('btn-new-account').getAttribute('href'), '#/users/new');
  assert.match(within(bob, 'chip-type').parentNode.getAttribute('data-label'), /Type/);
  // counts arrive afterwards: alice owns 2, bob 2 (notes + book), the disabled one and the one without own space show no number
  assert.equal(within(rows[1], 'own-count').getAttribute('data-count'), '2');
  assert.equal(within(bob, 'own-count').getAttribute('data-count'), '2');
  assert.equal(within(rows[0], 'own-count').getAttribute('aria-busy'), 'false');
  assert.match(within(rows[4], 'own-count').textContent, /own space off/);
  assert.equal(within(rows[3], 'own-count').textContent, '–');
  assert.equal(tid('rights-limits-note'), null, 'the limits note belongs to the permission screens');
});

// ------------------------------------------------------------------ create account

const fillForm = (login, name) => {
  type(tid('field-acct-login'), login);
  type(tid('field-acct-name'), name);
};

test('create form: validation messages next to the fields, nothing sent, focus on the first error', async () => {
  const fx = fixture();
  await open(fx, R.new);
  assert.equal(tid('account-form').getAttribute('aria-busy'), 'false');
  type(tid('field-acct-login'), 'Bob Smith');
  assert.equal(tid('field-acct-login').value, 'bob smith', 'lower-cased as you type');
  fire(tid('account-form'), 'submit');
  await flush();
  assert.equal(tid('form-errors').hidden, false);
  assert.equal(tid('form-errors').getAttribute('role'), 'alert');
  assert.match(tid('form-errors').textContent, /2 fields need attention\. Nothing was created\./);
  assert.match(tid('field-acct-login-error').textContent, /2 to 32 characters/);
  assert.match(tid('field-acct-name-error').textContent, /Enter a display name/);
  assert.equal(tid('field-acct-login').getAttribute('aria-invalid'), 'true');
  assert.equal(doc.activeElement, tid('field-acct-login'));
  assert.deepEqual(fx.api.calls.filter((c) => c.startsWith('createAccount')), []);
  // reserved name, then a typed weak password
  type(tid('field-acct-login'), 'admin');
  fire(tid('field-acct-name'), 'input');
  type(tid('field-acct-name'), 'Admin');
  chooseRadio(tid('pw-mode-typed'), doc);
  assert.equal(tid('pw-typed-box').hidden, false);
  type(tid('field-acct-password'), 'abc123');
  assert.equal(tid('pw-strength').getAttribute('role'), 'meter');
  assert.ok(Number(tid('pw-strength').getAttribute('aria-valuenow')) <= 1);
  assert.match(tid('pw-strength-text').textContent, /Strength: (too weak|weak)/);
  fire(tid('account-form'), 'submit');
  await flush();
  assert.match(tid('field-acct-login-error').textContent, /reserved/);
  assert.match(tid('field-acct-password-error').textContent, /at least 12 characters/);
  assert.deepEqual(fx.api.calls.filter((c) => c.startsWith('createAccount')), []);
});

test('create form: a bot cannot be an administrator; the type radios drive the admin box', async () => {
  const fx = fixture();
  await open(fx, R.new);
  assert.equal(tid('field-acct-admin').disabled, false);
  tid('field-acct-admin').checked = true;
  chooseRadio(tid('acct-type-bot'), doc);
  assert.equal(tid('field-acct-admin').disabled, true);
  assert.equal(tid('field-acct-admin').checked, false);
  chooseRadio(tid('acct-type-person'), doc);
  assert.equal(tid('field-acct-admin').disabled, false);
});

test('create with a generated password: the one-time dialog opens first, navigation waits for the tick, the secret is not logged', async () => {
  const fx = fixture();
  await open(fx, R.new);
  fillForm('agent-2', 'Agent Two');
  chooseRadio(tid('acct-type-bot'), doc);
  assert.deepEqual(fx.dirty.at(-1), true, 'the form is dirty once something was typed');
  fire(tid('account-form'), 'submit');
  await flush();
  assert.deepEqual(fx.api.bodies.find((b) => b.method === 'createAccount'), { method: 'createAccount', login: 'agent-2', displayName: 'Agent Two', type: 'bot', ownSpace: true, generate: true, dryRun: false });
  const dlg = tid('dialog-password-once');
  assert.ok(dlg, 'the dialog is open');
  assert.equal(tid('generated-password').textContent, 'Abcde-Fghjk-Lmnpq-Rstuv');
  assert.match(plain(dlg.textContent), /The account was created/);
  assert.deepEqual(fx.nav, [], 'no navigation before the tick');
  assert.equal(fx.dirty.at(-1), false);
  await ack();
  assert.deepEqual(fx.nav.map((n) => n.hash), ['#/users/agent-2']);
  assert.match(plain(fx.feedback.status.text), /Account agent-2 created\./);
  assert.equal(fx.activity.some((a) => JSON.stringify(a).includes('Abcde')), false);
  assert.equal(fx.activity.filter((a) => a.op === 'account').length, 1);
});

test('create with a typed password: no dialog, the password goes out once and is cleared from the field', async () => {
  const fx = fixture();
  await open(fx, R.new);
  fillForm('dave', 'Dave Example');
  chooseRadio(tid('pw-mode-typed'), doc);
  type(tid('field-acct-password'), 'Correct-Horse-9');
  fire(tid('field-acct-show'), 'change');
  fire(tid('account-form'), 'submit');
  await flush();
  assert.equal(tid('dialog-password-once'), null);
  const body = fx.api.bodies.find((b) => b.method === 'createAccount');
  assert.equal(body.password, 'Correct-Horse-9');
  assert.equal(body.generate, undefined);
  assert.equal(tid('field-acct-password').value, '');
  assert.deepEqual(fx.nav.map((n) => n.hash), ['#/users/dave']);
  assert.equal(JSON.stringify(fx.activity).includes('Correct-Horse'), false);
});

test('create form: a server answer maps onto its field (taken login) and the form keeps what was typed', async () => {
  const fx = fixture({ fail: { createAccount: () => apiError('conflict', { status: 409, code: 'exists' }) } });
  await open(fx, R.new);
  fillForm('bob', 'Another Bob');
  fire(tid('account-form'), 'submit');
  await flush();
  assert.match(plain(tid('field-acct-login-error').textContent), /The login “bob” is already taken/);
  assert.equal(tid('field-acct-login').value, 'bob');
  assert.equal(tid('field-acct-name').value, 'Another Bob');
  assert.equal(tid('account-form').getAttribute('aria-busy'), 'false');
  assert.deepEqual(fx.nav, []);
  assert.ok(fx.feedback.alert, 'the alert region carries the service text too');
});

test('create form: a language switch keeps the typed values (snapshot without the password)', async () => {
  const fx = fixture();
  const { ctl } = await open(fx, R.new);
  fillForm('dave', 'Dave');
  chooseRadio(tid('pw-mode-typed'), doc);
  type(tid('field-acct-password'), 'Correct-Horse-9');
  const snap = ctl.snapshot();
  assert.equal(JSON.stringify(snap).includes('Correct-Horse'), false);
  assert.deepEqual([snap.login, snap.name, snap.mode], ['dave', 'Dave', 'typed']);
  ctl.dispose();
  await open(fx, R.new, { restore: snap });
  assert.equal(tid('field-acct-login').value, 'dave');
  assert.equal(tid('pw-typed-box').hidden, false);
});

// ------------------------------------------------------------------ account view

const bobGrants = [grant('alice', 'work', 'bob', 'read'), grant('carol', 'shared', 'bob', 'readwrite'), grant('bob', 'notes', 'agent-1', 'read')];

test('account view: details, own collections with Share, grants table, effective access, the limits note', async () => {
  const fx = fixture({ grants: bobGrants, effective: { bob: [{ path: '/', level: 'root', letters: 'R' }, { path: '/bob/*', level: 'own', letters: 'rwDO' }, { path: '/alice/work', level: 'grant-r', letters: 'r' }, { path: '/carol/shared', level: 'grant-rw', letters: 'rwl' }] } });
  await open(fx, R.user('bob'));
  assert.equal(tid('account-view').getAttribute('data-login'), 'bob');
  assert.equal(tid('users-screen').getAttribute('data-state'), 'ready');
  assert.equal(tid('acct-status').textContent, 'Active');
  assert.equal(plain(tid('access-title').textContent), 'What can bob access?');
  assert.ok(tid('rights-limits-note'));
  assert.equal(tidAll('own-collection').length, 2);
  assert.match(tidAll('own-shared')[0].textContent + tidAll('own-shared')[1].textContent, /Shared with: agent-1 \(read access\)/);
  assert.equal(tidAll('btn-share').length, 2);
  const grants = tidAll('grant-row');
  assert.deepEqual(grants.map((r) => r.getAttribute('data-owner') + '/' + r.getAttribute('data-coll')), ['alice/work', 'carol/shared']);
  assert.deepEqual(tidAll('grant-select').map((s) => s.value), ['read', 'readwrite']);
  assert.equal(plain(tidAll('grant-select')[0].getAttribute('aria-label')), 'Access of bob to alice/work');
  const eff = tidAll('effective-row');
  assert.deepEqual(eff.map((r) => [r.getAttribute('data-level'), r.getAttribute('data-why')]), [['own', 'owner'], ['grant-r', 'grant'], ['grant-rw', 'grant']]);
  assert.match(plain(tid('effective-summary').textContent), /bob will reach 3 collections/);
  assert.ok(tid('add-access-form'), 'once every collection is known the add form appears');
  assert.deepEqual(tid('field-add-coll').querySelectorAll('option').map((o) => o.value), ['alice/book'], 'granted and own collections are not offered');
});

test('account view: yourself and the last administrator cannot be disabled or deleted; the page says why', async () => {
  const fx = fixture({ login: 'alice' });
  await open(fx, R.user('alice'));
  for (const id of ['btn-toggle-disabled', 'btn-delete-account']) {
    const b = tid(id);
    assert.equal(b.getAttribute('aria-disabled'), 'true', id);
    assert.equal(b.getAttribute('aria-describedby'), 'acct-guard');
    b.click();
  }
  assert.equal(tid('acct-guard').getAttribute('data-reason'), 'self');
  assert.match(tid('acct-guard').textContent, /cannot disable, delete or demote the account you are signed in with/);
  assert.equal(tid('field-acct-admin').disabled, true, 'an administrator cannot demote herself');
  assert.equal(tid('btn-reset-password').getAttribute('aria-disabled'), 'true');
  assert.equal(tid('btn-own-settings').getAttribute('href'), '#/settings');
  assert.equal(tid('dialog-delete-account'), null);
  assert.deepEqual(fx.api.calls.filter((c) => /patchAccount|deleteAccount|resetPassword/.test(c)), []);
  // the last administrator, seen by somebody else's session
  const fx2 = fixture({ login: 'zed', accounts: [acct('alice', { admin: true }), acct('zed', { admin: true, disabled: true }), acct('bob')] });
  await open(fx2, R.user('alice'));
  assert.equal(tid('acct-guard').getAttribute('data-reason'), 'lastAdmin');
  assert.equal(tid('btn-delete-account').getAttribute('aria-disabled'), 'true');
  assert.equal(tid('btn-reset-password').getAttribute('aria-disabled'), null, 'resetting somebody else is allowed');
});

test('account view: disable and enable apply at once and say so; the status line follows', async () => {
  const fx = fixture();
  await open(fx, R.user('bob'));
  assert.equal(tid('btn-toggle-disabled').getAttribute('aria-disabled'), null);
  tid('btn-toggle-disabled').click();
  await flush(12);
  assert.ok(fx.api.calls.includes('patchAccount(real:bob:{"disabled":true})'));
  assert.equal(tid('acct-status').textContent, 'Disabled');
  assert.match(plain(fx.feedback.status.text), /bob is disabled\. Its credentials stopped working at once/);
  assert.match(plain(tid('users-status').textContent), /bob: Disabled/);
  assert.equal(tid('btn-toggle-disabled').textContent, 'Enable account');
  assert.equal(doc.activeElement, tid('btn-toggle-disabled'), 'focus stays on the button');
  assert.match(tid('add-access-disabled').textContent, /cannot be given new access/);
  tid('btn-toggle-disabled').click();
  await flush(12);
  assert.equal(tid('acct-status').textContent, 'Active');
});

test('account view: reset password goes through its dialog and shows the password once', async () => {
  const fx = fixture();
  await open(fx, R.user('bob'));
  tid('btn-reset-password').click();
  await flush();
  assert.ok(tid('dialog-reset-password'));
  tid('dialog-confirm-reset').click();
  await flush(12);
  assert.equal(tid('generated-password').textContent, 'Wxyz2-3456a-Bcdef-Ghjkm');
  await ack();
  assert.match(plain(fx.feedback.status.text), /Password of bob reset/);
  assert.deepEqual(fx.api.calls.filter((c) => c.startsWith('resetPassword')), ['resetPassword(bob)']);
});

test('account view: the URL dialog=reset-password opens the dialog; closing it removes the parameter', async () => {
  const fx = fixture();
  await open(fx, R.user('bob', { dialog: 'reset-password' }));
  assert.ok(tid('dialog-reset-password'));
  tid('dialog-cancel').click();
  await flush();
  assert.deepEqual(fx.nav.at(-1), { hash: '#/users/bob', opts: { replace: true } });
});

test('account view: own space off with owned collections needs the typed login, then sends confirm', async () => {
  const fx = fixture({ fail: { confirmRequired: 2 } });
  await open(fx, R.user('bob'));
  const box = tid('field-ownspace');
  box.checked = false;
  change(box);
  await flush(12);
  assert.ok(fx.api.calls.includes('patchAccount(dry:bob:{"ownSpace":false})'));
  const yes = tid('dialog-confirm-ownspace-yes');
  assert.equal(yes.disabled, true);
  assert.equal(fx.api.calls.some((c) => c.startsWith('patchAccount(real')), false, 'nothing applied before the confirmation');
  type(tid('field-confirm-login'), 'bob');
  yes.click();
  await flush(12);
  assert.ok(fx.api.calls.includes('patchAccount(real:bob:{"ownSpace":false,"confirm":"bob"})'));
  assert.match(plain(fx.feedback.status.text), /bob can no longer create its own collections/);
  assert.equal(tid('field-ownspace').checked, false);
});

test('account view: own space off, then Cancel, puts the box back and sends nothing', async () => {
  const fx = fixture({ fail: { confirmRequired: 2 } });
  await open(fx, R.user('bob'));
  const box = tid('field-ownspace');
  box.checked = false;
  change(box);
  await flush(12);
  tid('dialog-cancel').click();
  await flush();
  assert.equal(box.checked, true);
  assert.equal(fx.api.calls.some((c) => c.startsWith('patchAccount(real')), false);
});

test('account view: making an administrator is a named confirmation, and a bot has no such switch', async () => {
  const fx = fixture();
  await open(fx, R.user('bob'));
  const box = tid('field-acct-admin');
  box.checked = true;
  change(box);
  await flush();
  assert.match(plain(tid('dialog-confirm-admin').textContent), /Make bob an administrator\?/);
  tid('dialog-confirm-admin-yes').click();
  await flush(12);
  assert.ok(fx.api.calls.includes('patchAccount(real:bob:{"admin":true})'));
  assert.match(plain(fx.feedback.status.text), /bob is now an administrator/);
  await open(fx, R.user('agent-1'));
  assert.equal(tid('field-acct-admin'), null);
  assert.ok(tid('acct-admin-bot'));
});

test('account view: changing a grant opens the preview, applies on confirm, and a cancel puts the select back', async () => {
  const fx = fixture({ grants: bobGrants });
  await open(fx, R.user('bob'));
  const sel = tidAll('grant-select')[0];
  sel.value = 'readwrite';
  change(sel);
  await flush();
  assert.deepEqual(fx.api.calls.filter((c) => c.startsWith('putGrant')), ['putGrant(dry:alice/work:bob:readwrite)']);
  tid('access-cancel').click();
  await flush();
  assert.equal(sel.value, 'read');
  assert.equal(fx.api.calls.some((c) => c.startsWith('putGrant(real')), false);
  const sel2 = tidAll('grant-select')[0];
  sel2.value = 'none';
  change(sel2);
  await flush();
  tid('access-confirm').click();
  await flush(12);
  assert.ok(fx.api.calls.includes('putGrant(real:alice/work:bob:none)'));
  assert.deepEqual(tidAll('grant-row').map((r) => r.getAttribute('data-coll')), ['shared']);
  assert.match(plain(fx.feedback.status.text), /bob no longer has access to alice\/work/);
});

test('account view: the add-access form previews first, then grants', async () => {
  const fx = fixture({ grants: bobGrants });
  await open(fx, R.user('bob'));
  assert.ok(tid('add-access-form'));
  const options = tid('field-add-coll').querySelectorAll('option').map((o) => o.value);
  assert.ok(options.includes('alice/book'));
  assert.equal(options.includes('alice/work'), false, 'already granted');
  assert.equal(options.some((o) => o.startsWith('bob/')), false, 'its own collections are not offered');
  choose(tid('field-add-coll'), 'alice/book');
  choose(tid('field-add-level'), 'readwrite');
  fire(tid('add-access-form'), 'submit');
  await flush();
  assert.deepEqual(fx.api.calls.filter((c) => c.startsWith('putGrant')), ['putGrant(dry:alice/book:bob:readwrite)']);
  tid('access-confirm').click();
  await flush(12);
  assert.ok(fx.api.calls.includes('putGrant(real:alice/book:bob:readwrite)'));
  assert.ok(tidAll('grant-row').some((r) => r.getAttribute('data-coll') === 'book'));
});

test('account view: delete with "keep data" needs the exact login and calls only the account delete', async () => {
  const fx = fixture({ grants: bobGrants });
  await open(fx, R.user('bob'));
  tid('btn-delete-account').click();
  await flush(12);
  assert.ok(tid('dialog-delete-account'));
  assert.equal(tidAll('delete-collection').length, 2);
  assert.equal(tid('dialog-confirm-delete').disabled, true);
  type(tid('field-confirm-login'), 'Bob');
  assert.equal(tid('dialog-confirm-delete').disabled, true);
  type(tid('field-confirm-login'), 'bob');
  tid('dialog-confirm-delete').click();
  await flush(12);
  assert.deepEqual(fx.deleted, []);
  assert.deepEqual(fx.api.calls.filter((c) => c.startsWith('deleteAccount')), ['deleteAccount(real:bob)']);
  assert.deepEqual(fx.nav.map((n) => n.hash), ['#/users']);
  assert.match(plain(fx.feedback.status.text), /Account bob deleted\. Its data stays on the server\./);
});

test('account view: delete with "delete data" deletes the collections first, one by one, then the account', async () => {
  const fx = fixture();
  await open(fx, R.user('bob'));
  tid('btn-delete-account').click();
  await flush(12);
  tid('delete-data').checked = true;
  tid('delete-keep').checked = false;
  type(tid('field-confirm-login'), 'bob');
  tid('dialog-confirm-delete').click();
  await flush(20);
  assert.deepEqual(fx.deleted, ['/bob/notes/', '/bob/book/']);
  const calls = fx.api.calls.filter((c) => c.startsWith('deleteAccount'));
  assert.deepEqual(calls, ['deleteAccount(dry:bob)', 'deleteAccount(real:bob)']);
  assert.deepEqual(fx.nav.map((n) => n.hash), ['#/users']);
  assert.match(plain(fx.feedback.status.text), /Account bob and its data deleted/);
});

test('account view: an ETag that changed while the dialog was open deletes nothing and shows a persistent alert', async () => {
  const homes = { '/alice/': [], '/bob/': [coll('/bob/notes/'), coll('/bob/book/', { displayName: 'Bob book' })], '/carol/': [], '/agent-1/': [] };
  const fx = fixture({ homes });
  await open(fx, R.user('bob'));
  tid('btn-delete-account').click();
  await flush(12);
  homes['/bob/'] = homes['/bob/'].map((c) => (c.href === '/bob/notes/' ? { ...c, etag: '"e2"' } : c)); // edited elsewhere while the dialog is open
  tid('delete-data').checked = true;
  tid('delete-keep').checked = false;
  type(tid('field-confirm-login'), 'bob');
  tid('dialog-confirm-delete').click();
  await flush(20);
  assert.deepEqual(fx.deleted, []);
  assert.equal(fx.api.calls.some((c) => c === 'deleteAccount(real:bob)'), false);
  assert.match(plain(fx.feedback.alert.text), /data of "bob" changed since you opened this dialog; reopen it/);
  assert.equal(fx.feedback.alert.scope, null);
});

test('account view: a collection that cannot be deleted stops the run; the account stays and the alert lists what is left', async () => {
  const fx = fixture();
  fx.writes.failOn = '/bob/book/';
  await open(fx, R.user('bob'));
  tid('btn-delete-account').click();
  await flush(12);
  tid('delete-data').checked = true;
  tid('delete-keep').checked = false;
  type(tid('field-confirm-login'), 'bob');
  tid('dialog-confirm-delete').click();
  await flush(20);
  assert.deepEqual(fx.deleted, ['/bob/notes/']);
  assert.equal(fx.api.calls.some((c) => c === 'deleteAccount(real:bob)'), false, 'the account delete is never sent after a failure');
  assert.deepEqual(fx.nav, []);
  assert.match(plain(fx.feedback.alert.text), /The account "bob" was kept: 1 collections could not be deleted \(book\)/);
  assert.ok(tid('account-view'), 'the account is still there');
});

test('account view: an unknown login says so', async () => {
  const fx = fixture();
  await open(fx, R.user('nobody'));
  assert.ok(tid('account-missing'));
  assert.equal(tid('users-screen').getAttribute('data-state'), 'ready');
});

// ------------------------------------------------------------------ permission matrix

test('matrix: a real table, owner cells fixed, every other cell a select with a full-sentence name', async () => {
  const fx = fixture({ grants: [grant('alice', 'work', 'bob', 'read'), grant('alice', 'work', 'carol', 'readwrite')] });
  await open(fx, R.matrix());
  assert.equal(tid('permission-matrix').tagName, 'TABLE');
  assert.ok(tid('rights-limits-note'));
  assert.deepEqual(tidAll('matrix-account').map((c) => c.getAttribute('data-login')), ['agent-1', 'bob', 'carol'], 'enabled non-admin accounts only');
  const rows = tidAll('matrix-row');
  assert.deepEqual(rows.map((r) => r.getAttribute('data-owner') + '/' + r.getAttribute('data-uid')), ['alice/book', 'alice/work', 'bob/book', 'bob/notes']);
  const work = rows[1];
  const sel = (login) => work.querySelector(`[data-testid="perm-select"][data-login="${login}"]`);
  assert.equal(sel('bob').value, 'read');
  assert.equal(sel('carol').value, 'readwrite');
  assert.equal(sel('agent-1').value, 'none');
  assert.equal(plain(sel('bob').getAttribute('aria-label')), 'Access of bob to alice/work');
  assert.equal(sel('bob').getAttribute('data-owner'), 'alice');
  assert.equal(sel('bob').getAttribute('data-coll'), 'work');
  assert.deepEqual(sel('bob').querySelectorAll('option').map((o) => o.getAttribute('data-testid')), ['perm-option-none', 'perm-option-r', 'perm-option-rw']);
  assert.equal(plain(sel('bob').querySelectorAll('option')[2].getAttribute('aria-label')), 'Give bob read + write access to alice/work');
  const bobRow = rows[3];
  assert.equal(bobRow.querySelector('[data-testid="perm-fixed"]').textContent, 'Owner');
  assert.equal(bobRow.querySelector('[data-testid="perm-select"][data-login="bob"]'), null);
  assert.match(tid('users-status').textContent, /4 collections · 3 accounts/);
});

test('matrix: a change previews (dry run) before it applies; Cancel puts the select back', async () => {
  const fx = fixture({ grants: [grant('alice', 'work', 'bob', 'read')] });
  await open(fx, R.matrix());
  const sel = tidAll('perm-select').find((s) => s.getAttribute('data-login') === 'bob' && s.getAttribute('data-coll') === 'work');
  sel.value = 'readwrite';
  change(sel);
  await flush();
  assert.ok(tid('dialog-change-access'));
  assert.deepEqual(fx.api.calls.filter((c) => c.startsWith('putGrant')), ['putGrant(dry:alice/work:bob:readwrite)']);
  assert.match(plain(tid('access-preview').textContent), /give bob read \+ write access to alice\/work/);
  tid('access-cancel').click();
  await flush();
  assert.equal(sel.value, 'read');
  assert.equal(fx.api.calls.some((c) => c.startsWith('putGrant(real')), false);
  sel.value = 'readwrite';
  change(sel);
  await flush();
  tid('access-confirm').click();
  await flush(12);
  assert.deepEqual(fx.api.calls.filter((c) => c.startsWith('putGrant')), ['putGrant(dry:alice/work:bob:readwrite)', 'putGrant(dry:alice/work:bob:readwrite)', 'putGrant(real:alice/work:bob:readwrite)']);
  assert.equal(sel.value, 'readwrite');
  assert.equal(sel.getAttribute('data-prev'), 'readwrite');
  assert.match(plain(fx.feedback.status.text), /bob now has read \+ write access on alice\/work/);
});

test('matrix: more than 12 accounts are capped, the filter reaches the rest and the status says so', async () => {
  const accounts = [acct('alice', { admin: true })];
  for (let i = 1; i <= 14; i++) accounts.push(acct(`user${String(i).padStart(2, '0')}`));
  const fx = fixture({ accounts, homes: { '/alice/': [coll('/alice/work/')] } });
  await open(fx, R.matrix());
  assert.equal(tidAll('matrix-account').length, 12);
  assert.match(tid('matrix-status').textContent, /Showing the first 12 of 14 accounts/);
  type(tid('matrix-filter'), 'user14');
  assert.deepEqual(tidAll('matrix-account').map((c) => c.getAttribute('data-login')), ['user14']);
  assert.match(tid('matrix-status').textContent, /Showing 1 accounts and 1 collections/);
  type(tid('matrix-filter'), 'nobody');
  assert.ok(tid('matrix-empty'));
  assert.equal(tid('permission-matrix'), null);
});

test('matrix: the deep link dialog=change opens the preview for that cell', async () => {
  const fx = fixture();
  await open(fx, R.matrix({ dialog: 'change', account: 'bob', href: '/alice/work/', level: 'rw' }));
  assert.ok(tid('dialog-change-access'));
  assert.deepEqual(fx.api.calls.filter((c) => c.startsWith('putGrant')), ['putGrant(dry:alice/work:bob:readwrite)']);
  tid('access-cancel').click();
  await flush();
  assert.deepEqual(fx.nav.at(-1), { hash: '#/users/permissions', opts: { replace: true } });
});

test('matrix: a deep link that cannot be applied says so instead of guessing', async () => {
  const fx = fixture();
  await open(fx, R.matrix({ dialog: 'change', account: 'alice', href: '/alice/work/', level: 'rw' }));
  assert.equal(tid('dialog-change-access'), null);
  assert.match(fx.feedback.alert.text, /does not point to a change/);
});

test('matrix: Share opens the sharing dialog of that row', async () => {
  const fx = fixture({ grants: [grant('alice', 'work', 'bob', 'read')] });
  await open(fx, R.matrix());
  const row = tidAll('matrix-row')[1];
  row.querySelector('[data-testid="btn-share"]').click();
  await flush(12);
  assert.ok(tid('dialog-share'));
  assert.equal(tidAll('share-row').length, 1);
  assert.equal(tid('share-select').value, 'read');
  tid('share-cancel').click();
  await flush();
});
