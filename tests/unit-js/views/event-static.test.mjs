// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of the event form work package (B3b): CSP-safe code, SPDX headers, no direct DAV writes, every translation key
// the code uses exists in both languages, dictionary parity, the documented test ids exist, wiring (screens, nav, manifest,
// index.html), tokens-only CSS, and the rules of the plan that are easy to break (no hard-coded zone, no client VTIMEZONE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../src/i18n/en.js';
import fr from '../../../src/i18n/fr.js';
import enE from '../../../src/i18n/en.event.js';
import frE from '../../../src/i18n/fr.event.js';
import enS from '../../../src/i18n/en.settings.js';
import frS from '../../../src/i18n/fr.settings.js';
import { ALARM_PRESETS } from '../../../src/js/calendar/formmodel.js';
import { checkParity } from '../../../src/js/i18n.js';
import { SCREENS } from '../../../src/js/screens.js';

const SRC = new URL('../../../src/', import.meta.url).pathname;
const MINE = ['form', 'recurrence', 'scopedialog', 'tzpicker', 'alarms'].map((f) => `js/views/calendar/${f}.js`).concat('js/views/settings/calendar.js');
const read = (f) => readFileSync(join(SRC, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const code = MINE.map((f) => strip(read(f))).join('\n');

test('SPDX header, no raw HTML, no style attribute, no inline handler, no external URL, no eval, no deployment value', () => {
  for (const f of [...MINE, 'css/event.css', 'i18n/en.event.js', 'i18n/fr.event.js']) {
    const text = read(f);
    assert.match(text.split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
    if (!f.endsWith('.js') || f.startsWith('i18n/')) continue;
    const c = strip(text);
    assert.equal(/https?:\/\//i.test(c), false, `${f}: absolute URL`);
    assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(c), false, `${f}: raw HTML or eval`);
    // `style: 'unit'` is an Intl.NumberFormat option, not a style attribute
    assert.equal(/setAttribute\(\s*['"`]style|\bstyle\s*:(?!\s*['"]unit['"])|\.style\b|\.cssText/.test(c), false, `${f}: style`);
    assert.equal(/\bon(click|input|change|keydown|error|load)\s*=|setAttribute\(\s*['"`]on/i.test(c), false, `${f}: inline handler`);
    assert.equal(/['"`]\/ui\/|localhost|127\.0\.0\.1/.test(c), false, `${f}: deployment value`);
    assert.equal(/(?:Europe|America|Asia|Africa|Australia|Pacific)\/[A-Z]/.test(c), false, `${f}: a hard-coded time zone`);
    assert.equal(/\.dataset\b|\bjavascript:/.test(c.replace(/'javascript:alert/g, '')), false, `${f}: dataset or javascript: URL`);
    assert.equal(/BEGIN:VTIMEZONE/.test(c), false, `${f}: no client VTIMEZONE`);
  }
});

test('the form and the dialogs never call a DAV method or a grant method themselves; every write goes through the write path', () => {
  assert.equal(/\.(putItem|deleteItem\(\s*href|mkcalendar|mkAddressbook|proppatch|putGrant|revokeGrant|deleteCollection)\(/.test(code), false);
  assert.equal(/\bclient\b|\bdav\b/.test(code), false, 'no DAV client in the views');
  for (const m of ['applyOps', 'splitWrite', 'createItem']) assert.match(code, new RegExp(`${m}\\(`), m);
  const form = strip(read('js/views/calendar/form.js'));
  assert.match(form, /planEdit\(item, \{ scope, occ, base: base0, patch, exceptions \}\)/);
  assert.match(form, /toPatch\(base0, v, \{ zones \}\)/);
  assert.match(form, /\bretry: state\.retry/);
  assert.match(form, /openConflictDialog/);
  assert.match(form, /resolveReload/);
  assert.match(form, /\bbase,\s*rid: plan\.rid/);
  assert.match(form, /collection: collection\.href, href: entry\.href, base, ops/);
});

test('every translation key the code uses exists in both languages (literal keys, prefixes and plurals)', () => {
  const keys = new Set();
  for (const m of code.matchAll(/\bt\(\s*['"`]([a-z][A-Za-z0-9.-]*)['"`]/g)) keys.add(m[1]);
  for (const m of code.matchAll(/\b(?:tp|plural)\(\s*['"`]([a-z][A-Za-z0-9.-]*)['"`]/g)) keys.add(`${m[1]}.other`);
  assert.ok(keys.size > 80, `found ${keys.size} keys`);
  for (const k of keys) {
    assert.ok(Object.hasOwn(en, k), `en: ${k}`);
    assert.ok(Object.hasOwn(fr, k), `fr: ${k}`);
  }
  const all = (prefix, list) => {
    for (const x of list) assert.ok(Object.hasOwn(en, prefix + x) && Object.hasOwn(fr, prefix + x), prefix + x);
  };
  all('event.alarm.', ALARM_PRESETS.map((p) => p.id));
  all('event.status.', ['CONFIRMED', 'TENTATIVE', 'CANCELLED']);
  all('event.transp.', ['OPAQUE', 'TRANSPARENT']);
  all('event.rec.freq.', ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
  all('event.scope.', ['edit.this', 'edit.following', 'edit.all', 'delete.this', 'delete.following', 'delete.all', 'edit.title', 'delete.title', 'text.edit', 'text.delete', 'editing.this', 'editing.following', 'editing.all', 'help.edit.this', 'help.edit.following', 'help.edit.all', 'help.delete.this', 'help.delete.following', 'help.delete.all']);
  all('event.err.', ['summary-required', 'too-long', 'url-scheme', 'url-unsafe', 'date-invalid', 'date-required', 'time-invalid', 'time-required', 'tz-unknown', 'end-before-start', 'alarms-max', 'alarm-invalid', 'freq', 'interval', 'byday', 'count', 'until-invalid', 'until-before-start']);
  all('event.err.plan.', ['read-only', 'not-event', 'occurrence-required', 'occurrence-not-found', 'following-first', 'rrule-needs-series', 'allday-toggle-with-exceptions', 'unknown-zone', 'start-mismatch', 'invalid', 'read-only-scope']);
  for (const k of ['event.attendeesKept', 'event.form.errors', 'event.preview.allDayMany', 'event.alarm.foreign', 'event.exc.count', 'event.exc.orphans', 'event.exc.keepOrphans', 'event.exc.removeAll', 'event.exc.removeOrphans', 'event.rec.unit.DAILY', 'event.rec.unit.WEEKLY', 'event.rec.unit.MONTHLY', 'event.rec.unit.YEARLY']) {
    assert.ok(en[`${k}.one`] && en[`${k}.other`] && fr[`${k}.one`] && fr[`${k}.other`], k);
  }
  for (const f of ['field-title', 'field-start-date', 'field-start-time', 'field-end-date', 'field-end-time', 'field-tz-start', 'field-tz-end', 'field-location', 'field-url', 'field-description', 'field-status', 'field-transp']) {
    assert.ok(en[`event.f.${f.replace(/^field-/, '')}`], f);
  }
});

test('the event dictionary part and the settings part: identical keys and placeholders, own key areas', () => {
  assert.deepEqual(checkParity({ en: enE, fr: frE }).problems, []);
  assert.deepEqual(checkParity({ en: enS, fr: frS }).problems, []);
  assert.ok(Object.keys(enE).length > 150);
  for (const k of Object.keys(enE)) assert.ok(k.startsWith('event.'), k);
  assert.ok(Object.keys(enS).filter((k) => k.startsWith('settings.cal.')).length >= 15);
  assert.ok(Object.isFrozen(enE) && Object.isFrozen(frE));
});

test('the test ids of the plan are in the sources', () => {
  const ids = [
    'event-form-screen', 'event-form', 'field-title', 'field-calendar', 'field-allday', 'event-when-preview', 'field-location', 'field-url', 'field-description', 'field-categories', 'field-status', 'field-transp',
    'btn-add-alarm', 'btn-remove-alarm', 'alarms-foreign', 'form-errors', 'form-error-link', 'form-status', 'event-save', 'event-cancel', 'scope-notice', 'event-attendees-note', 'event-form-notfound', 'event-readonly',
    'recurrence-builder', 'rec-freq', 'rec-interval', 'rec-monthly-day', 'rec-monthly-nth', 'rec-end-never', 'rec-end-until', 'rec-end-count', 'rec-until', 'rec-count', 'rec-summary', 'rec-custom', 'btn-replace-rule', 'rec-exceptions', 'exception-row', 'btn-restore-exception',
    'dialog-scope-', 'scope-this', 'scope-following', 'scope-all', 'scope-cancel', 'dialog-rule-exceptions', 'exceptions-keep', 'exceptions-remove', 'exceptions-remove-orphans', 'exceptions-cancel', 'exception-item',
    'field-tz-start', 'field-tz-end', 'settings-tz-display', 'settings-first-weekday', 'settings-24h', 'settings-birthdays', 'settings-bday-hide-duplicates', 'settings-calendar',
  ];
  for (const id of ids) assert.ok(code.includes(`'${id}`) || code.includes(`"${id}`) || code.includes(`\`${id}`), id);
  for (const g of ['field-start', 'field-end', 'field-alarm-', 'rec-day-']) assert.ok(code.includes(g), g);
  for (const kind of ['date', 'time']) assert.match(code, new RegExp(`field-\\$\\{which\\}-${kind}`));
});

test('wiring: the screen registry, the settings section, the stylesheet link and the manifest shortcut', async () => {
  assert.equal(SCREENS['event-form'].module, './views/calendar/form.js');
  assert.equal(SCREENS['event-form'].model, true);
  const m = await import('../../../src/js/views/calendar/form.js');
  assert.equal(typeof m.mount, 'function');
  const scope = await import('../../../src/js/views/calendar/scopedialog.js');
  assert.equal(typeof scope.askScope, 'function');
  assert.equal(typeof scope.askRuleExceptions, 'function');
  assert.match(read('js/views/settings/screen.js'), /calendarSection, deviceSection/);
  assert.match(read('index.html'), /href="css\/event\.css"/);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(manifest.shortcuts.some((s) => s.url === './#/events/new'));
});

test('settings stays light: nothing in the settings calendar section imports the time model statically', () => {
  const c = strip(read('js/views/settings/calendar.js'));
  const staticImports = [...c.matchAll(/^import .* from '([^']+)'/gm)].map((x) => x[1]);
  assert.deepEqual(staticImports, ['../../ui.js', '../../widgets/fieldkit.js']);
  assert.match(c, /import\('\.\.\/calendar\/tzpicker\.js'\)/);
});

test('event.css: design tokens only, no remote CSS, mobile first with a desktop breakpoint', () => {
  const css = read('css/event.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, 'hex colour');
  assert.equal(/@import|url\(/i.test(css), false);
  assert.match(css, /@media \(min-width: 640px\)/);
  for (const decl of css.matchAll(/(?:^|[;{\s])(?:color|background|border-color)\s*:\s*([^;}]+)/g)) assert.match(decl[1], /var\(--|transparent|inherit|none/, decl[0]);
});
