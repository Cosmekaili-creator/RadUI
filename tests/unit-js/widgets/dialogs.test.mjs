// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, type, key, one, pressEscape, fire } from './_dom.mjs';
import { confirmDialog, typedConfirmDialog, oneTimeDialog, matchesTyped, hasBlockingDialog } from '../../../src/js/widgets/dialogs.js';
import { writeGate } from '../../../src/js/ui.js';
import { createI18n } from '../_i18n-all.mjs';

const doc = makeDom();
const t = createI18n({ lang: 'en' }).t;
const reset = () => {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  doc.activeElement = doc.body;
};
const opener = () => {
  const b = doc.createElement('button');
  doc.body.append(b);
  b.focus();
  return b;
};
const fakeWin = () => ({ listeners: new Set(), addEventListener(type, fn) { this.listeners.add(fn); }, removeEventListener(type, fn) { this.listeners.delete(fn); } });

// ---------------------------------------------------------------- confirmDialog

test('confirmDialog: named buttons, danger focuses Cancel, confirm resolves true and returns focus', async () => {
  reset();
  const op = opener();
  const p = confirmDialog({ title: 'Delete contact?', message: 'This cannot be undone.', confirmLabel: 'Delete «Jane Doe»', cancelLabel: 'Cancel', danger: true, testid: 'dialog-delete-contact', confirmTestid: 'dialog-confirm-delete', win: null });
  const dlg = one(doc.body, 'dialog-delete-contact');
  assert.equal(dlg.getAttribute('aria-labelledby'), 'dialog-delete-contact-title');
  assert.equal(dlg.querySelector('h2').textContent, 'Delete contact?');
  assert.equal(dlg.querySelector('#dialog-delete-contact-desc').textContent, 'This cannot be undone.');
  const confirm = one(dlg, 'dialog-confirm-delete');
  const cancel = one(dlg, 'dialog-cancel');
  assert.equal(confirm.textContent, 'Delete «Jane Doe»');
  assert.equal(cancel.textContent, 'Cancel');
  assert.ok(confirm.classList.contains('btn--danger'));
  assert.equal(doc.activeElement, cancel, 'a destructive dialog focuses Cancel (m7)');
  confirm.click();
  assert.equal(await p, true);
  assert.equal(dlg.open, false);
  assert.equal(doc.activeElement, op, 'focus returned to the opener');
});

test('confirmDialog: Cancel and Esc resolve false; a non-destructive dialog focuses the confirm button', async () => {
  reset();
  let op = opener();
  let p = confirmDialog({ title: 'Leave?', win: null, t });
  let dlg = one(doc.body, 'dialog-confirmation');
  assert.equal(doc.activeElement, one(dlg, 'dialog-confirm'));
  assert.equal(one(dlg, 'dialog-confirm').textContent, 'Confirm', 'default labels come from t');
  assert.equal(one(dlg, 'dialog-cancel').textContent, 'Cancel');
  assert.equal(pressEscape(dlg), 'closed');
  assert.equal(await p, false);
  assert.equal(doc.activeElement, op);
  p = confirmDialog({ title: 'Leave?', win: null, danger: true });
  one(doc.body, 'dialog-cancel').click();
  assert.equal(await p, false);
});

test('confirmDialog: exposes the dialog controller, accepts extra body nodes and a custom focus', async () => {
  reset();
  const note = doc.createElement('p');
  note.textContent = 'Also removed from 2 groups: Family, Book club';
  note.setAttribute('data-testid', 'delete-groups-note');
  const p = confirmDialog({ title: 'Delete', body: [note], win: null, focus: 'first' });
  assert.ok(p.dialog.dialog.contains(note));
  assert.equal(doc.activeElement, one(doc.body, 'dialog-cancel'), 'first button');
  p.dialog.close('x');
  assert.equal(await p, false);
});

// -------------------------------------------------------------- typedConfirmDialog

test('matchesTyped: exact, Unicode NFC, no trimming, no case folding', () => {
  assert.equal(matchesTyped('Work', 'Work'), true);
  assert.equal(matchesTyped('work', 'Work'), false);
  assert.equal(matchesTyped('Work ', 'Work'), false);
  assert.equal(matchesTyped('Café', 'Café'), true, 'composed equals decomposed');
  assert.equal(matchesTyped('', ''), false, 'an empty expected text never matches');
  assert.equal(matchesTyped(null, 'x'), false);
  assert.equal(matchesTyped('x', undefined), false);
});

test('typedConfirmDialog: the confirm button is disabled until the input equals the expected text', async () => {
  reset();
  const op = opener();
  const p = typedConfirmDialog({ title: 'Delete collection', message: 'All items are deleted.', expected: 'Personal calendar', label: 'Type the name', confirmLabel: 'Delete collection', testid: 'dialog-delete-collection', win: null, t });
  const dlg = one(doc.body, 'dialog-delete-collection');
  const input = one(dlg, 'field-confirm-name');
  const confirm = one(dlg, 'dialog-confirm');
  assert.equal(doc.activeElement, input, 'the typed field has the focus (m7)');
  assert.equal(confirm.disabled, true);
  assert.equal(dlg.querySelector('label').textContent, 'Type the name');
  assert.equal(dlg.querySelector('label').getAttribute('for'), input.id);
  assert.ok(input.getAttribute('aria-describedby').split(' ').length === 2);
  assert.match(dlg.querySelector(`#${input.id}-hint`).textContent, /Personal calendar/);
  const status = one(dlg, 'dialog-delete-collection-match');
  assert.equal(status.getAttribute('role'), 'status');
  type(input, 'Personal');
  assert.equal(confirm.disabled, true);
  assert.equal(status.textContent, 'The name does not match yet.');
  type(input, 'personal calendar');
  assert.equal(confirm.disabled, true, 'case matters');
  type(input, 'Personal calendar ');
  assert.equal(confirm.disabled, true, 'no trimming');
  type(input, 'Personal calendar');
  assert.equal(confirm.disabled, false);
  assert.equal(status.getAttribute('data-match'), 'true');
  assert.equal(status.textContent, 'The name matches. You can confirm.');
  type(input, 'Personal calendarX');
  assert.equal(confirm.disabled, true);
  type(input, 'Personal calendar');
  confirm.click();
  assert.equal(await p, true);
  assert.equal(doc.activeElement, op);
});

