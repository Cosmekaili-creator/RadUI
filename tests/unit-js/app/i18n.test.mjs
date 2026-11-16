// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTIONARIES, createI18n } from '../_i18n-all.mjs';
import {
  SUPPORTED_LANGUAGES,
  checkParity,
  placeholders,
  matchLanguage,
  pickLanguage,
  isValidTimeZone,
  resolveTimeZone,
  resolveFirstWeekday,
  localeFirstWeekday,
  formatDateTime,
  formatDate,
  formatTime,
  formatNumber,
} from '../../../src/js/i18n.js';
import en from '../../../src/i18n/en.js';
import fr from '../../../src/i18n/fr.js';

test('FR and EN dictionaries have identical key sets and placeholders', () => {
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  const { ok, problems } = checkParity(DICTIONARIES);
  assert.deepEqual(problems, []);
  assert.ok(ok);
  assert.deepEqual([...SUPPORTED_LANGUAGES].sort(), Object.keys(DICTIONARIES).sort());
});

test('checkParity reports missing, extra, empty and placeholder problems', () => {
  const dicts = {
    en: { a: 'Hello {name}', b: 'B', c: 'C' },
    xx: { a: 'Salut {who}', b: '', d: 'D' },
  };
  const { ok, problems } = checkParity(dicts);
  assert.equal(ok, false);
  const kinds = problems.map((p) => `${p.lang}:${p.key}:${p.kind}`).sort();
  assert.deepEqual(kinds, ['xx:a:placeholders', 'xx:b:empty', 'xx:c:missing', 'xx:d:extra']);
});

test('placeholders', () => {
  assert.deepEqual(placeholders('{b} and {a} and {a} {1x} { c }'), ['a', 'b']);
});

test('every dictionary value is a non-empty string', () => {
  for (const [lang, d] of Object.entries(DICTIONARIES)) for (const [k, v] of Object.entries(d)) assert.ok(typeof v === 'string' && v.trim(), `${lang}:${k}`);
});

test('t(): interpolation, fallback to English, unknown keys, no throw', () => {
  const missing = [];
  const i = createI18n({ dictionaries: { en: { a: 'Hi {name}', only: 'English only' }, fr: { a: 'Salut {name}' } }, lang: 'fr', onMissing: (k, l) => missing.push([k, l]) });
  assert.equal(i.t('a', { name: 'Zoé' }), 'Salut Zoé');
  assert.equal(i.t('a'), 'Salut {name}');
  assert.equal(i.t('only'), 'English only');
  assert.equal(i.t('nope'), 'nope');
  assert.deepEqual(missing, [['nope', 'fr']]);
  assert.equal(i.t('a', { name: '$&{x}' }), 'Salut $&{x}');
  assert.equal(i.setLang('de'), false);
  assert.equal(i.lang, 'fr');
  assert.equal(i.setLang('en'), true);
  assert.equal(i.t('a', { name: 'Al' }), 'Hi Al');
});

test('tp(): plural categories', () => {
  const i = createI18n({ lang: 'en' });
  assert.equal(i.tp('debug.coll.count', 1), '1 item');
  assert.equal(i.tp('debug.coll.count', 3), '3 items');
  i.setLang('fr');
  assert.equal(i.tp('debug.coll.count', 0), '0 élément');
  assert.equal(i.tp('debug.coll.count', 2), '2 éléments');
});

test('language selection order: stored, configured, browser, English', () => {
  assert.equal(matchLanguage('fr-CH'), 'fr');
  assert.equal(matchLanguage('FR_ca'), 'fr');
  assert.equal(matchLanguage('de'), null);
  assert.equal(matchLanguage(null), null);
  assert.equal(pickLanguage({ stored: 'en', configured: 'fr', browser: ['fr'] }), 'en');
  assert.equal(pickLanguage({ stored: 'xx', configured: 'fr', browser: ['en'] }), 'fr');
  assert.equal(pickLanguage({ configured: null, browser: ['de', 'fr-FR', 'en'] }), 'fr');
  assert.equal(pickLanguage({ browser: ['de'] }), 'en');
  assert.equal(pickLanguage(), 'en');
});

