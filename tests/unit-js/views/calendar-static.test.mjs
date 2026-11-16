// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of the calendar screens (WP B3a): CSP-safe code, SPDX headers, no direct DAV writes, the i18n keys the
// code uses exist in both languages, the documented test ids exist, tokens-only CSS, the registry and the shippable-slice rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../src/i18n/en.js';
import fr from '../../../src/i18n/fr.js';
import enC from '../../../src/i18n/en.calendar.js';
import frC from '../../../src/i18n/fr.calendar.js';
import { checkParity } from '../../../src/js/i18n.js';
import { ENABLED_SLICES } from '../../../src/js/app.js';

const SRC = new URL('../../../src/', import.meta.url).pathname;
const dir = join(SRC, 'js/views/calendar');
const OWN = ['actions', 'agenda', 'bdaylink', 'callist', 'common', 'detail', 'detailmodel', 'keyed', 'month', 'nodes', 'screen', 'source', 'toolbar', 'week'];
// WP B3b owns form, recurrence, scopedialog, tzpicker and alarms in the same directory: they are not checked here
const files = readdirSync(dir).filter((f) => f.endsWith('.js') && OWN.includes(f.slice(0, -3)));
const read = (f) => readFileSync(join(dir, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const all = files.map(read).join('\n');

test('every module of WP B3a exists', () => {
  assert.deepEqual(files.map((f) => f.slice(0, -3)).sort(), [...OWN].sort());
});

test('the registry binds the calendar screen and the event page; the other routes stay as they are', async () => {
  const { SCREENS } = await import('../../../src/js/screens.js');
  assert.equal(SCREENS.calendar.module, './views/calendar/screen.js');
  assert.equal(SCREENS.calendar.export, 'mount');
  assert.equal(SCREENS.event.module, './views/calendar/screen.js');
  assert.equal(SCREENS.event.export, 'mountEvent');
  for (const k of ['calendar', 'event']) assert.equal(SCREENS[k].model, true);
  for (const k of ['calendar', 'event']) {
    const m = await import(new URL(SRC + 'js/' + SCREENS[k].module.slice(2), 'file://'));
    assert.equal(typeof m[SCREENS[k].export], 'function', k);
  }
  assert.equal(SCREENS.tasks.module, './views/tasks/screen.js'); // bound by WP C1
});

test('shippable-slice rule: the navigation entry of slice 3b is enabled by the last work package, once the `calendar` E2E suite passed', () => {
  assert.equal(ENABLED_SLICES.includes('3b'), true);
  assert.equal(ENABLED_SLICES.includes('3c'), true); // since the `tasks` E2E suite
});

test('SPDX header, no raw HTML, no style attribute, no inline handler, no external URL, no eval, no deployment value', () => {
  for (const f of [...files.map((x) => `js/views/calendar/${x}`), 'css/calendar.css', 'i18n/en.calendar.js', 'i18n/fr.calendar.js']) {
    const text = readFileSync(join(SRC, f), 'utf8');
    assert.match(text.split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
    if (!f.endsWith('.js') || f.startsWith('i18n/')) continue;
    const code = strip(text);
    assert.equal(/https?:\/\//i.test(code), false, `${f}: absolute URL`);
    assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(code), false, `${f}: raw HTML or eval`);
    assert.equal(/setAttribute\(\s*['"`]style|\bstyle\s*:|\.style\b|\.cssText/.test(code), false, `${f}: style`);
    assert.equal(/\bon(click|input|change|keydown|error|load)\s*=|setAttribute\(\s*['"`]on/i.test(code), false, `${f}: inline handler`);
    assert.equal(/['"`]\/ui\/|localhost|127\.0\.0\.1|@[a-z0-9-]+\.(?:com|net|org)\b/.test(code.replace(/example\.org/g, '')), false, `${f}: deployment value`);
    assert.equal(/(?:Europe|America|Asia|Africa|Pacific|Australia)\/[A-Z]/.test(code), false, `${f}: hard-coded time zone`);
    assert.equal(/\.dataset\b|\bjavascript:|data:image/.test(code), false, `${f}: dataset, javascript: or data: URL`);
  }
});

test('the views never call a DAV or grant write method themselves; writes go through the store write path', () => {
  const code = strip(all);
  assert.equal(/\.(putItem|mkcalendar|mkAddressbook|proppatch|putGrant|revokeGrant|deleteCollection)\(/.test(code), false);
  assert.equal(/\.deleteItem\(/.test(code.replace(/writes\(\)\.deleteItem\(/g, '')), false);
  assert.equal(/\bclient\b|\bdav\b/.test(code), false, 'no DAV client in the views');
  for (const m of ['applyOps', 'moveItem', 'deleteItem']) assert.match(code, new RegExp(`${m}\\(`), m);
  assert.match(code, /deleteItem\(\{[^}]*etag: entry\.etag/);
  assert.match(code, /openConflictDialog/);
});

test('every translation key the code uses exists in both languages (literal keys, plurals and the known templates)', () => {
  const code = strip(all);
  const keys = new Set();
  for (const m of code.matchAll(/\bt\(\s*['"`]([a-z][A-Za-z0-9.-]*)['"`]/g)) keys.add(m[1]);
  for (const m of code.matchAll(/\btp\(\s*['"`]([a-z][A-Za-z0-9.-]*)['"`]/g)) keys.add(`${m[1]}.other`);
  for (const view of ['month', 'week', 'day', 'agenda']) for (const k of ['view', 'prev', 'next']) keys.add(`cal.${k}.${view}`);
  for (const s of ['TENTATIVE', 'CANCELLED']) keys.add(`cal.status.${s}`);
  for (const s of ['open', 'rail', 'hidden']) for (const k of ['fold', 'state']) keys.add(`cal.list.${k}.${s}`);
  for (const id of ['start', '5m', '10m', '15m', '30m', '1h', '1d']) keys.add(`cal.detail.alarm.${id}`);
  for (const k of ['before', 'after', 'beforeEnd', 'afterEnd']) keys.add(`cal.detail.alarm.custom.${k}`);
  for (const p of ['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED', 'IN-PROCESS', 'COMPLETED']) keys.add(`cal.detail.partstat.${p}`);
  for (const mode of ['edit', 'delete']) for (const k of ['this', 'following', 'all', 'title']) keys.add(`cal.scope.${mode}.${k}`);
  for (const k of ['notfound', 'occurrenceGone', 'nocalendar', 'unreadable', 'error']) keys.add(`cal.detail.${k}`);
  for (const k of ['shownN', 'hiddenN']) keys.add(`cal.${k}`);
  for (const k of ['zoneStart', 'zoneEnd']) keys.add(`cal.detail.${k}`);
  assert.ok(keys.size > 90);
  const missing = [...keys].filter((k) => !Object.hasOwn(en, k) || !Object.hasOwn(fr, k));
  assert.deepEqual(missing, []);
  // dialog.cancel and the davError texts come from other parts
  for (const k of keys) if (k.startsWith('cal.')) assert.ok(Object.hasOwn(enC, k), `${k} belongs to the calendar part`);
});

test('the dictionary part: identical keys and placeholders, every key used, keys all start with cal.', () => {
  assert.deepEqual(checkParity({ en: enC, fr: frC }).problems, []);
  assert.deepEqual(Object.keys(enC).sort(), Object.keys(frC).sort());
  for (const k of Object.keys(enC)) assert.match(k, /^cal\./);
  const code = strip(all);
  const unused = Object.keys(enC).filter((k) => {
    const base = k.replace(/\.(one|other)$/, '');
    return !code.includes(base) && !code.includes(base.split('.').slice(0, -1).join('.') + '.${') && !/\.(view|prev|next|status|list\.(fold|state)|detail\.(alarm|partstat)|scope)\./.test(k) && !/^cal\.detail\.(notfound|occurrenceGone|nocalendar|unreadable|error|zoneStart|zoneEnd)$/.test(k) && !['cal.shownN', 'cal.hiddenN', 'cal.bday.dupHiddenN', 'cal.bday.dupShownN', 'cal.err.loadAll'].includes(k);
  });
  assert.deepEqual(unused, []);
});

test('the documented test ids exist in the code', () => {
  const code = all;
  const ids = [
    'calendar-screen', 'cal-toolbar', 'view-', 'cal-today', 'cal-prev', 'cal-next', 'cal-jump', 'period-heading', 'tz-display', 'cal-search', 'btn-new-event', 'calendar-readonly', 'cal-status',
    'calendar-list', 'calendar-toggle', 'calendar-loading', 'callist-count', 'callist-live', 'bday-hide-duplicates', 'btn-toggle-callist', 'link-manage-calendars',
    'month-grid', 'month-cell', 'month-day', 'month-more', 'week-grid', 'day-grid', 'week-day', 'now-marker', 'agenda-list', 'search-results', 'cal-no-match', 'event-chip', 'event-row', 'btn-new-event-at',
    'calendar-empty', 'calendar-noaccess', 'calendar-error', 'btn-retry', 'calendar-offline',
    'event-detail', 'event-title', 'event-when', 'event-zone-start', 'event-zone-end', 'event-floating', 'event-recurrence', 'event-attendees', 'attendee-row', 'event-alarms', 'event-meta',
    'event-readonly', 'event-tz-warning', 'event-raw', 'btn-edit-event', 'btn-delete-event', 'btn-move-event', 'btn-export-event', 'btn-open-contact', 'dialog-delete-event', 'dialog-move-event',
    'dialog-scope-', 'scope-this', 'scope-following', 'scope-all', 'scope-cancel', 'event-screen', 'event-panel',
  ];
  for (const id of ids) assert.ok(code.includes(id), id);
});

test('calendar.css: design tokens only (no colour literal), no remote CSS, desktop breakpoint, reduced motion', () => {
  const css = readFileSync(join(SRC, 'css/calendar.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, 'hex colour');
  assert.equal(/@import|url\(/i.test(css), false);
  assert.match(css, /@media \(min-width: 900px\)/);
  assert.match(css, /prefers-reduced-motion/);
  for (const decl of css.matchAll(/(?:^|[;{\s])(?:color|background|border-color)\s*:\s*([^;}]+)/g)) assert.match(decl[1], /var\(--|transparent|inherit|none|color-mix|repeating-linear-gradient/, decl[0]);
  assert.match(readFileSync(join(SRC, 'index.html'), 'utf8'), /css\/calendar\.css/);
});

test('i18n: no hard-coded English text in the builders (every visible string goes through t)', () => {
  const code = strip(all);
  const literal = [...code.matchAll(/\bh\(\s*'(?:button|a|p|h1|h2|h3|span|label|summary|legend|li)'\s*,[^()]*?,\s*'([A-Z][a-z]+(?: [a-z]+)*)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(literal, []);
});
