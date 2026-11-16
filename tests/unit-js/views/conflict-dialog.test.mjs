// SPDX-License-Identifier: AGPL-3.0-or-later
// views/conflictdialog.js: the edit-conflict dialog (rendering, enable rules, buttons, second conflict, busy state,
// focus, Esc, failures, hostile values, language).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pressEscape, fire } from '../widgets/_dom.mjs';
import { openConflictDialog, modeOf } from '../../../src/js/views/conflictdialog.js';
import { writeGate } from '../../../src/js/ui.js';
import { COLL, HREF, conflictResult, deferred, dialogOf, doc, fakeWrites, feedbackFake, flush, okResult, reset, rowsOf, tEn, tFr, text, tid, tidAll } from './conflict-helpers.mjs';

const open = (over = {}, writes = fakeWrites(), extra = {}) => {
  const p = openConflictDialog({ conflict: conflictResult(over), t: tEn, writes, label: 'Alice Example', win: null, ...extra });
  return { p, writes, dlg: dialogOf() };
};
const buttonIds = (dlg) => dlg.querySelectorAll('button').map((b) => b.getAttribute('data-testid'));

// ------------------------------------------------------------------ rendering

test('modeOf maps the three conflict statuses and nothing else', () => {
  assert.equal(modeOf({ status: 'conflict' }), 'conflict');
  assert.equal(modeOf({ status: 'deleted-elsewhere' }), 'deleted');
  assert.equal(modeOf({ status: 'changed-elsewhere' }), 'changed');
  assert.equal(modeOf({ status: 'saved' }), null);
  assert.equal(modeOf(null), null);
  assert.equal(modeOf({ status: 'toString' }), null);
});

test('dialog-conflict: modal with title, description, a real table and the four named buttons', () => {
  reset();
  const { dlg } = open();
  assert.ok(dlg.open);
  assert.equal(dlg.getAttribute('data-testid'), 'dialog-conflict');
  assert.ok(dlg.classList.contains('dialog--conflict'));
  assert.equal(dlg.querySelector('h2').textContent, 'This item was changed elsewhere');
  assert.equal(dlg.getAttribute('aria-labelledby'), 'dialog-conflict-title');
  assert.match(dlg.querySelector('.dialog__desc').textContent, /Alice Example.* was changed on the server after you opened it/);
  const table = tid('conflict-diff');
  assert.equal(table.tagName, 'TABLE');
  assert.deepEqual(table.querySelectorAll('thead th').map((th) => [th.textContent, th.getAttribute('scope')]), [['Field', 'col'], ['Yours', 'col'], ['Theirs', 'col']]);
  assert.equal(table.querySelector('caption').textContent, 'Differences between your version and the version on the server');
  assert.deepEqual(buttonIds(dlg), ['conflict-reload', 'conflict-overwrite', 'conflict-copy', 'conflict-cancel']);
  assert.deepEqual(
    dlg.querySelectorAll('button').map((b) => b.textContent),
    ['Reload theirs', 'Overwrite with mine', 'Save mine as a copy', 'Cancel'],
  );
});

test('rows: one conflict-field-row per field with data-field and data-both; list values are lists; photo is only changed/unchanged', () => {
  reset();
  open();
  assert.deepEqual(rowsOf(), [
    ['title', 'true', 'Mine', 'Theirs'],
    ['tel', 'false', '+1 555 0100 (cell)+1 555 0111 (work)', '+1 555 0100 (cell)'],
    ['photo', 'false', 'unchanged', 'changed'],
  ]);
  const [titleRow, telRow, photoRow] = tidAll('conflict-field-row');
  assert.equal(titleRow.children[0].tagName, 'TH');
  assert.equal(titleRow.children[0].getAttribute('scope'), 'row');
  assert.match(titleRow.children[0].textContent, /^Display name|^Job title/);
  assert.match(titleRow.children[0].textContent, /Changed on both sides/, 'the both-sides marker is text, not colour');
  assert.equal(telRow.children[0].querySelector('[data-testid="conflict-both"]'), null);
  assert.equal(telRow.children[1].querySelectorAll('li').length, 2);
  assert.equal(telRow.children[2].querySelectorAll('li').length, 1);
  assert.equal(photoRow.children[1].querySelector('.conflict__photo').getAttribute('data-state'), 'unchanged');
  assert.equal(photoRow.children[2].querySelector('.conflict__photo').getAttribute('data-state'), 'changed');
  assert.equal(photoRow.querySelector('img'), null, 'the photo itself is never drawn');
});

