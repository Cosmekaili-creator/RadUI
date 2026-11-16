// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of the shell sources: CSP compatibility (no inline script, style or
// handler, no external URL), the ids app.js depends on, i18n keys used by the
// markup and the sources, and the documented test ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../src/i18n/en.js';

const SRC = new URL('../../../src/', import.meta.url).pathname;
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');
const html = read('index.html');
const PARTS = ['shell', 'widgets', 'contacts', 'groups', 'collections', 'import', 'conflict', 'pwa', 'common', 'settings', 'users', 'calendar', 'event', 'tasks'];
const I18N_FILES = ['en', 'fr'].flatMap((l) => [`i18n/${l}.js`, ...PARTS.map((p) => `i18n/${l}.${p}.js`)]);
const SHELL_JS = ['app', 'router', 'screens', 'session', 'i18n', 'auth', 'api', 'config', 'ui', 'login', 'debug/debug', 'views/comingsoon', 'views/settings/screen', 'views/settings/prefs'].map((n) => `js/${n}.js`);
const SHELL_CSS = ['css/app.css', 'css/layout.css', 'css/tokens.css', 'css/widgets.css', 'css/contacts.css', 'css/collections.css', 'css/settings.css'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'vendor') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('index.html: no inline script, no style attribute, no inline handler, no external URL', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc="[^"]+"/);
    assert.equal(body.trim(), '', 'inline script body');
  }
  assert.equal(/<style\b/i.test(html), false, '<style> element');
  assert.equal(/\sstyle\s*=/i.test(html), false, 'style attribute');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'inline handler');
  assert.equal(/javascript:/i.test(html), false);
  const urls = [...html.matchAll(/(?:src|href|action)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  for (const u of urls) assert.ok(!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u), 'external URL ' + u);
  assert.match(html, /default-src 'self'/);
});

