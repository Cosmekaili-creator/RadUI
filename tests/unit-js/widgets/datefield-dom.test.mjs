// SPDX-License-Identifier: AGPL-3.0-or-later
// Date field and picker rendering, driven like a user through a fake DOM.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeDom, type, change, key, one, byTestId, pressEscape, fire } from './_dom.mjs';
import { createDateField, openDatePicker } from '../../../src/js/widgets/datefield.js';
import { createI18n } from '../_i18n-all.mjs';

const doc = makeDom();
const tEn = createI18n({ lang: 'en' }).t;
const tFr = createI18n({ lang: 'fr' }).t;
const NOW = () => new Date('2026-11-13T12:00:00Z');
const tick = () => new Promise((r) => setImmediate(r));
const D = (y, m, d) => ({ y, m, d });

function mountField(opts) {
  const f = createDateField({ testid: 'field-bday', label: 'Birthday', t: tFr, lang: 'fr', now: NOW, ...opts });
  doc.body.append(f.el);
  return f;
}
const reset = () => {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  doc.activeElement = doc.body;
};

test('field structure: label, hint, input, picker button, linked error line, test ids', () => {
  reset();
  const f = mountField({ yearOptional: true });
  const input = one(f.el, 'field-bday-input');
  assert.equal(f.el.getAttribute('data-testid'), 'field-bday');
  assert.equal(input, f.input);
  assert.equal(input.getAttribute('type'), 'text');
  assert.equal(input.getAttribute('autocomplete'), 'off');
  const label = f.el.querySelector('label');
  assert.equal(label.getAttribute('for'), input.id);
  assert.equal(label.textContent, 'Birthday');
  assert.match(one(f.el, 'field-bday-hint').textContent, /JJ\/MM\/AAAA.*JJ\/MM.*AAAA-MM-JJ/);
  assert.equal(input.getAttribute('placeholder'), 'JJ/MM/AAAA');
  const err = one(f.el, 'field-bday-error');
  assert.equal(err.getAttribute('data-visible'), 'false');
  assert.equal(err.hidden, false, 'the error line is always in the layout (its space is reserved)');
  const described = input.getAttribute('aria-describedby').split(' ');
  assert.ok(described.includes(`${input.id}-hint`) && described.includes(err.id), described.join());
  const btn = one(f.el, 'field-bday-picker');
  assert.equal(btn.getAttribute('aria-label'), 'Choisir la date pour Birthday');
  assert.equal(btn.getAttribute('type'), 'button');
  assert.equal(f.el.getAttribute('data-year-optional'), 'true');
});

test('field: typing, committing and the plain-data and ISO values', () => {
  reset();
  const seen = [];
  const f = mountField({ onChange: (r) => seen.push(r) });
  assert.equal(f.value, null);
  assert.equal(f.iso, '');
  type(f.input, '1990-11-13');
  assert.deepEqual(f.value, D(1990, 11, 13));
  assert.equal(f.iso, '1990-11-13');
  assert.equal(f.input.value, '1990-11-13', 'nothing is rewritten while typing');
  change(f.input);
  assert.equal(f.input.value, '13/11/1990', 'normalised to the locale form on commit');
  assert.equal(f.el.getAttribute('data-value'), '1990-11-13');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);
  assert.equal(one(f.el, 'field-bday-error').getAttribute('data-visible'), 'false');
});

test('field: an invalid date shows a persistent text error; correcting it clears the error', () => {
  reset();
  const f = mountField();
  type(f.input, '31/02/2020');
  change(f.input);
  const err = one(f.el, 'field-bday-error');
  assert.equal(err.getAttribute('data-visible'), 'true');
  assert.equal(err.textContent, 'Le jour 31 n’existe pas dans ce mois.');
  assert.equal(f.input.getAttribute('aria-invalid'), 'true');
  assert.equal(f.value, null);
  assert.equal(f.iso, '');
  type(f.input, '28/02/2020');
  assert.equal(err.getAttribute('data-visible'), 'false', 'the message goes away as soon as the text is valid');
  assert.equal(f.input.getAttribute('aria-invalid'), null);
});

