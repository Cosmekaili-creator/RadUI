// SPDX-License-Identifier: AGPL-3.0-or-later
// Date field logic: locale order, parsing, validation, formatting, picker navigation. No DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localeDatePattern,
  parseDate,
  formatDate,
  dateHint,
  fromISO,
  toISO,
  isValidYMD,
  isLeapYear,
  daysInMonth,
  addDays,
  addMonths,
  navigateDate,
  monthGrid,
  isoWeekday,
  weekdayNames,
  monthNames,
  todayYMD,
  compareYMD,
  dateErrorMessage,
  dateHintText,
  normalizeYMD,
  EXAMPLE_DATE,
} from '../../../src/js/widgets/datefield.js';
import { createI18n } from '../_i18n-all.mjs';

const tEn = createI18n({ lang: 'en' }).t;
const tFr = createI18n({ lang: 'fr' }).t;
const ok = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};
const D = (y, m, d) => ({ y, m, d });

// ------------------------------------------------------------------ locale order

test('localeDatePattern: field order and separator come from Intl', () => {
  assert.deepEqual({ ...localeDatePattern('en') }, { order: ['m', 'd', 'y'], sep: '/' });
  assert.deepEqual({ ...localeDatePattern('fr') }, { order: ['d', 'm', 'y'], sep: '/' });
  assert.deepEqual({ ...localeDatePattern('de') }, { order: ['d', 'm', 'y'], sep: '.' });
  assert.deepEqual({ ...localeDatePattern('ja') }, { order: ['y', 'm', 'd'], sep: '/' });
  assert.deepEqual({ ...localeDatePattern('hu') }, { order: ['y', 'm', 'd'], sep: '.' });
  assert.deepEqual({ ...localeDatePattern('sv') }, { order: ['y', 'm', 'd'], sep: '-' });
  assert.deepEqual({ ...localeDatePattern('nl') }, { order: ['d', 'm', 'y'], sep: '-' });
  assert.equal(localeDatePattern('ar').sep, '/', 'invisible direction marks are stripped');
  assert.deepEqual({ ...localeDatePattern('en-GB') }, { order: ['d', 'm', 'y'], sep: '/' });
});

test('localeDatePattern: an invalid language tag falls back to English', () => {
  assert.deepEqual({ ...localeDatePattern('not a tag!') }, { order: ['m', 'd', 'y'], sep: '/' });
});

test('formatDate and dateHint follow the locale', () => {
  const v = D(2026, 11, 3);
  assert.equal(formatDate(v, 'fr'), '03/11/2026');
  assert.equal(formatDate(v, 'en'), '11/03/2026');
  assert.equal(formatDate(v, 'de'), '03.11.2026');
  assert.equal(formatDate(v, 'ja'), '2026/11/03');
  assert.equal(formatDate(D(null, 11, 3), 'fr'), '03/11');
  assert.equal(formatDate(D(null, 11, 3), 'en'), '11/03');
  assert.equal(formatDate(D(2026, 2, 30), 'fr'), '');
  assert.equal(dateHint('fr', { d: 'JJ', m: 'MM', y: 'AAAA' }), 'JJ/MM/AAAA');
  assert.equal(dateHint('en'), 'MM/DD/YYYY');
  assert.equal(dateHint('ja'), 'YYYY/MM/DD');
  assert.equal(dateHint('fr', { d: 'JJ', m: 'MM', y: 'AAAA' }, { yearless: true }), 'JJ/MM');
});

// --------------------------------------------------------------------- parsing

test('parseDate: French, English and other orders', () => {
  assert.deepEqual(ok(parseDate('13/11/2026', { pattern: 'fr' })).value, D(2026, 11, 13));
  assert.deepEqual(ok(parseDate('11/13/2026', { pattern: 'en' })).value, D(2026, 11, 13));
  assert.deepEqual(ok(parseDate('13.11.2026', { pattern: 'de' })).value, D(2026, 11, 13));
  assert.deepEqual(ok(parseDate('2026/11/13', { pattern: 'ja' })).value, D(2026, 11, 13));
  assert.deepEqual(ok(parseDate('2026. 11. 13.', { pattern: 'hu' })).value, D(2026, 11, 13));
  assert.deepEqual(ok(parseDate('13-11-2026', { pattern: 'nl' })).value, D(2026, 11, 13));
  assert.equal(ok(parseDate('13/11/2026', { pattern: 'fr' })).iso, '2026-11-13');
});

