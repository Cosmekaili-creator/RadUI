// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, CONFIG_KEYS, isSafePath, isHttpsUrl, validateConfig, loadConfig, loadBuildInfo, resolveBases } from '../../../src/js/config.js';
import { makeFetch } from './_helpers.mjs';
import { readFileSync } from 'node:fs';

test('defaults are neutral and relative', () => {
  assert.equal(DEFAULT_CONFIG.basePath, './');
  assert.equal(DEFAULT_CONFIG.apiBasePath, 'api/');
  assert.equal(DEFAULT_CONFIG.radicaleBasePath, '/');
  assert.equal(DEFAULT_CONFIG.defaultTimeZone, null);
  assert.equal(DEFAULT_CONFIG.firstWeekday, null);
  assert.equal(DEFAULT_CONFIG.defaultLanguage, null);
  assert.equal(DEFAULT_CONFIG.debug, false);
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
});

test('the shipped src/config.json validates without warnings and equals the defaults', () => {
  const raw = JSON.parse(readFileSync(new URL('../../../src/config.json', import.meta.url), 'utf8'));
  const { config, warnings } = validateConfig(raw);
  assert.deepEqual(warnings, []);
  assert.deepEqual(config, { ...DEFAULT_CONFIG });
  assert.deepEqual(Object.keys(raw).sort(), [...CONFIG_KEYS].sort());
});

test('valid values are accepted', () => {
  const { config, warnings } = validateConfig({
    basePath: '/app/',
    radicaleBasePath: '/dav/',
    apiBasePath: '/app/api/',
    defaultLanguage: 'fr-CH',
    defaultTimeZone: 'Europe/Paris',
    firstWeekday: 7,
    appTitle: '  My Calendar ',
    debug: true,
  });
  assert.deepEqual(warnings, []);
  assert.equal(config.defaultLanguage, 'fr');
  assert.equal(config.defaultTimeZone, 'Europe/Paris');
  assert.equal(config.firstWeekday, 7);
  assert.equal(config.appTitle, 'My Calendar');
  assert.equal(config.debug, true);
  assert.equal(config.basePath, '/app/');
});

test('invalid values warn and fall back to the defaults', () => {
  const bad = {
    basePath: 'https://evil.example.org/',
    radicaleBasePath: '//evil.example.org/',
    apiBasePath: 'api/?x=1',
    defaultLanguage: 'xx',
    defaultTimeZone: 'Mars/Olympus',
    firstWeekday: 0,
    appTitle: '',
    debug: 'yes',
    surprise: 1,
  };
  const { config, warnings } = validateConfig(bad);
  assert.deepEqual(config, { ...DEFAULT_CONFIG });
  assert.deepEqual(warnings.map((w) => w.key).sort(), ['apiBasePath', 'appTitle', 'basePath', 'debug', 'defaultLanguage', 'defaultTimeZone', 'firstWeekday', 'radicaleBasePath', 'surprise']);
  assert.equal(warnings.find((w) => w.key === 'surprise').code, 'unknown-key');
});

test('type errors never throw', () => {
  for (const raw of [[], 'text', 42, true]) {
    const { config, warnings } = validateConfig(raw);
    assert.deepEqual(config, { ...DEFAULT_CONFIG });
    assert.equal(warnings[0].code, 'not-an-object');
  }
  assert.deepEqual(validateConfig(null).warnings, []);
  assert.equal(validateConfig({ firstWeekday: '1' }).warnings.length, 1);
  assert.equal(validateConfig({ appTitle: 'x'.repeat(41) }).warnings.length, 1);
  assert.equal(validateConfig({ appTitle: 'a\nb' }).warnings.length, 1);
});

test('isSafePath', () => {
  for (const ok of ['/', './', 'api/', '/a/b/', '../x/']) assert.ok(isSafePath(ok), ok);
  for (const bad of ['', 'javascript:alert(1)', 'https://h/', '//h/', '/a\\b', '/a?b', '/a#b', '/a\nb', 5, null]) assert.ok(!isSafePath(bad), String(bad));
});

