// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, type, change, one } from './_dom.mjs';
import { parseTime, formatTime, timeToISO, timeFromISO, normalizeHM, isValidHM, dayPeriods, timeErrorMessage, timeHintText, createTimeField } from '../../../src/js/widgets/timefield.js';
import { createI18n } from '../_i18n-all.mjs';

const doc = makeDom();
const tEn = createI18n({ lang: 'en' }).t;
const tFr = createI18n({ lang: 'fr' }).t;
const HM = (h, mi) => ({ h, mi });
const ok = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};

test('parseTime: 24-hour forms', () => {
  assert.deepEqual(ok(parseTime('14:30')).value, HM(14, 30));
  assert.deepEqual(ok(parseTime('09:05')).value, HM(9, 5));
  assert.deepEqual(ok(parseTime('9:05')).value, HM(9, 5));
  assert.deepEqual(ok(parseTime('0905')).value, HM(9, 5));
  assert.deepEqual(ok(parseTime('930')).value, HM(9, 30));
  assert.deepEqual(ok(parseTime('9.30')).value, HM(9, 30));
  assert.deepEqual(ok(parseTime('9h30')).value, HM(9, 30));
  assert.deepEqual(ok(parseTime('9h')).value, HM(9, 0));
  assert.deepEqual(ok(parseTime('9')).value, HM(9, 0));
  assert.deepEqual(ok(parseTime('00:00')).value, HM(0, 0));
  assert.deepEqual(ok(parseTime('23:59')).value, HM(23, 59));
  assert.equal(ok(parseTime('9:05')).iso, '09:05');
});

test('parseTime: ISO HH:MM and HH:MM:00 are always accepted; non-zero seconds are refused, not dropped', () => {
  assert.deepEqual(ok(parseTime('14:30:00')).value, HM(14, 30));
  assert.equal(parseTime('14:30:15').error, 'format');
  assert.equal(parseTime('14:30:').ok, false);
});

test('parseTime: AM and PM', () => {
  assert.deepEqual(ok(parseTime('2:30 PM')).value, HM(14, 30));
  assert.deepEqual(ok(parseTime('2:30pm')).value, HM(14, 30));
  assert.deepEqual(ok(parseTime('2:30 p.m.')).value, HM(14, 30));
  assert.deepEqual(ok(parseTime('12:00 AM')).value, HM(0, 0));
  assert.deepEqual(ok(parseTime('12:15 pm')).value, HM(12, 15));
  assert.deepEqual(ok(parseTime('9 am')).value, HM(9, 0));
  assert.deepEqual(ok(parseTime('11:59 PM')).value, HM(23, 59));
  assert.equal(parseTime('13:00 PM').error, 'hour');
  assert.equal(parseTime('0:30 AM').error, 'hour');
  assert.deepEqual(ok(parseTime('午後 2:30', { lang: 'ja' })).value, HM(14, 30));
});

test('parseTime: invalid times', () => {
  assert.equal(parseTime('24:00').error, 'hour');
  assert.equal(parseTime('25:10').error, 'hour');
  assert.equal(parseTime('12:60').error, 'minute');
  assert.equal(parseTime('12:5').error, 'format');
  for (const bad of ['abc', '1:2:3:4', '12:', ':30', '9.5', '99999', '12h3', 'noon']) assert.equal(parseTime(bad).ok, false, bad);
  assert.deepEqual(parseTime(''), { ok: true, empty: true, value: null, iso: '' });
  assert.equal(parseTime('', { required: true }).error, 'required');
});

test('parseTime: min and max are inclusive', () => {
  const o = { min: '08:00', max: { h: 18, mi: 30 } };
  assert.equal(parseTime('08:00', o).ok, true);
  assert.equal(parseTime('07:59', o).error, 'min');
  assert.equal(parseTime('18:30', o).ok, true);
  assert.equal(parseTime('18:31', o).error, 'max');
  assert.equal(parseTime('18:31', o).detail.max, '18:30');
});

