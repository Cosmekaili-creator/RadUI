// SPDX-License-Identifier: AGPL-3.0-or-later
// The dialogs of the Users screens: the password shown once (cannot be dismissed before the tick), the grant
// change preview (a dry run before anything is applied), the reset flow, the typed-login delete dialog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeAccessDialog, confirmOwnSpaceOff, deleteAccountDialog, passwordOnceDialog, resetPasswordFlow } from '../../../src/js/views/users/dialogs.js';
import { adminStoreFor } from '../../../src/js/views/users/adminstore.js';
import { hasBlockingDialog } from '../../../src/js/widgets/dialogs.js';
import { apiError, coll, doc, fixture, flush, plain, reset, tFor, tid } from './users-helpers.mjs';
import { fire, one, pressEscape, type } from '../widgets/_dom.mjs';

const t = tFor('en');
const fakeWin = () => ({ listeners: new Set(), addEventListener(_t, fn) { this.listeners.add(fn); }, removeEventListener(_t, fn) { this.listeners.delete(fn); } });
const adminOf = (fx) => adminStoreFor({ app: fx.app, store: fx.store });

test('password once: Esc, backdrop and a forced close cannot dismiss it before the tick; the secret leaves the page afterwards', async () => {
  reset();
  const win = fakeWin();
  let done = false;
  const p = passwordOnceDialog({ t, login: 'bob', secret: 'Abcde-Fghjk-Lmnpq-Rstuv', created: true, win });
  p.then(() => {
    done = true;
  });
  const dlg = tid('dialog-password-once');
  assert.ok(dlg);
  assert.equal(dlg.getAttribute('data-dismissible'), 'false');
  assert.equal(hasBlockingDialog(), true, 'navigation is vetoed while it is open');
  assert.equal(win.listeners.size, 1, 'beforeunload is armed');
  assert.equal(tid('generated-password').textContent, 'Abcde-Fghjk-Lmnpq-Rstuv');
  assert.equal(plain(tid('generated-password').getAttribute('aria-label')), 'Generated password for bob');
  assert.match(plain(tid('pw-once-note').textContent), /only once/);
  const confirm = tid('btn-password-saved');
  const ack = tid('field-pw-saved');
  assert.equal(confirm.disabled, true);
  assert.equal(tid('pw-once-warning').hidden, true);
  assert.equal(pressEscape(dlg), 'blocked-by-keydown');
  assert.equal(tid('pw-once-warning').hidden, false, 'a visible text explains why it stays');
  fire(dlg, 'click'); // a click on the backdrop is a click on the dialog element itself
  dlg.close('x');
  assert.equal(dlg.open, true, 'a forced close puts it back');
  await flush(2);
  assert.equal(done, false);
  ack.checked = true;
  fire(ack, 'change');
  assert.equal(confirm.disabled, false);
  confirm.click();
  assert.equal(await p, true);
  assert.equal(hasBlockingDialog(), false);
  assert.equal(win.listeners.size, 0);
  assert.equal(tid('generated-password'), null, 'the dialog is gone');
});

test('change access: the dry run comes first, confirm stays disabled until it answered, then ONE real call', async () => {
  reset();
  const fx = fixture();
  const admin = adminOf(fx);
  const p = changeAccessDialog({ t, admin, grant: { owner: 'alice', collection: 'work', grantee: 'bob', level: 'readwrite' }, before: 'none' });
  const confirm = tid('access-confirm');
  assert.equal(confirm.disabled, true, 'nothing can be applied before the preview');
  assert.deepEqual(fx.api.calls, ['putGrant(dry:alice/work:bob:readwrite)']);
  await flush();
  assert.match(plain(tid('access-preview').textContent), /This will give bob read \+ write access to alice\/work\./);
  assert.match(plain(tid('dialog-change-access').textContent), /Now: No access\. After: Read \+ write\./);
  assert.ok(tid('rights-limits-note'), 'the limits note is in the dialog');
  assert.match(plain(tid('access-effect').textContent), /bob: \/alice\/work was none, becomes readwrite/);
  assert.equal(confirm.disabled, false);
  assert.deepEqual(fx.api.calls, ['putGrant(dry:alice/work:bob:readwrite)']);
  confirm.click();
  const out = await p;
  assert.equal(out.applied, true);
  assert.deepEqual(fx.api.calls, ['putGrant(dry:alice/work:bob:readwrite)', 'putGrant(real:alice/work:bob:readwrite)']);
  assert.equal(fx.activity.filter((a) => a.op === 'grant').length, 1);
});

