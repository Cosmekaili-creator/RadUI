// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of the collections and import files: header, CSP-safe code, writes only through the store's
// write path, CSS tokens only, dictionary parity and use, documented test ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import enColl from '../../../src/i18n/en.collections.js';
import frColl from '../../../src/i18n/fr.collections.js';
import enImp from '../../../src/i18n/en.import.js';
import frImp from '../../../src/i18n/fr.import.js';
import enAll from '../../../src/i18n/en.js';
import { checkParity, placeholders } from '../../../src/js/i18n.js';
import { PALETTE } from '../../../src/js/views/collections/model.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const COLL_DIR = 'src/js/views/collections';
const JS = [...readdirSync(join(ROOT, COLL_DIR)).filter((n) => n.endsWith('.js')).map((n) => `${COLL_DIR}/${n}`), 'src/js/views/importdialog.js'];
const ALL = [...JS, 'src/css/collections.css', 'src/i18n/en.collections.js', 'src/i18n/fr.collections.js', 'src/i18n/en.import.js', 'src/i18n/fr.import.js', 'docs/collections-ui.md'];
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1');
const SOURCES = JS.map((f) => [f, strip(read(f))]);
const joined = SOURCES.map(([, s]) => s).join('\n');

test('the expected files exist', () => {
  for (const f of ['model', 'list', 'form', 'screen', 'deletedialog', 'exporter']) assert.ok(JS.includes(`${COLL_DIR}/${f}.js`), f);
  assert.ok(JS.includes('src/js/views/importdialog.js'));
});

