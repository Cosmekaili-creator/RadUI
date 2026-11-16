// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, type, choose, chooseRadio, one, byTestId } from './_dom.mjs';
import { createRowsModel, createRepeatable } from '../../../src/js/widgets/repeatable.js';
import { snapshotForm, restoreForm } from '../../../src/js/ui.js';
import { createI18n } from '../_i18n-all.mjs';

const doc = makeDom();
const t = createI18n({ lang: 'en' }).t;

// ------------------------------------------------------------------ pure model

const origA = { prop: 'TEL#1', marker: {} };
const origB = { prop: 'TEL#2', marker: {} };
const origC = { prop: 'TEL#3', marker: {} };
const loaded = () => [
  { orig: origA, type: 'cell', pref: true, values: { value: '+1 555 0100' } },
  { orig: origB, type: 'work', values: { value: '+1 555 0101' } },
  { orig: origC, type: 'x-weird', custom: 'Boat', values: { value: '+1 555 0102' } },
];
const model = () => createRowsModel({ kind: 'phone', rows: loaded(), blank: () => ({ value: '' }), defaultType: 'cell' });

test('model: rows keep the caller handle untouched (same reference) and start unchanged', () => {
  const m = model();
  assert.equal(m.size, 3);
  assert.equal(m.rows[0].orig, origA);
  assert.equal(m.rows[1].orig, origB);
  assert.equal(m.rows[2].orig, origC);
  assert.ok(m.rows.every((r) => !r.isNew && !r.changed && !r.typeChanged && !r.prefChanged && r.changedFields.length === 0));
  assert.equal(m.dirty, false);
  assert.equal(m.preferredKey, m.rows[0].key);
  assert.equal(new Set(m.rows.map((r) => r.key)).size, 3);
});

test('model: update marks only the fields that differ from the loaded row; reverting un-marks them', () => {
  const m = model();
  const [a, b] = m.rows;
  m.update(a.key, 'value', '+1 555 0199');
  assert.deepEqual(a.changedFields, ['value']);
  assert.equal(a.changed, true);
  assert.equal(a.typeChanged, false, 'the type select was not touched');
  assert.equal(b.changed, false);
  assert.equal(m.dirty, true);
  m.update(a.key, 'value', '+1 555 0100');
  assert.equal(a.changed, false);
  assert.equal(m.dirty, false);
  m.update(b.key, 'type', 'home');
  assert.equal(b.typeChanged, true);
  assert.deepEqual(b.changedFields, ['type']);
  m.update(b.key, 'custom', 'Desk');
  assert.deepEqual(b.changedFields, ['type', 'custom']);
  assert.equal(m.update('nope', 'value', 'x'), false);
  assert.equal(b.orig, origB);
});

test('model: markChanged forces a field to count as changed', () => {
  const m = model();
  const a = m.rows[0];
  assert.equal(m.markChanged(a.key, 'value'), true);
  assert.deepEqual(a.changedFields, ['value']);
  assert.equal(a.changed, true);
  m.markChanged(a.key, 'type');
  assert.equal(a.typeChanged, true);
  m.markChanged(m.rows[1].key, 'pref');
  assert.equal(m.rows[1].prefChanged, true);
  assert.equal(m.markChanged('nope', 'value'), false);
});

test('model: addRow appends a new row without a handle; the maximum is enforced', () => {
  const m = createRowsModel({ kind: 'phone', rows: loaded(), blank: () => ({ value: '' }), defaultType: 'cell', max: 4 });
  const row = m.addRow();
  assert.equal(row.isNew, true);
  assert.equal(row.orig, null);
  assert.equal(row.type, 'cell');
  assert.deepEqual(row.values, { value: '' });
  assert.equal(row.changed, true);
  assert.equal(m.size, 4);
  assert.equal(m.canAdd, false);
  assert.equal(m.addRow(), null);
  assert.equal(m.dirty, true);
});

test('model: removeRow returns the index, keeps original handles of removed rows, never reuses keys', () => {
  const m = model();
  const keys = m.rows.map((r) => r.key);
  const res = m.removeRow(keys[1]);
  assert.equal(res.index, 1);
  assert.equal(res.row.orig, origB);
  assert.deepEqual(m.removed, [origB]);
  assert.equal(m.size, 2);
  assert.equal(m.dirty, true);
  assert.equal(m.removeRow(keys[1]), null);
  const added = m.addRow();
  assert.ok(!keys.includes(added.key));
  m.removeRow(added.key);
  assert.deepEqual(m.removed, [origB], 'removing a new row leaves no trace');
  assert.equal(m.indexOf(keys[2]), 1);
});