test('loadConfig: file, missing file, bad JSON, HTTP error, network error', async () => {
  const ok = await loadConfig({ fetchImpl: makeFetch(() => ({ status: 200, body: '{"appTitle":"X"}' })) });
  assert.equal(ok.source, 'file');
  assert.equal(ok.config.appTitle, 'X');

  const missing = await loadConfig({ fetchImpl: makeFetch(() => ({ status: 404, body: 'nope' })) });
  assert.equal(missing.source, 'defaults');
  assert.deepEqual(missing.warnings, []);
  assert.deepEqual(missing.config, { ...DEFAULT_CONFIG });

  const garbled = await loadConfig({ fetchImpl: makeFetch(() => ({ status: 200, body: '{nope' })) });
  assert.equal(garbled.source, 'defaults');
  assert.equal(garbled.warnings[0].code, 'unreadable');

  const http = await loadConfig({ fetchImpl: makeFetch(() => ({ status: 500, body: 'x' })) });
  assert.equal(http.warnings[0].code, 'unreadable');

  const net = await loadConfig({
    fetchImpl: async () => {
      throw new TypeError('failed');
    },
  });
  assert.equal(net.source, 'defaults');
  assert.equal(net.warnings[0].code, 'unreadable');
});

test('loadConfig fetches relative to the page, without credentials, uncached', async () => {
  const f = makeFetch(() => ({ status: 200, body: '{}' }));
  await loadConfig({ fetchImpl: f });
  assert.equal(f.calls[0].url, 'config.json');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.calls[0].init.cache, 'no-store');
});

test('resolveBases resolves relative to the page and the app directory', () => {
  const b = resolveBases(DEFAULT_CONFIG, 'https://host.example.org/some/dir/index.html#/login');
  assert.deepEqual(b, { appBase: '/some/dir/', apiBase: '/some/dir/api/', radicaleBase: '/' });
  const c = resolveBases({ ...DEFAULT_CONFIG, basePath: '/ui/', apiBasePath: 'backend', radicaleBasePath: '/dav' }, 'https://host.example.org/ui/');
  assert.deepEqual(c, { appBase: '/ui/', apiBase: '/ui/backend/', radicaleBase: '/dav/' });
  const d = resolveBases({ ...DEFAULT_CONFIG, radicaleBasePath: '../' }, 'https://host.example.org/a/b/');
  assert.equal(d.radicaleBase, '/a/');
});

test('sourceUrl: empty by default; only https: addresses are accepted', () => {
  assert.equal(DEFAULT_CONFIG.sourceUrl, '');
  assert.equal(validateConfig({ sourceUrl: ' https://example.invalid/radui ' }).config.sourceUrl, 'https://example.invalid/radui');
  assert.deepEqual(validateConfig({ sourceUrl: '' }).warnings, []);
  for (const bad of ['javascript:alert(1)', 'http://example.invalid/x', 'ftp://example.invalid/x', 'data:text/html,x', '//example.invalid/x', 'example.invalid/x', 'https://' + 'user:pw' + String.fromCharCode(64) + 'host.invalid/', 'https://exa mple.invalid/', 'https://', 7, null, {}, 'https://example.invalid/' + 'a'.repeat(300)]) {
    const { config, warnings } = validateConfig({ sourceUrl: bad });
    assert.equal(config.sourceUrl, '', String(bad));
    assert.equal(warnings.length, 1, String(bad));
    assert.equal(warnings[0].key, 'sourceUrl');
  }
  assert.equal(isHttpsUrl('https://example.invalid/'), true);
  assert.equal(isHttpsUrl('HTTPS://EXAMPLE.invalid/'), true);
  assert.equal(isHttpsUrl('javascript:alert(1)'), false);
});

test('loadBuildInfo: reads the version label, ignores anything odd', async () => {
  const ok = await loadBuildInfo({ fetchImpl: makeFetch(() => ({ status: 200, body: '{"source":"v1.0-2-gabc","minified":true,"terser":"5.38.0"}' })) });
  assert.deepEqual(ok, { source: 'v1.0-2-gabc', minified: true });
  const f = makeFetch(() => ({ status: 200, body: '{"source":"x"}' }));
  await loadBuildInfo({ fetchImpl: f });
  assert.equal(f.calls[0].init.cache, 'no-cache');
  for (const r of [{ status: 404 }, { status: 200, body: '<html>' }, { status: 200, body: '{"source":"a b"}' }, { status: 200, body: '{"source":"<img>"}' }, { status: 200, body: '[]' }, { status: 200, body: '{}' }]) {
    assert.equal(await loadBuildInfo({ fetchImpl: makeFetch(() => r) }), null, JSON.stringify(r));
  }
  assert.equal(await loadBuildInfo({ fetchImpl: async () => { throw new Error('offline'); } }), null);
});