test('field: required, year optional, min and max, in English', () => {
  reset();
  const f = createDateField({ testid: 'field-d', label: 'Date', t: tEn, lang: 'en', required: true, min: '2000-01-01', max: '2026-11-13', now: NOW });
  doc.body.append(f.el);
  assert.equal(f.input.getAttribute('aria-required'), 'true');
  const r = f.validate();
  assert.equal(r.error, 'required');
  assert.equal(one(f.el, 'field-d-error').textContent, 'Enter a date.');
  type(f.input, '11/14/2026');
  assert.equal(f.validate().error, 'max');
  assert.match(one(f.el, 'field-d-error').textContent, /11\/13\/2026 or earlier/);
  type(f.input, '12/31/1999');
  assert.equal(f.validate().error, 'min');
  type(f.input, '11/13/2026');
  assert.equal(f.validate().ok, true);
  assert.equal(f.iso, '2026-11-13');
});

test('field: year-less value is exposed with y null and the vCard ISO form', () => {
  reset();
  const f = mountField({ yearOptional: true });
  type(f.input, '24/03');
  change(f.input);
  assert.deepEqual(f.value, D(null, 3, 24));
  assert.equal(f.iso, '--03-24');
  assert.equal(f.input.value, '24/03');
});

test('field: setValue accepts plain data, ISO and null; a caller-provided error region receives the text', () => {
  reset();
  const region = doc.createElement('p');
  doc.body.append(region);
  const f = mountField({ errorRegion: region });
  assert.equal(f.errorEl, region);
  assert.ok(region.id, 'the region got an id');
  assert.ok(f.input.getAttribute('aria-describedby').split(' ').includes(region.id));
  assert.equal(one(f.el, 'field-bday-error'), null, 'no second error line');
  f.setValue(D(2000, 3, 24));
  assert.equal(f.input.value, '24/03/2000');
  f.setValue('1999-12-31');
  assert.equal(f.input.value, '31/12/1999');
  type(f.input, 'nope');
  change(f.input);
  assert.match(region.textContent, /pas valide/);
  assert.equal(region.hidden, false);
  f.setValue(null);
  assert.equal(f.input.value, '');
  assert.equal(region.hidden, true);
});

test('field without a picker has no picker button', () => {
  reset();
  const f = mountField({ picker: false });
  assert.equal(one(f.el, 'field-bday-picker'), null);
  assert.equal(f.pickerButton, null);
});

// ---------------------------------------------------------------------- picker

const days = (dlg) => byTestId(dlg, 'field-bday-picker-day');
const dayBtn = (dlg, iso) => dlg.querySelector(`[data-date="${iso}"]`);
const dialog = () => one(doc.body, 'field-bday-picker-dialog');

test('picker: opens on the value, focus on that day, month grid with accessible day names', async () => {
  reset();
  const opener = doc.createElement('button');
  doc.body.append(opener);
  opener.focus();
  const p = openDatePicker({ t: tEn, lang: 'en', label: 'Birthday', testid: 'field-bday', value: D(2026, 11, 13), now: NOW });
  const dlg = dialog();
  assert.ok(dlg.open);
  assert.equal(dlg.querySelector('h2').textContent, 'Choose a date: Birthday');
  assert.equal(days(dlg).length, 30);
  assert.equal(doc.activeElement.getAttribute('data-date'), '2026-11-13');
  assert.equal(doc.activeElement.getAttribute('tabindex'), '0');
  assert.equal(dayBtn(dlg, '2026-11-14').getAttribute('tabindex'), '-1', 'roving tabindex');
  assert.equal(doc.activeElement.getAttribute('aria-label'), 'Friday, November 13, 2026');
  assert.equal(doc.activeElement.parentNode.getAttribute('aria-selected'), 'true');
  assert.equal(dayBtn(dlg, '2026-11-13').getAttribute('aria-current'), 'date', 'the fixed "today" is 13 November');
  const grid = one(dlg, 'field-bday-picker-grid');
  assert.equal(grid.getAttribute('role'), 'grid');
  assert.equal(grid.getAttribute('aria-label'), 'Calendar, November 2026');
  assert.equal(one(dlg, 'field-bday-picker-month').value, '11');
  assert.equal(one(dlg, 'field-bday-picker-year').value, '2026');
  assert.ok(byTestId(dlg, 'field-bday-picker-clear').length === 0, 'no Clear button unless clearable');
  pressEscape(dlg);
  assert.equal(await p, null);
});

