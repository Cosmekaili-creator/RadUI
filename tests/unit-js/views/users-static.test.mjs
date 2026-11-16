// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of the Users screens and the sharing dialog: header, CSP-safe code, no direct writes, no secret
// in logs, CSS tokens only, dictionary parity and use, documented test ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import enUsers from '../../../src/i18n/en.users.js';
import frUsers from '../../../src/i18n/fr.users.js';
import enAll from '../../../src/i18n/en.js';
import { checkParity, placeholders } from '../../../src/js/i18n.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const DIR = 'src/js/views/users';
const JS = [...readdirSync(join(ROOT, DIR)).filter((n) => n.endsWith('.js')).map((n) => `${DIR}/${n}`), 'src/js/views/collections/sharedialog.js'];
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1');
const SOURCES = JS.map((f) => [f, strip(read(f))]);
const joined = SOURCES.map(([, s]) => s).join('\n');

test('the expected files exist', () => {
  for (const f of ['screen', 'accounts', 'form', 'account', 'matrix', 'dialogs', 'model', 'parts', 'adminstore']) assert.ok(JS.includes(`${DIR}/${f}.js`), f);
  assert.ok(JS.includes('src/js/views/collections/sharedialog.js'));
  assert.equal(typeof read('src/css/users.css'), 'string');
});