test('change access: Cancel applies nothing; a failed apply keeps the dialog open with the text', async () => {
  reset();
  let fx = fixture();
  let p = changeAccessDialog({ t, admin: adminOf(fx), grant: { owner: 'alice', collection: 'work', grantee: 'bob', level: 'read' }, before: 'none' });
  await flush();
  tid('access-cancel').click();
  assert.equal((await p).applied, false);
  assert.deepEqual(fx.api.calls, ['putGrant(dry:alice/work:bob:read)']);

  reset();
  fx = fixture({ fail: { putGrant: (g, dry) => (dry ? null : apiError('forbidden', { status: 403, code: 'forbidden' })) } });
  p = changeAccessDialog({ t, admin: adminOf(fx), grant: { owner: 'alice', collection: 'work', grantee: 'bob', level: 'none' }, before: 'read' });
  await flush();
  assert.match(plain(tid('access-preview').textContent), /remove all access of bob to alice\/work/);
  tid('access-confirm').click();
  await flush();
  assert.equal(tid('dialog-change-access').open, true, 'still open');
  assert.equal(tid('access-error').hidden, false);
  assert.match(plain(tid('access-error').textContent), /do not have permission/);
  assert.equal(tid('access-confirm').disabled, false, 'it can be tried again');
  tid('access-cancel').click();
  assert.equal((await p).applied, false);
});

test('change access: a refused dry run shows its text and offers no confirm', async () => {
  reset();
  const fx = fixture({ fail: { putGrant: (g, dry) => (dry ? apiError('conflict', { status: 409, code: 'grantee_disabled' }) : null) } });
  const p = changeAccessDialog({ t, admin: adminOf(fx), grant: { owner: 'alice', collection: 'work', grantee: 'bob', level: 'read' }, before: 'none' });
  await flush();
  assert.match(plain(tid('access-error').textContent), /disabled and cannot receive access/);
  assert.equal(tid('access-confirm').disabled, true);
  assert.deepEqual(fx.api.calls, ['putGrant(dry:alice/work:bob:read)']);
  tid('access-cancel').click();
  await p;
});

test('reset password: confirm, generate on the service, show the password once; the result never carries it', async () => {
  reset();
  const fx = fixture();
  const admin = adminOf(fx);
  const flow = resetPasswordFlow({ t, admin, login: 'bob' });
  const dlg = tid('dialog-reset-password');
  assert.match(plain(dlg.textContent), /Reset the password of bob\?/);
  assert.deepEqual(fx.api.calls, [], 'nothing before the confirm');
  tid('dialog-confirm-reset').click();
  await flush();
  assert.deepEqual(fx.api.calls, ['resetPassword(bob)']);
  assert.deepEqual(fx.api.bodies[0], { method: 'resetPassword', login: 'bob', generate: true });
  assert.equal(tid('generated-password').textContent, 'Wxyz2-3456a-Bcdef-Ghjkm');
  assert.match(plain(tid('dialog-password-once').textContent), /The password was reset/);
  const ack = tid('field-pw-saved');
  ack.checked = true;
  fire(ack, 'change');
  tid('btn-password-saved').click();
  const out = await flow;
  assert.equal(out.ok, true);
  assert.equal('password' in out, false);
  assert.equal(fx.activity.some((a) => JSON.stringify(a).includes('Wxyz2')), false, 'the secret is not in the Activity log');
  assert.equal(JSON.stringify(fx.feedback.status || '').includes('Wxyz2'), false);
});