test('picker: arrow keys, Page keys, Home and End move the focus and change the month', async () => {
  reset();
  const p = openDatePicker({ t: tEn, lang: 'en', firstWeekday: 1, label: 'Birthday', testid: 'field-bday', value: D(2026, 11, 13), now: NOW });
  const dlg = dialog();
  const focused = () => doc.activeElement.getAttribute('data-date');
  key(doc.activeElement, 'ArrowRight');
  assert.equal(focused(), '2026-11-14');
  key(doc.activeElement, 'ArrowLeft');
  key(doc.activeElement, 'ArrowLeft');
  assert.equal(focused(), '2026-11-12');
  key(doc.activeElement, 'ArrowDown');
  assert.equal(focused(), '2026-11-19');
  key(doc.activeElement, 'ArrowUp');
  key(doc.activeElement, 'ArrowUp');
  assert.equal(focused(), '2026-11-05');
  key(doc.activeElement, 'Home');
  assert.equal(focused(), '2026-11-02');
  key(doc.activeElement, 'End');
  assert.equal(focused(), '2026-11-08');
  const ev = key(doc.activeElement, 'ArrowDown'); // 15 Nov
  assert.equal(ev.defaultPrevented, true, 'arrow keys do not scroll the page');
  key(doc.activeElement, 'ArrowDown'); // 22 Nov
  key(doc.activeElement, 'ArrowDown'); // 29 Nov
  key(doc.activeElement, 'ArrowDown'); // 6 Dec: the grid shows December
  assert.equal(focused(), '2026-12-06');
  assert.equal(days(dlg).length, 31);
  assert.equal(one(dlg, 'field-bday-picker-month').value, '12');
  assert.equal(one(dlg, 'field-bday-picker-grid').getAttribute('aria-label'), 'Calendar, December 2026');
  assert.equal(one(dlg, 'field-bday-picker-month-label').textContent, 'December 2026', 'the month change is announced');
  key(doc.activeElement, 'PageUp');
  assert.equal(focused(), '2026-11-06');
  key(doc.activeElement, 'PageDown', { shiftKey: true });
  assert.equal(focused(), '2027-11-06');
  assert.equal(one(dlg, 'field-bday-picker-year').value, '2027');
  const other = key(doc.activeElement, 'x');
  assert.equal(other.defaultPrevented, false);
  pressEscape(dlg);
  await p;
});

test('picker: Enter or a click on a day chooses it; the dialog closes and focus returns to the opener', async () => {
  reset();
  const opener = doc.createElement('button');
  doc.body.append(opener);
  opener.focus();
  const p = openDatePicker({ t: tEn, lang: 'en', label: 'Birthday', testid: 'field-bday', value: D(2026, 11, 13), now: NOW });
  const dlg = dialog();
  key(doc.activeElement, 'ArrowRight');
  doc.activeElement.click(); // Enter or Space on a button is a click
  assert.deepEqual(await p, { value: D(2026, 11, 14) });
  assert.equal(dlg.open, false);
  assert.equal(dialog(), null, 'the dialog is removed');
  assert.equal(doc.activeElement, opener);
});

