// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, type, key, one, byTestId, fakeTimers, pressEscape } from './_dom.mjs';
import { buildIndex, searchOptions, createPickerState, openPicker, MAX_RESULTS } from '../../../src/js/widgets/picker.js';
import { createI18n } from '../_i18n-all.mjs';

const doc = makeDom();
const i18n = createI18n({ lang: 'en' });
const t = i18n.t;
const tp = i18n.tp;

const people = [
  { id: 'u1', label: 'Zoë Martin', sublabel: 'zoe@example.org' },
  { id: 'u2', label: 'Éric Dupont', sublabel: 'eric@example.org', keywords: ['Œuvres Ltd'] },
  { id: 'u3', label: 'Martin Zola', sublabel: 'martin@example.org' },
  { id: 'u4', label: 'Jean D’Arc' },
  { id: 'u5', label: 'Anne-Marie Smith', sublabel: 'amsmith@example.org' },
  { id: 'u6', label: 'Bob Marley', disabled: true },
];
const many = Array.from({ length: 130 }, (_, i) => ({ id: `m${i}`, label: `Member ${String(i).padStart(3, '0')}` }));

// ------------------------------------------------------------------ pure logic

test('searchOptions: accent, case, ligature and apostrophe insensitive; every word must match', () => {
  const ids = (q) => searchOptions(people, q).items.map((o) => o.id);
  assert.deepEqual(ids('zoe'), ['u1']);
  assert.deepEqual(ids('ZOË'), ['u1']);
  assert.deepEqual(ids('eric'), ['u2']);
  assert.deepEqual(ids('oeuvres'), ['u2'], 'keywords are searched');
  assert.deepEqual(ids("d'arc"), ['u4']);
  assert.deepEqual(ids('d’arc'), ['u4']);
  assert.deepEqual(ids('example.org').length, 4, 'sub-labels are searched');
  assert.deepEqual(ids('martin zoe'), ['u1']);
  assert.deepEqual(ids('martin zola'), ['u3']);
  assert.deepEqual(ids('nobody'), []);
  assert.equal(searchOptions(people, '').total, 6);
  assert.equal(searchOptions(people, '   ').items.length, 6);
});

test('searchOptions: labels starting with the query come first, then word starts, then the rest; ties keep order', () => {
  const r = searchOptions(people, 'mar').items.map((o) => o.id);
  assert.equal(r[0], 'u3', 'label starts with "mar"');
  assert.ok(r.indexOf('u1') < r.indexOf('u5'), 'word start before inside-word match');
  assert.deepEqual(searchOptions(people, '').items.map((o) => o.id), people.map((o) => o.id), 'empty query keeps the caller order');
});

test('searchOptions: at most 50 results, with the real total and a truncated flag', () => {
  const r = searchOptions(many, '');
  assert.equal(r.items.length, MAX_RESULTS);
  assert.equal(r.total, 130);
  assert.equal(r.truncated, true);
  const r2 = searchOptions(many, 'member 12');
  assert.equal(r2.total, 12, '012, 112 and 120 to 129');
  assert.equal(r2.truncated, false);
  assert.equal(searchOptions(many, '', { limit: 10 }).items.length, 10);
  assert.equal(searchOptions(many, '', { limit: 500 }).items.length, 50, 'the limit never exceeds 50');
  assert.equal(searchOptions([], 'x').total, 0);
});

test('searchOptions: accepts a prebuilt index', () => {
  const index = buildIndex(people);
  assert.equal(searchOptions(index, 'zoe').items[0].id, 'u1');
  assert.equal(index[0].label, 'zoe martin');
});

