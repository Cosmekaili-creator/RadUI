// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-language loading: the whitelist, the cache, the fallback, the language switch, and the static rule that
// the application's import graph contains no dictionary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { loadDictionary, createDictionaryLoader, createLanguageSwitcher, createI18n, checkParity, SUPPORTED_LANGUAGES } from '../../../src/js/i18n.js';
import { DICTIONARIES } from '../_i18n-all.mjs';

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));

const fakeImporter = (dicts = { en: { a: 'A' }, fr: { a: 'Á' } }, { failing = [] } = {}) => {
  const calls = [];
  const importer = async (lang) => {
    calls.push(lang);
    if (failing.includes(lang)) throw new Error('404');
    return { default: dicts[lang] };
  };
  importer.calls = calls;
  return importer;
};

test('loadDictionary refuses anything outside the whitelist before it calls the importer', async () => {
  const importer = fakeImporter();
  for (const bad of ['../x', 'de', '', 'EN', 'en/../fr', 'fr.js', null, undefined, 7, {}, ['en']]) {
    await assert.rejects(() => loadDictionary(bad, importer), RangeError, String(bad));
  }
  assert.deepEqual(importer.calls, [], 'the importer was never reached');
  assert.deepEqual(await loadDictionary('fr', importer), { a: 'Á' });
  assert.deepEqual(importer.calls, ['fr']);
});

test('loadDictionary needs a default export that is an object', async () => {
  for (const mod of [undefined, {}, { default: null }, { default: 'x' }, { default: [] }]) {
    await assert.rejects(() => loadDictionary('en', async () => mod), TypeError);
  }
});

test('the default importer loads the real aggregators (source tree)', async () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    const d = await loadDictionary(lang);
    assert.ok(Object.keys(d).length > 500, lang);
    assert.deepEqual(d, DICTIONARIES[lang]);
  }
});

test('the loader imports each language once, shares concurrent requests and retries after a failure', async () => {
  let failFr = true;
  const calls = [];
  const loader = createDictionaryLoader({
    importer: async (l) => {
      calls.push(l);
      if (l === 'fr' && failFr) throw new Error('offline');
      return { default: { a: l } };
    },
  });
  assert.equal(loader.get('en'), null);
  const [a, b] = await Promise.all([loader.load('en'), loader.load('en')]);
  assert.equal(a, b);
  await loader.load('en');
  assert.deepEqual(calls, ['en']);
  assert.deepEqual(loader.get('en'), { a: 'en' });
  await assert.rejects(() => loader.load('fr'));
  assert.equal(loader.get('fr'), null);
  failFr = false;
  assert.deepEqual(await loader.load('fr'), { a: 'fr' });
  await loader.load('fr');
  assert.deepEqual(calls, ['en', 'fr', 'fr']);
  await assert.rejects(() => loader.load('../x'), RangeError);
  assert.equal(calls.length, 3);
});

test('a failed language import falls back to English (the start-up sequence of app.js)', async () => {
  const loader = createDictionaryLoader({ importer: fakeImporter(undefined, { failing: ['fr'] }) });
  let lang = 'fr';
  let dict;
  try {
    dict = await loader.load(lang);
  } catch {
    lang = 'en';
    dict = await loader.load(lang);
  }
  const i18n = createI18n({ lang: 'en' });
  i18n.addDictionary(lang, dict);
  i18n.setLang(lang);
  assert.equal(i18n.lang, 'en');
  assert.equal(i18n.t('a'), 'A');
});

test('createI18n: no dictionary means keys come back; addDictionary then setLang switches; no hidden English fallback is loaded', () => {
  const i = createI18n({ lang: 'fr' });
  assert.equal(i.t('a'), 'a');
  assert.equal(i.setLang('fr'), false, 'not loaded yet');
  assert.equal(i.addDictionary('fr', { a: 'Á' }), true);
  assert.equal(i.setLang('fr'), true);
  assert.equal(i.t('a'), 'Á');
  assert.equal(i.t('missing'), 'missing', 'a key absent from the only loaded language returns the key');
  assert.deepEqual(i.languages(), ['fr']);
  const given = { en: { a: 'A' } };
  const j = createI18n({ dictionaries: given });
  j.addDictionary('fr', { a: 'Á' });
  assert.deepEqual(Object.keys(given), ['en'], 'the caller\'s object is not modified');
});

test('parity: the explicit-dictionaries checkParity still reports the same problems', () => {
  assert.deepEqual(checkParity(DICTIONARIES).problems, []);
  assert.equal(checkParity({ en: { a: 'x' }, fr: {} }).ok, false);
});

// ------------------------------------------------------------ language switch

function switcher({ importer = fakeImporter(), lang = 'en' } = {}) {
  const loader = createDictionaryLoader({ importer });
  const i18n = createI18n({ lang });
  const events = [];
  const written = [];
  const sw = createLanguageSwitcher({
    i18n,
    loader,
    begin: () => {
      events.push('busy');
      return () => events.push('idle');
    },
    onApplied: (code) => {
      events.push(`applied:${code}`);
      written.push(code); // stands in for the single localStorage preference write
    },
    onFailed: (code) => events.push(`failed:${code}`),
  });
  return { sw, i18n, events, written, importer, loader };
}