test('reset password: Cancel does nothing', async () => {
  reset();
  const fx = fixture();
  const flow = resetPasswordFlow({ t, admin: adminOf(fx), login: 'bob' });
  tid('dialog-cancel').click();
  assert.deepEqual(await flow, { ok: false, status: 'cancelled' });
  assert.deepEqual(fx.api.calls, []);
});

test('delete account: the confirm button needs the exact login', async () => {
  reset();
  const fx = fixture();
  const p = deleteAccountDialog({ t, store: fx.store, login: 'bob', collections: [], grants: { held: 1, given: 0 } });
  const confirm = tid('dialog-confirm-delete');
  const input = tid('field-confirm-login');
  assert.equal(confirm.disabled, true);
  for (const wrong of ['Bob', 'bo', 'bob ', 'bobb', '']) {
    type(input, wrong);
    assert.equal(confirm.disabled, true, JSON.stringify(wrong));
  }
  type(input, 'bob');
  assert.equal(confirm.disabled, false);
  assert.match(plain(tid('dialog-delete-account').textContent), /owns 0 collections, holds 1 grants/);
  assert.equal(tid('delete-keep').checked, true, '"keep data" is the default');
  confirm.click();
  assert.deepEqual(await p, { confirmed: true, deleteData: false });
});

test('delete account: "delete data" lists the collections, each with an export first; the choice is returned', async () => {
  reset();
  const fx = fixture();
  const list = [coll('/bob/notes/', { displayName: 'Notes' }), coll('/bob/book/', { displayName: 'Bob book' })];
  const p = deleteAccountDialog({ t, store: fx.store, login: 'bob', collections: list });
  const rows = doc.body.querySelectorAll('[data-testid="delete-collection"]');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.getAttribute('data-href')), ['/bob/notes/', '/bob/book/']);
  assert.equal(tid('delete-collections').getAttribute('data-count'), '2');
  assert.match(plain(tid('delete-collections').textContent), /Collections of this account \(2\)/);
  const exportBtn = rows[0].querySelector('[data-testid="btn-export-first"]');
  assert.equal(plain(exportBtn.getAttribute('aria-label')), 'Export Notes of bob before deleting');
  exportBtn.click();
  await flush();
  assert.equal(fx.store.exportCalls.length, 1);
  assert.equal(fx.store.exportCalls[0].includeGroups, true);
  assert.equal(fx.store.exportCalls[0].collection.href, '/bob/notes/');
  const wipe = tid('delete-data');
  wipe.checked = true;
  tid('delete-keep').checked = false;
  fire(wipe, 'change');
  type(tid('field-confirm-login'), 'bob');
  tid('dialog-confirm-delete').click();
  assert.deepEqual(await p, { confirmed: true, deleteData: true });
});

test('delete account: Cancel and a listing that failed (null) say so; nothing is confirmed', async () => {
  reset();
  const fx = fixture();
  const p = deleteAccountDialog({ t, store: fx.store, login: 'bob', collections: null });
  assert.equal(tid('delete-collections').getAttribute('data-count'), '-1');
  assert.match(plain(tid('delete-collections').textContent), /could not be listed/);
  assert.equal(tid('delete-data').disabled, true, '"delete data" is not offered without the listing');
  tid('dialog-cancel').click();
  assert.deepEqual(await p, { confirmed: false, deleteData: false });
});

test('own space off needs the login typed', async () => {
  reset();
  const p = confirmOwnSpaceOff({ t, login: 'bob', count: 2 });
  assert.match(plain(tid('dialog-confirm-ownspace').textContent), /bob owns 2 collections/);
  const yes = tid('dialog-confirm-ownspace-yes');
  assert.equal(yes.disabled, true);
  type(one(doc.body, 'field-confirm-login'), 'bob');
  assert.equal(yes.disabled, false);
  yes.click();
  assert.equal(await p, true);
});