test('createPickerState: active option, movement, selection (single and multi), disabled options', () => {
  const s = createPickerState({ options: people, multiple: true, selected: ['u1', 'nope'] });
  assert.deepEqual(s.selected, ['u1'], 'unknown ids are dropped');
  assert.equal(s.activeIndex, 0);
  assert.equal(s.activeId, 'u1');
  assert.equal(s.move(1), 1);
  assert.equal(s.move(100), 5, 'clamped, no wrap');
  assert.equal(s.move(-100), 0);
  assert.equal(s.move('last'), 5);
  assert.equal(s.move('first'), 0);
  assert.equal(s.toggle('u2'), true);
  assert.deepEqual(s.selected, ['u1', 'u2']);
  assert.equal(s.toggle('u1'), true);
  assert.deepEqual(s.selected, ['u2']);
  assert.equal(s.toggle('u6'), false, 'disabled');
  assert.equal(s.toggle('zzz'), false, 'unknown');
  s.setQuery('martin');
  assert.equal(s.activeIndex, 0, 'a new search resets the active option');
  assert.deepEqual(s.results.map((o) => o.id), ['u3', 'u1']);
  s.setQuery('nobody');
  assert.equal(s.activeIndex, -1);
  assert.equal(s.activeId, null);
  assert.equal(s.move(1), -1);
  const single = createPickerState({ options: people, selected: ['u1', 'u2'] });
  assert.deepEqual(single.selected, ['u1']);
  single.toggle('u3');
  assert.deepEqual(single.selected, ['u3'], 'single mode replaces');
});

// ------------------------------------------------------------------- rendering

const reset = () => {
  for (const c of [...doc.body.childNodes]) doc.body.removeChild(c);
  doc.activeElement = doc.body;
};
function open(extra = {}) {
  reset();
  const opener = doc.createElement('button');
  doc.body.append(opener);
  opener.focus();
  const timers = fakeTimers();
  const p = openPicker({ name: 'member', title: 'Add a member', options: people, t, tp, timers, win: null, ...extra });
  const dlg = one(doc.body, 'member-picker');
  return { p, dlg, timers, opener, input: one(dlg, 'field-member-search'), list: one(dlg, 'member-list'), count: one(dlg, 'member-result-count') };
}
const optionIds = (dlg) => byTestId(dlg, 'member-option').map((o) => o.getAttribute('data-id'));

test('dialog: structure, test ids and accessible roles (combobox, listbox, option, live count)', () => {
  const { dlg, input, list, count } = open();
  assert.equal(dlg.querySelector('h2').textContent, 'Add a member');
  assert.equal(doc.activeElement, input);
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-controls'), list.id);
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');
  assert.equal(dlg.querySelector('label').getAttribute('for'), input.id);
  assert.equal(dlg.querySelector('label').textContent, 'Search');
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.equal(list.getAttribute('aria-multiselectable'), null);
  assert.equal(count.getAttribute('role'), 'status');
  assert.equal(count.getAttribute('aria-live'), 'polite');
  assert.equal(count.textContent, '6 results');
  assert.ok(input.getAttribute('aria-describedby').includes(count.id));
  const opts = byTestId(dlg, 'member-option');
  assert.equal(opts.length, 6);
  assert.ok(opts.every((o) => o.getAttribute('role') === 'option'));
  assert.equal(opts[0].querySelector('.picker__label').textContent, 'Zoë Martin');
  assert.equal(opts[0].querySelector('.picker__sub').textContent, 'zoe@example.org');
  assert.equal(opts[5].getAttribute('aria-disabled'), 'true');
  assert.equal(input.getAttribute('aria-activedescendant'), opts[0].id);
  assert.ok(opts[0].classList.contains('is-active'));
  assert.equal(byTestId(dlg, 'member-picker-confirm').length, 0, 'single mode has no confirm button');
  assert.ok(one(dlg, 'dialog-cancel'));
});

test('typing filters the list after the debounce; the live count follows later still (m17)', () => {
  const { dlg, input, count, timers } = open();
  type(input, 'zo');
  assert.equal(optionIds(dlg).length, 6, 'nothing changes before the debounce delay');
  timers.advance(119);
  assert.equal(optionIds(dlg).length, 6);
  timers.advance(1);
  assert.deepEqual(optionIds(dlg), ['u1', 'u3'], 'Zoë and Zola');
  assert.equal(count.textContent, '6 results', 'the live text is throttled');
  timers.advance(500);
  assert.equal(count.textContent, '2 results');
  type(input, 'z');
  type(input, 'zo');
  type(input, 'zoe');
  timers.advance(120);
  assert.deepEqual(optionIds(dlg), ['u1']);
  timers.advance(500);
  assert.equal(count.textContent, '1 result');
  type(input, 'nobody');
  timers.advance(700);
  assert.equal(optionIds(dlg).length, 0);
  assert.equal(count.textContent, 'No results.');
  assert.equal(input.getAttribute('aria-activedescendant'), null);
});

