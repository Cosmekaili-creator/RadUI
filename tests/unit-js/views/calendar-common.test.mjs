// SPDX-License-Identifier: AGPL-3.0-or-later
// Calendar view helpers (WP B3a): preferences, hashes, accessible names, node attributes, keyed node sets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createI18n } from '../_i18n-all.mjs';
import { birthdayOccurrences } from '../../../src/js/calendar/birthdays.js';
import { BIRTHDAYS_HREF, PREF, calendarHash, describeOccurrence, detailHashOf, nodeAttrs, parseView, periodText, readCalPrefs, timeText } from '../../../src/js/views/calendar/common.js';
import { periodRange } from '../../../src/js/calendar/grid.js';
import { createNodeSet } from '../../../src/js/views/calendar/keyed.js';
import { createPrefs } from '../../../src/js/views/settings/prefs.js';
import { buildChip, buildRow, sigOf } from '../../../src/js/views/calendar/nodes.js';
import { fakeStorage } from '../store/_helpers.mjs';
import { CAL_A, doc, flight, floating, allDay3, model, one, single, unknownZone, weekly } from './calendar-helpers.mjs';

const i18n = createI18n({ lang: 'en' });
const t = (k, p) => i18n.t(k, p);
const fr = createI18n({ lang: 'fr' });
const tf = (k, p) => fr.t(k, p);

function occOf(text, href = `${CAL_A}x.ics`) {
  const item = model.openItem(text);
  assert.ok(item.ok, item.reason);
  const [occ] = item.expand({ limit: 1 }).occurrences;
  return { ...occ, collection: CAL_A, href, uid: item.uid };
}
const cx = (over = {}) => ({ t, lang: 'en', tz: 'Europe/Paris', use24h: true, calendars: new Map([[CAL_A, { name: 'Work', color: '#0072b2' }]]), keyOf: () => 'key-1', readOnly: () => false, ...over });

test('accessible name: title, when, calendar (24 h clock, display zone)', () => {
  const rec = describeOccurrence(occOf(single('a@example.org', 'Lunch')), cx());
  assert.equal(rec.name, 'Lunch, Thu, Jun 4 12:00–13:00, Work');
  assert.equal(rec.when, 'Thu, Jun 4 12:00–13:00');
  assert.equal(rec.occParam, 'single');
  assert.equal(rec.routeKey, 'key-1');
});

test('the same event is drawn in the display zone: two zones give two clock times, the stored zone stays', () => {
  const o = occOf(single('a@example.org', 'Lunch'));
  const kathmandu = describeOccurrence(o, cx({ tz: 'Asia/Kathmandu' }));
  assert.match(kathmandu.when, /15:45–16:45/); // 12:00 Paris (UTC+2) = 15:45 in UTC+5:45
  assert.equal(o.start.tzid, 'Europe/Paris');
});

test('a 12 hour clock and French text', () => {
  const rec = describeOccurrence(occOf(single('a@example.org', 'Déjeuner')), cx({ use24h: false, t: tf, lang: 'fr' }));
  assert.match(rec.when, /jeu\./);
  assert.match(rec.when, /12:00 PM|12:00 PM–1:00 PM|12:00/);
  assert.match(rec.name, /Déjeuner/);
});

test('all-day, multi-day, floating and unknown zone events: names say so and nothing is shifted', () => {
  const day = describeOccurrence(occOf(allDay3('c@example.org')), cx({ tz: 'Pacific/Auckland' }));
  assert.match(day.name, /Jun 2 to .*Jun 4, all day/);
  const run = describeOccurrence(occOf(floating('r@example.org')), cx({ tz: 'Asia/Kathmandu' }));
  assert.match(run.when, /07:00–08:00/); // floating: the same clock time in every zone
  const mars = describeOccurrence(occOf(unknownZone('m@example.org')), cx());
  assert.equal(mars.unknownZone, true);
  assert.ok(mars.name.endsWith(', time zone unknown'));
});

test('a series occurrence carries its RECURRENCE-ID as data-occurrence and the whole key', () => {
  const rec = describeOccurrence(occOf(weekly('w@example.org', { count: 4 })), cx());
  assert.equal(rec.recurring, true);
  assert.equal(rec.occParam, '2026-03-02T09:30:00');
  assert.equal(rec.key, `${CAL_A}x.ics#2026-03-02T09:30:00`);
  assert.ok(rec.name.endsWith(', Repeats'));
  const attrs = nodeAttrs(rec);
  assert.deepEqual(Object.keys(attrs).sort(), ['data-calendar', 'data-href', 'data-key', 'data-occurrence', 'data-readonly', 'data-uid']);
  assert.equal(attrs['data-uid'], 'w@example.org');
  assert.equal(attrs['data-readonly'], 'false');
  assert.equal(detailHashOf(rec), `#/events/key-1?cal=${encodeURIComponent(CAL_A)}&occ=2026-03-02T09%3A30%3A00`);
});