test('typedConfirmDialog: Enter confirms only when the text matches; Esc and Cancel resolve false; NFC compare', async () => {
  reset();
  let p = typedConfirmDialog({ title: 'Delete', expected: 'Café « Z »', win: null });
  let dlg = one(doc.body, 'dialog-typed-confirm');
  const input = one(dlg, 'field-confirm-name');
  type(input, 'nope');
  const e1 = key(input, 'Enter');
  assert.equal(e1.defaultPrevented, true);
  assert.equal(dlg.open, true, 'Enter does nothing while the text differs');
  type(input, 'Café « Z »');
  key(input, 'Enter');
  assert.equal(await p, true);
  p = typedConfirmDialog({ title: 'Delete', expected: 'x', win: null });
  assert.equal(pressEscape(one(doc.body, 'dialog-typed-confirm')), 'closed');
  assert.equal(await p, false);
  p = typedConfirmDialog({ title: 'Delete', expected: 'x', win: null });
  one(doc.body, 'dialog-cancel').click();
  assert.equal(await p, false);
});

test('typedConfirmDialog: needs something to type', () => {
  assert.throws(() => typedConfirmDialog({ title: 'x', expected: '' }), TypeError);
  assert.throws(() => typedConfirmDialog({ title: 'x' }), TypeError);
});

test('typedConfirmDialog: the write gate keeps the confirm disabled while offline, even when the text matches', async () => {
  reset();
  const p = typedConfirmDialog({ title: 'Delete', expected: 'abc', win: null, confirmLabel: 'Delete' });
  const dlg = one(doc.body, 'dialog-typed-confirm');
  const input = one(dlg, 'field-confirm-name');
  const confirm = one(dlg, 'dialog-confirm');
  type(input, 'abc');
  assert.equal(confirm.disabled, false);
  writeGate.setReason('offline', 'offline: changes disabled');
  assert.equal(confirm.disabled, true);
  assert.equal(confirm.getAttribute('aria-label'), 'Delete (offline: changes disabled)');
  type(input, 'abc'); // typing while blocked must not re-enable it
  assert.equal(confirm.disabled, true);
  writeGate.setReason('offline', null);
  assert.equal(confirm.disabled, false, 'back to enabled because the text matches');
  assert.equal(confirm.getAttribute('aria-label'), null);
  type(input, 'ab');
  assert.equal(confirm.disabled, true);
  p.dialog.close();
  await p;
});

// ------------------------------------------------------------------ oneTimeDialog

test('oneTimeDialog: Esc and backdrop cannot close it; the explicit confirm does', async () => {
  reset();
  const win = fakeWin();
  const op = opener();
  const secret = doc.createElement('code');
  secret.textContent = 'correct-horse-battery-staple';
  let resolved = false;
  const p = oneTimeDialog({ title: 'Password created', message: 'It is shown once.', body: [secret], confirmLabel: 'I have saved it', win });
  p.then(() => {
    resolved = true;
  });
  const dlg = one(doc.body, 'dialog-once');
  assert.equal(dlg.getAttribute('data-dismissible'), 'false');
  assert.equal(hasBlockingDialog(), true);
  assert.equal(win.listeners.size, 1, 'beforeunload is armed');
  assert.equal(doc.activeElement, one(dlg, 'dialog-once-confirm'));
  assert.equal(pressEscape(dlg), 'blocked-by-keydown');
  const cancel = fire(dlg, 'cancel');
  assert.equal(cancel.defaultPrevented, true, 'the cancel event is prevented');
  // something closes it anyway: it is shown again
  dlg.close('x');
  assert.equal(dlg.open, true, 'put back');
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false);
  // a click on the backdrop is a click on the dialog element itself: nothing happens
  fire(dlg, 'click');
  assert.equal(dlg.open, true);
  one(dlg, 'dialog-once-confirm').click();
  assert.equal(await p, true);
  assert.equal(dlg.open, false);
  assert.equal(hasBlockingDialog(), false);
  assert.equal(win.listeners.size, 0);
  assert.equal(doc.activeElement, op);
});

test('oneTimeDialog: with an acknowledgement box the confirm stays disabled until it is ticked', async () => {
  reset();
  const p = oneTimeDialog({ title: 'Password', ackLabel: 'I have saved it', confirmLabel: 'Continue', win: fakeWin() });
  const dlg = one(doc.body, 'dialog-once');
  const ack = one(dlg, 'dialog-once-ack');
  const btn = one(dlg, 'dialog-once-confirm');
  assert.equal(doc.activeElement, ack);
  assert.equal(btn.disabled, true);
  assert.equal(dlg.querySelector(`label`).getAttribute('for'), ack.id);
  ack.checked = true;
  fire(ack, 'change');
  assert.equal(btn.disabled, false);
  ack.checked = false;
  fire(ack, 'change');
  assert.equal(btn.disabled, true);
  ack.checked = true;
  fire(ack, 'change');
  btn.click();
  assert.equal(await p, true);
});