test('a long list shows at most 50 options and says how many match', () => {
  const { dlg, count, input, timers } = open({ options: many });
  assert.equal(byTestId(dlg, 'member-option').length, 50);
  assert.equal(count.textContent, '130 results. Showing the first 50; type more to narrow the list.');
  type(input, '12');
  timers.advance(700);
  assert.equal(count.textContent, '12 results');
});

test('single mode: arrows move the active option, Enter chooses and closes, focus returns to the opener', async () => {
  const { p, dlg, input, opener, timers } = open();
  const ev = key(input, 'ArrowDown');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(input.getAttribute('aria-activedescendant'), byTestId(dlg, 'member-option')[1].id);
  key(input, 'ArrowDown');
  key(input, 'ArrowUp');
  key(input, 'ArrowDown'); // u3
  assert.equal(byTestId(dlg, 'member-option')[2].classList.contains('is-active'), true);
  assert.ok(byTestId(dlg, 'member-option')[2].scrolled >= 1, 'scrolled into view');
  key(input, 'PageDown');
  assert.equal(input.getAttribute('aria-activedescendant'), byTestId(dlg, 'member-option')[5].id, 'clamped at the end');
  key(input, 'PageUp');
  key(input, 'Enter'); // u1 is active again
  assert.deepEqual(await p, ['u1']);
  assert.equal(dlg.open, false);
  assert.equal(doc.activeElement, opener);
  assert.equal(timers.pending, 0, 'no timer left behind');
});

test('single mode: Enter right after typing uses the current text (the debounce is flushed); clicking an option chooses it', async () => {
  let r = open();
  type(r.input, 'dupont');
  key(r.input, 'Enter');
  assert.deepEqual(await r.p, ['u2']);
  r = open();
  byTestId(r.dlg, 'member-option')[3].click();
  assert.deepEqual(await r.p, ['u4']);
  r = open();
  byTestId(r.dlg, 'member-option')[5].click(); // disabled
  assert.equal(r.dlg.open, true, 'a disabled option cannot be chosen');
  pressEscape(r.dlg);
  assert.equal(await r.p, null);
});

test('Esc and Cancel resolve null and return focus', async () => {
  let r = open();
  assert.equal(pressEscape(r.dlg), 'closed');
  assert.equal(await r.p, null);
  assert.equal(doc.activeElement, r.opener);
  r = open();
  one(r.dlg, 'dialog-cancel').click();
  assert.equal(await r.p, null);
  assert.equal(r.timers.pending, 0);
});

test('multi mode: Enter and clicks toggle, the selection count is announced, Done returns the ids', async () => {
  const { p, dlg, input, timers } = open({ multiple: true, selected: ['u5'], confirmLabel: 'Add members' });
  const list = one(dlg, 'member-list');
  assert.equal(list.getAttribute('aria-multiselectable'), 'true');
  const selectedCount = one(dlg, 'member-selected-count');
  assert.equal(selectedCount.textContent, '1 selected');
  assert.equal(byTestId(dlg, 'member-option')[4].getAttribute('aria-selected'), 'true');
  key(input, 'Enter'); // u1
  assert.equal(byTestId(dlg, 'member-option')[0].getAttribute('aria-selected'), 'true');
  assert.equal(selectedCount.textContent, '2 selected');
  assert.equal(dlg.open, true, 'multi mode stays open');
  byTestId(dlg, 'member-option')[1].click();
  key(input, 'Enter'); // toggles u1 off again
  assert.equal(byTestId(dlg, 'member-option')[0].getAttribute('aria-selected'), 'false');
  type(input, 'smith');
  timers.advance(120);
  assert.equal(byTestId(dlg, 'member-option')[0].getAttribute('aria-selected'), 'true', 'a selection survives filtering');
  const done = one(dlg, 'member-picker-confirm');
  assert.equal(done.textContent, 'Add members');
  done.click();
  assert.deepEqual(await p, ['u5', 'u2']);
});

test('multi mode: cancelling returns null even after ticking options', async () => {
  const r = open({ multiple: true });
  byTestId(r.dlg, 'member-option')[0].click();
  one(r.dlg, 'dialog-cancel').click();
  assert.equal(await r.p, null);
});

test('French dictionary: plural count and hints', () => {
  const fr = createI18n({ lang: 'fr' });
  const { count, dlg } = open({ t: fr.t, tp: fr.tp });
  assert.equal(count.textContent, '6 résultats');
  assert.match(dlg.querySelector('.field__hint').textContent, /Saisissez pour filtrer/);
});