test('empty values read "(empty)"; an unknown field falls back to its raw name; no rows gives a text, not an empty table', () => {
  reset();
  open({ rows: [{ field: 'x-custom', kind: 'text', mine: '', theirs: 'v', both: false }, { field: 'categories', kind: 'list', mine: [], theirs: ['a'], both: false }] });
  assert.deepEqual(rowsOf().map((r) => r.slice(2)), [['(empty)', 'v'], ['(empty)', 'a']]);
  assert.equal(tidAll('conflict-field-row')[0].children[0].textContent, 'x-custom');
  reset();
  open({ rows: [] });
  assert.equal(tid('conflict-diff'), null);
  assert.match(text('conflict-no-rows'), /No difference in the fields this app edits/);
});

test('hostile values are shown as literal text: no element is created from them', () => {
  reset();
  const evil = '<script>globalThis.pwned = 1</script>';
  const img = '<img src=x onerror="globalThis.pwned = 2">';
  open(
    {
      rows: [
        { field: 'note', kind: 'text', mine: evil, theirs: img, both: true },
        { field: 'tel', kind: 'list', mine: [evil], theirs: [img, '{name}'], both: false },
        { field: '<b>x</b>', kind: 'text', mine: '1', theirs: '2', both: false },
      ],
      unmappable: [{ field: 'tel', op: 'modify', reason: 'row-not-found', base: evil, mine: img }],
      notes: [{ field: 'org', code: 'pref-moved', row: evil }],
    },
    fakeWrites(),
    { label: '<i>Mallory</i>' },
  );
  const dlg = dialogOf();
  assert.equal(dlg.querySelector('script'), null);
  assert.equal(dlg.querySelector('img'), null);
  assert.equal(dlg.querySelector('b'), null);
  assert.equal(dlg.querySelector('i'), null);
  const rows = tidAll('conflict-field-row');
  assert.equal(rows[0].children[1].textContent, evil);
  assert.equal(rows[0].children[2].textContent, img);
  assert.equal(rows[1].children[1].querySelector('li').textContent, evil);
  assert.equal(rows[1].children[2].querySelectorAll('li')[1].textContent, '{name}', 'placeholders in values are not interpolated');
  assert.equal(rows[2].children[0].textContent, '<b>x</b>');
  assert.ok(tid('conflict-unmappable').textContent.includes(evil));
  assert.ok(tid('conflict-notes').textContent.includes(evil));
  assert.ok(dlg.querySelector('.dialog__desc').textContent.includes('<i>Mallory</i>'));
  assert.equal(globalThis.pwned, undefined);
});

test('notes say where mine won (organisation units, removed N, moved preferred mark, unknown code)', () => {
  reset();
  open({
    notes: [
      { field: 'org', code: 'both-edited', parts: ['units'] },
      { field: 'n', code: 'theirs-removed', parts: ['given', 'family'] },
      { field: 'tel', code: 'pref-moved', row: '+1 555 0100' },
      { field: 'note', code: 'something-new' },
    ],
  });
  const items = tid('conflict-notes').querySelectorAll('li').map((li) => li.textContent);
  assert.deepEqual(items, [
    'Organisation: both of you edited the units; your version won.',
    'Name: they removed it while you edited the given name, the family name; your version was kept.',
    'Phone: you marked another entry as preferred, so their preferred mark on “+1 555 0100” was removed.',
    'Note: your version won.',
  ]);
  reset();
  open({ notes: [] });
  assert.equal(tid('conflict-notes'), null);
});

