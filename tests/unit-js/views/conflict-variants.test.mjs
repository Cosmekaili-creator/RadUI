// SPDX-License-Identifier: AGPL-3.0-or-later
// views/conflictdialog.js: the "deleted elsewhere" variant and the delete-conflict ("changed elsewhere") variant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pressEscape } from '../widgets/_dom.mjs';
import { openConflictDialog } from '../../../src/js/views/conflictdialog.js';
import { writeGate } from '../../../src/js/ui.js';
import { HREF, changedResult, conflictResult, deferred, deletedResult, dialogOf, doc, fakeWrites, feedbackFake, flush, okResult, reset, tEn, text, tid } from './conflict-helpers.mjs';

const open = (conflict, writes = fakeWrites(), extra = {}) => {
  const p = openConflictDialog({ conflict, t: tEn, writes, label: 'Alice Example', win: null, ...extra });
  return { p, writes, dlg: dialogOf() };
};
const buttonIds = (dlg) => dlg.querySelectorAll('button').map((b) => b.getAttribute('data-testid'));

// ------------------------------------------------------------------ deleted elsewhere

test('dialog-deleted-elsewhere: title, text, and the buttons Save mine as a copy / Discard my changes / Cancel', () => {
  const op = reset();
  const { dlg } = open(deletedResult());
  assert.equal(dlg.getAttribute('data-testid'), 'dialog-deleted-elsewhere');
  assert.equal(dlg.querySelector('h2').textContent, 'This item was deleted elsewhere');
  assert.match(dlg.querySelector('.dialog__desc').textContent, /Alice Example.* was deleted on the server after you opened it/);
  assert.deepEqual(buttonIds(dlg), ['deleted-save-copy', 'deleted-discard', 'deleted-cancel']);
  assert.deepEqual(dlg.querySelectorAll('button').map((b) => b.textContent), ['Save mine as a copy', 'Discard my changes', 'Cancel']);
  assert.equal(tid('conflict-diff'), null, 'there is nothing to compare');
  assert.equal(doc.activeElement, tid('deleted-cancel'), 'Cancel first');
  assert.notEqual(doc.activeElement, op);
});

test('deleted-save-copy calls resolveCopy with the result and resolves with its result', async () => {
  const op = reset();
  const created = okResult('created', { href: '/alice/book/new.vcf' });
  const r = deletedResult();
  const { p, writes, dlg } = open(r, fakeWrites({ resolveCopy: created }));
  tid('deleted-save-copy').click();
  assert.equal(await p, created);
  assert.deepEqual(writes.calls.map((c) => c.name), ['resolveCopy']);
  assert.equal(writes.calls[0].args[0], r);
  assert.equal(dlg.open, false);
  assert.equal(doc.activeElement, op);
});

test('deleted-discard writes nothing and resolves {ok: true, status: "discarded"}', async () => {
  reset();
  const fb = feedbackFake();
  const { p, writes } = open(deletedResult(), fakeWrites(), { feedback: fb });
  tid('deleted-discard').click();
  assert.deepEqual(await p, { ok: true, status: 'discarded', href: HREF });
  assert.equal(writes.calls.length, 0);
  assert.deepEqual(fb.log, [], 'a discard is not a cancel: no "nothing was saved" text');
});

test('deleted-cancel and Esc resolve {cancelled: true}', async () => {
  reset();
  let r = open(deletedResult());
  tid('deleted-cancel').click();
  assert.deepEqual(await r.p, { cancelled: true });
  reset();
  r = open(deletedResult());
  assert.equal(pressEscape(r.dlg), 'closed');
  assert.deepEqual(await r.p, { cancelled: true });
  assert.equal(r.writes.calls.length, 0);
});

test('deleted variant: canCopy false disables the copy with the reason as text (a group card)', () => {
  reset();
  const { writes } = open(deletedResult({ canCopy: false, isGroup: true }));
  const copy = tid('deleted-save-copy');
  assert.equal(copy.disabled, true);
  assert.equal(text('deleted-copy-reason'), 'A group cannot be saved as a copy.');
  assert.equal(copy.getAttribute('aria-describedby'), tid('deleted-copy-reason').id);
  copy.click();
  assert.equal(writes.calls.length, 0);
  assert.equal(tid('deleted-discard').disabled, false);
});

test('deleted variant: offline disables the copy only; a copy failure shows the alert inside the dialog', async () => {
  reset();
  open(deletedResult());
  writeGate.setReason('readonly', 'read-only');
  assert.equal(tid('deleted-save-copy').disabled, true);
  assert.equal(tid('deleted-discard').disabled, false);
  writeGate.setReason('readonly', null);
  assert.equal(tid('deleted-save-copy').disabled, false);
  reset();
  const { dlg } = open(deletedResult(), fakeWrites({ resolveCopy: { ok: false, status: 'exists', message: 'An item with this name already exists.' } }));
  tid('deleted-save-copy').click();
  await flush();
  assert.equal(text('conflict-alert'), 'An item with this name already exists.');
  assert.equal(dlg.open, true);
});

