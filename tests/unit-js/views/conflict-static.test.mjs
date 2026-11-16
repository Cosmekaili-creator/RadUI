// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of the conflict dialog files: header, CSP-safe code, CSS tokens only, dictionary parity and use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../src/i18n/en.conflict.js';
import fr from '../../../src/i18n/fr.conflict.js';
import { checkParity, placeholders } from '../../../src/js/i18n.js';
import { DIFF_FIELDS, FIELDS } from '../../../src/js/model/conflict.js';

const SRC = new URL('../../../src/', import.meta.url).pathname;
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');
const FILES = ['js/views/conflictdialog.js', 'js/views/download.js', 'css/conflict.css', 'i18n/en.conflict.js', 'i18n/fr.conflict.js'];
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const dialogSrc = read('js/views/conflictdialog.js');

test('SPDX header, no raw HTML, no style attribute, no inline handler, no external URL, no eval', () => {
  for (const f of FILES) {
    const text = read(f);
    assert.match(text.split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
    const code = f.endsWith('.js') ? stripComments(text) : text;
    assert.equal(/https?:\/\//i.test(code), false, `${f}: absolute URL`);
    if (f.startsWith('js/')) {
      assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(code), false, `${f}: raw HTML or eval`);
      assert.equal(/setAttribute\(\s*['"`]style|\bstyle\s*:|\.style\.\w+\s*=|\.cssText/.test(code), false, `${f}: style attribute`);
      assert.equal(/\bon(click|input|change|keydown|error|load)\s*=|setAttribute\(\s*['"`]on/i.test(code), false, `${f}: inline handler`);
      assert.equal(/['"`]\/ui\/|localhost|127\.0\.0\.1/.test(code), false, `${f}: deployment value`);
    }
  }
});

test('the dialog never calls a client write method itself: only the injected write path', () => {
  const code = stripComments(dialogSrc);
  assert.equal(/\.(putItem|deleteItem|mkcalendar|mkAddressbook|proppatch|putGrant|revokeGrant|deleteCollection)\(/.test(code), false);
  for (const m of ['resolveReload', 'resolveOverwrite', 'resolveCopy', 'resolveDeleteAnyway']) assert.ok(code.includes(`writes.${m}(`), m);
});

test('conflict.css uses design tokens only (no colour literals, no remote CSS)', () => {
  const css = read('css/conflict.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, 'hex colour');
  assert.equal(/\brgba?\(|\bhsla?\(/i.test(css), false, 'colour function');
  assert.equal(/@import|url\(/i.test(css), false, 'remote CSS');
  assert.equal(/!important/.test(css), false);
  for (const decl of css.matchAll(/(?:color|background|border-color)\s*:\s*([^;}]+)/g)) assert.match(decl[1], /var\(--|transparent|inherit|none/, decl[0]);
});

test('FR and EN have identical keys and placeholders, all under conflict.*', () => {
  assert.deepEqual(checkParity({ en, fr }), { ok: true, problems: [] });
  assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort());
  assert.ok(Object.keys(en).length > 60);
  for (const k of Object.keys(en)) assert.ok(k.startsWith('conflict.'), k);
  for (const k of Object.keys(en)) assert.deepEqual(placeholders(en[k]), placeholders(fr[k]), k);
  assert.ok(Object.isFrozen(en) && Object.isFrozen(fr));
});

test('the exact visible texts of the task are in the English part', () => {
  assert.equal(en['conflict.title'], 'This item was changed elsewhere');
  assert.equal(en['conflict.deleted.title'], 'This item was deleted elsewhere');
  assert.equal(en['conflict.reload'], 'Reload theirs');
  assert.equal(en['conflict.overwrite'], 'Overwrite with mine');
  assert.equal(en['conflict.copy'], 'Save mine as a copy');
  assert.equal(en['conflict.cancel'], 'Cancel');
  assert.equal(en['conflict.col.field'], 'Field');
  assert.equal(en['conflict.col.mine'], 'Yours');
  assert.equal(en['conflict.col.theirs'], 'Theirs');
  assert.match(en['conflict.unmappable.title'], /^These changes cannot be applied automatically:/);
  assert.equal(en['conflict.changed.show'], 'Show their version');
  assert.equal(en['conflict.changed.deleteAnyway'], 'Delete anyway');
});

test('every key the dialog uses exists, and every key of the part is used', () => {
  const code = stripComments(dialogSrc);
  const used = new Set([...code.matchAll(/\b(?:t|named|tOr)\(\s*(?:t,\s*)?[`'"]([a-z][A-Za-z0-9.-]*)[`'"]/g)].map((m) => m[1]));
  for (const m of code.matchAll(/'(conflict\.[A-Za-z0-9.-]+)'/g)) used.add(m[1]);
  for (const f of [...DIFF_FIELDS, ...FIELDS.event, ...FIELDS.task]) used.add(`conflict.field.${f}`); // contacts, events, tasks (dynamic keys)
  for (const c of ['start-mismatch', 'allday-toggle-with-exceptions', 'unknown-zone', 'no-master', 'error']) used.add(`conflict.replay.${c}`);
  for (const p of ['name', 'value', 'types', 'units', 'family', 'given', 'additional', 'prefix', 'suffix', 'any']) used.add(`conflict.part.${p}`);
  for (const c of ['both-edited', 'theirs-removed', 'pref-moved', 'generic']) used.add(`conflict.note.${c}`);
  used.add('conflict.photo.changed').add('conflict.photo.unchanged');
  used.add('conflict.status.identical'); // the store's text when Overwrite finds their version already equal to mine (store/writes.js)
  // `named('conflict.text')` reads <key>Unnamed when there is no label
  for (const k of [...used]) if (/^conflict\.(text|deleted\.text|changed\.text)$/.test(k)) used.add(`${k}Unnamed`);
  for (const k of used) assert.ok(Object.hasOwn(en, k) && Object.hasOwn(fr, k), `missing: ${k}`);
  for (const k of Object.keys(en)) assert.ok(used.has(k), `unused key: ${k}`);
});