// ------------------------------------------------------------------ unmappable confirmation

const UNMAPPABLE = [
  { field: 'tel', op: 'modify', reason: 'row-not-found', base: '+1 555 0100 (cell)', mine: '+1 555 0199 (cell)' },
  { field: 'email', op: 'remove', reason: 'row-not-found', base: 'old@example.org', mine: null },
];

test('unmappable changes are listed; Overwrite stays disabled until the required checkbox is ticked', async () => {
  reset();
  const { p, writes } = open({ unmappable: UNMAPPABLE });
  const list = tid('conflict-unmappable');
  assert.match(list.textContent, /^These changes cannot be applied automatically:/);
  assert.deepEqual(list.querySelectorAll('li').map((li) => li.textContent), [
    'Phone: your change to “+1 555 0100 (cell)” (now “+1 555 0199 (cell)”)',
    'E-mail: your removal of “old@example.org”',
  ]);
  const box = tid('conflict-confirm-unmappable');
  assert.equal(box.getAttribute('type'), 'checkbox');
  assert.equal(box.checked, false);
  const label = doc.body.querySelector(`label[for="${box.id}"]`);
  assert.equal(label.textContent, 'I understand that these changes will be left out.');
  const overwrite = tid('conflict-overwrite');
  assert.equal(overwrite.disabled, true);
  overwrite.click();
  assert.equal(writes.calls.length, 0, 'a disabled button does nothing');
  box.checked = true;
  fire(box, 'change');
  assert.equal(overwrite.disabled, false);
  box.checked = false;
  fire(box, 'change');
  assert.equal(overwrite.disabled, true, 'unticking disables it again');
  box.checked = true;
  fire(box, 'change');
  overwrite.click();
  await flush();
  assert.deepEqual(writes.calls.map((c) => [c.name, c.args[1]]), [['resolveOverwrite', { confirmUnmappable: true }]]);
  assert.equal((await p).status, 'resolveOverwrite');
});

test('no unmappable changes: no checkbox, Overwrite is enabled and sends confirmUnmappable false', async () => {
  reset();
  const { p, writes } = open();
  assert.equal(tid('conflict-confirm-unmappable'), null);
  assert.equal(tid('conflict-unmappable'), null);
  assert.equal(tid('conflict-overwrite').disabled, false);
  tid('conflict-overwrite').click();
  await p;
  assert.deepEqual(writes.calls[0].args[1], { confirmUnmappable: false });
  assert.equal(writes.calls[0].args[0].href, HREF, 'the conflict result itself is handed to the store');
});

test('canOverwrite false: Overwrite is disabled and the reason is visible text linked to the button', () => {
  reset();
  const { writes } = open({ canOverwrite: false, theirsReadable: false });
  const overwrite = tid('conflict-overwrite');
  assert.equal(overwrite.disabled, true);
  const reason = tid('conflict-overwrite-reason');
  assert.match(reason.textContent, /Overwriting is not possible/);
  assert.equal(overwrite.getAttribute('aria-describedby'), reason.id);
  overwrite.click();
  assert.equal(writes.calls.length, 0);
  assert.equal(tid('conflict-reload').disabled, false);
  assert.equal(tid('conflict-copy').disabled, false);
});

test('canCopy false (a group card): Save as a copy is disabled with the reason as text; Reload still works', async () => {
  reset();
  const { p, writes } = open({ canCopy: false, isGroup: true });
  const copy = tid('conflict-copy');
  assert.equal(copy.disabled, true);
  assert.equal(text('conflict-copy-reason'), 'A group cannot be saved as a copy.');
  assert.equal(copy.getAttribute('aria-describedby'), tid('conflict-copy-reason').id);
  copy.click();
  assert.equal(writes.calls.length, 0);
  tid('conflict-reload').click();
  assert.equal((await p).status, 'resolveReload');
  reset();
  open({ canCopy: false, isGroup: false });
  assert.equal(text('conflict-copy-reason'), 'Saving a copy is not possible for this item.');
});