test('parseDate: one-digit day and month, spaces and other separators are tolerated', () => {
  assert.deepEqual(ok(parseDate('3/4/2026', { pattern: 'fr' })).value, D(2026, 4, 3));
  assert.deepEqual(ok(parseDate('3 4 2026', { pattern: 'fr' })).value, D(2026, 4, 3));
  assert.deepEqual(ok(parseDate(' 03-04-2026 ', { pattern: 'fr' })).value, D(2026, 4, 3));
  assert.deepEqual(ok(parseDate('03.04.2026.', { pattern: 'fr' })).value, D(2026, 4, 3), 'a trailing separator is ignored');
  assert.deepEqual(ok(parseDate('１３／１１／２０２６', { pattern: 'fr' })).value, D(2026, 11, 13), 'full-width digits are normalised');
});

test('parseDate: ISO YYYY-MM-DD is accepted whatever the locale', () => {
  for (const lang of ['en', 'fr', 'de', 'ja', 'hu', 'nl', 'sv', 'ko']) {
    const r = ok(parseDate('2026-11-13', { pattern: lang }));
    assert.deepEqual(r.value, D(2026, 11, 13), lang);
    assert.equal(r.iso, '2026-11-13');
  }
  assert.deepEqual(ok(parseDate('20261113', { pattern: 'fr' })).value, D(2026, 11, 13));
  assert.deepEqual(ok(parseDate('2026-1-3', { pattern: 'fr' })).value, D(2026, 1, 3), 'a year first always reads year-month-day');
  assert.deepEqual(ok(parseDate('2026/11/13', { pattern: 'fr' })).value, D(2026, 11, 13));
});

test('parseDate: empty text', () => {
  assert.deepEqual(parseDate('', {}), { ok: true, empty: true, value: null, iso: '' });
  assert.deepEqual(parseDate('   ', {}), { ok: true, empty: true, value: null, iso: '' });
  assert.deepEqual(parseDate(null, {}), { ok: true, empty: true, value: null, iso: '' });
  assert.equal(parseDate('', { required: true }).error, 'required');
});

test('parseDate: real calendar dates only (month lengths, leap years)', () => {
  const fr = { pattern: 'fr' };
  assert.equal(parseDate('31/04/2026', fr).error, 'day');
  assert.equal(parseDate('30/04/2026', fr).ok, true);
  assert.equal(parseDate('00/04/2026', fr).error, 'day');
  assert.equal(parseDate('32/01/2026', fr).error, 'day');
  assert.equal(parseDate('01/00/2026', fr).error, 'month');
  assert.equal(parseDate('01/13/2026', fr).error, 'month');
  assert.equal(parseDate('2026-02-30', fr).error, 'day');
  assert.equal(parseDate('11/13/2026', fr).error, 'month', 'English order typed in a French field');
});

test('parseDate: 29 February and leap years', () => {
  const fr = { pattern: 'fr' };
  assert.equal(parseDate('29/02/2024', fr).ok, true);
  assert.equal(parseDate('29/02/2025', fr).error, 'day');
  assert.equal(parseDate('29/02/1900', fr).error, 'day', 'century years are leap only when divisible by 400');
  assert.equal(parseDate('29/02/2000', fr).ok, true);
  assert.equal(parseDate('29/02/2100', fr).error, 'day');
  assert.equal(parseDate('28/02/2025', fr).ok, true);
  assert.deepEqual(parseDate('29/02/2025', fr).detail, { day: 29, month: 2, year: 2025 });
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(1900), false);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2025, 2), 28);
  assert.equal(daysInMonth(null, 2), 29, 'no year: 29 February is allowed');
});

test('parseDate: formats that are refused', () => {
  const fr = { pattern: 'fr' };
  for (const bad of ['abc', '13/11/26', '13/11/20266', '13 nov 2026', '13/11/2026 10:00', '1/2/3/4', '13//', '/11/2026', '13-11', '2026', '13/11/2026x', '٣١/٠٤/٢٠٢٦']) {
    assert.equal(parseDate(bad, fr).ok, false, bad);
  }
  assert.equal(parseDate('13/11/26', fr).error, 'format');
  assert.equal(parseDate('0000-01-01', fr).error, 'year');
  assert.equal(parseDate('13/11', fr).error, 'year', 'no year while the year is required');
  assert.equal(parseDate('--11-13', fr).error, 'year');
});

