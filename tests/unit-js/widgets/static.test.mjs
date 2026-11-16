// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of the widget sources: CSP compatibility (no raw HTML, style attribute, inline handler or
// external URL), SPDX headers, i18n keys used by the code exist in both languages, CSS uses only tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../src/i18n/en.js';
import fr from '../../../src/i18n/fr.js';
import enW from '../../../src/i18n/en.widgets.js';
import frW from '../../../src/i18n/fr.widgets.js';
import { checkParity } from '../../../src/js/i18n.js';

const SRC = new URL('../../../src/', import.meta.url).pathname;
const dir = join(SRC, 'js/widgets');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const read = (f) => readFileSync(join(dir, f), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the widget modules exist', () => {
  for (const f of ['datefield', 'timefield', 'dialogs', 'avatar', 'repeatable', 'picker', 'progress', 'fold', 'fieldkit', 'timing']) assert.ok(files.includes(`${f}.js`), f);
});

test('SPDX header, no raw HTML, no style attribute, no inline handler, no external URL, no eval', () => {
  for (const f of [...files.map((x) => `js/widgets/${x}`), 'css/widgets.css', 'i18n/en.widgets.js', 'i18n/fr.widgets.js']) {
    const text = readFileSync(join(SRC, f), 'utf8');
    assert.match(text.split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
    const code = f.endsWith('.js') ? stripComments(text) : text;
    assert.equal(/https?:\/\//i.test(code), false, `${f}: absolute URL`);
    if (f.endsWith('.js')) {
      assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/.test(code), false, `${f}: raw HTML or eval`);
      assert.equal(/setAttribute\(\s*['"`]style|\bstyle\s*:|\.style\.\w+\s*=|\.cssText/.test(code), false, `${f}: style attribute or style assignment`);
      assert.equal(/\bon(click|input|change|keydown|error|load)\s*=|setAttribute\(\s*['"`]on/i.test(code), false, `${f}: inline handler`);
      assert.equal(/['"`]\/ui\/|localhost|127\.0\.0\.1/.test(code), false, `${f}: deployment value`);
    } else {
      assert.equal(/@import|url\(/i.test(text), false, `${f}: remote CSS`);
    }
  }
});

test('the only dynamic style is the audited vars() helper', () => {
  const all = files.map(read).join('\n');
  assert.equal([...all.matchAll(/\bvars\(/g)].length >= 1, true);
  assert.equal(/\.style\b/.test(stripComments(all)), false);
});

test('every translation key the widgets use exists in both languages', () => {
  const keys = new Set();
  for (const f of files) for (const m of stripComments(read(f)).matchAll(/\bt\(\s*['"`]([a-z][A-Za-z0-9.]*)['"`]/g)) keys.add(m[1]);
  for (const m of stripComments(files.map(read).join('\n')).matchAll(/plural\(\s*['"`]([a-z][A-Za-z0-9.]*)['"`]/g)) keys.add(`${m[1]}.other`);
  for (const m of stripComments(files.map(read).join('\n')).matchAll(/`widget\.date\.err\.\$\{/g)) for (const c of ['required', 'format', 'year', 'month', 'day', 'min', 'max']) keys.add(`widget.date.err.${c}`);
  for (const c of ['required', 'format', 'hour', 'minute', 'min', 'max']) keys.add(`widget.time.err.${c}`);
  for (const k of ['widget.time.hint24', 'widget.time.hint12', 'widget.time.format24', 'widget.time.format12', 'widget.date.hint', 'widget.date.hintYearless']) keys.add(k);
  assert.ok(keys.size > 40, `found ${keys.size} keys`);
  for (const k of keys) {
    assert.ok(Object.hasOwn(en, k), `en: ${k}`);
    assert.ok(Object.hasOwn(fr, k), `fr: ${k}`);
  }
});

test('the widgets dictionary part: identical keys and placeholders in both languages, plural pairs complete', () => {
  assert.deepEqual(checkParity({ en: enW, fr: frW }).problems, []);
  assert.ok(Object.keys(enW).length > 60);
  for (const k of Object.keys(enW)) if (k.endsWith('.one')) assert.ok(Object.hasOwn(enW, k.replace(/\.one$/, '.other')), k);
  for (const k of Object.keys(enW)) assert.ok(k.startsWith('widget.') || k.startsWith('dialog.'), `key area: ${k}`);
});

test('CSS: colours come from tokens (only the avatar tones are literal) and focus/reduced motion are respected', () => {
  const css = readFileSync(join(SRC, 'css/widgets.css'), 'utf8');
  const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
  const allowed = new Set(['#1e5e52', '#7a5a2c', '#34507a', '#8a3a4c', '#55642a', '#5c4a80', '#2f6a78', '#7a4a2a', '#ffffff', '#000000', '#1f201e', '#f1f1ec']);
  for (const c of literals) assert.ok(allowed.has(c), c);
  assert.match(css, /prefers-reduced-motion: reduce/);
  for (let i = 0; i < 8; i += 1) assert.match(css, new RegExp(`\\.avatar--c${i}\\b`));
  assert.match(css, /var\(--tap\)/);
  assert.equal(/outline:\s*none/.test(css), false, 'focus rings are never removed');
});