// ------------------------------------------------------------------ buttons and results

test('Reload theirs calls resolveReload(conflict) and resolves with its result; the dialog closes and focus returns', async () => {
  const op = reset();
  const fb = feedbackFake();
  const result = okResult('reloaded', { etag: '"2"', text: 'THEIRS' });
  const { p, writes, dlg } = open({}, fakeWrites({ resolveReload: result }), { feedback: fb });
  tid('conflict-reload').click();
  assert.equal(await p, result);
  assert.deepEqual(writes.calls.map((c) => c.name), ['resolveReload']);
  assert.equal(dlg.open, false);
  assert.equal(dialogOf(), null, 'the dialog element is removed');
  assert.equal(doc.activeElement, op, 'focus returns to the opener');
  assert.deepEqual(fb.log, [['dismiss', 'alert']], 'the stale conflict alert is dismissed; the store wrote the status');
});

test('Overwrite with mine and Save mine as a copy each call their store function once and resolve with the result', async () => {
  reset();
  let r = open({}, fakeWrites({ resolveOverwrite: okResult('saved', { etag: '"3"' }) }));
  tid('conflict-overwrite').click();
  assert.deepEqual(await r.p, okResult('saved', { etag: '"3"' }));
  assert.deepEqual(r.writes.calls.map((c) => c.name), ['resolveOverwrite']);
  reset();
  r = open({}, fakeWrites({ resolveCopy: okResult('created', { href: COLL + 'copy.vcf' }) }));
  tid('conflict-copy').click();
  assert.equal((await r.p).href, COLL + 'copy.vcf');
  assert.deepEqual(r.writes.calls.map((c) => c.name), ['resolveCopy']);
});

test('Cancel resolves {cancelled: true}, calls nothing, leaves "nothing was saved" as status text', async () => {
  const op = reset();
  const fb = feedbackFake();
  const { p, writes } = open({}, fakeWrites(), { feedback: fb });
  tid('conflict-cancel').click();
  assert.deepEqual(await p, { cancelled: true });
  assert.equal(writes.calls.length, 0);
  assert.equal(doc.activeElement, op);
  assert.deepEqual(fb.log, [['status', 'Conflict left unresolved: nothing was saved.']]);
});

test('Esc cancels like the Cancel button', async () => {
  const op = reset();
  const { p, dlg, writes } = open();
  assert.equal(pressEscape(dlg), 'closed');
  assert.deepEqual(await p, { cancelled: true });
  assert.equal(writes.calls.length, 0);
  assert.equal(doc.activeElement, op);
});

// ------------------------------------------------------------------ focus

test('focus starts on Cancel (the safe button) and the tab order is the visible order', () => {
  reset();
  const { dlg } = open();
  assert.equal(doc.activeElement, tid('conflict-cancel'));
  assert.deepEqual(buttonIds(dlg), ['conflict-reload', 'conflict-overwrite', 'conflict-copy', 'conflict-cancel']);
  // the confirmation checkbox comes before the buttons in the DOM, so it is reached before them
  reset();
  const second = open({ unmappable: UNMAPPABLE });
  const order = second.dlg.all((e) => e.tagName === 'INPUT' || e.tagName === 'BUTTON').map((e) => e.getAttribute('data-testid'));
  assert.deepEqual(order, ['conflict-confirm-unmappable', 'conflict-reload', 'conflict-overwrite', 'conflict-copy', 'conflict-cancel']);
  assert.equal(doc.activeElement, tid('conflict-cancel'));
});

// ------------------------------------------------------------------ busy state