test('parseDate: year optional (vCard --MM-DD and --MMDD)', () => {
  const opt = { pattern: 'fr', yearOptional: true };
  const a = ok(parseDate('13/11', opt));
  assert.deepEqual(a.value, D(null, 11, 13));
  assert.equal(a.iso, '--11-13');
  assert.equal(a.yearless, true);
  assert.deepEqual(ok(parseDate('11/13', { pattern: 'en', yearOptional: true })).value, D(null, 11, 13));
  assert.deepEqual(ok(parseDate('--11-13', opt)).value, D(null, 11, 13));
  assert.deepEqual(ok(parseDate('--1113', opt)).value, D(null, 11, 13));
  assert.deepEqual(ok(parseDate('13.11', { pattern: 'de', yearOptional: true })).value, D(null, 11, 13));
  assert.deepEqual(ok(parseDate('11/13', { pattern: 'ja', yearOptional: true })).value, D(null, 11, 13));
  assert.deepEqual(ok(parseDate('29/02', opt)).value, D(null, 2, 29), 'a birthday on 29 February without a year');
  assert.equal(parseDate('31/04', opt).error, 'day');
  assert.equal(parseDate('--02-30', opt).error, 'day');
  assert.equal(parseDate('--13-01', opt).error, 'month');
  // with a year it is still a full date
  const full = ok(parseDate('13/11/1990', opt));
  assert.deepEqual(full.value, D(1990, 11, 13));
  assert.equal(full.yearless, false);
});

test('parseDate: min and max are inclusive and ignored for dates without a year', () => {
  const o = { pattern: 'fr', min: '1900-01-01', max: { y: 2026, m: 11, d: 13 } };
  assert.equal(parseDate('01/01/1900', o).ok, true);
  assert.equal(parseDate('31/12/1899', o).error, 'min');
  assert.equal(parseDate('31/12/1899', o).detail.min, '1900-01-01');
  assert.equal(parseDate('13/11/2026', o).ok, true);
  assert.equal(parseDate('14/11/2026', o).error, 'max');
  assert.equal(parseDate('14/11/2026', o).detail.max, '2026-11-13');
  assert.equal(parseDate('14/11', { ...o, yearOptional: true }).ok, true);
  assert.equal(parseDate('2026-11-14', o).error, 'max');
});

test('error messages are translated and carry the format and the bounds', () => {
  assert.equal(dateErrorMessage(tFr, parseDate('31/04/2026', { pattern: 'fr' }), { pattern: 'fr' }), 'Le jour 31 n’existe pas dans ce mois.');
  assert.match(dateErrorMessage(tFr, parseDate('abc', { pattern: 'fr' }), { pattern: 'fr' }), /JJ\/MM\/AAAA.*24\/03\/2000/);
  assert.match(dateErrorMessage(tEn, parseDate('abc', { pattern: 'en' }), { pattern: 'en' }), /MM\/DD\/YYYY.*03\/24\/2000/);
  assert.match(dateErrorMessage(tEn, parseDate('01/01/1990', { pattern: 'en', min: '2000-01-01' }), { pattern: 'en' }), /01\/01\/2000/);
  assert.match(dateHintText(tFr, 'fr'), /JJ\/MM\/AAAA/);
  assert.match(dateHintText(tEn, 'en', { yearOptional: true }), /MM\/DD\/YYYY.*MM\/DD/);
});

// ----------------------------------------------------------------- ISO and values