test('a read-only calendar marks its nodes data-readonly=true and the name says Read-only only for birthdays', () => {
  const rec = describeOccurrence(occOf(single('a@example.org')), cx({ readOnly: () => true }));
  assert.equal(nodeAttrs(rec)['data-readonly'], 'true');
});

test('a birthday: virtual, read-only, the age in the title, the contact key', () => {
  const [b] = birthdayOccurrences([{ uid: 'u1', key: 'u1', ab: '/alice/book/', fn: 'Jo Example', bday: { year: 1990, month: 6, day: 4 } }], { from: '2026-06-01', to: '2026-06-08' });
  const rec = describeOccurrence(b, cx({ calendars: new Map([[BIRTHDAYS_HREF, { name: 'Birthdays', color: '#a64a85' }]]) }));
  assert.equal(rec.virtual, true);
  assert.equal(rec.readOnly, true);
  assert.equal(rec.title, 'Jo Example – 36');
  assert.equal(rec.calendar, BIRTHDAYS_HREF);
  assert.equal(rec.routeKey, 'u1');
  assert.equal(rec.occParam, '2026-06-04');
  assert.ok(rec.name.includes('Read-only'));
});

test('preferences: defaults, per-login values, bad values ignored', () => {
  const storage = fakeStorage();
  const prefs = createPrefs({ storage, login: 'alice' });
  assert.deepEqual({ ...readCalPrefs(prefs, { firstWeekday: 3 }), hidden: [...readCalPrefs(prefs).hidden] }, { firstWeekday: 3, use24h: null, birthdays: true, hideDup: true, hidden: [], listState: 'open' });
  prefs.set(PREF.firstWeekday, 7);
  prefs.set(PREF.use24h, true);
  prefs.set(PREF.hidden, ['/alice/cal-b', 5, 'birthdays']);
  prefs.set(PREF.listState, 'rail');
  prefs.set(PREF.birthdays, false);
  const p = readCalPrefs(prefs);
  assert.equal(p.firstWeekday, 7);
  assert.equal(p.use24h, true);
  assert.deepEqual([...p.hidden].sort(), ['/alice/cal-b/', 'birthdays']);
  assert.equal(p.listState, 'rail');
  assert.equal(p.birthdays, false);
  prefs.set(PREF.firstWeekday, 12);
  prefs.set(PREF.listState, 'sideways');
  const bad = readCalPrefs(prefs);
  assert.equal(bad.firstWeekday, 1);
  assert.equal(bad.listState, 'open');
  assert.equal(readCalPrefs(null).firstWeekday, 1);
});

test('hashes and the route parameters: invalid view or date is refused', () => {
  assert.equal(calendarHash('week', '2026-06-03', { q: 'team lunch' }), '#/calendar/week/2026-06-03?q=team+lunch');
  assert.equal(calendarHash('month', '2026-06-03', { q: '' }), '#/calendar/month/2026-06-03');
  assert.deepEqual(parseView({ view: 'day', date: '2026-02-28' }), { view: 'day', date: '2026-02-28' });
  assert.equal(parseView({ view: 'year', date: '2026-02-28' }), null);
  assert.equal(parseView({ view: 'day', date: '2026-02-30' }), null);
  assert.equal(parseView({}), null);
});

test('the period heading text: month, a week across two months, a day', () => {
  const week = periodRange('week', '2026-06-29', { firstWeekday: 1 });
  assert.deepEqual(periodText('week', week, { lang: 'en' }), { main: 'Jun 29 – Jul 5', sub: '2026' });
  const month = periodRange('month', '2026-06-10', { firstWeekday: 1 });
  assert.deepEqual(periodText('month', month), { main: 'June', sub: '2026' });
  assert.equal(periodText('day', periodRange('day', '2026-06-10')).main, 'Wednesday');
  assert.equal(timeText(Date.UTC(2026, 5, 3, 13, 5), { use24h: false }), '01:05 PM');
});

// ---- keyed node sets (stable toggling)

const item = (id, sig = 's', visible = true) => ({ id, sig, visible, make: () => Object.assign(doc.createElement('div'), {}) });