test('picker: Esc cancels without a value and returns focus', async () => {
  reset();
  const opener = doc.createElement('button');
  doc.body.append(opener);
  opener.focus();
  const p = openDatePicker({ t: tEn, lang: 'en', label: 'Birthday', testid: 'field-bday', now: NOW });
  const dlg = dialog();
  assert.equal(pressEscape(dlg), 'closed');
  assert.equal(await p, null);
  assert.equal(doc.activeElement, opener);
  // the Cancel button does the same
  const p2 = openDatePicker({ t: tEn, lang: 'en', label: 'Birthday', testid: 'field-bday', now: NOW });
  one(dialog(), 'dialog-cancel').click();
  assert.equal(await p2, null);
});

test('picker: Today and Clear buttons; month and year fields; previous and next month', async () => {
  reset();
  let p = openDatePicker({ t: tEn, lang: 'en', label: 'Birthday', testid: 'field-bday', value: D(1990, 5, 20), clearable: true, now: NOW });
  let dlg = dialog();
  assert.equal(days(dlg).length, 31);
  assert.equal(one(dlg, 'field-bday-picker-year').value, '1990');
  const year = one(dlg, 'field-bday-picker-year');
  year.value = '1985';
  change(year);
  assert.equal(one(dlg, 'field-bday-picker-month').value, '5');
  assert.ok(dayBtn(dlg, '1985-05-20'));
  const month = one(dlg, 'field-bday-picker-month');
  month.value = '2';
  change(month);
  assert.equal(days(dlg).length, 28);
  one(dlg, 'field-bday-picker-next').click();
  assert.equal(days(dlg).length, 31);
  assert.ok(dayBtn(dlg, '1985-03-20'));
  one(dlg, 'field-bday-picker-prev').click();
  one(dlg, 'field-bday-picker-prev').click();
  assert.ok(dayBtn(dlg, '1985-01-20'));
  year.value = 'abc';
  change(year);
  assert.equal(year.value, '1985', 'an invalid year is put back');
  one(dlg, 'field-bday-picker-clear').click();
  assert.deepEqual(await p, { value: null });
  p = openDatePicker({ t: tEn, lang: 'en', label: 'Birthday', testid: 'field-bday', now: NOW });
  dlg = dialog();
  one(dlg, 'field-bday-picker-today').click();
  assert.deepEqual(await p, { value: D(2026, 11, 13) });
});

test('picker: days outside min and max are disabled and unreachable by keyboard', async () => {
  reset();
  const p = openDatePicker({ t: tEn, lang: 'en', label: 'Birthday', testid: 'field-bday', value: D(2026, 11, 13), min: '2026-11-10', max: '2026-11-15', now: NOW });
  const dlg = dialog();
  assert.equal(dayBtn(dlg, '2026-11-09').disabled, true);
  assert.equal(dayBtn(dlg, '2026-11-09').getAttribute('aria-label'), 'Monday, November 9, 2026 (not available)');
  assert.equal(dayBtn(dlg, '2026-11-10').disabled, false);
  assert.equal(dayBtn(dlg, '2026-11-15').disabled, false);
  assert.equal(dayBtn(dlg, '2026-11-16').disabled, true);
  key(doc.activeElement, 'ArrowDown');
  key(doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement.getAttribute('data-date'), '2026-11-15', 'clamped to the maximum');
  key(doc.activeElement, 'PageUp');
  assert.equal(doc.activeElement.getAttribute('data-date'), '2026-11-10', 'clamped to the minimum');
  pressEscape(dlg);
  await p;
});

test('picker: a Sunday-first language and week start', async () => {
  reset();
  const p = openDatePicker({ t: tEn, lang: 'en', firstWeekday: 7, label: 'D', testid: 'field-bday', value: D(2026, 11, 13), now: NOW });
  const dlg = dialog();
  const heads = dlg.querySelectorAll('th');
  assert.equal(heads[0].textContent, 'Sun');
  assert.equal(heads[6].textContent, 'Sat');
  key(doc.activeElement, 'Home');
  assert.equal(doc.activeElement.getAttribute('data-date'), '2026-11-08');
  pressEscape(dlg);
  await p;
});