test('model: the preferred choice is exclusive per kind and prefChanged is derived from the loaded state', () => {
  const m = model();
  const [a, b, c] = m.rows;
  assert.equal(m.setPreferred(b.key), true);
  assert.deepEqual([a.pref, b.pref, c.pref], [false, true, false]);
  assert.equal(a.prefChanged, true);
  assert.equal(b.prefChanged, true);
  assert.equal(c.prefChanged, false);
  m.setPreferred(a.key);
  assert.deepEqual([a.pref, b.pref], [true, false]);
  assert.equal(a.prefChanged, false, 'back to the loaded state: pref stays undefined in the patch');
  assert.equal(b.prefChanged, false);
  assert.equal(m.dirty, false);
  m.clearPreferred();
  assert.equal(m.preferredKey, null);
  assert.equal(a.prefChanged, true);
  assert.equal(m.setPreferred('nope'), false);
  const n = m.addRow({ pref: true });
  assert.equal(m.preferredKey, n.key);
});

test('model: snapshot is plain data without handles', () => {
  const m = model();
  m.update(m.rows[0].key, 'value', 'x');
  const snap = m.snapshot();
  assert.equal(snap.length, 3);
  assert.equal(JSON.stringify(snap).includes('marker'), false);
  assert.deepEqual(snap[0].changedFields, ['value']);
});

// -------------------------------------------------------------------- rendering

const TYPES = [
  { value: 'cell', label: 'Mobile' },
  { value: 'home', label: 'Home' },
  { value: 'work', label: 'Work' },
  { value: 'custom', label: 'Custom' },
];
function mount(extra = {}) {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  const said = [];
  const changes = [];
  const rep = createRepeatable({
    kind: 'phone',
    t,
    labels: { legend: 'Phones', row: 'Phone {n}', add: 'Add phone', remove: 'Remove phone {n}' },
    types: TYPES,
    fields: [{ name: 'value', label: 'Number', input: 'tel', attrs: { autocomplete: 'tel', inputmode: 'tel' } }],
    rows: loaded(),
    blank: () => ({ value: '' }),
    defaultType: 'cell',
    announce: (s) => said.push(s),
    onChange: (c) => changes.push(c),
    ...extra,
  });
  doc.body.append(rep.el);
  return { rep, said, changes };
}
const rows = (rep) => byTestId(rep.el, 'phone-row');