test('while a request runs the buttons are disabled, aria-busy is set, Esc cannot close; afterwards it all clears', async () => {
  reset();
  const gate = deferred();
  const { p, dlg } = open({}, fakeWrites({ resolveOverwrite: () => gate.promise }));
  assert.equal(dlg.getAttribute('aria-busy'), null);
  tid('conflict-overwrite').click();
  assert.equal(dlg.getAttribute('aria-busy'), 'true');
  assert.deepEqual(dlg.querySelectorAll('button').map((b) => b.disabled), [true, true, true, true]);
  assert.equal(text('conflict-status'), 'Working…');
  assert.equal(tid('conflict-status').hidden, false);
  assert.equal(pressEscape(dlg), 'blocked-by-keydown');
  assert.equal(dlg.open, true);
  // a second click while busy is ignored
  tid('conflict-overwrite').click();
  tid('conflict-reload').click();
  gate.resolve(okResult('saved'));
  assert.equal((await p).status, 'saved');
  assert.equal(dlg.getAttribute('aria-busy'), null);
});

test('a conflict answer after a busy request re-enables the buttons; busy state is not left behind on failure', async () => {
  reset();
  const gate = deferred();
  const { dlg } = open({}, fakeWrites({ resolveCopy: () => gate.promise }));
  tid('conflict-copy').click();
  assert.equal(dlg.getAttribute('aria-busy'), 'true');
  gate.resolve({ ok: false, status: 'forbidden', message: 'You do not have permission to write here.' });
  await flush();
  assert.equal(dlg.getAttribute('aria-busy'), null);
  assert.deepEqual(dlg.querySelectorAll('button').map((b) => b.disabled), [false, false, false, false]);
  assert.equal(tid('conflict-status').hidden, true);
});

test('closed by the browser while busy: the answer still reaches the caller', async () => {
  reset();
  const gate = deferred();
  const { p, dlg } = open({}, fakeWrites({ resolveOverwrite: () => gate.promise }));
  tid('conflict-overwrite').click();
  dlg.close(); // a browser that closes on a second Esc
  let settled = false;
  p.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false, 'the promise waits for the request');
  gate.resolve(okResult('saved'));
  assert.equal((await p).status, 'saved');
});

// ------------------------------------------------------------------ second conflict

test('a second 412 re-renders the SAME dialog with the new rows and a reset confirmation', async () => {
  reset();
  const again = conflictResult({
    theirs: { text: 'THEIRS2', etag: '"3"' },
    rows: [{ field: 'note', kind: 'text', mine: 'M', theirs: 'T2', both: true }],
    unmappable: [UNMAPPABLE[1]],
  });
  const { p, writes, dlg } = open({ unmappable: UNMAPPABLE }, fakeWrites({ resolveOverwrite: [again, okResult('saved', { etag: '"4"' })] }));
  const box = tid('conflict-confirm-unmappable');
  box.checked = true;
  fire(box, 'change');
  tid('conflict-overwrite').click();
  await flush();
  assert.equal(dialogOf(), dlg, 'the same dialog element');
  assert.equal(tidAll('dialog-conflict').length, 1);
  assert.equal(dlg.open, true);
  assert.deepEqual(rowsOf(), [['note', 'true', 'M', 'T2']]);
  assert.equal(tid('conflict-unmappable').querySelectorAll('li').length, 1);
  assert.equal(tid('conflict-confirm-unmappable').checked, false, 'the new list needs its own confirmation');
  assert.equal(tid('conflict-overwrite').disabled, true);
  assert.equal(text('conflict-status'), 'The item changed again before your choice could be saved. Review the new differences.');
  assert.equal(doc.activeElement, tid('conflict-cancel'));
  // the next call carries the NEW conflict
  tid('conflict-confirm-unmappable').checked = true;
  fire(tid('conflict-confirm-unmappable'), 'change');
  tid('conflict-overwrite').click();
  const final = await p;
  assert.equal(final.etag, '"4"');
  assert.equal(writes.calls.length, 2);
  assert.equal(writes.calls[0].args[0].theirs.etag, '"2"');
  assert.equal(writes.calls[1].args[0].theirs.etag, '"3"');
  assert.deepEqual(writes.calls[1].args[1], { confirmUnmappable: true });
});

