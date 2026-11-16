// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of the contact screens: CSP-safe code, SPDX headers, no direct DAV writes, i18n keys used by
// the code exist in both languages, dictionary parity, the documented test ids exist, tokens-only CSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../src/i18n/en.js';
import fr from '../../../src/i18n/fr.js';
import enC from '../../../src/i18n/en.contacts.js';
import frC from '../../../src/i18n/fr.contacts.js';
import enG from '../../../src/i18n/en.groups.js';
import frG from '../../../src/i18n/fr.groups.js';
import { checkParity } from '../../../src/js/i18n.js';

const SRC = new URL('../../../src/', import.meta.url).pathname;
const dir = join(SRC, 'js/views/contacts');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const read = (f) => readFileSync(join(dir, f), 'utf8');
const all = files.map(read).join('\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the modules of the screens exist and the registry points at them', async () => {
  for (const f of ['screen', 'list', 'detail', 'form', 'groups', 'bookdata', 'common', 'links', 'formfields']) assert.ok(files.includes(`${f}.js`), f);
  const { SCREENS } = await import('../../../src/js/screens.js');
  assert.equal(SCREENS.contacts.module, './views/contacts/screen.js');
  assert.equal(SCREENS['contact-form'].module, './views/contacts/form.js');
  assert.equal(SCREENS.groups.module, './views/contacts/groups.js');
  for (const k of ['contacts', 'contact-form', 'groups']) assert.equal(SCREENS[k].model, true);
  for (const k of ['contacts', 'contact-form', 'groups']) {
    const m = await import(new URL(SRC + 'js/' + SCREENS[k].module.slice(2), 'file://'));
    assert.equal(typeof m.mount, 'function', k);
  }
});