test('picker through the field: the button opens it, the choice fills the input, focus returns to the input', async () => {
  reset();
  const f = mountField({ yearOptional: true, clearable: true });
  type(f.input, '1990-11-13');
  change(f.input);
  one(f.el, 'field-bday-picker').click();
  await tick();
  const dlg = dialog();
  assert.ok(dlg);
  assert.equal(doc.activeElement.getAttribute('data-date'), '1990-11-13', 'opens on the typed value');
  key(doc.activeElement, 'ArrowRight');
  doc.activeElement.click();
  await tick();
  assert.equal(f.input.value, '14/11/1990');
  assert.deepEqual(f.value, D(1990, 11, 14));
  assert.equal(doc.activeElement, f.input);
  // Alt+Down on the input also opens it
  const ev = key(f.input, 'ArrowDown', { altKey: true });
  assert.equal(ev.defaultPrevented, true);
  await tick();
  assert.ok(dialog());
  one(dialog(), 'field-bday-picker-clear').click();
  await tick();
  assert.equal(f.input.value, '');
  assert.equal(f.value, null);
});

test('picker through a year-less field: an invalid typed text does not break opening', async () => {
  reset();
  const f = mountField({ yearOptional: true });
  type(f.input, 'garbage');
  fire(f.input, 'change');
  const done = f.openPicker();
  await tick();
  assert.equal(doc.activeElement.getAttribute('data-date'), '2026-11-13', 'falls back to today');
  pressEscape(dialog());
  assert.equal(await done, null);
  assert.equal(f.input.value, 'garbage', 'cancelling leaves the text as typed');
});

test('layout contract: an error on blur adds, removes and moves NO node (the first click on Create is not lost)', () => {
  reset();
  const f = mountField({ yearOptional: true });
  const err = one(f.el, 'field-bday-error');
  const shape = () => f.el.all(() => true).map((n) => `${n.tagName}#${n.getAttribute('data-testid') || ''}`).join('|');
  const before = shape();
  const parent = err.parentNode;
  const index = parent.childNodes.indexOf(err);
  type(f.input, '31/02/2020');
  change(f.input);
  assert.equal(shape(), before, 'same nodes, same order');
  assert.equal(err.parentNode, parent);
  assert.equal(parent.childNodes.indexOf(err), index);
  assert.equal(err.hidden, false, 'never toggled with the hidden attribute (display: none would reflow)');
  assert.equal(err.getAttribute('data-visible'), 'true');
  type(f.input, '28/02/2020');
  assert.equal(shape(), before);
});

test('layout contract (css): the date field error line reserves its space and only changes visibility', () => {
  const css = readFileSync(new URL('../../../src/css/widgets.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const base = css.match(/\.datefield__error\s*\{([^}]*)\}/);
  assert.ok(base, 'a .datefield__error rule');
  assert.match(base[1], /min-height:\s*[\d.]+(?:em|lh|rem)/);
  assert.match(base[1], /visibility:\s*hidden/);
  assert.equal(/display:\s*none/.test(base[1]), false);
  const shown = css.match(/\.datefield__error\[data-visible="true"\]\s*\{([^}]*)\}/);
  assert.ok(shown && /visibility:\s*visible/.test(shown[1]));
  assert.equal(/\.datefield__error[^{]*\{[^}]*display:\s*none/.test(css), false);
});

test('css: under 360 px the calendar fills the width and its cells lose their padding (44 px day cells)', () => {
  const css = readFileSync(new URL('../../../src/css/widgets.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const m = css.match(/@media \(max-width: 359px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'a max-width: 359px block');
  assert.match(m[1], /\.dialog\.dialog--cal\s*\{[^}]*width:\s*100vw/);
  assert.match(m[1], /\.cal__grid td[^{]*\{[^}]*padding-left:\s*0[^}]*padding-right:\s*0/);
  assert.match(css, /\.cal__day\s*\{[^}]*min-height:\s*var\(--tap\)/);
});