test('deleted variant: busy state disables everything and blocks Esc', async () => {
  reset();
  const gate = deferred();
  const { p, dlg } = open(deletedResult(), fakeWrites({ resolveCopy: () => gate.promise }));
  tid('deleted-save-copy').click();
  assert.equal(dlg.getAttribute('aria-busy'), 'true');
  assert.deepEqual(dlg.querySelectorAll('button').map((b) => b.disabled), [true, true, true]);
  assert.equal(pressEscape(dlg), 'blocked-by-keydown');
  gate.resolve(okResult('created'));
  await p;
});

// ------------------------------------------------------------------ changed elsewhere (delete refused)

test('dialog-changed-elsewhere: Show their version / Delete anyway / Cancel, Cancel focused', () => {
  reset();
  const { dlg } = open(changedResult());
  assert.equal(dlg.getAttribute('data-testid'), 'dialog-changed-elsewhere');
  assert.equal(dlg.querySelector('h2').textContent, 'This item was changed elsewhere');
  assert.match(dlg.querySelector('.dialog__desc').textContent, /Alice Example.* was changed on the server after you opened it, so it was not deleted/);
  assert.deepEqual(buttonIds(dlg), ['changed-show-theirs', 'changed-delete-anyway', 'changed-cancel']);
  assert.deepEqual(dlg.querySelectorAll('button').map((b) => b.textContent), ['Show their version', 'Delete anyway', 'Cancel']);
  assert.equal(doc.activeElement, tid('changed-cancel'));
  assert.equal(tid('conflict-diff'), null);
});

test('Show their version: resolveReload(result) (no request), resolves with the reloaded result', async () => {
  reset();
  const reloaded = okResult('reloaded', { etag: '"2"', text: 'THEIRS' });
  const r = changedResult();
  const { p, writes } = open(r, fakeWrites({ resolveReload: reloaded }));
  tid('changed-show-theirs').click();
  assert.equal(await p, reloaded);
  assert.deepEqual(writes.calls.map((c) => c.name), ['resolveReload']);
  assert.equal(writes.calls[0].args[0], r);
});

test('Delete anyway: resolveDeleteAnyway(result) and resolves with the delete result', async () => {
  reset();
  const gone = okResult('deleted');
  const r = changedResult();
  const { p, writes, dlg } = open(r, fakeWrites({ resolveDeleteAnyway: gone }));
  tid('changed-delete-anyway').click();
  assert.equal(await p, gone);
  assert.deepEqual(writes.calls.map((c) => c.name), ['resolveDeleteAnyway']);
  assert.equal(writes.calls[0].args[0], r);
  assert.equal(dlg.open, false);
});

test('Delete anyway answered by another changed-elsewhere: the same dialog stays with a note', async () => {
  reset();
  const again = changedResult({ theirs: { text: 'THEIRS3', etag: '"3"' } });
  const { p, writes, dlg } = open(changedResult(), fakeWrites({ resolveDeleteAnyway: [again, okResult('deleted')] }));
  tid('changed-delete-anyway').click();
  await flush();
  assert.equal(dialogOf(), dlg);
  assert.equal(dlg.open, true);
  assert.equal(text('conflict-status'), 'The item changed again before your choice could be saved. Review the new differences.');
  assert.equal(tid('changed-delete-anyway').disabled, false);
  tid('changed-delete-anyway').click();
  assert.equal((await p).status, 'deleted');
  assert.equal(writes.calls[1].args[0], again);
});

test('Delete anyway while offline is disabled; Show their version and Cancel stay available', () => {
  reset();
  const { writes } = open(changedResult());
  writeGate.setReason('offline', 'offline');
  assert.equal(tid('changed-delete-anyway').disabled, true);
  assert.equal(tid('changed-show-theirs').disabled, false);
  tid('changed-delete-anyway').click();
  assert.equal(writes.calls.length, 0);
  writeGate.setReason('offline', null);
  assert.equal(tid('changed-delete-anyway').disabled, false);
});

test('Delete anyway failure: persistent alert inside the dialog; Cancel resolves {cancelled: true}', async () => {
  reset();
  const { p } = open(changedResult(), fakeWrites({ resolveDeleteAnyway: { ok: false, status: 'forbidden', message: 'You do not have permission to write here.' } }));
  tid('changed-delete-anyway').click();
  await flush();
  assert.equal(tid('conflict-alert').getAttribute('role'), 'alert');
  assert.equal(text('conflict-alert'), 'You do not have permission to write here.');
  tid('changed-cancel').click();
  assert.deepEqual(await p, { cancelled: true });
});

test('the dialog follows the store result: an overwrite answered with changed-elsewhere shows the delete variant', async () => {
  reset();
  const { dlg } = open(conflictResult(), fakeWrites({ resolveOverwrite: changedResult() }));
  tid('conflict-overwrite').click();
  await flush();
  assert.equal(dlg.getAttribute('data-testid'), 'dialog-changed-elsewhere');
  assert.deepEqual(buttonIds(dlg), ['changed-show-theirs', 'changed-delete-anyway', 'changed-cancel']);
  assert.equal(tidCount('conflict-reload'), 0);
});

const tidCount = (id) => doc.body.querySelectorAll(`[data-testid="${id}"]`).length;