test('language switch: loads first, then switches; the importer runs once per language', async () => {
  const s = switcher();
  await s.loader.load('en').then((d) => s.i18n.addDictionary('en', d));
  assert.equal(await s.sw('fr'), true);
  assert.equal(s.i18n.lang, 'fr');
  assert.equal(s.i18n.t('a'), 'Á');
  assert.equal(await s.sw('en'), true);
  assert.equal(await s.sw('fr'), true);
  assert.equal(await s.sw('en'), true);
  assert.deepEqual(s.importer.calls, ['en', 'fr'], 'one import per language, however often the user switches');
  assert.deepEqual(s.events.slice(0, 3), ['busy', 'idle', 'applied:fr'], 'busy while loading, language applied after');
});

test('language switch: the same language or an unknown one does nothing (and writes nothing)', async () => {
  const s = switcher();
  assert.equal(await s.sw('en'), true);
  for (const bad of ['de', '../x', '', null, undefined]) assert.equal(await s.sw(bad), false);
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.written, []);
  assert.deepEqual(s.importer.calls, []);
});

test('language switch: a failed load keeps the current language, reports it and writes nothing; a retry works', async () => {
  let down = true;
  const calls = [];
  const s = switcher({ importer: async (l) => { calls.push(l); if (l === 'fr' && down) throw new Error('offline'); return { default: { a: l } }; } });
  assert.equal(await s.sw('fr'), false);
  assert.equal(s.i18n.lang, 'en');
  assert.deepEqual(s.events, ['busy', 'idle', 'failed:fr']);
  assert.deepEqual(s.written, []);
  down = false;
  assert.equal(await s.sw('fr'), true);
  assert.equal(s.i18n.lang, 'fr');
  assert.deepEqual(s.written, ['fr']);
});

test('language switch: only the newest request wins (a slow older one is dropped; going back cancels a pending one)', async () => {
  const gates = {};
  const importer = (l) => new Promise((resolve) => { gates[l] = () => resolve({ default: { a: l } }); });
  const s = switcher({ importer: (l) => (l === 'en' ? Promise.resolve({ default: { a: 'en' } }) : importer(l)) });
  await s.loader.load('en').then((d) => s.i18n.addDictionary('en', d));
  const pending = s.sw('fr');
  assert.equal(await s.sw('en'), true, 'switching back to the active language cancels the pending one');
  gates.fr();
  assert.equal(await pending, false);
  assert.equal(s.i18n.lang, 'en');
  assert.deepEqual(s.written, []);
});

test('language switch keeps the screen state: app.js snapshots the screen, remounts with `restore`, and writes nothing to the server', () => {
  const app = readFileSync(join(SRC, 'js/app.js'), 'utf8');
  const start = app.indexOf('function rerenderScreen()');
  const end = app.indexOf("$('lang-select').addEventListener");
  assert.ok(start > 0 && end > start);
  const block = app.slice(start, end);
  assert.match(block, /snapshot\(\)/);
  assert.match(block, /forceRemount = true/);
  assert.match(block, /router\.refresh\(\)/);
  assert.match(block, /createLanguageSwitcher\(/);
  assert.match(block, /safeSet\(storages\.local, PREF_LANG/);
  assert.equal(/\bdav\.|\bapi\.|fetch\(/.test(block), false, 'a language switch makes no server request');
});

// ------------------------------------------------------------ static closure

/** Static import closure of a module (import ... from, export ... from, bare import); dynamic import() is not followed. */
function closure(entry) {
  const seen = new Set();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    const re = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n;]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(re)) if (m[1].startsWith('.')) todo.push(normalize(join(dirname(file), m[1])));
  }
  return [...seen];
}

test('the static import closure of js/app.js (and of the model chain) contains no dictionary file', () => {
  const files = closure(join(SRC, 'js/app.js'));
  assert.ok(files.length > 15, 'the walk found the shell modules');
  assert.ok(files.some((f) => f.endsWith('/js/i18n.js')));
  assert.deepEqual(files.filter((f) => f.includes('/i18n/')), []);
  const lazy = [...closure(join(SRC, 'js/screens.js')), ...closure(join(SRC, 'js/model/item.js')), ...closure(join(SRC, 'js/store/index.js'))];
  assert.deepEqual(lazy.filter((f) => f.includes('/i18n/')), []);
});

test('no source module outside js/i18n.js imports a dictionary (dynamic import included)', () => {
  const offenders = [];
  const walk = (dir, out) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === 'vendor') continue;
      if (name.endsWith('.js')) out.push(p);
      else if (!name.includes('.')) walk(p, out);
    }
    return out;
  };
  for (const f of walk(join(SRC, 'js'), [])) {
    if (/\/js\/i18n\.js$/.test(f)) continue;
    if (/i18n\/(?:en|fr|\$\{)/.test(readFileSync(f, 'utf8'))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
