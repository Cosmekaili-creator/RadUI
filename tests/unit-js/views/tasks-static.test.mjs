// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of the task screens (WP C1): CSP-safe code, SPDX headers, no direct DAV writes, the i18n keys the code
// uses exist in both languages, the documented test ids exist, tokens-only CSS, the registry and the shippable-slice rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../src/i18n/en.js';
import fr from '../../../src/i18n/fr.js';
import enT from '../../../src/i18n/en.tasks.js';
import frT from '../../../src/i18n/fr.tasks.js';
import { checkParity } from '../../../src/js/i18n.js';
import { ENABLED_SLICES } from '../../../src/js/app.js';

const SRC = new URL('../../../src/', import.meta.url).pathname;
const viewDir = join(SRC, 'js/views/tasks');
const logicDir = join(SRC, 'js/tasks');
const OWN = ['actions', 'common', 'detail', 'form', 'rows', 'screen', 'source'];
const viewFiles = readdirSync(viewDir).filter((f) => f.endsWith('.js'));
const logicFiles = readdirSync(logicDir).filter((f) => f.endsWith('.js'));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ALL = [...viewFiles.map((f) => `js/views/tasks/${f}`), ...logicFiles.map((f) => `js/tasks/${f}`)];
const code = strip(viewFiles.map((f) => readFileSync(join(viewDir, f), 'utf8')).join('\n') + '\n' + logicFiles.map((f) => readFileSync(join(logicDir, f), 'utf8')).join('\n'));

test('the modules of WP C1 exist', () => {
  assert.deepEqual(viewFiles.map((f) => f.slice(0, -3)).sort(), OWN);
  assert.deepEqual(logicFiles.map((f) => f.slice(0, -3)).sort(), ['formmodel', 'list']);
});

test('the registry binds tasks, task and task-form; the nav entry of slice 3c is on (the `tasks` E2E suite passed)', async () => {
  const { SCREENS } = await import('../../../src/js/screens.js');
  assert.deepEqual([SCREENS.tasks, SCREENS.task, SCREENS['task-form']].map((e) => [e.module, e.export, e.model]), [
    ['./views/tasks/screen.js', 'mount', true],
    ['./views/tasks/screen.js', 'mountTask', true],
    ['./views/tasks/form.js', 'mount', true],
  ]);
  for (const k of ['tasks', 'task', 'task-form']) {
    const m = await import(new URL(`js/${SCREENS[k].module.slice(2)}`, `file://${SRC}`));
    assert.equal(typeof m[SCREENS[k].export], 'function', k);
    assert.equal(SCREENS[k].family, 'tasks');
  }
  assert.equal(ENABLED_SLICES.includes('3c'), true);
});

