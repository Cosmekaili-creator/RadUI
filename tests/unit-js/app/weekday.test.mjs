// SPDX-License-Identifier: AGPL-3.0-or-later
// The first weekday is shown as a localized weekday name, not a bare number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { weekdayName } from '../../../src/js/app.js';

test('weekdayName: 1 = Monday ... 7 = Sunday, localized', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => weekdayName('en', n)), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  assert.deepEqual([1, 7].map((n) => weekdayName('fr', n)), ['lundi', 'dimanche']);
});

test('weekdayName: out-of-range or non-integer input falls back to Monday; a bad language does not throw', () => {
  assert.equal(weekdayName('en', 0), 'Monday');
  assert.equal(weekdayName('en', 8), 'Monday');
  assert.equal(weekdayName('en', 'x'), 'Monday');
  assert.equal(typeof weekdayName('not a language!!', 3), 'string');
});

test('weekdayName never returns a bare digit for a valid weekday', () => {
  for (const lang of ['en', 'fr']) for (let n = 1; n <= 7; n += 1) assert.ok(!/^\d+$/.test(weekdayName(lang, n)), `${lang} ${n}`);
});