test('shell sources contain no external URL, no innerHTML, no inline handler strings', () => {
  const files = [...SHELL_JS, ...SHELL_CSS, 'config.json'];
  for (const f of files) {
    const text = read(f);
    assert.equal(/https?:\/\//i.test(text), false, `${f}: absolute URL`);
    assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(text.replace(/\/\/.*$/gm, '')), false, `${f}: raw HTML or eval`);
    assert.equal(/@import|url\(\s*['"]?(?:https?:)?\/\//i.test(text), false, `${f}: remote CSS`);
  }
});

test('every shell source file carries the SPDX header', () => {
  for (const f of [...SHELL_JS, ...SHELL_CSS, 'index.html', ...I18N_FILES]) {
    assert.match(read(f).split('\n').slice(0, 5).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
  }
});

test('no deployment-specific values in the shell sources (base paths, hosts, zones)', () => {
  for (const f of [...SHELL_JS, 'index.html', 'config.json', ...SHELL_CSS]) {
    const text = read(f);
    assert.equal(/['"`]\/ui\/|\/ui\/api|America\/|Europe\/|localhost|127\.0\.0\.1/.test(text), false, f);
  }
});

test('every id that app.js looks up exists exactly once in index.html', () => {
  const app = read('js/app.js');
  const ids = new Set([...app.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]));
  ids.add('app');
  assert.ok(ids.size >= 12);
  for (const id of ids) assert.equal([...html.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length, 1, `#${id}`);
});

test('index.html structure: landmarks, live regions, readiness attributes, skip link', () => {
  assert.match(html, /<div id="app" data-state="loading"[^>]*aria-busy="true"/);
  assert.match(html, /<header\b/);
  assert.match(html, /<nav\b[^>]*aria-label=/);
  assert.match(html, /<main\b[^>]*id="main"/);
  assert.match(html, /<aside\b/);
  assert.match(html, /id="status-region" role="status"/);
  assert.match(html, /id="alert-region" role="alert"/);
  assert.match(html, /class="skip"[^>]*data-testid="skip-link"/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<meta name="theme-color"/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<html lang="en">/);
});

test('i18n keys used by the markup and by t() calls exist in the dictionary', () => {
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-label)?="([^"]+)"/g)) keys.add(m[1]);
  for (const f of SHELL_JS) {
    for (const m of read(f).matchAll(/\bt\('([a-zA-Z0-9.]+)'/g)) keys.add(m[1]);
    for (const m of read(f).matchAll(/\btp\('([a-zA-Z0-9.]+)'/g)) keys.add(m[1] + '.other');
  }
  // keys built from a prefix in the code
  for (const p of ['debug.coll.kind.', 'debug.coll.source.', 'debug.coll.status.', 'err.kind.', 'account.type.', 'debug.health.']) assert.ok(Object.keys(en).some((k) => k.startsWith(p)), p);
  const missing = [...keys].filter((k) => !Object.hasOwn(en, k));
  assert.deepEqual(missing, []);
  for (const kind of ['auth', 'forbidden', 'notfound', 'network', 'server', 'unavailable', 'invalid', 'other']) assert.ok(en[`err.kind.${kind}`], kind);
  for (const s of ['ok', 'missing', 'inaccessible', 'error']) assert.ok(en[`debug.coll.status.${s}`], s);
  for (const s of ['ok', 'degraded', 'unknown']) assert.ok(en[`debug.health.${s}`], s);
  for (const s of ['person', 'bot']) assert.ok(en[`account.type.${s}`], s);
});

test('required test ids exist in the sources', () => {
  const login = read('js/login.js');
  for (const id of ['login-form', 'login-username', 'login-password', 'login-stay', 'login-submit', 'login-error']) assert.ok(login.includes(`'${id}'`), id);
  const debug = read('js/debug/debug.js');
  for (const id of ['debug-screen', 'debug-session', 'debug-collections', 'debug-collection', 'debug-item-row', 'debug-signout', 'debug-refresh', 'debug-summary']) assert.ok(debug.includes(`'${id}'`), id);
  for (const id of ['app-root', 'status-region', 'alert-region', 'activity-toggle', 'activity-panel', 'lang-select', 'theme-select', 'skip-link']) assert.ok(html.includes(`data-testid="${id}"`), id);
});

test('the documented test ids are the ones in the sources', () => {
  const docs = readFileSync(new URL('../../../docs/app-shell.md', import.meta.url), 'utf8');
  const sources = [html, ...SHELL_JS.map(read)].join('\n');
  for (const [, id] of docs.matchAll(/`((?:[a-z]+-)+[a-z]+)`/g)) {
    if (!/^(login|debug|activity|status|alert|app|nav|header|lang|theme|skip|notfound|main|feedback|brand|btn|banner|comingsoon|dialog)-/.test(id)) continue;
    const dynamic = id.match(/^(?:status|alert)-(message|text|dismiss)$/); // built as `${kind}-<suffix>` in ui.js
    const config = /^debug-config-(appbase|apibase|radicalebase|language|timezone|firstweekday)$/.test(id); // built from the label key in debug.js
    const ok = sources.includes(id) || (dynamic && sources.includes('${kind}-' + dynamic[1])) || (config && sources.includes('debug-config-${'));
    assert.ok(ok, `documented id not found in sources: ${id}`);
  }
});

test('text files under src/ (outside vendor) have no BOM', () => {
  for (const p of walk(SRC)) {
    if (!/\.(js|css|html|json|md)$/.test(p)) continue;
    assert.notEqual(readFileSync(p)[0], 0xef, 'BOM in ' + p);
  }
});

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('the browser never calls the loopback-only health endpoint', () => {
  for (const f of SHELL_JS) {
    const code = stripComments(read(f));
    assert.equal(/\.health\s*\(|,\s*['"`]health['"`]\s*[,)]|\/health\b/.test(code), false, `${f}: health call`);
  }
});

test('login focuses the password field after a failure but never select()s it', () => {
  const code = stripComments(read('js/login.js'));
  assert.equal(/\.select\s*\(/.test(code), false);
  assert.match(code, /pass\.focus\(\)/);
});

test('skip link: solid opaque background, high z-index, pushes the header down instead of covering it', () => {
  const css = read('css/app.css');
  const skip = css.match(/\.skip\s*\{([^}]*)\}/)[1];
  assert.match(skip, /position:\s*fixed/);
  assert.match(skip, /background:\s*var\(--ink\)/);
  assert.match(skip, /color:\s*var\(--bg\)/);
  assert.ok(Number(skip.match(/z-index:\s*(\d+)/)[1]) >= 100, 'above the Activity panel');
  assert.match(css, /\.skip:focus\s*\+\s*\.topbar\s*\{\s*margin-top:/);
});

test('phone header: "Signed in as" is not drawn under 481 px but stays accessible; tools stay on one row', () => {
  const css = read('css/app.css');
  const m = css.match(/@media \(max-width: 480px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'a max-width: 480px block exists');
  const user = m[1].match(/\.topbar__user\s*\{([^}]*)\}/)[1];
  assert.match(user, /clip:\s*rect\(0 0 0 0\)/);
  assert.equal(/display:\s*none/.test(user), false, 'display:none would hide it from assistive technology');
  assert.match(m[1], /\.topbar__tools\s*\{[^}]*flex-wrap:\s*nowrap/);
  const app = read('js/app.js');
  assert.match(app, /user\.setAttribute\('aria-label', signedInAs\)/);
});

test('config.json ships with debug off', () => {
  assert.equal(JSON.parse(read('config.json')).debug, false);
});

// ------------------------------------------------------------- whole-tree scan (run 2)

/** Every text source under src/ except src/vendor (walk() skips it). */
const SOURCES = walk(SRC).filter((p) => /\.(js|css|html|json|webmanifest)$/.test(p));
const rel = (p) => p.slice(SRC.length);
const stripJsComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('scan: no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, new Function anywhere in src/ (vendor excluded)', () => {
  assert.ok(SOURCES.length > 20, 'the scan found the tree');
  assert.equal(SOURCES.some((p) => p.includes('/vendor/')), false, 'vendor is excluded');
  for (const p of SOURCES.filter((f) => f.endsWith('.js'))) {
    const code = stripJsComments(readFileSync(p, 'utf8'));
    assert.equal(/\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b/.test(code), false, `${rel(p)}: raw HTML or dynamic code`);
  }
});

test('scan: no style attribute written, no inline event handler, no javascript: URL in src/ (CSSOM setProperty only)', () => {
  for (const p of SOURCES) {
    const text = readFileSync(p, 'utf8');
    const code = p.endsWith('.js') ? stripJsComments(text) : text;
    if (p.endsWith('.js')) {
      assert.equal(/setAttribute\(\s*['"`]style['"`]/i.test(code), false, `${rel(p)}: setAttribute('style'`);
      assert.equal(/\.cssText\s*=|\.setAttribute\(\s*['"`]on[a-z]+['"`]/i.test(code), false, `${rel(p)}: cssText or inline handler attribute`);
      assert.equal(/['"`]\s*javascript:/i.test(code), false, `${rel(p)}: javascript: URL`);
    }
    if (p.endsWith('.html')) {
      assert.equal(/\sstyle\s*=/i.test(code), false, `${rel(p)}: style attribute`);
      assert.equal(/\son[a-z]+\s*=/i.test(code), false, `${rel(p)}: inline handler`);
    }
    assert.equal(/<[a-z][^>]*\sstyle\s*=\s*["'`]/i.test(code), false, `${rel(p)}: style= in markup`);
  }
});

test('scan: no external URL in src/ (XML namespace identifiers aside); ical.js is vendored, not loaded from a CDN', () => {
  for (const p of SOURCES) {
    // XML namespace identifiers (WebDAV property names) are names, not addresses that are ever fetched
    const text = readFileSync(p, 'utf8').replace(/http:\/\/(?:www\.w3\.org\/[A-Za-z0-9/.-]+|calendarserver\.org\/ns\/|apple\.com\/ns\/ical\/)/g, '');
    assert.equal(/https?:\/\/(?!example\.(?:org|com|net)\b)/i.test(stripJsComments(text)) && !/\.md$/.test(p), false, `${rel(p)}: external URL`);
  }
});

test('ui.js is the only source that sets a data: image source', () => {
  for (const p of SOURCES.filter((f) => f.endsWith('.js'))) {
    if (rel(p) === 'js/ui.js') continue;
    const code = stripJsComments(readFileSync(p, 'utf8'));
    assert.equal(/['"`]data:image|\bdata:\$\{|\.src\s*=\s*[^;]*data:/.test(code), false, `${rel(p)}: builds a data: image URL`);
  }
});

test('ui.js never writes a style attribute: custom properties go through style.setProperty only', () => {
  const code = stripJsComments(read('js/ui.js'));
  assert.match(code, /el\.style\.setProperty\(name, text\)/);
  assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(code), false);
});

// ------------------------------------------------------------- shell markup (run 2)

test('index.html: manifest link, CSP aligned with the header, banner slots, navigation, sign-out', () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /manifest-src 'self'; worker-src 'self'/);
  assert.equal((html.match(/<meta name="theme-color"/g) || []).length, 2);
  for (const id of ['banner-offline', 'banner-update', 'btn-reload-update', 'btn-sign-out', 'nav-contacts', 'nav-collections', 'nav-debug']) assert.match(html, new RegExp(`data-testid="${id}"`), id);
  assert.match(html, /id="banner-offline" role="status"/);
  assert.match(html, /id="banner-update" role="status"/);
  // run 3: every entry exists in the markup; js/app.js shows them according to ENABLED_SLICES and the admin flag
  for (const id of ['nav-calendar', 'nav-tasks', 'nav-users', 'nav-settings', 'topbar-users', 'topbar-settings']) assert.match(html, new RegExp(`id="${id}"[^>]*data-testid="${id}"`), id);
  for (const css of ['layout', 'widgets', 'contacts', 'collections', 'settings']) assert.match(html, new RegExp(`href="css/${css}\\.css"`));
});

test('layout.css: bottom tab bar under 900 px, side rail from 900 px, banners', () => {
  const css = read('css/layout.css');
  assert.match(css, /\.nav\s*\{[^}]*position:\s*fixed[^}]*bottom|\.nav\s*\{[^}]*inset:\s*auto 0 0 0/);
  assert.match(css, /@media \(min-width: 900px\)/);
  assert.match(css, /\.banner--offline/);
  assert.match(css, /\.banner--update/);
  const phone = css.match(/@media \(max-width: 599px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(phone && /\.topbar__signout\s*\{[^}]*order/.test(phone[1]) && /\.topbar__tools\s*\{[^}]*order/.test(phone[1]), 'sign-out sits on the first phone row, tools on the second');
});

test('stub files for the other work packages exist, carry SPDX and export an empty dictionary / empty css', () => {
  for (const area of PARTS.slice(1)) {
    for (const l of ['en', 'fr']) assert.match(read(`i18n/${l}.${area}.js`), /export default Object\.freeze\(\{/, `${l}.${area}`);
  }
  for (const c of ['widgets', 'contacts', 'collections']) assert.match(read(`css/${c}.css`), /SPDX-License-Identifier: AGPL-3\.0-or-later/);
});

test('layout fix: wide and full screens use the whole main width from 900 px, aligned to its start edge; phones keep the column', () => {
  const css = read('css/layout.css');
  const m = css.match(/@media \(min-width: 900px\)\s*\{\s*\.main--wide, \.main--full \{([^}]*)\}/);
  assert.ok(m, 'a 900 px rule for .main--wide and .main--full');
  assert.match(m[1], /max-width:\s*none/);
  assert.match(m[1], /margin-left:\s*0/);
  assert.match(m[1], /margin-right:\s*0/);
  assert.equal(/\.main--wide\s*\{\s*max-width:\s*1280px/.test(css), false, 'no centred max-width for wide screens any more');
  assert.match(read('css/app.css'), /\.main\s*\{[^}]*max-width:\s*960px[^}]*margin:\s*0 auto/, 'the normal column is unchanged');
  assert.match(read('css/contacts.css'), /@media \(min-width: 900px\)\s*\{\s*\.split \{ grid-template-columns: minmax\(300px, 400px\) minmax\(0, 1fr\)/);
  const app = read('js/app.js');
  assert.match(app, /classList\.toggle\('main--full'/, 'the shell applies main--full for ctl.full and ctl.wide');
});

test('settings.css: rail-only entries are hidden under 900 px and the phone top-bar shortcuts from 900 px', () => {
  const css = read('css/settings.css');
  assert.match(css, /@media \(max-width: 899px\)\s*\{\s*\.nav__item--rail \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 900px\)\s*\{\s*\.topbar__icon \{ display: none; \}/);
});