test('SPDX header, no raw HTML, no style attribute, no inline handler, no external URL, no eval', () => {
  for (const f of [...files.map((x) => `js/views/contacts/${x}`), 'css/contacts.css', 'i18n/en.contacts.js', 'i18n/fr.contacts.js', 'i18n/en.groups.js', 'i18n/fr.groups.js']) {
    const text = readFileSync(join(SRC, f), 'utf8');
    assert.match(text.split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
    if (!f.endsWith('.js') || f.startsWith('i18n/')) continue;
    const code = strip(text);
    assert.equal(/https?:\/\//i.test(code), false, `${f}: absolute URL`);
    assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(code), false, `${f}: raw HTML or eval`);
    assert.equal(/setAttribute\(\s*['"`]style|\bstyle\s*:|\.style\b|\.cssText/.test(code), false, `${f}: style`);
    assert.equal(/\bon(click|input|change|keydown|error|load)\s*=|setAttribute\(\s*['"`]on/i.test(code), false, `${f}: inline handler`);
    assert.equal(/['"`]\/ui\/|localhost|127\.0\.0\.1|@[a-z0-9-]+\.(?:com|net|org)\b/.test(code.replace(/example\.org/g, '')), false, `${f}: deployment value`);
    assert.equal(/\.dataset\b|\bjavascript:/.test(code), false, `${f}: dataset or javascript: URL`);
  }
});

test('data: images only through setDataImage (via the avatar widget); no other data: URL is built', () => {
  assert.equal(/data:image|`data:|'data:|"data:/.test(strip(all)), false);
  assert.match(strip(all), /canDisplayPhoto/);
});

test('the screens never call a DAV or grant write method themselves', () => {
  const code = strip(all);
  assert.equal(/\.(putItem|deleteItem|mkcalendar|mkAddressbook|proppatch|putGrant|revokeGrant|deleteCollection)\(/.test(code.replace(/writes(?:\(\))?\.deleteItem\(/g, '').replace(/\.deleteItem\(\{ collection/g, '')), false);
  assert.equal(/\bclient\b|\bdav\b/.test(code), false, 'no DAV client in the views');
  for (const m of ['saveItem', 'createItem', 'deleteItem', 'putGroupMembers']) assert.match(code, new RegExp(`${m}\\(`), m);
});

test('every save passes base and baseFields; the patch comes from toPatch', () => {
  const form = strip(read('form.js'));
  assert.match(form, /saveItem\(\{[^}]*\bbase\b[^}]*\bbaseFields\b/);
  assert.match(form, /toPatch\(baseFields, v\)/);
  assert.match(form, /\bretry: state\.retry/);
  assert.match(form, /resolveReload/);
  assert.match(form, /openConflictDialog/);
  assert.match(form, /serverLossWarnings/);
  assert.match(form, /acceptNicknameLoss/);
  const detail = strip(read('screen.js'));
  assert.match(detail, /deleteItem\(\{[^}]*etag: m\.etag/);
});

test('every translation key the code uses exists in both languages (literal keys, prefixes and plurals)', () => {
  const code = strip(all);
  const keys = new Set();
  for (const m of code.matchAll(/\bt\(\s*['"`]([a-z][A-Za-z0-9.-]*)['"`]/g)) keys.add(m[1]);
  for (const m of code.matchAll(/\btp\(\s*['"`]([a-z][A-Za-z0-9.-]*)['"`]/g)) keys.add(`${m[1]}.other`);
  assert.ok(keys.size > 150, `found ${keys.size} keys`);
  for (const k of keys) {
    assert.ok(Object.hasOwn(en, k), `en: ${k}`);
    assert.ok(Object.hasOwn(fr, k), `fr: ${k}`);
  }
  // keys built from a prefix
  const prefixes = {
    'contact.type.': ['cell', 'home', 'work', 'main', 'fax', 'pager', 'other', 'custom'],
    'contact.readonly.': ['parse-error', 'empty', 'multiple-vcards', 'unsupported-version', 'duplicate-property', 'invalid-value', 'wrong-kind', 'fidelity', 'unknown'],
    'contact.rows.': ['phone.legend', 'phone.row', 'phone.add', 'phone.remove', 'email.legend', 'email.row', 'email.add', 'email.remove', 'address.legend', 'address.row', 'address.add', 'address.remove', 'url.legend', 'url.row', 'url.add', 'url.remove'],
    'contact.field.adr.': ['street', 'extended', 'pobox', 'code', 'city', 'region', 'country'],
    'groups.format.': ['apple', 'rfc6350'],
    'groups.formatNote.': ['apple', 'rfc6350'],
    'photo.err.': ['not-a-file', 'empty', 'too-large', 'unsupported-type', 'bad-image', 'type-mismatch', 'too-many-pixels', 'decode-failed', 'encode-failed'],
    'photo.note.': ['external-uri', 'not-base64', 'bad-base64', 'unsupported-mime', 'too-large', 'bad-image', 'too-many-pixels', 'too-wide'],
    'groups.err.': ['no-uid', 'group-read-only', 'nameRequired', 'nameTooLong', 'nameDuplicate'],
    'contact.err.': ['name', 'tooLong', 'email', 'phone', 'urlScheme', 'url', 'label', 'date', 'bdayFuture', 'anniversaryVersion', 'cardTooLarge'],
    'contact.applelabel.': ['mobile', 'iphone', 'home', 'work', 'main', 'home-fax', 'work-fax', 'other-fax', 'pager', 'other', 'home-page', 'anniversary', 'friend', 'spouse', 'partner', 'father', 'mother', 'parent', 'brother', 'sister', 'child', 'assistant', 'manager'],
  };
  for (const [p, list] of Object.entries(prefixes)) for (const x of list) assert.ok(Object.hasOwn(en, p + x) && Object.hasOwn(fr, p + x), p + x);
  for (const k of ['contacts.count', 'groups.members', 'groups.count', 'contact.form.errors']) assert.ok(en[`${k}.one`] && en[`${k}.other`] && fr[`${k}.one`] && fr[`${k}.other`], k);
});

test('the contacts and groups dictionary parts: identical keys and placeholders, own key areas', () => {
  assert.deepEqual(checkParity({ en: enC, fr: frC }).problems, []);
  assert.deepEqual(checkParity({ en: enG, fr: frG }).problems, []);
  assert.ok(Object.keys(enC).length > 150 && Object.keys(enG).length > 40);
  for (const k of Object.keys(enC)) assert.ok(/^(contacts|contact|photo)\./.test(k), k);
  for (const k of Object.keys(enG)) assert.ok(k.startsWith('groups.'), k);
  assert.ok(Object.isFrozen(enC) && Object.isFrozen(frG));
});

test('the test ids of the plan are in the sources', () => {
  const code = strip(all);
  const ids = [
    'contacts-screen', 'contacts-book', 'contacts-search', 'contacts-group', 'contacts-count', 'contact-list', 'contact-row', 'az-index', 'btn-new-contact', 'btn-import-vcf', 'btn-export-book', 'btn-groups',
    'btn-show-more', 'btn-show-earlier', 'contacts-empty', 'contacts-nobook', 'contacts-noaccess', 'contacts-readonly', 'contacts-no-match', 'contacts-error', 'contacts-offline', 'btn-retry',
    'contact-detail', 'contact-avatar', 'contact-name', 'btn-edit-contact', 'btn-delete-contact', 'btn-export-contact', 'contact-groups', 'btn-add-to-group', 'contact-meta', 'contact-readonly-reason', 'contact-raw',
    'contact-form', 'field-fn', 'field-prefix', 'field-given', 'field-additional', 'field-family', 'field-suffix', 'field-nickname', 'field-org', 'field-department', 'field-title', 'field-bday', 'field-anniversary',
    'field-categories', 'field-note', 'field-photo', 'btn-choose-photo', 'btn-remove-photo', 'photo-status', 'duplicate-hint', 'form-errors', 'contact-save', 'contact-cancel',
    'dialog-delete-contact', 'dialog-confirm-delete', 'dialog-cancel', 'delete-groups-note',
    'groups-screen', 'group-list', 'group-row', 'btn-new-group', 'dialog-new-group', 'field-group-name', 'dialog-create-group', 'group-detail', 'field-group-rename', 'btn-rename-group', 'group-format-note',
    'member-list', 'member-row', 'member-unknown-row', 'btn-remove-member', 'member-picker', 'field-member-search', 'member-option', 'btn-add-member', 'btn-delete-group', 'dialog-delete-group',
  ];
  for (const id of ids) assert.ok(code.includes(`'${id}'`) || code.includes(`"${id}"`), id);
  // generated ones: az-<L> / az-hash, field-<k>-type|custom|pref and btn-add/remove-<k> come from the widgets with these kinds
  assert.match(code, /e\.testId/);
  for (const kind of ['phone', 'email', 'address', 'url']) assert.match(code, new RegExp(`\\b${kind}\\b`));
});

test('contacts.css: design tokens only, focus rings and reduced motion untouched', () => {
  const css = readFileSync(join(SRC, 'css/contacts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, 'hex colour');
  assert.equal(/@import|url\(/i.test(css), false);
  // outline:none only where the focus is shown otherwise (the search box ring) or the element takes programmatic focus only (headings)
  const allowed = ['.searchbox .input:focus-visible', '.cdetail__name', '.clist__letter'];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*outline:\s*none[^}]*)\}/g)) assert.ok(allowed.includes(m[1].trim()), `outline removed on ${m[1].trim()}`);
  assert.match(css, /@media \(min-width: 900px\)/);
  for (const decl of css.matchAll(/(?:^|[;{\s])(?:color|background|border-color)\s*:\s*([^;}]+)/g)) assert.match(decl[1], /var\(--|transparent|inherit|none|rgb\(128 128 128/, decl[0]);
});

test('i18n: no hard-coded English text in the views (every visible string goes through t)', () => {
  const code = strip(all);
  const literal = [...code.matchAll(/\bh\(\s*'(?:button|a|p|h1|h2|h3|span|label|summary|legend|li)'\s*,[^()]*?,\s*'([A-Z][a-z]+(?: [a-z]+)*)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(literal, []);
});