test('formatTime: 24 h and 12 h; ISO helpers', () => {
  assert.equal(formatTime(HM(9, 5)), '09:05');
  assert.equal(formatTime(HM(14, 30), { use24h: true, lang: 'fr' }), '14:30');
  assert.equal(formatTime(HM(14, 30), { use24h: false, lang: 'en' }), '2:30 PM');
  assert.equal(formatTime(HM(0, 5), { use24h: false, lang: 'en' }), '12:05 AM');
  assert.equal(formatTime(HM(24, 0)), '');
  assert.equal(timeToISO(HM(9, 5)), '09:05');
  assert.equal(timeToISO(HM(9, 60)), '');
  assert.deepEqual(timeFromISO('09:05'), HM(9, 5));
  assert.deepEqual(timeFromISO('09:05:00'), HM(9, 5));
  assert.equal(timeFromISO('9:05'), null);
  assert.equal(timeFromISO('24:00'), null);
  assert.deepEqual(normalizeHM('10:00'), HM(10, 0));
  assert.deepEqual(normalizeHM(HM(10, 0)), HM(10, 0));
  assert.equal(normalizeHM(HM(10, 99)), null);
  assert.equal(isValidHM(HM(23, 59)), true);
});

test('round trip: every minute of the day in 24 h and 12 h, English and French', () => {
  for (const lang of ['en', 'fr']) {
    for (const use24h of [true, false]) {
      for (let m = 0; m < 24 * 60; m += 7) {
        const v = HM(Math.floor(m / 60), m % 60);
        const text = formatTime(v, { use24h, lang });
        const r = parseTime(text, { lang });
        assert.equal(r.ok, true, `${lang} ${use24h} ${text}`);
        assert.deepEqual(r.value, v, `${lang} ${use24h} ${text}`);
      }
    }
  }
});

test('dayPeriods: the language markers come from Intl', () => {
  assert.ok(dayPeriods('en').pm.includes('pm'));
  assert.ok(dayPeriods('ja').pm.includes('午後'));
});

test('messages and hints are translated', () => {
  assert.match(timeHintText(tEn, { use24h: true }), /HH:MM.*14:30/);
  assert.match(timeHintText(tEn, { use24h: false }), /h:mm AM\/PM.*2:30 PM/);
  assert.match(timeHintText(tFr, { use24h: true, lang: 'fr' }), /24 heures.*14:30/);
  assert.equal(timeErrorMessage(tEn, parseTime('12:60')), 'The minutes must be between 00 and 59.');
  assert.match(timeErrorMessage(tEn, parseTime('abc')), /HH:MM.*14:30/);
  assert.match(timeErrorMessage(tEn, parseTime('07:00', { min: '08:00' })), /08:00 or later/);
});

test('field: structure, typing, normalising, error, 12 h mode', () => {
  const f = createTimeField({ testid: 'field-start-time', label: 'Start', t: tEn, lang: 'en' });
  doc.body.append(f.el);
  assert.equal(f.el.getAttribute('data-testid'), 'field-start-time');
  assert.equal(one(f.el, 'field-start-time-input'), f.input);
  assert.equal(f.el.querySelector('label').getAttribute('for'), f.input.id);
  assert.match(one(f.el, 'field-start-time-hint').textContent, /24-hour/);
  assert.equal(f.input.getAttribute('placeholder'), 'HH:MM');
  type(f.input, '930');
  assert.deepEqual(f.value, HM(9, 30));
  change(f.input);
  assert.equal(f.input.value, '09:30');
  assert.equal(f.iso, '09:30');
  type(f.input, '25:00');
  change(f.input);
  const err = one(f.el, 'field-start-time-error');
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /hour/);
  assert.equal(f.input.getAttribute('aria-invalid'), 'true');
  assert.ok(f.input.getAttribute('aria-describedby').includes(err.id));
  type(f.input, '10:00');
  assert.equal(err.hidden, true);

  const g = createTimeField({ testid: 'field-end-time', label: 'End', t: tEn, lang: 'en', use24h: false, value: '14:30' });
  assert.equal(g.input.value, '2:30 PM');
  type(g.input, '9:15 am');
  change(g.input);
  assert.equal(g.input.value, '9:15 AM');
  assert.equal(g.iso, '09:15');
  assert.deepEqual(g.value, HM(9, 15));
  g.setValue(null);
  assert.equal(g.input.value, '');
  const region = doc.createElement('p');
  const h2 = createTimeField({ testid: 'field-t', label: 'T', t: tEn, required: true, errorRegion: region });
  h2.validate();
  assert.equal(region.textContent, 'Enter a time.');
  assert.ok(region.id);
});