test('SPDX header, no raw HTML, no style attribute, no inline handler, no external URL, no eval, no deployment value, no hard-coded zone', () => {
  for (const f of [...ALL, 'css/tasks.css', 'i18n/en.tasks.js', 'i18n/fr.tasks.js']) {
    const text = readFileSync(join(SRC, f), 'utf8');
    assert.match(text.split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
    if (!f.endsWith('.js') || f.startsWith('i18n/')) continue;
    const c = strip(text);
    assert.equal(/https?:\/\//i.test(c), false, `${f}: absolute URL`);
    assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(c), false, `${f}: raw HTML or eval`);
    assert.equal(/setAttribute\(\s*['"`]style|\bstyle\s*:|\.style\b|\.cssText/.test(c), false, `${f}: style`);
    assert.equal(/\bon(click|input|change|keydown|error|load)\s*=|setAttribute\(\s*['"`]on/i.test(c), false, `${f}: inline handler`);
    assert.equal(/['"`]\/ui\/|localhost|127\.0\.0\.1|@[a-z0-9-]+\.(?:com|net|org)\b/.test(c.replace(/example\.org/g, '')), false, `${f}: deployment value`);
    assert.equal(/(?:Europe|America|Asia|Africa|Pacific|Australia)\/[A-Z]/.test(c), false, `${f}: hard-coded time zone`);
    assert.equal(/\.dataset\b|\bjavascript:|data:image/.test(c), false, `${f}: dataset, javascript: or data: URL`);
  }
});

test('the views never call a DAV or grant write method themselves; writes go through the store write path', () => {
  assert.equal(/\.(putItem|mkcalendar|mkAddressbook|proppatch|putGrant|revokeGrant|deleteCollection)\(/.test(code), false);
  assert.equal(/\.deleteItem\(/.test(code.replace(/writes\(\)\.deleteItem\(/g, '')), false);
  assert.equal(/\bclient\b|\bdav\b/.test(code), false, 'no DAV client in the views');
  for (const m of ['applyOps', 'createItem', 'saveItem', 'deleteItem']) assert.match(code, new RegExp(`${m}\\(`), m);
  assert.match(code, /deleteItem\(\{[^}]*etag: entry\.etag/);
  assert.match(code, /openConflictDialog/);
  assert.match(code, /base,/, 'every update passes its base');
});

test('every translation key the code uses exists in both languages', () => {
  const keys = new Set();
  for (const m of code.matchAll(/\b(?:t|tr)\(\s*['"`]([a-z][A-Za-z0-9.-]*)['"`]/g)) keys.add(m[1]);
  for (const m of code.matchAll(/\btp\(\s*['"`]([a-z][A-Za-z0-9.-]*)['"`]/g)) keys.add(`${m[1]}.other`);
  for (const m of code.matchAll(/statusKey: [^'"]*['"]([a-z.]+)['"]/g)) keys.add(m[1]);
  for (const f of ['open', 'today', 'overdue', 'done', 'all']) for (const k of ['filter', 'none']) keys.add(`tasks.${k}.${f}`);
  for (const s of ['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']) keys.add(`tasks.state.${s}`);
  for (const p of ['none', 'high', 'medium', 'low']) keys.add(`tasks.prio.${p}`);
  for (const k of ['summary-required', 'too-long', 'percent', 'priority', 'status', 'recurring-complete', 'date-required', 'date-invalid', 'time-invalid', 'tz-unknown', 'date-types-differ', 'due-before-start']) keys.add(`tasks.err.${k}`);
  for (const k of ['due', 'start', 'dueTime', 'startTime', 'summary', 'list', 'priority', 'status', 'percent', 'zone', 'categories', 'description']) keys.add(`tasks.field.${k}`);
  for (const k of ['notfound', 'nolist', 'unreadable']) keys.add(`tasks.detail.${k}`);
  for (const k of ['shownN', 'hiddenN']) keys.add(`tasks.${k}`);
  assert.ok(keys.size > 70, String(keys.size));
  const missing = [...keys].filter((k) => !Object.hasOwn(en, k) || !Object.hasOwn(fr, k));
  assert.deepEqual(missing, []);
  for (const k of keys) if (k.startsWith('tasks.')) assert.ok(Object.hasOwn(enT, k), `${k} belongs to the tasks part`);
});

test('the dictionary part: identical keys and placeholders, every key starts with tasks., every key is used', () => {
  assert.deepEqual(checkParity({ en: enT, fr: frT }).problems, []);
  assert.deepEqual(Object.keys(enT).sort(), Object.keys(frT).sort());
  for (const k of Object.keys(enT)) assert.match(k, /^tasks\./);
  const dynamic = /^tasks\.(filter|none|state|prio|err|field)\./;
  const unused = Object.keys(enT).filter((k) => {
    if (dynamic.test(k)) return false;
    const base = k.replace(/\.(one|other)$/, '');
    return !code.includes(`'${base}'`) && !code.includes(`"${base}"`) && !code.includes(`\`${base}\``);
  });
  assert.deepEqual(unused, []);
});

test('the documented test ids exist in the code', () => {
  const ids = [
    'tasks-screen', 'task-filter-', 'task-sort', 'btn-new-task', 'tasklist-bar', 'tasklist-toggle', 'tasklist-loading', 'tasklist-live', 'tasks-status', 'task-list', 'task-row', 'task-complete', 'task-open',
    'tasks-empty', 'tasks-nolist', 'btn-create-task-list', 'tasks-readonly', 'tasks-filter-empty', 'tasks-error', 'tasks-offline', 'btn-retry', 'task-subtasks',
    'task-detail', 'task-title', 'task-status', 'task-due', 'task-recurrence', 'task-parent', 'task-children', 'task-readonly', 'task-raw', 'btn-edit-task', 'btn-delete-task', 'task-screen', 'task-notfound',
    'task-form', 'task-form-screen', 'field-summary', 'field-list', 'field-due-date', 'field-due-time', 'field-tz-', 'field-start-date', 'field-start-time', 'field-priority', 'field-status', 'field-percent', 'field-description',
    'task-save', 'task-cancel', 'task-delete', 'dialog-delete-task', 'form-errors', 'task-form-notfound', 'task-form-readonly', 'task-form-nolist',
  ];
  for (const id of ids) assert.ok(code.includes(id) || readFileSync(join(SRC, 'js/views/contacts/formfields.js'), 'utf8').includes(id), id);
});

test('tasks.css: design tokens only (no colour literal), no remote CSS, desktop breakpoint, reduced motion, linked from index.html', () => {
  const css = readFileSync(join(SRC, 'css/tasks.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, 'hex colour');
  assert.equal(/@import|url\(/i.test(css), false);
  assert.match(css, /@media \(min-width: 900px\)/);
  assert.match(css, /prefers-reduced-motion/);
  for (const decl of css.matchAll(/(?:^|[;{\s])(?:color|background|border-color)\s*:\s*([^;}]+)/g)) assert.match(decl[1], /var\(--|transparent|inherit|none/, decl[0]);
  assert.match(readFileSync(join(SRC, 'index.html'), 'utf8'), /css\/tasks\.css/);
});

test('the "New task" shortcut is in the manifest and points at the form route', () => {
  const m = JSON.parse(readFileSync(join(SRC, 'manifest.webmanifest'), 'utf8'));
  const s = m.shortcuts.find((x) => x.url.endsWith('#/tasks/new'));
  assert.ok(s);
  assert.equal(s.name, 'New task');
});

test('the collection form starts with tasks ticked when the Tasks screen asks for it (?components=VTODO)', () => {
  const src = readFileSync(join(SRC, 'js/views/collections/form.js'), 'utf8');
  assert.match(src, /components === 'VTODO' \? \['VTODO'\]/);
  assert.match(readFileSync(join(viewDir, 'common.js'), 'utf8'), /components: 'VTODO'/);
});

test('i18n: no hard-coded English text in the builders (every visible string goes through t)', () => {
  const literal = [...code.matchAll(/\bh\(\s*'(?:button|a|p|h1|h2|h3|span|label|summary|legend|li)'\s*,[^()]*?,\s*'([A-Z][a-z]+(?: [a-z]+)*)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(literal, []);
});