test('render: a group per kind, one row per phone, add button, ids and accessible names', () => {
  const { rep } = mount();
  assert.equal(rep.el.tagName, 'FIELDSET');
  assert.equal(rep.el.querySelector('legend').textContent, 'Phones');
  assert.equal(rows(rep).length, 3);
  assert.equal(one(rep.el, 'btn-add-phone').textContent, 'Add phone');
  const removes = byTestId(rep.el, 'btn-remove-phone');
  assert.deepEqual(removes.map((b) => b.getAttribute('aria-label')), ['Remove phone 1', 'Remove phone 2', 'Remove phone 3']);
  assert.equal(removes[0].textContent, 'Remove');
  const types = byTestId(rep.el, 'field-phone-type');
  assert.equal(types.length, 3);
  assert.deepEqual(types.map((s) => s.value), ['cell', 'work', 'x-weird'], 'an unknown type is shown as written');
  assert.equal(types[2].querySelectorAll('option').length, 5, 'the unknown value was added to the options');
  const values = byTestId(rep.el, 'field-phone');
  assert.deepEqual(values.map((v) => v.value), ['+1 555 0100', '+1 555 0101', '+1 555 0102']);
  assert.equal(values[0].getAttribute('type'), 'tel');
  assert.equal(values[0].getAttribute('autocomplete'), 'tel');
  // the control is named by the row caption plus its visible label
  const names = values[1].getAttribute('aria-labelledby').split(' ').map((id) => doc.body.querySelector(`#${id}`).textContent);
  assert.deepEqual(names, ['Phone 2', 'Number']);
  assert.equal(doc.body.querySelector(`#${values[1].id}-label`).getAttribute('for'), values[1].id);
  // every id is unique
  const ids = doc.body.querySelectorAll('[id]').map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('render: the custom label field shows only for the custom type', () => {
  const { rep } = mount();
  const customs = byTestId(rep.el, 'field-phone-custom');
  assert.equal(customs.length, 3);
  const boxes = customs.map((c) => c.parentNode);
  assert.deepEqual(boxes.map((b) => b.hidden), [true, true, true], 'the stored custom label of a non-custom row stays hidden');
  const sel = byTestId(rep.el, 'field-phone-type')[0];
  choose(sel, 'custom');
  assert.equal(boxes[0].hidden, false);
  type(customs[0], 'Boat phone');
  assert.equal(rep.model.rows[0].custom, 'Boat phone');
  assert.equal(rep.model.rows[0].typeChanged, true);
  choose(sel, 'home');
  assert.equal(boxes[0].hidden, true);
});

test('render: editing updates the model and reports the change; untouched rows stay unchanged', () => {
  const { rep, changes } = mount();
  type(byTestId(rep.el, 'field-phone')[1], '+1 555 0177');
  assert.deepEqual(changes, [{ type: 'edit', key: rep.model.rows[1].key, field: 'value' }]);
  assert.deepEqual(rep.model.rows.map((r) => r.changed), [false, true, false]);
  assert.equal(rep.model.rows[1].orig, origB);
});

test('render: preferred is one radio group; choosing one unticks the others and the model follows', () => {
  const { rep, changes } = mount();
  const radios = byTestId(rep.el, 'field-phone-pref');
  assert.equal(radios.length, 3);
  assert.equal(new Set(radios.map((r) => r.getAttribute('name'))).size, 1, 'one group');
  assert.deepEqual(radios.map((r) => r.checked), [true, false, false]);
  chooseRadio(radios[2], doc);
  assert.deepEqual(radios.map((r) => r.checked), [false, false, true]);
  assert.equal(rep.model.preferredKey, rep.model.rows[2].key);
  assert.equal(changes.at(-1).type, 'pref');
  const clear = one(rep.el, 'btn-clear-pref-phone');
  assert.equal(clear.hidden, false);
  clear.click();
  assert.equal(rep.model.preferredKey, null);
  assert.deepEqual(byTestId(rep.el, 'field-phone-pref').map((r) => r.checked), [false, false, false]);
  assert.equal(one(rep.el, 'btn-clear-pref-phone').hidden, true);
  assert.equal(doc.activeElement, one(rep.el, 'btn-add-phone'));
});

test('add: a new row appears, its first field gets the focus, the status region is told', () => {
  const { rep, said, changes } = mount();
  one(rep.el, 'btn-add-phone').click();
  assert.equal(rows(rep).length, 4);
  const added = rows(rep)[3];
  assert.equal(added.getAttribute('data-new'), 'true');
  assert.equal(doc.activeElement, added.querySelector('[data-testid="field-phone"]'));
  assert.deepEqual(said, ['Phone 4 added.']);
  assert.equal(changes.at(-1).type, 'add');
  assert.equal(byTestId(rep.el, 'btn-remove-phone')[3].getAttribute('aria-label'), 'Remove phone 4');
  // typed values survive a re-render caused by another add
  type(doc.activeElement, '+1 555 0150');
  one(rep.el, 'btn-add-phone').click();
  assert.equal(byTestId(rep.el, 'field-phone')[3].value, '+1 555 0150');
  assert.equal(rows(rep).length, 5);
});

test('add: the button is disabled at the maximum and a note explains it', () => {
  const { rep } = mount({ max: 3 });
  assert.equal(one(rep.el, 'btn-add-phone').disabled, true);
  assert.equal(one(rep.el, 'phone-max').hidden, false);
  assert.match(one(rep.el, 'phone-max').textContent, /at most 3/);
  one(rep.el, 'btn-remove-phone').click();
  assert.equal(one(rep.el, 'btn-add-phone').disabled, false);
  assert.equal(one(rep.el, 'phone-max').hidden, true);
});

test('remove: the row goes, the numbers shift, focus lands on a neighbour, the status region is told', () => {
  const { rep, said } = mount();
  byTestId(rep.el, 'btn-remove-phone')[1].click();
  assert.equal(rows(rep).length, 2);
  assert.deepEqual(byTestId(rep.el, 'field-phone').map((v) => v.value), ['+1 555 0100', '+1 555 0102']);
  assert.deepEqual(byTestId(rep.el, 'btn-remove-phone').map((b) => b.getAttribute('aria-label')), ['Remove phone 1', 'Remove phone 2']);
  assert.equal(doc.activeElement, byTestId(rep.el, 'field-phone')[1], 'the row that took its place');
  assert.deepEqual(said, ['Phone 2 removed.']);
  assert.deepEqual(rep.model.removed, [origB]);
  byTestId(rep.el, 'btn-remove-phone')[1].click(); // the last row: focus goes to the previous one
  assert.equal(doc.activeElement, byTestId(rep.el, 'field-phone')[0]);
  byTestId(rep.el, 'btn-remove-phone')[0].click(); // none left: focus goes to Add
  assert.equal(rows(rep).length, 0);
  assert.equal(doc.activeElement, one(rep.el, 'btn-add-phone'));
  assert.deepEqual(said, ['Phone 2 removed.', 'Phone 2 removed.', 'Phone 1 removed.']);
  assert.deepEqual(rep.model.removed, [origB, origC, origA]);
});

test('render: several value fields, a field folded under More, test ids per field, textarea', () => {
  const { rep } = mount({
    kind: 'address',
    labels: { legend: 'Addresses', row: 'Address {n}', add: 'Add address', remove: 'Remove address {n}' },
    types: [{ value: 'home', label: 'Home' }],
    fields: [
      { name: 'street', label: 'Street', input: 'textarea' },
      { name: 'city', label: 'City' },
      { name: 'pobox', label: 'PO box', more: true },
      { name: 'ext', label: 'Extended address', more: true },
    ],
    rows: [{ orig: {}, type: 'home', values: { street: '1 Example Street', city: 'Springfield', pobox: '', ext: '' } }],
    blank: () => ({ street: '', city: '', pobox: '', ext: '' }),
    defaultType: 'home',
  });
  const row = byTestId(rep.el, 'address-row')[0];
  assert.ok(row.querySelector('textarea[data-testid="field-address-street"]'));
  assert.ok(one(row, 'field-address-city'));
  const details = one(row, 'address-more');
  assert.equal(details.open, false, 'empty optional fields are folded');
  assert.ok(details.querySelector('[data-testid="field-address-pobox"]'));
  assert.equal(details.querySelector('summary').textContent, 'More fields');
  assert.ok(one(rep.el, 'btn-add-address') && one(rep.el, 'btn-remove-address'));
  // a filled optional field opens the disclosure
  const rep2 = createRepeatable({
    kind: 'address', t, labels: { legend: 'A', row: 'Address {n}', add: 'Add', remove: 'Remove {n}' }, preferred: false,
    fields: [{ name: 'city', label: 'City' }, { name: 'pobox', label: 'PO box', more: true }],
    rows: [{ orig: {}, values: { city: 'X', pobox: '12' } }],
  });
  assert.equal(one(rep2.el, 'address-more').open, true);
  assert.equal(byTestId(rep2.el, 'field-address-pref').length, 0, 'no preferred radio when turned off');
  assert.equal(byTestId(rep2.el, 'field-address-type').length, 0, 'no type select without types');
});

test('render: persistent per-field errors with aria-describedby; they can be cleared', () => {
  const { rep } = mount();
  const key = rep.model.rows[1].key;
  assert.equal(rep.setError(key, 'value', 'Enter a valid phone number.'), true);
  const input = byTestId(rep.el, 'field-phone')[1];
  const err = doc.body.querySelector(`#${input.getAttribute('aria-describedby')}`);
  assert.equal(err.textContent, 'Enter a valid phone number.');
  assert.equal(err.hidden, false);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(rep.focusField(key, 'value'), true);
  assert.equal(doc.activeElement, input);
  rep.clearErrors();
  assert.equal(err.hidden, true);
  assert.equal(input.getAttribute('aria-invalid'), null);
  assert.equal(rep.setError('nope', 'value', 'x'), false);
});

test('render: no drag handles, only buttons; every control is a real input, select or button', () => {
  const { rep } = mount();
  assert.equal(rep.el.querySelectorAll('[draggable]').length, 0);
  assert.equal(rep.el.querySelectorAll('[tabindex]').length, 0);
  for (const b of rep.el.querySelectorAll('button')) assert.equal(b.getAttribute('type'), 'button');
  assert.equal(rep.el.querySelectorAll('[style]').length, 0);
});

test('render: the language-switch snapshot (m11) captures and restores typed row values', () => {
  const { rep } = mount();
  type(byTestId(rep.el, 'field-phone')[0], '+1 555 0111');
  const snap = snapshotForm(rep.el, doc);
  const again = mount();
  assert.equal(restoreForm(again.rep.el, snap) > 0, true);
  assert.equal(byTestId(again.rep.el, 'field-phone')[0].value, '+1 555 0111');
});