test('a second 412 whose item is now gone turns the same dialog into the deleted-elsewhere variant', async () => {
  reset();
  const gone = { ok: false, status: 'deleted-elsewhere', message: '', href: HREF, collection: COLL, base: { text: 'B', etag: '"1"' }, mine: {}, canCopy: true };
  const { p, dlg, writes } = open({}, fakeWrites({ resolveOverwrite: gone, resolveCopy: okResult('created') }));
  tid('conflict-overwrite').click();
  await flush();
  assert.equal(dialogOf(), dlg);
  assert.equal(dlg.getAttribute('data-testid'), 'dialog-deleted-elsewhere');
  assert.equal(dlg.querySelector('h2').textContent, 'This item was deleted elsewhere');
  assert.deepEqual(buttonIds(dlg), ['deleted-save-copy', 'deleted-discard', 'deleted-cancel']);
  assert.equal(tid('conflict-diff'), null);
  tid('deleted-save-copy').click();
  assert.equal((await p).status, 'created');
  assert.deepEqual(writes.calls.map((c) => c.name), ['resolveOverwrite', 'resolveCopy']);
  assert.equal(writes.calls[1].args[0], gone, 'the copy uses the newest result');
});

// ------------------------------------------------------------------ failures

test('a failure shows a persistent role=alert text inside the dialog and keeps the dialog open', async () => {
  reset();
  const { p, dlg } = open({}, fakeWrites({ resolveOverwrite: { ok: false, status: 'forbidden', message: 'You do not have permission to write here.' } }));
  tid('conflict-overwrite').click();
  await flush();
  const alert = tid('conflict-alert');
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.equal(alert.hidden, false);
  assert.equal(alert.textContent, 'You do not have permission to write here.');
  assert.equal(dlg.open, true);
  assert.equal(doc.activeElement, tid('conflict-cancel'));
  // it stays until the next action starts
  assert.equal(alert.textContent, 'You do not have permission to write here.');
  tid('conflict-cancel').click();
  assert.deepEqual(await p, { cancelled: true });
});

test('a failure without a message, and a thrown error, give a generic alert text', async () => {
  reset();
  open({}, fakeWrites({ resolveOverwrite: { ok: false, status: 'unknown-result' } }));
  tid('conflict-overwrite').click();
  await flush();
  assert.equal(text('conflict-alert'), 'The action did not complete (unknown-result). Check the item before trying again.');
  reset();
  open({}, fakeWrites({ resolveCopy: () => Promise.reject(new Error('boom')) }));
  tid('conflict-copy').click();
  await flush();
  assert.equal(text('conflict-alert'), 'The action did not complete (error). Check the item before trying again.');
  assert.equal(dialogOf().getAttribute('aria-busy'), null);
  reset();
  open({}, fakeWrites({ resolveReload: () => { throw new Error('sync boom'); } }));
  tid('conflict-reload').click();
  await flush();
  assert.equal(text('conflict-alert'), 'The action did not complete (error). Check the item before trying again.');
});

test('a needs-confirmation answer replaces the unmappable list and asks again', async () => {
  reset();
  const fresh = [{ field: 'adr', op: 'remove', reason: 'row-not-found', base: '1 Example Street', mine: null }];
  const { dlg } = open({}, fakeWrites({ resolveOverwrite: { ok: false, status: 'needs-confirmation', message: 'Some of your changes cannot be applied automatically. Confirm to continue without them.', unmappable: fresh } }));
  tid('conflict-overwrite').click();
  await flush();
  assert.match(text('conflict-alert'), /cannot be applied automatically/);
  assert.equal(tid('conflict-unmappable').querySelectorAll('li').length, 1);
  assert.equal(tid('conflict-confirm-unmappable').checked, false);
  assert.equal(tid('conflict-overwrite').disabled, true);
  assert.equal(dlg.open, true);
});