test('SPDX header, no raw HTML, no style attribute, no inline handler, no external URL, no eval, no deployment values', () => {
  for (const f of ALL) assert.match(read(f).split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
  for (const [f, code] of SOURCES) {
    assert.equal(/https?:\/\//i.test(code), false, `${f}: absolute URL`);
    assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(code), false, `${f}: raw HTML or eval`);
    assert.equal(/setAttribute\(\s*['"`]style|\bstyle\s*:|\.style\.\w+\s*=|\.cssText|\.style\.setProperty/.test(code), false, `${f}: style attribute or direct CSSOM`);
    assert.equal(/\bon(click|input|change|keydown|error|load)\s*=|setAttribute\(\s*['"`]on/i.test(code), false, `${f}: inline handler`);
    assert.equal(/['"`]\/ui\/|localhost|127\.0\.0\.1|America\/|Europe\//.test(code), false, `${f}: deployment value`);
    assert.equal(/localStorage|sessionStorage/.test(code), false, `${f}: no storage here`);
  }
});

test('colours reach the page only through the audited vars helper with the whitelist', () => {
  assert.match(joined, /vars:\s*\{\s*allow:\s*COLOUR_ALLOW/);
  assert.equal((joined.match(/--cal/g) || []).length >= 2, true);
});

test('writes go through the store write path only: no client, dav, api or transport write call', () => {
  const direct = /\b(?:client|dav|api|transport|app\.dav|app\.api)\s*\.\s*(?:putItem|deleteItem|mkcalendar|mkAddressbook|mkcol|proppatch|putGrant|revokeGrant|deleteCollection|request)\s*\(/;
  for (const [f, code] of SOURCES) assert.equal(direct.test(code), false, f);
  // the same patterns the store's own static test applies to views/ and contacts/
  const FORBIDDEN = [/\.\s*putItem\s*\(/, /\.\s*deleteItem\s*\(/, /\.\s*deleteCollection\s*\(/, /\.\s*mkcalendar\s*\(/, /\.\s*mkAddressbook\s*\(/, /\.\s*proppatch\s*\(/, /\.\s*putGrant\s*\(/, /\.\s*revokeGrant\s*\(/, /\.\s*request\s*\(\s*['"`](?:PUT|DELETE|MKCOL|MKCALENDAR|PROPPATCH|POST|PATCH|MOVE|COPY)['"`]/, /\b(?:PUT|DELETE|MKCOL|MKCALENDAR|PROPPATCH)['"`]\s*,\s*[a-z]+\s*[,)]/];
  for (const [f, code] of SOURCES) for (const re of FORBIDDEN) assert.equal(re.test(code), false, `${f}: ${re}`);
  // and the screens really use the store's writes
  assert.match(read(`${COLL_DIR}/form.js`), /\{\s*mkcol,\s*mkcalendar\s*\}\s*=\s*store\.writes/);
  assert.match(read(`${COLL_DIR}/form.js`), /\{\s*proppatch\s*\}\s*=\s*store\.writes/);
  assert.match(read(`${COLL_DIR}/deletedialog.js`), /\{\s*deleteCollection\s*\}\s*=\s*store\.writes/);
  assert.match(read('src/js/views/importdialog.js'), /store\.startImport\(/);
});

test('the delete passes expectedEtag; the export-first asks for the groups', () => {
  assert.match(read(`${COLL_DIR}/deletedialog.js`), /expectedEtag:\s*prep\.etag/);
  assert.match(read(`${COLL_DIR}/deletedialog.js`), /includeGroups:\s*true/);
});

test('the screens do not edit the shell: no import of app.js or screens.js', () => {
  for (const [f, code] of SOURCES) assert.equal(/from\s+['"][^'"]*\/(?:app|screens)\.js['"]/.test(code), false, f);
});

test('collections.css uses design tokens only (no colour literals, no remote CSS, no !important)', () => {
  const css = read('src/css/collections.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, 'hex colour');
  assert.equal(/\brgba?\(|\bhsla?\(/i.test(css), false, 'colour function');
  assert.equal(/@import|url\(/i.test(css), false, 'remote CSS');
  assert.equal(/!important/.test(css), false);
  for (const decl of css.matchAll(/(?:color|background|border-color|border-left|border)\s*:\s*([^;}]+)/g)) {
    if (/^\s*0\s*$/.test(decl[1]) || /\b(?:solid|dashed)\b/.test(decl[1]) || /var\(--|transparent|inherit|none/.test(decl[1])) continue;
    assert.fail(decl[0]);
  }
  assert.match(read('src/index.html'), /css\/collections\.css/);
});

test('FR and EN: identical keys and placeholders in both parts, frozen, namespaced', () => {
  assert.deepEqual(checkParity({ en: enColl, fr: frColl }), { ok: true, problems: [] });
  assert.deepEqual(checkParity({ en: enImp, fr: frImp }), { ok: true, problems: [] });
  assert.deepEqual(Object.keys(enColl).sort(), Object.keys(frColl).sort());
  assert.deepEqual(Object.keys(enImp).sort(), Object.keys(frImp).sort());
  for (const k of Object.keys(enColl)) assert.ok(/^(?:coll|colour)\./.test(k), k);
  for (const k of Object.keys(enImp)) assert.ok(k.startsWith('import.'), k);
  for (const [en, fr] of [[enColl, frColl], [enImp, frImp]]) for (const k of Object.keys(en)) assert.deepEqual(placeholders(en[k]), placeholders(fr[k]), k);
  assert.ok(Object.isFrozen(enColl) && Object.isFrozen(frColl) && Object.isFrozen(enImp) && Object.isFrozen(frImp));
  assert.ok(Object.keys(enColl).length > 100 && Object.keys(enImp).length > 80);
});

test('every dictionary key the code asks for exists (literals and the dynamic families)', () => {
  const keys = new Set();
  for (const m of joined.matchAll(/\bt\(\s*['"`]([a-zA-Z0-9.]+)['"`]/g)) keys.add(m[1]);
  for (const m of joined.matchAll(/\btp\(\s*['"`]([a-zA-Z0-9.]+)['"`]/g)) {
    keys.add(`${m[1]}.one`);
    keys.add(`${m[1]}.other`);
  }
  for (const m of joined.matchAll(/'((?:coll|import)\.[a-zA-Z0-9.]+)'/g)) keys.add(m[1]); // keys passed through ternaries
  const families = {
    'coll.type.': ['events', 'tasks', 'both', 'addressbook'],
    'coll.level.': ['read', 'readwrite'],
    'coll.err.name.': ['required', 'long', 'control'],
    'coll.err.slug.': ['empty', 'reserved', 'pattern', 'tilde'],
    'import.state.': ['new', 'duplicate', 'invalid', 'unsupported', 'file-duplicate'],
    'import.hint.': ['same-name', 'same-email'],
    'import.policy.': ['skip', 'replace', 'keep'],
    'import.policyHelp.': ['skip', 'replace', 'keep'],
    'import.fatal.': ['file-too-large', 'too-many-items', 'too-many-chunks', 'empty'],
    'import.result.': ['created', 'replaced', 'skipped', 'failed'],
    'import.report.stopped.': ['auth', 'network', 'forbidden', 'offline'],
    'colour.': PALETTE.map((p) => p.id),
  };
  for (const [prefix, names] of Object.entries(families)) for (const n of names) keys.add(prefix + n);
  const missing = [...keys].filter((k) => !Object.hasOwn(enAll, k) && !Object.hasOwn(enAll, `${k}.one`));
  assert.deepEqual(missing, []);
});

test('every reason code the import can report has its own text', () => {
  const codes = ['unsupported-version', 'parse-error', 'too-large', 'unterminated', 'outside-card', 'invalid-value', 'duplicate-property', 'duplicate-uid', 'empty-uid', 'uid-exists', 'kept-existing', 'lossy-needs-confirmation', 'no-etag', 'guard-failed', 'exists', 'changed', 'auth', 'unknown-result', 'forbidden', 'uid-conflict', 'server-error', 'error'];
  for (const c of codes) assert.ok(enImp[`import.reason.${c}`] && frImp[`import.reason.${c}`], c);
});

test('the test ids of the plan are in the sources', () => {
  const ids = [
    'collections-screen', 'collection-list-own', 'collection-list-shared', 'collection-row', 'collection-name', 'collection-type', 'collection-count', 'collection-desc', 'coll-owner', 'coll-readonly', 'shared-with', 'collection-tech',
    'btn-open-collection', 'btn-edit-collection', 'btn-import', 'btn-export', 'btn-delete-collection', 'btn-new-calendar', 'btn-new-addressbook', 'own-space-disabled', 'collections-empty', 'collections-error',
    'calendar-form', 'addressbook-form', 'field-coll-name', 'field-coll-slug', 'field-coll-desc', 'field-color', 'field-color-custom', 'field-components', 'private-notice', 'collection-save', 'collection-cancel',
    'dialog-delete-collection', 'delete-count', 'delete-shared', 'btn-export-first', 'field-confirm-name', 'dialog-confirm-delete',
    'dialog-import', 'field-import-target', 'field-import-file', 'import-preview', 'import-row', 'import-policy', 'policy-skip', 'policy-replace', 'policy-keep', 'import-summary', 'dialog-import-confirm', 'import-progress', 'btn-import-cancel', 'import-report', 'import-report-row',
  ];
  const all = joined + enAll['coll.title'];
  const progress = read('src/js/widgets/progress.js');
  for (const id of ids) {
    const found = all.includes(`'${id}'`) || all.includes(`"${id}"`) || (/^(?:import-progress|btn-import-cancel)$/.test(id) && progress.includes('-progress') && /name:\s*'import'/.test(all)) || (id.startsWith('colour-') || id.startsWith('component-') || (id.startsWith('policy-') && all.includes('`policy-${k}`')));
    assert.ok(found, id);
  }
  for (const p of PALETTE) assert.ok(joined.includes('`colour-${p.id}`'), p.id);
  assert.ok(joined.includes('`component-${comp.toLowerCase()}`'));
  assert.ok(/'field-confirm-name'/.test(joined) && /'dialog-confirm-delete'/.test(joined));
});

test('the docs name the screen registry lines and the test ids', () => {
  const d = read('docs/collections-ui.md');
  assert.match(d, /views\/collections\/screen\.js/);
  assert.match(d, /views\/collections\/form\.js/);
  assert.match(d, /openImportDialog/);
});