test('time zone helpers', () => {
  assert.ok(isValidTimeZone('Europe/Paris'));
  assert.ok(isValidTimeZone('UTC'));
  assert.ok(!isValidTimeZone('Not/AZone'));
  assert.ok(!isValidTimeZone(''));
  assert.ok(!isValidTimeZone(null));
  assert.equal(resolveTimeZone('Asia/Tokyo'), 'Asia/Tokyo');
  assert.equal(resolveTimeZone(null), new Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(resolveTimeZone('bogus'), new Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('first weekday: configured value wins, else the locale', () => {
  assert.equal(resolveFirstWeekday(3, 'en'), 3);
  assert.equal(resolveFirstWeekday(null, 'fr'), 1);
  assert.equal(localeFirstWeekday('en-US'), 7);
  assert.equal(resolveFirstWeekday(9, 'fr'), 1);
  assert.equal(localeFirstWeekday('not a locale'), 1);
});

test('formatting uses the requested zone and a 24 h clock', () => {
  const d = new Date(Date.UTC(2026, 0, 15, 23, 5, 0));
  assert.equal(formatTime(d, { lang: 'en', timeZone: 'Europe/Paris' }), '00:05');
  assert.equal(formatTime(d, { lang: 'fr', timeZone: 'UTC', withSeconds: true }), '23:05:00');
  assert.match(formatDate(d, { lang: 'en', timeZone: 'UTC', dateStyle: 'long' }), /January 15, 2026/);
  assert.match(formatDate(d, { lang: 'fr', timeZone: 'UTC', dateStyle: 'long' }), /15 janvier 2026/);
  assert.match(formatDateTime(d, { lang: 'en', timeZone: 'Asia/Tokyo' }), /Jan 16, 2026/);
  assert.equal(formatNumber(1234.5, { lang: 'en' }), '1,234.5');
  assert.equal(formatDate('2026-01-15T10:00:00Z', { lang: 'en', timeZone: 'UTC', dateStyle: 'short' }), '1/15/26');
});

// ------------------------------------------------ part files and aggregators (run 2)

import enShell from '../../../src/i18n/en.shell.js';
import frShell from '../../../src/i18n/fr.shell.js';
import enWidgets from '../../../src/i18n/en.widgets.js';
import frWidgets from '../../../src/i18n/fr.widgets.js';
import enContacts from '../../../src/i18n/en.contacts.js';
import frContacts from '../../../src/i18n/fr.contacts.js';
import enGroups from '../../../src/i18n/en.groups.js';
import frGroups from '../../../src/i18n/fr.groups.js';
import enCollections from '../../../src/i18n/en.collections.js';
import frCollections from '../../../src/i18n/fr.collections.js';
import enImport from '../../../src/i18n/en.import.js';
import frImport from '../../../src/i18n/fr.import.js';
import enConflict from '../../../src/i18n/en.conflict.js';
import frConflict from '../../../src/i18n/fr.conflict.js';
import enPwa from '../../../src/i18n/en.pwa.js';
import frPwa from '../../../src/i18n/fr.pwa.js';
import enCommon from '../../../src/i18n/en.common.js';
import frCommon from '../../../src/i18n/fr.common.js';
import enSettings from '../../../src/i18n/en.settings.js';
import frSettings from '../../../src/i18n/fr.settings.js';
import enUsers from '../../../src/i18n/en.users.js';
import frUsers from '../../../src/i18n/fr.users.js';
import enCalendar from '../../../src/i18n/en.calendar.js';
import frCalendar from '../../../src/i18n/fr.calendar.js';
import enEvent from '../../../src/i18n/en.event.js';
import frEvent from '../../../src/i18n/fr.event.js';
import enTasks from '../../../src/i18n/en.tasks.js';
import frTasks from '../../../src/i18n/fr.tasks.js';
import enRecur from '../../../src/i18n/en.recur.js';
import frRecur from '../../../src/i18n/fr.recur.js';

const EN_PARTS = { shell: enShell, widgets: enWidgets, contacts: enContacts, groups: enGroups, collections: enCollections, import: enImport, conflict: enConflict, pwa: enPwa, common: enCommon, settings: enSettings, users: enUsers, calendar: enCalendar, event: enEvent, tasks: enTasks, recur: enRecur };
const FR_PARTS = { shell: frShell, widgets: frWidgets, contacts: frContacts, groups: frGroups, collections: frCollections, import: frImport, conflict: frConflict, pwa: frPwa, common: frCommon, settings: frSettings, users: frUsers, calendar: frCalendar, event: frEvent, tasks: frTasks, recur: frRecur };

/** key -> parts that define it; every key listed more than once is a collision. */
function collisions(parts) {
  const owners = new Map();
  for (const [part, dict] of Object.entries(parts)) for (const key of Object.keys(dict)) owners.set(key, [...(owners.get(key) || []), part]);
  return [...owners].filter(([, p]) => p.length > 1).map(([k, p]) => `${k}: ${p.join(', ')}`);
}

test('part files: no key is defined in two parts (EN and FR)', () => {
  assert.deepEqual(collisions(EN_PARTS), []);
  assert.deepEqual(collisions(FR_PARTS), []);
});

test('the collision check really detects a duplicate key', () => {
  assert.deepEqual(collisions({ a: { x: '1', y: '2' }, b: { y: '3' }, c: { z: '4' } }), ['y: a, b']);
});

test('aggregators contain every key of every part, and nothing else', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.values(EN_PARTS).flatMap((d) => Object.keys(d)).sort());
  assert.deepEqual(Object.keys(fr).sort(), Object.values(FR_PARTS).flatMap((d) => Object.keys(d)).sort());
  for (const [part, dict] of Object.entries(EN_PARTS)) for (const [k, v] of Object.entries(dict)) assert.equal(en[k], v, `${part}:${k}`);
  assert.ok(Object.isFrozen(en) && Object.isFrozen(fr));
});

test('FR/EN parity holds part by part (same keys and placeholders per area), so each owner can keep it', () => {
  for (const part of Object.keys(EN_PARTS)) {
    const { problems } = checkParity({ en: EN_PARTS[part], fr: FR_PARTS[part] });
    assert.deepEqual(problems, [], part);
  }
});

test('part files are frozen dictionaries of non-empty strings; stubs are empty until their work package fills them', () => {
  for (const parts of [EN_PARTS, FR_PARTS]) {
    for (const [part, dict] of Object.entries(parts)) {
      assert.ok(Object.isFrozen(dict), part);
      for (const [k, v] of Object.entries(dict)) assert.ok(typeof v === 'string' && v.trim(), `${part}:${k}`);
    }
  }
  assert.ok(Object.keys(enShell).length > 140, 'the shell part holds the keys of the first release plus the navigation keys');
});

test('shell keys of the run 2 shell exist in both languages with the same placeholders', () => {
  for (const k of ['nav.contacts', 'nav.collections', 'nav.signOut', 'shell.offline', 'shell.write.offline', 'shell.write.readOnly', 'shell.update.text', 'shell.update.reload', 'shell.discard.title', 'shell.discard.text', 'shell.discard.confirm', 'shell.discard.keep', 'comingsoon.title', 'comingsoon.text', 'comingsoon.home']) {
    assert.ok(Object.hasOwn(enShell, k) && Object.hasOwn(frShell, k), k);
  }
  assert.deepEqual(placeholders(enShell['comingsoon.text']), ['name']);
  assert.deepEqual(placeholders(frShell['comingsoon.text']), ['name']);
});