test('fromISO and toISO: the machine forms', () => {
  assert.deepEqual(fromISO('2026-11-13'), D(2026, 11, 13));
  assert.deepEqual(fromISO('20261113'), D(2026, 11, 13));
  assert.deepEqual(fromISO('--11-13'), D(null, 11, 13));
  assert.deepEqual(fromISO('--1113'), D(null, 11, 13));
  assert.equal(fromISO('2026-02-30'), null);
  assert.equal(fromISO('2026-2-3'), null);
  assert.equal(fromISO('--13-01'), null);
  assert.equal(fromISO(''), null);
  assert.equal(fromISO(5), null);
  assert.equal(toISO(D(2026, 1, 3)), '2026-01-03');
  assert.equal(toISO(D(null, 1, 3)), '--01-03');
  assert.equal(toISO(D(2026, 2, 30)), '');
  assert.equal(toISO(null), '');
  assert.equal(isValidYMD(D(10000, 1, 1)), false);
  assert.equal(isValidYMD(D(2026.5, 1, 1)), false);
  assert.deepEqual(normalizeYMD('2026-11-13'), D(2026, 11, 13));
  assert.deepEqual(normalizeYMD({ m: 3, d: 4 }), D(null, 3, 4));
  assert.equal(normalizeYMD({ y: 2026, m: 2, d: 31 }), null);
  assert.equal(normalizeYMD(7), null);
});

test('round trip: format then parse gives the same value in every locale', () => {
  const values = [D(2026, 11, 13), D(2024, 2, 29), D(1999, 1, 1), D(2000, 12, 31), D(1, 1, 1), D(9999, 12, 31), D(null, 2, 29), D(null, 7, 9)];
  for (const lang of ['en', 'fr', 'de', 'ja', 'hu', 'sv', 'nl', 'ko', 'ar', 'pt-BR', 'en-GB', 'zh']) {
    for (const v of values) {
      const text = formatDate(v, lang);
      const r = parseDate(text, { pattern: lang, yearOptional: true });
      assert.equal(r.ok, true, `${lang} ${text}`);
      assert.deepEqual(r.value, v, `${lang} ${text}`);
      assert.equal(r.iso, toISO(v));
      assert.deepEqual(fromISO(r.iso), v);
    }
  }
});

// ------------------------------------------------------------ calendar arithmetic

test('addDays and addMonths', () => {
  assert.deepEqual(addDays(D(2026, 12, 31), 1), D(2027, 1, 1));
  assert.deepEqual(addDays(D(2024, 2, 28), 1), D(2024, 2, 29));
  assert.deepEqual(addDays(D(2025, 3, 1), -1), D(2025, 2, 28));
  assert.deepEqual(addDays(D(1, 1, 1), -1), D(1, 1, 1), 'clamped at the first supported date');
  assert.deepEqual(addDays(D(9999, 12, 31), 1), D(9999, 12, 31));
  assert.deepEqual(addMonths(D(2026, 1, 31), 1), D(2026, 2, 28));
  assert.deepEqual(addMonths(D(2024, 1, 31), 1), D(2024, 2, 29));
  assert.deepEqual(addMonths(D(2026, 12, 15), 1), D(2027, 1, 15));
  assert.deepEqual(addMonths(D(2026, 1, 15), -1), D(2025, 12, 15));
  assert.deepEqual(addMonths(D(2026, 3, 31), -13), D(2025, 2, 28));
  assert.equal(addMonths(D(1, 1, 5), -1).y, 1);
  assert.equal(addMonths(D(9999, 12, 5), 1).y, 9999);
});

test('isoWeekday and compareYMD', () => {
  assert.equal(isoWeekday(D(2026, 11, 13)), 5); // Friday
  assert.equal(isoWeekday(D(2026, 11, 1)), 7); // Sunday
  assert.equal(isoWeekday(D(2024, 1, 1)), 1);
  assert.equal(compareYMD(D(2026, 1, 1), D(2026, 1, 2)), -1);
  assert.equal(compareYMD(D(2027, 1, 1), D(2026, 12, 31)), 1);
  assert.equal(compareYMD(D(2026, 5, 5), D(2026, 5, 5)), 0);
});

test('todayYMD uses the requested time zone', () => {
  const instant = new Date('2026-11-13T23:30:00Z');
  assert.deepEqual(todayYMD(instant, 'UTC'), D(2026, 11, 13));
  assert.deepEqual(todayYMD(instant, 'Pacific/Auckland'), D(2026, 11, 14));
});

// ------------------------------------------------------------- picker navigation