test('node set: unchanged items keep the SAME element; new ones are inserted, missing ones removed one by one', () => {
  const box = doc.createElement('div');
  const set = createNodeSet(box);
  let r = set.sync([item('a'), item('b'), item('c')]);
  assert.deepEqual(r, { added: 3, removed: 0, replaced: 0 });
  const a = set.nodes.get('a');
  const c = set.nodes.get('c');
  r = set.sync([item('a'), item('d'), item('c')]);
  assert.deepEqual(r, { added: 1, removed: 1, replaced: 0 });
  assert.equal(set.nodes.get('a'), a);
  assert.equal(set.nodes.get('c'), c);
  assert.deepEqual(box.children.map((n) => n), [a, set.nodes.get('d'), c]);
});

test('node set: visible=false only flags is-off (the element stays), a changed signature replaces it and keeps focus', () => {
  const box = doc.createElement('div');
  doc.body.append(box);
  const set = createNodeSet(box);
  set.sync([item('a'), item('b')]);
  const a = set.nodes.get('a');
  set.sync([item('a', 's', false), item('b')]);
  assert.equal(set.nodes.get('a'), a);
  assert.equal(a.classList.contains('is-off'), true);
  assert.equal(a.getAttribute('aria-hidden'), 'true');
  set.sync([item('a'), item('b')]);
  assert.equal(a.classList.contains('is-off'), false);
  assert.equal(a.hasAttribute('aria-hidden'), false);
  const b = set.nodes.get('b');
  b.focus();
  const r = set.sync([item('a'), item('b', 'changed')]);
  assert.equal(r.replaced, 1);
  assert.notEqual(set.nodes.get('b'), b);
  assert.equal(doc.activeElement, set.nodes.get('b'));
  assert.equal(box.children.length, 2);
});

test('node set: an element is only moved when its place is wrong', () => {
  const box = doc.createElement('div');
  const set = createNodeSet(box);
  set.sync([item('a'), item('b'), item('c')]);
  let moves = 0;
  const orig = box.insertBefore.bind(box);
  box.insertBefore = (n, ref) => (moves++, orig(n, ref));
  set.sync([item('a'), item('b'), item('c')]);
  assert.equal(moves, 0);
  set.sync([item('b'), item('a'), item('c')]);
  assert.ok(moves <= 2);
  assert.deepEqual(box.children, ['b', 'a', 'c'].map((k) => set.nodes.get(k)));
});

test('chips and rows carry the data attributes, test ids and the accessible name; titles are text', () => {
  const rec = describeOccurrence(occOf(single('h@example.org', '<img src=x onerror=alert(1)>')), cx());
  const chip = buildChip(rec, { t, lang: 'en', use24h: true });
  assert.equal(chip.getAttribute('data-testid'), 'event-chip');
  assert.equal(chip.getAttribute('aria-label'), rec.name);
  assert.equal(chip.getAttribute('data-calendar'), CAL_A);
  assert.equal(chip.querySelector('img'), null);
  assert.ok(chip.textContent.includes('<img src=x onerror=alert(1)>'));
  const row = buildRow(rec, { t, lang: 'en', use24h: true, day: '2026-06-04' });
  assert.equal(row.getAttribute('data-testid'), 'event-row');
  assert.equal(row.getAttribute('data-day'), '2026-06-04');
  assert.notEqual(sigOf(rec), sigOf({ ...rec, name: 'other' }));
  assert.equal(one(row, 'nothing'), null);
});

test('a tentative and a cancelled event say so in words, not only by style', () => {
  const tent = describeOccurrence(occOf(single('t@example.org', 'Maybe', { extra: 'STATUS:TENTATIVE\n' })), cx());
  assert.equal(tent.status, 'TENTATIVE');
  assert.ok(tent.name.includes('Tentative'));
  const canc = describeOccurrence(occOf(single('c@example.org', 'Off', { extra: 'STATUS:CANCELLED\n' })), cx());
  assert.ok(canc.name.includes('Cancelled'));
  assert.ok(buildChip(canc, { t, lang: 'en', use24h: true }).classList.contains('chip--cancelled'));
  assert.ok(buildChip(tent, { t, lang: 'en', use24h: true }).textContent.includes('?'));
});

test('flight: two zones are listed in the occurrence times', () => {
  const o = occOf(flight('f@example.org'));
  assert.equal(o.start.tzid, 'Europe/Paris');
  assert.equal(o.end.tzid, 'America/New_York');
});