test('nickname loss: the user must accept it explicitly before Overwrite or Copy retries with acceptNicknameLoss', async () => {
  reset();
  const loss = { ok: false, status: 'nickname-loss', message: 'The server keeps only the first value of a list of nicknames. Saving would lose: Al, Ali. Nothing was saved.', lost: ['Al', 'Ali'] };
  const { p, writes } = open({}, fakeWrites({ resolveOverwrite: [loss, okResult('saved')] }));
  tid('conflict-overwrite').click();
  await flush();
  assert.match(text('conflict-alert'), /Saving would lose: Al, Ali/);
  const box = tid('conflict-confirm-nickname');
  assert.match(doc.body.querySelector(`label[for="${box.id}"]`).textContent, /I accept losing: Al, Ali/);
  assert.equal(tid('conflict-overwrite').disabled, true);
  assert.equal(tid('conflict-copy').disabled, true);
  box.checked = true;
  fire(box, 'change');
  assert.equal(tid('conflict-overwrite').disabled, false);
  tid('conflict-overwrite').click();
  await p;
  assert.deepEqual(writes.calls[1].args[1], { confirmUnmappable: false, acceptNicknameLoss: true });
});

// ------------------------------------------------------------------ write gate

test('offline: the write buttons are disabled with a named reason; reading buttons stay; the dialog follows the gate back', () => {
  reset();
  const { writes } = open({ canCopy: false, isGroup: true });
  writeGate.setReason('offline', 'offline: changes disabled');
  assert.equal(tid('conflict-overwrite').disabled, true);
  assert.equal(tid('conflict-copy').disabled, true);
  assert.match(tid('conflict-overwrite').getAttribute('aria-label'), /Overwrite with mine \(offline: changes disabled\)/);
  assert.equal(tid('conflict-reload').disabled, false);
  assert.equal(tid('conflict-cancel').disabled, false);
  tid('conflict-overwrite').click();
  assert.equal(writes.calls.length, 0);
  writeGate.setReason('offline', null);
  assert.equal(tid('conflict-overwrite').disabled, false);
  assert.equal(tid('conflict-copy').disabled, true, 'still disabled: a group cannot be copied');
  assert.equal(tid('conflict-overwrite').getAttribute('aria-label'), null);
});

// ------------------------------------------------------------------ language, input checks

test('French dictionary: the same dialog in French, with an isolated name', () => {
  reset();
  openConflictDialog({ conflict: conflictResult(), t: tFr, writes: fakeWrites(), label: 'Aïcha', win: null });
  const dlg = dialogOf();
  assert.equal(dlg.querySelector('h2').textContent, 'Cet élément a été modifié ailleurs');
  assert.deepEqual(
    dlg.querySelectorAll('button').map((b) => b.textContent),
    ['Recharger la leur', 'Écraser avec la mienne', 'Garder la mienne en copie', 'Annuler'],
  );
  assert.deepEqual(dlg.querySelectorAll('thead th').map((th) => th.textContent), ['Champ', 'Votre version', 'Sur le serveur']);
  assert.ok(dlg.querySelector('.dialog__desc').textContent.includes('⁨Aïcha⁩'));
});

test('no label: the text does not name the item', () => {
  reset();
  openConflictDialog({ conflict: conflictResult(), t: tEn, writes: fakeWrites(), win: null });
  assert.match(dialogOf().querySelector('.dialog__desc').textContent, /^This item was changed on the server/);
});

test('a result that is not a conflict, or no writes object, opens nothing and answers invalid', async () => {
  reset();
  const a = await openConflictDialog({ conflict: { ok: true, status: 'saved' }, t: tEn, writes: fakeWrites() });
  assert.deepEqual(a, { ok: false, status: 'invalid', reason: 'not-a-conflict' });
  const b = await openConflictDialog({ conflict: conflictResult(), t: tEn });
  assert.deepEqual(b, { ok: false, status: 'invalid', reason: 'no-writes' });
  const c = await openConflictDialog();
  assert.equal(c.status, 'invalid');
  assert.equal(dialogOf(), null);
});