test('navigateDate: arrows, pages, home and end', () => {
  const cur = D(2026, 11, 13); // Friday
  const opt = { firstWeekday: 1 };
  assert.deepEqual(navigateDate(cur, 'ArrowLeft', opt), D(2026, 11, 12));
  assert.deepEqual(navigateDate(cur, 'ArrowRight', opt), D(2026, 11, 14));
  assert.deepEqual(navigateDate(cur, 'ArrowUp', opt), D(2026, 11, 6));
  assert.deepEqual(navigateDate(cur, 'ArrowDown', opt), D(2026, 11, 20));
  assert.deepEqual(navigateDate(cur, 'PageUp', opt), D(2026, 10, 13));
  assert.deepEqual(navigateDate(cur, 'PageDown', opt), D(2026, 12, 13));
  assert.deepEqual(navigateDate(cur, 'PageUp', { ...opt, shift: true }), D(2025, 11, 13));
  assert.deepEqual(navigateDate(cur, 'PageDown', { ...opt, shift: true }), D(2027, 11, 13));
  assert.deepEqual(navigateDate(cur, 'Home', opt), D(2026, 11, 9)); // Monday
  assert.deepEqual(navigateDate(cur, 'End', opt), D(2026, 11, 15)); // Sunday
  assert.deepEqual(navigateDate(cur, 'Home', { firstWeekday: 7 }), D(2026, 11, 8)); // Sunday-first weeks
  assert.deepEqual(navigateDate(cur, 'End', { firstWeekday: 7 }), D(2026, 11, 14));
  assert.deepEqual(navigateDate(D(2026, 11, 9), 'Home', opt), D(2026, 11, 9), 'already on the first day of the week');
  assert.equal(navigateDate(cur, 'a', opt), null);
  assert.equal(navigateDate(cur, 'Enter', opt), null);
});

test('navigateDate: month paging clamps the day, bounds clamp the result', () => {
  assert.deepEqual(navigateDate(D(2026, 3, 31), 'PageUp'), D(2026, 2, 28));
  assert.deepEqual(navigateDate(D(2024, 3, 31), 'PageUp'), D(2024, 2, 29));
  assert.deepEqual(navigateDate(D(2024, 2, 29), 'PageDown', { shift: true }), D(2025, 2, 28));
  const min = D(2026, 11, 10);
  const max = D(2026, 11, 20);
  assert.deepEqual(navigateDate(D(2026, 11, 12), 'ArrowLeft', { min, max }), D(2026, 11, 11));
  assert.deepEqual(navigateDate(D(2026, 11, 10), 'ArrowLeft', { min, max }), D(2026, 11, 10));
  assert.deepEqual(navigateDate(D(2026, 11, 19), 'ArrowDown', { min, max }), D(2026, 11, 20));
  assert.deepEqual(navigateDate(D(2026, 11, 15), 'PageDown', { min, max }), D(2026, 11, 20));
});

test('monthGrid: Monday-first and Sunday-first layouts', () => {
  const mon = monthGrid(2026, 11, 1); // 1 November 2026 is a Sunday
  assert.equal(mon.length, 6);
  assert.deepEqual(mon[0].slice(0, 6), [null, null, null, null, null, null]);
  assert.deepEqual(mon[0][6], D(2026, 11, 1));
  assert.equal(mon.flat().filter(Boolean).length, 30);
  assert.ok(mon.every((w) => w.length === 7));
  const sun = monthGrid(2026, 11, 7);
  assert.equal(sun.length, 5);
  assert.deepEqual(sun[0][0], D(2026, 11, 1));
  assert.deepEqual(sun[4][1], D(2026, 11, 30));
  const feb = monthGrid(2026, 2, 1); // 1 February 2026 is a Sunday; 28 days
  assert.equal(feb.flat().filter(Boolean).length, 28);
  assert.equal(monthGrid(2024, 2, 1).flat().filter(Boolean).length, 29);
});

test('weekdayNames and monthNames follow the language and the first weekday', () => {
  assert.equal(weekdayNames('en', 1)[0].short, 'Mon');
  assert.equal(weekdayNames('en', 7)[0].short, 'Sun');
  assert.equal(weekdayNames('en', 7).length, 7);
  assert.equal(weekdayNames('fr', 1)[0].long, 'lundi');
  assert.equal(weekdayNames('fr', 1)[6].long, 'dimanche');
  assert.equal(monthNames('en')[10], 'November');
  assert.equal(monthNames('fr')[1], 'février');
  assert.equal(monthNames('fr').length, 12);
});

test('the example date is unambiguous (day above 12) and valid', () => {
  assert.equal(isValidYMD(EXAMPLE_DATE), true);
  assert.ok(EXAMPLE_DATE.d > 12);
});