test('SPDX header, no raw HTML, no style attribute, no inline handler, no external URL, no eval, no deployment values, no storage', () => {
  for (const f of [...JS, 'src/css/users.css', 'src/i18n/en.users.js', 'src/i18n/fr.users.js']) assert.match(read(f).split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
  for (const [f, code] of SOURCES) {
    assert.equal(/https?:\/\//i.test(code), false, `${f}: absolute URL`);
    assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(code), false, `${f}: raw HTML or eval`);
    assert.equal(/setAttribute\(\s*['"`]style|\bstyle\s*:|\.style\.\w+\s*=|\.cssText|\.style\.setProperty/.test(code), false, `${f}: style attribute or direct CSSOM`);
    assert.equal(/\bon(click|input|change|keydown|error|load)\s*=|setAttribute\(\s*['"`]on/i.test(code), false, `${f}: inline handler`);
    assert.equal(/['"`]\/ui\/|localhost|127\.0\.0\.1|America\/|Europe\/|Asia\//.test(code), false, `${f}: deployment value`);
    assert.equal(/localStorage|sessionStorage|document\.cookie/.test(code), false, `${f}: no storage here`);
  }
});

test('no password reaches console, Activity, a status or a URL: the only readers of a password are the form, the one-time dialog and the store call', () => {
  for (const [f, code] of SOURCES) {
    assert.equal(/\bconsole\./.test(code), false, `${f}: console`);
    assert.equal(/\.log\s*\(/.test(code), false, `${f}: Activity is written by the store only`);
    assert.equal(/(?:setStatus|setAlert|status\(|alert\()[^;]*(?:password|secret)/i.test(code), false, `${f}: a secret in a message`);
    assert.equal(/hash\s*[:=][^;]*password|navigate\([^)]*(?:password|secret)/i.test(code), false, `${f}: a secret in a URL`);
  }
  // the generated password is dropped from the result as soon as it is read
  assert.match(read(`${DIR}/form.js`), /res\.password = null/);
  assert.match(read(`${DIR}/dialogs.js`), /result\.password = null/);
  assert.match(read(`${DIR}/dialogs.js`), /code\.textContent = ''/);
});

test('writes go through the admin store (and the store write path): no client, dav, api or transport write call', () => {
  const direct = /\b(?:client|dav|api|transport|app\.dav|app\.api)\s*\.\s*(?:putItem|deleteItem|mkcalendar|mkAddressbook|mkcol|proppatch|putGrant|revokeGrant|deleteCollection|createAccount|patchAccount|resetPassword|deleteAccount|request|post|put|patch|del)\s*\(/;
  const FORBIDDEN = [/\.\s*putItem\s*\(/, /\.\s*deleteItem\s*\(/, /\.\s*deleteCollection\s*\(/, /\.\s*mkcalendar\s*\(/, /\.\s*mkAddressbook\s*\(/, /\.\s*proppatch\s*\(/, /\.\s*putGrant\s*\(/, /\.\s*revokeGrant\s*\(/, /\.\s*request\s*\(\s*['"`](?:PUT|DELETE|MKCOL|MKCALENDAR|PROPPATCH|POST|PATCH|MOVE|COPY)['"`]/, /\b(?:PUT|DELETE|MKCOL|MKCALENDAR|PROPPATCH)['"`]\s*,\s*[a-z]+\s*[,)]/];
  for (const [f, code] of SOURCES) {
    assert.equal(direct.test(code), false, f);
    for (const re of FORBIDDEN) assert.equal(re.test(code), false, `${f}: ${re}`);
  }
  // the account changes use the admin store verbs
  for (const verb of ['createAccount', 'applyAccountChange', 'resetPassword', 'deleteAccount', 'applyGrant', 'previewGrant']) assert.match(joined, new RegExp(`admin\\.${verb}\\(`), verb);
  assert.match(read(`${DIR}/adminstore.js`), /createAdminStore\(\{[^}]*writes: store\.writes/);
});

test('the screens do not edit the shell: no import of app.js, screens.js or router.js', () => {
  for (const [f, code] of SOURCES) assert.equal(/from\s+['"][^'"]*\/(?:app|screens|router)\.js['"]/.test(code), false, f);
});

test('colours reach the page only as tokens; users.css is linked and has no literals, remote CSS or !important', () => {
  const css = read('src/css/users.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, 'hex colour');
  assert.equal(/\brgba?\(|\bhsla?\(/i.test(css), false, 'colour function');
  assert.equal(/@import|url\(/i.test(css), false, 'remote CSS');
  assert.equal(/!important/.test(css), false);
  for (const decl of css.matchAll(/(?:color|background|border-color|border-left|border)\s*:\s*([^;}]+)/g)) {
    if (/^\s*0\s*$/.test(decl[1]) || /\b(?:solid|dashed)\b/.test(decl[1]) || /var\(--|transparent|inherit|none/.test(decl[1])) continue;
    assert.fail(decl[0]);
  }
  assert.match(read('src/index.html'), /css\/users\.css/);
});

test('FR and EN: identical keys and placeholders, frozen, namespaced', () => {
  assert.deepEqual(checkParity({ en: enUsers, fr: frUsers }), { ok: true, problems: [] });
  assert.deepEqual(Object.keys(enUsers).sort(), Object.keys(frUsers).sort());
  for (const k of Object.keys(enUsers)) {
    assert.ok(/^(?:users|perm|pw|share)\./.test(k), k);
    assert.deepEqual(placeholders(enUsers[k]), placeholders(frUsers[k]), k);
  }
  assert.ok(Object.isFrozen(enUsers) && Object.isFrozen(frUsers));
  assert.ok(Object.keys(enUsers).length > 200);
});

test('every dictionary key the code asks for exists (literals and the dynamic families)', () => {
  const keys = new Set();
  for (const m of joined.matchAll(/\bt\(\s*['"`]([a-zA-Z0-9.]+)['"`]/g)) keys.add(m[1]);
  for (const m of joined.matchAll(/\btp\(\s*['"`]([a-zA-Z0-9.]+)['"`]/g)) {
    keys.add(`${m[1]}.one`);
    keys.add(`${m[1]}.other`);
  }
  for (const m of joined.matchAll(/'((?:users|perm|pw|share)\.[a-zA-Z0-9.]+)'/g)) keys.add(m[1]); // keys passed through ternaries
  const families = {
    'perm.': ['none', 'read', 'readwrite'],
    'perm.phrase.': ['none', 'read', 'readwrite'],
    'perm.why.': ['admin', 'owner', 'grant', 'none', 'principal', 'root'],
    'pw.score.': ['0', '1', '2', '3', '4'],
    'users.err.login.': ['required', 'pattern', 'reserved', 'exists', 'tombstoned'],
    'users.err.name.': ['required', 'long', 'control'],
    'users.err.password.': ['required', 'short', 'long', 'login', 'weak'],
    'users.err.server.': ['login', 'name', 'password', 'type', 'admin', 'ownspace'],
    'users.type.': ['person', 'bot'],
  };
  for (const [prefix, names] of Object.entries(families)) for (const n of names) keys.add(prefix + n);
  const known = (k) => Object.hasOwn(enAll, k) || Object.hasOwn(enAll, `${k}.one`);
  const missing = [...keys].filter((k) => !known(k));
  assert.deepEqual(missing, []);
  // and the other way: no key of this part is dead
  const unused = Object.keys(enUsers).filter((k) => {
    const base = k.replace(/\.(?:one|other)$/, '');
    if (joined.includes(`'${base}'`) || joined.includes(`"${base}"`)) return false;
    return !Object.entries(families).some(([prefix, names]) => names.some((n) => prefix + n === base));
  });
  assert.deepEqual(unused, []);
});

test('the test ids of the plan are in the sources', () => {
  const ids = [
    'users-screen', 'users-status', 'users-error', 'access-required', 'accounts-table', 'account-row', 'btn-new-account', 'chip-type', 'chip-admin', 'chip-status',
    'account-form', 'field-acct-login', 'field-acct-name', 'acct-type-person', 'acct-type-bot', 'field-acct-admin', 'field-acct-ownspace', 'pw-mode-generate', 'pw-mode-typed', 'field-acct-password', 'field-acct-show', 'pw-strength', 'account-save', 'account-cancel',
    'dialog-password-once', 'generated-password', 'btn-copy-password', 'copy-status', 'field-pw-saved', 'btn-password-saved', 'pw-once-warning',
    'account-view', 'account-details', 'acct-status', 'acct-pwchanged', 'field-ownspace', 'btn-reset-password', 'btn-toggle-disabled', 'btn-delete-account', 'access-title', 'grants-table', 'grant-row', 'grant-select', 'add-access-form', 'field-add-coll', 'field-add-level', 'btn-add-access', 'effective-table', 'effective-row', 'rights-limits-note',
    'dialog-reset-password', 'dialog-confirm-reset', 'dialog-delete-account', 'field-confirm-login', 'delete-keep', 'delete-data', 'btn-export-first', 'dialog-confirm-delete',
    'permission-matrix', 'matrix-account', 'matrix-row', 'perm-select', 'perm-fixed', 'matrix-filter', 'dialog-change-access', 'access-preview', 'access-confirm', 'access-cancel',
    'btn-share', 'dialog-share', 'share-table', 'share-row', 'share-select', 'share-preview', 'share-change', 'share-apply', 'share-cancel', 'users-tab-accounts', 'users-tab-permissions',
  ];
  const all = joined + enAll['users.new'];
  for (const id of ids) assert.ok(all.includes(`'${id}'`) || all.includes(`"${id}"`) || (id.startsWith('perm-option') && all.includes('perm-option-')) || (id.startsWith('acct-type-') && all.includes('acct-type-')), id);
  assert.ok(joined.includes('`perm-option-${'));
});

test('the collections list and screen carry the share entry points', () => {
  assert.match(read('src/js/views/collections/list.js'), /testid: 'btn-share'/);
  assert.match(read('src/js/views/collections/screen.js'), /dialog: 'share'/);
  assert.match(read('src/js/views/collections/screen.js'), /openShareDialog\(/);
});
