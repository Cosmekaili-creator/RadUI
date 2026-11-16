// SPDX-License-Identifier: AGPL-3.0-or-later
// The scope dialogs (WP B3b): askScope (edit and delete; no "this and following" for the first occurrence; the interface
// B3a's actions.js calls) and askRuleExceptions (addendum M3: no default to Keep when something would be orphaned).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createI18n } from '../_i18n-all.mjs';
import { askRuleExceptions, askScope } from '../../../src/js/views/calendar/scopedialog.js';
import { doc, dlg, flush, q, qa } from './event-helpers.mjs';

const en = createI18n({ lang: 'en' });
const fr = createI18n({ lang: 'fr' });
const T = { t: (k, p) => en.t(k, p), tp: (k, n, p) => en.tp(k, n, p) };
const ids = (d) => ['scope-this', 'scope-following', 'scope-all', 'scope-cancel'].filter((i) => q(d, i));
const exdate = (iso) => ({ type: 'exdate', spec: { kind: 'zoned', iso, tzid: 'Europe/Paris' }, key: `i${iso}` });
const override = (iso) => ({ type: 'override', spec: { kind: 'zoned', iso, tzid: 'Europe/Paris' }, key: `o${iso}` });

test('askScope edit: three choices plus Cancel, ids per variant, the choice is the answer, focus on "this"', async () => {
  const p = askScope({ mode: 'edit', isFirst: false, title: 'Weekly sync', ...T });
  const d = dlg('dialog-scope-edit');
  assert.ok(d);
  assert.deepEqual(ids(d), ['scope-this', 'scope-following', 'scope-all', 'scope-cancel']);
  assert.match(d.textContent, /Weekly sync/);
  assert.match(d.textContent, /Only this date changes/);
  assert.equal(doc.activeElement, q(d, 'scope-this'));
  q(d, 'scope-following').click();
  assert.equal(await p, 'following');
  assert.equal(dlg('dialog-scope-edit'), null, 'the dialog is gone');
});

test('askScope: the first occurrence has no "this and following"; Cancel and Esc answer null; delete focuses Cancel', async () => {
  let p = askScope({ mode: 'edit', isFirst: true, title: 'x', ...T });
  assert.deepEqual(ids(dlg('dialog-scope-edit')), ['scope-this', 'scope-all', 'scope-cancel']);
  q(dlg('dialog-scope-edit'), 'scope-all').click();
  assert.equal(await p, 'all');
  p = askScope({ mode: 'delete', isFirst: false, title: 'x', ...T });
  const d = dlg('dialog-scope-delete');
  assert.ok(d);
  assert.deepEqual(ids(d), ['scope-this', 'scope-following', 'scope-all', 'scope-cancel']);
  assert.equal(doc.activeElement, q(d, 'scope-cancel'), 'a delete never starts on a destructive button');
  assert.match(q(d, 'scope-all').className, /btn--danger/);
  q(d, 'scope-cancel').click();
  assert.equal(await p, null);
  p = askScope({ mode: 'edit', title: 'x', ...T });
  dlg('dialog-scope-edit').close('');
  assert.equal(await p, null);
});

test('askScope: titles come from the dictionary in both languages, the series name is isolated for right-to-left names', async () => {
  const p = askScope({ mode: 'delete', title: 'Réunion', t: (k, v) => fr.t(k, v) });
  const d = dlg('dialog-scope-delete');
  assert.match(d.textContent, /Supprimer dans un événement récurrent/);
  assert.match(d.textContent, /Supprimer cette occurrence/);
  q(d, 'scope-cancel').click();
  await p;
});

test('askRuleExceptions: nothing orphaned -> Keep is the default and focused; the count is named', async () => {
  const list = [exdate('2026-03-16T09:30:00'), override('2026-03-23T09:30:00')];
  const p = askRuleExceptions({ exceptions: list, orphans: [], defaultChoice: 'keep', ...T, win: {} });
  const d = dlg('dialog-rule-exceptions');
  assert.ok(d);
  assert.equal(doc.activeElement, q(d, 'exceptions-keep'));
  assert.match(q(d, 'exceptions-keep').className, /btn--primary/);
  assert.equal(q(d, 'exceptions-remove-orphans'), null);
  assert.match(q(d, 'exceptions-remove').textContent, /Remove 2 exceptions/);
  q(d, 'exceptions-keep').click();
  assert.equal(await p, 'keep');
});

test('askRuleExceptions: orphans listed, "will no longer be shown", Keep is NOT the default and Cancel has the focus (addendum M3)', async () => {
  const all = [exdate('2026-03-16T09:30:00'), exdate('2026-03-23T09:30:00'), override('2026-03-30T09:30:00')];
  const p = askRuleExceptions({ exceptions: all, orphans: all.slice(0, 2), defaultChoice: null, ...T, win: {} });
  const d = dlg('dialog-rule-exceptions');
  assert.equal(doc.activeElement, q(d, 'exceptions-cancel'));
  assert.doesNotMatch(q(d, 'exceptions-keep').className, /btn--primary/);
  assert.equal(qa(d, 'exception-item').length, 2);
  assert.match(d.textContent, /2 dates will no longer be shown/);
  assert.match(q(d, 'exceptions-keep').textContent, /they will no longer be shown/);
  assert.match(q(d, 'exceptions-remove-orphans').textContent, /Remove only these 2 dates/);
  q(d, 'exceptions-remove-orphans').click();
  assert.equal(await p, 'remove-orphans');
});

test('askRuleExceptions: when every exception is orphaned there is no separate "only these" button; Cancel answers null', async () => {
  const all = [exdate('2026-03-16T09:30:00')];
  const p = askRuleExceptions({ exceptions: all, orphans: all, defaultChoice: null, ...T, win: {} });
  const d = dlg('dialog-rule-exceptions');
  assert.equal(q(d, 'exceptions-remove-orphans'), null);
  assert.match(q(d, 'exceptions-remove').textContent, /Remove 1 exception/);
  q(d, 'exceptions-cancel').click();
  assert.equal(await p, null);
  await flush(2);
});
