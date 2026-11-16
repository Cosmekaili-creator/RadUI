// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers of the browser suites: the stack description, PASS/FAIL accounting, pages with their
// collectors (console errors, page errors, CSP violations, failed requests, requests to other hosts), the
// page-level audits of run 1 (overflow, accessible names, contrast), screenshots, plain-HTTP helpers that talk
// to the throwaway Radicale and to the account service from Node, and small card helpers.
//
// ONE Chromium, one context at a time, everything sequential (see docs/testing.md, resource rules).
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(HERE, '..');
export const REPO = path.resolve(E2E_DIR, '..', '..');
export const spec = JSON.parse(readFileSync(process.env.RADUI_E2E_SPEC, 'utf8'));
export const SHOTS = process.env.RADUI_E2E_SHOTS || path.join(E2E_DIR, 'shots');
mkdirSync(SHOTS, { recursive: true });

export const en = (await import(pathToFileURL(path.join(REPO, 'src/i18n/en.js')).href)).default;
export const fr = (await import(pathToFileURL(path.join(REPO, 'src/i18n/fr.js')).href)).default;
export const DICT = { en, fr };
const pwEntry = path.join(process.env.RADUI_PW_DIR || '', 'node_modules', 'playwright', 'index.mjs');
export const pw = await import(pathToFileURL(pwEntry).href);

export const BASE = spec.base;
export const UI = BASE + spec.uiPath; // http://example.org:18120/ui/
export const HOST = spec.host;

// ------------------------------------------------------------------------------------- accounting
export const results = [];
export function check(ok, name, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  return Boolean(ok);
}
/** Findings of src/ that the audits know about (see docs/testing.md, "Findings"). */
// F1 (test ids on links and <summary> toggles) is fixed everywhere; the list stays for future known findings.
export const KNOWN_A11Y = [];

/** A check of a known, reproduced defect in src/: a failure is reported as TODO (not counted as a failure). */
export function checkTodo(ok, name, finding, detail = '') {
  if (ok) return check(true, name + ` (finding ${finding} no longer reproduces)`, detail);
  console.log(`TODO  ${name}  [${finding}${detail ? ': ' + detail : ''}]`);
  todos.push(`${finding}: ${name}`);
  return false;
}
export const todos = [];
export const info = (text) => console.log('INFO  ' + text);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mem = () => Number(/MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024;

// --------------------------------------------------------------------------------------- browser
export const CHROMIUM_ARGS = [`--host-resolver-rules=MAP ${spec.host} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${BASE}`, '--no-first-run', '--disable-dev-shm-usage'];
export const COMBOS = [];
for (const [vp, w, h] of [['phone', 390, 844], ['desktop', 1280, 800]])
  for (const scheme of ['light', 'dark'])
    for (const lang of ['en', 'fr']) COMBOS.push({ name: `${vp}-${scheme}-${lang}`, vp, w, h, scheme, lang });
export const PHONE = { w: 390, h: 844 };
export const DESKTOP = { w: 1280, h: 800 };

/** A fresh context + page with collectors. `watch.external` lists requests to any host other than the stack's. */
export async function openPage(browser, { w = 1280, h = 800, scheme = 'light', lang = 'en', cdpAuth = false, acceptDownloads = true, storageState, sw = 'allow', timezoneId } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, locale: lang === 'fr' ? 'fr-FR' : 'en-US', reducedMotion: 'reduce', acceptDownloads, storageState, serviceWorkers: sw, ...(timezoneId ? { timezoneId } : {}) });
  await ctx.addInitScript(() => {
    window.__csp = [];
    window.__dialogs = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  const watch = { errors: [], expected: [], pageErrors: [], csp: [], failed: [], external: [], dialogs: [], challenges: [], authRequired: 0, wwwAuth: [], http: [] };
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // the browser itself logs every 4xx answer of a fetch; a test that provokes one on purpose lists the status here
    if (/Failed to load resource: the server responded with a status of (401|429)/.test(text)) watch.expected.push(text);
    else watch.errors.push(text);
  });
  page.on('pageerror', (e) => watch.pageErrors.push(String(e.message || e)));
  page.on('dialog', async (d) => { watch.dialogs.push(`${d.type()}: ${d.message()}`); await d.dismiss().catch(() => {}); });
  page.on('requestfailed', (r) => {
    const f = r.failure();
    if (f && !/ERR_ABORTED/.test(f.errorText)) watch.failed.push(`${r.method()} ${r.url()} ${f.errorText}`);
  });
  page.on('request', (r) => {
    let u;
    try { u = new URL(r.url()); } catch { return; }
    if (/^https?:$/.test(u.protocol) && u.host !== `${spec.host}:${spec.port}`) watch.external.push(`${r.method()} ${r.url()}`);
  });
  page.on('response', (r) => {
    const hh = r.headers();
    if (hh['www-authenticate']) watch.wwwAuth.push(`${r.status()} ${r.url()}`);
    if (r.status() >= 400) watch.http.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`);
  });
  let cdp = null;
  if (cdpAuth) {
    cdp = await ctx.newCDPSession(page);
    cdp.on('Fetch.requestPaused', async (e) => {
      try { await cdp.send('Fetch.continueRequest', { requestId: e.requestId }); } catch { /* page closed */ }
    });
    cdp.on('Fetch.authRequired', async (e) => {
      watch.authRequired += 1;
      watch.challenges.push(`${e.request.url} ${e.authChallenge.scheme}`);
      try { await cdp.send('Fetch.continueWithAuth', { requestId: e.requestId, authChallengeResponse: { response: 'CancelAuth' } }); } catch { /* closed */ }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }], handleAuthRequests: true });
  }
  return { ctx, page, watch, cdp };
}

export const ready = (page, timeout = 30000) => page.waitForSelector('#app[data-state="ready"]', { timeout });
export const debugDone = (page) => page.waitForSelector('[data-testid="debug-progress"][data-state="done"]', { timeout: 30000 });
export const tid = (page, id) => page.getByTestId(id);

export async function harvestCsp(page, watch) {
  try {
    const v = await page.evaluate(() => { const a = window.__csp || []; window.__csp = []; return a; });
    watch.csp.push(...v);
  } catch { /* navigating */ }
}

/** Assert that the page produced no console error, page error, failed request, CSP violation or dialog so far. */
export async function assertClean(page, watch, label, { external = true, expectHttp = [] } = {}) {
  await harvestCsp(page, watch);
  // Creating a collection first probes its address with a PROPFIND that must answer 404 (store/writes.js, review C2):
  // the browser logs each such answer as a console error. Those lines are expected, one per 404 PROPFIND seen.
  const probes = watch.http.filter((x) => /^404 PROPFIND /.test(x)).length;
  let spare = probes;
  // a scenario that provokes answers on purpose (412 of a conflict, 404 of a deleted card) lists their statuses in `expectHttp`
  const wanted = new Map(expectHttp.map((c) => [c, watch.http.filter((x) => x.startsWith(c + ' ')).length]));
  watch.errors = watch.errors.filter((e) => {
    const m = /status of (\d{3})/.exec(e);
    if (m && wanted.has(m[1]) && wanted.get(m[1]) > 0) { wanted.set(m[1], wanted.get(m[1]) - 1); watch.expected.push(e); return false; }
    if (spare > 0 && /status of 404/.test(e)) { spare -= 1; watch.expected.push(e); return false; }
    return true;
  });
  check(watch.errors.length === 0, `no console errors: ${label}`, watch.errors.slice(0, 3).join(' | ') + (watch.errors.length ? ' || recent error responses: ' + watch.http.slice(-3).join(' ; ') : ''));
  check(watch.pageErrors.length === 0, `no uncaught page errors: ${label}`, watch.pageErrors.slice(0, 3).join(' | '));
  check(watch.csp.length === 0, `no CSP violations: ${label}`, watch.csp.slice(0, 3).join(' | '));
  check(watch.failed.length === 0, `no failed requests: ${label}`, watch.failed.slice(0, 3).join(' | '));
  if (external) check(watch.external.length === 0, `no request to another host: ${label}`, watch.external.slice(0, 3).join(' | '));
  watch.errors.length = watch.pageErrors.length = watch.csp.length = watch.failed.length = watch.external.length = 0;
  watch.http.length = 0;
}

/**
 * Sign in. A good login lands on #/contacts (or on the `next` target of a deep link). With `debug: true` the
 * helper then opens the diagnostics page, where the shell scenarios read the account and the collections.
 */
export async function login(page, user, password, { stay = false, wait = true, debug = false } = {}) {
  await tid(page, 'login-username').fill(user);
  await tid(page, 'login-password').fill(password);
  if (stay) await tid(page, 'login-stay').check();
  await tid(page, 'login-submit').click();
  if (wait) {
    await page.waitForFunction(() => /^#\/(contacts|collections|debug)/.test(location.hash), null, { timeout: 30000 });
    await ready(page);
    if (debug && !(await page.evaluate(() => location.hash)).startsWith('#/debug')) {
      await page.evaluate(() => { location.hash = '#/debug'; });
      await page.waitForFunction(() => location.hash.startsWith('#/debug'), null, { timeout: 20000 });
      await ready(page);
    }
  }
}

/** Open the app, sign in as `user`, land on `hash` (default: where the login lands). */
export async function signIn(page, user, hash = null, opts = {}) {
  await page.goto(UI);
  await ready(page);
  await login(page, user, spec.users[user], opts);
  if (hash) await go(page, hash);
}

/** Navigate by the URL hash and wait for the screen to be ready again. */
export async function go(page, hash) {
  const same = await page.evaluate((h) => location.hash === h, hash);
  if (!same) await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((h) => location.hash === h || location.hash.startsWith(h.split('?')[0]), hash, { timeout: 20000 });
  await ready(page);
}

export const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
export const shotViewport = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });

// ------------------------------------------------------------------------------ page-level audits
export async function overflow(page, label) {
  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const wide = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.right > de.clientWidth + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('.visually-hidden') && !el.classList.contains('skip')) wide.push((el.dataset.testid || el.tagName.toLowerCase()) + ':' + Math.round(b.right));
    }
    return { sw: de.scrollWidth, cw: de.clientWidth, bodySw: document.body.scrollWidth, wide: wide.slice(0, 5) };
  });
  return check(r.sw <= r.cw && r.bodySw <= r.cw, `no horizontal overflow: ${label}`, `scrollWidth ${r.sw} / clientWidth ${r.cw}${r.wide.length ? ' wide: ' + r.wide.join(',') : ''}`);
}

/** Chrome's own accessible name for every visible interactive element, plus its data-testid. */
export async function accessibility(page, label, { known = KNOWN_A11Y } = {}) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    // controls inside a closed <details> (content-visibility: hidden) are not on screen and not in the accessibility tree
    // with a modal dialog open the page behind it is inert: only the dialog is audited
    await page.evaluate(() => {
      const modal = document.querySelector('dialog[open]');
      for (const e of document.querySelectorAll('body *')) {
        const hiddenByCss = typeof e.checkVisibility === 'function' && !e.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true });
        if (hiddenByCss || (modal && !modal.contains(e) && !e.contains(modal))) e.setAttribute('data-e2e-hidden', '');
      }
    });
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const base = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[tabindex]:not([tabindex="-1"])';
    const sel = base.split(',').map((x) => x + ':not([data-e2e-hidden])').join(',');
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: sel });
    const bad = [];
    let counted = 0;
    for (const nodeId of nodeIds) {
      let visible = true;
      try { await cdp.send('DOM.getBoxModel', { nodeId }); } catch { visible = false; }
      if (!visible) continue;
      counted += 1;
      const { attributes } = await cdp.send('DOM.getAttributes', { nodeId });
      const nodeName = (await cdp.send('DOM.describeNode', { nodeId })).node.nodeName.toLowerCase();
      const attrs = {};
      for (let i = 0; i < attributes.length; i += 2) attrs[attributes[i]] = attributes[i + 1];
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const n = nodes && nodes[0];
      const name = n && n.name && n.name.value ? String(n.name.value).trim() : '';
      const desc = `${attrs['data-testid'] || attrs.id || 'element'}<${nodeName}${attrs.href ? ' href=' + String(attrs.href).slice(0, 30) : ''}>`;
      if (!name) bad.push(`${desc}: no accessible name`);
      if (!attrs['data-testid']) bad.push(`${desc}: no data-testid`);
    }
    // defects of src/ that are already recorded as findings are reported as TODO, anything else fails
    const todo = new Map();
    const real = [];
    for (const b of bad) {
      const k = known.find((x) => x.re.test(b) && (!x.label || x.label.test(label)));
      if (k) todo.set(k.finding, (todo.get(k.finding) || 0) + 1); else real.push(b);
    }
    check(counted > 0 && real.length === 0, `every interactive element has an accessible name and a data-testid (${counted} checked): ${label}`, [...new Set(real)].slice(0, 8).join('; '));
    for (const [f, n] of todo) checkTodo(false, `every interactive element has a data-testid (${n} without): ${label}`, f);
    await page.evaluate(() => { for (const e of document.querySelectorAll('[data-e2e-hidden]')) e.removeAttribute('data-e2e-hidden'); });
    return counted;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// WCAG 2.x relative luminance / contrast, evaluated in the page
const CONTRAST_FN = () => {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    // computed colour-mix() values come back as color(srgb r g b / a) with channels in 0..1
    const x = /color\(srgb ([^)]+)\)/.exec(c);
    if (x) {
      const p = x[1].split(/[ /]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; } }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    const pg = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (pg && pg.a > 0) acc = pg; else { const bb = parse(getComputedStyle(document.body).backgroundColor); if (bb && bb.a > 0) acc = bb; }
    for (const c of stack.reverse()) acc = over(c, acc);
    return acc;
  };
  const out = { texts: 0, min: 99, fails: [], tokens: [] };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim()) continue;
    if (el.closest('[hidden],.visually-hidden,option,script,style,noscript') || el.disabled || el.closest(':disabled')) continue;
    // behind an open modal dialog the page is inert and covered by the backdrop
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    seen.add(el);
    const fgc = parse(cs.color);
    const bgc = bgOf(el);
    const fg = over(fgc, bgc);
    const cr = ratio(fg, bgc);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    out.texts += 1;
    out.min = Math.min(out.min, cr);
    if (cr < need) out.fails.push(`${el.dataset.testid || el.tagName.toLowerCase() + '.' + el.className}: ${cr.toFixed(2)} (need ${need}) "${n.textContent.trim().slice(0, 24)}"`);
  }
  const root = getComputedStyle(document.documentElement);
  const tok = (name) => parse((() => { const d = document.createElement('i'); d.style.color = root.getPropertyValue(name); document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })());
  const pairs = [['--ink', '--bg', 4.5], ['--ink', '--surface', 4.5], ['--ink-2', '--surface', 4.5], ['--ink-3', '--surface', 4.5], ['--ink-3', '--bg', 4.5], ['--accent-ink', '--accent', 4.5], ['--accent-strong', '--accent-soft', 4.5], ['--accent', '--surface', 4.5], ['--danger', '--surface', 4.5], ['--danger', '--danger-soft', 4.5], ['--warn', '--warn-soft', 4.5], ['--ok', '--ok-soft', 4.5], ['--control', '--surface', 3], ['--focus', '--bg', 3]];
  for (const [f, b, need] of pairs) { const x = ratio(tok(f), tok(b)); out.tokens.push({ pair: `${f} on ${b}`, ratio: Math.round(x * 100) / 100, need, ok: x >= need }); }
  out.min = Math.round(out.min * 100) / 100;
  return out;
};
export async function contrast(page, label, { tokens = false } = {}) {
  const r = await page.evaluate(CONTRAST_FN);
  check(r.texts > 0 && r.fails.length === 0, `text contrast >= 4.5:1 (3:1 large text) on ${r.texts} text elements: ${label}`, `min ${r.min}${r.fails.length ? '; ' + r.fails.slice(0, 4).join('; ') : ''}`);
  if (tokens) {
    const bad = r.tokens.filter((t) => !t.ok);
    check(bad.length === 0, `design-token contrast pairs meet WCAG (${r.tokens.length} pairs): ${label}`, bad.map((t) => `${t.pair} ${t.ratio}<${t.need}`).join('; '));
    info('token ratios ' + label + ': ' + r.tokens.map((t) => `${t.pair.replace(/--/g, '')}=${t.ratio}`).join(', '));
  }
  return r;
}

/** The focused element has a visible ring (outline >= 2px or a box-shadow) and matches :focus-visible. */
export async function focusVisible(page, label) {
  const r = await page.evaluate(() => {
    const e = document.activeElement;
    if (!e || e === document.body) return { none: true };
    const cs = getComputedStyle(e);
    const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow && cs.boxShadow !== 'none');
    return { id: e.dataset.testid || e.id || e.tagName, visible: e.matches(':focus-visible'), ring: Boolean(ring) };
  });
  return check(!r.none && r.visible && r.ring, `the focused control shows a focus ring: ${label}`, JSON.stringify(r));
}

/**
 * The standard per-page checks of run 1: no console error, page error, CSP violation, failed request or foreign
 * request, no horizontal overflow, an accessible name and a data-testid on every control, contrast.
 */
export async function pageChecks(page, watch, label, { skip = [], known = KNOWN_A11Y, expectHttp = [] } = {}) {
  await assertClean(page, watch, label, { expectHttp });
  if (!skip.includes('overflow')) await overflow(page, label);
  if (!skip.includes('a11y')) await accessibility(page, label, { known });
  if (!skip.includes('contrast')) await contrast(page, label);
}

// ----------------------------------------------------------------------------- HTTP from Node
const basic = (user) => 'Basic ' + Buffer.from(`${user}:${spec.users[user]}`).toString('base64');

/** A request straight to the throwaway Radicale as `user` (never through nginx: no body size limit). */
export async function dav(user, method, href, body = null, headers = {}) {
  const res = await fetch(spec.radicale + href, { method, headers: { Authorization: basic(user), ...headers }, body, redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: buf.toString('utf8'), buf, etag: res.headers.get('etag') };
}
export const davGet = (user, href) => dav(user, 'GET', href);
export const davPut = (user, href, text, ctype = 'text/vcard', extra = {}) => dav(user, 'PUT', href, text, { 'Content-Type': ctype + '; charset=utf-8', ...extra });
export const davDelete = (user, href, etag) => dav(user, 'DELETE', href, null, etag ? { 'If-Match': etag } : {});

/** The account service through nginx (like the browser), as `user`. Node cannot resolve the stack's host name: it connects to loopback and sends the Host header. */
export function api(user, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest({
      host: '127.0.0.1', port: spec.port, method, path: spec.uiPath + 'api/' + p,
      headers: { Authorization: basic(user), Host: `${HOST}:${spec.port}`, Origin: BASE, 'Content-Type': 'application/json', 'X-RadUI': '1', 'Sec-Fetch-Site': 'same-origin', ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const MKCOL_BOOK = (name) => `<?xml version="1.0"?><D:mkcol xmlns:D="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav"><D:set><D:prop><D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype><D:displayname>${escXml(name)}</D:displayname></D:prop></D:set></D:mkcol>`;
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let counter = 0;
export const uniq = (p = 'x') => `${p}-${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Create an address book `name` for `user` and fill it with [fileName, text] pairs. Returns its href. */
export async function makeBook(user, name, displayName, items = []) {
  const href = `/${user}/${name}/`;
  const r = await dav(user, 'MKCOL', href, MKCOL_BOOK(displayName), { 'Content-Type': 'application/xml' });
  if (r.status !== 201) throw new Error(`MKCOL ${href}: ${r.status} ${r.text.slice(0, 100)}`);
  for (const [file, text] of items) {
    const p = await davPut(user, href + file, text);
    if (p.status !== 201) throw new Error(`PUT ${href}${file}: ${p.status} ${p.text.slice(0, 100)}`);
  }
  return href;
}

/** Hrefs and ETags of a collection's items (Depth 1 PROPFIND). */
export async function listItems(user, href) {
  const r = await dav(user, 'PROPFIND', href, '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>', { Depth: '1', 'Content-Type': 'application/xml' });
  const out = [];
  for (const m of r.text.matchAll(/<(?:\w+:)?response>([\s\S]*?)<\/(?:\w+:)?response>/g)) {
    const h = /<(?:\w+:)?href>([^<]+)</.exec(m[1]);
    const e = /<(?:\w+:)?getetag>([^<]+)</.exec(m[1]);
    if (h && e) out.push({ href: decodeURIComponent(h[1]), etag: e[1] });
  }
  return out;
}

/** The whole collection text (GET on a collection). */
export const getCollection = (user, href) => davGet(user, href);

// ------------------------------------------------------------------------------------- card helpers
/** Unfolded logical lines of a vCard/iCalendar text, trimmed, empty ones dropped. */
export function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
}
/** Which logical lines were removed and added between two texts (as multisets, ignoring order). */
export function lineDiff(before, after) {
  const count = (arr) => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) || 0) + 1); return m; };
  const a = count(unfold(before));
  const b = count(unfold(after));
  const removed = [];
  const added = [];
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) || 0); i++) removed.push(l);
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) || 0); i++) added.push(l);
  return { removed, added };
}
export const propName = (line) => /^(?:[\w-]+\.)?([\w-]+)/.exec(line)[1].toUpperCase();
/** Lines of the vCard with this property name (group prefix ignored). */
export const linesOf = (text, name) => unfold(text).filter((l) => propName(l) === name.toUpperCase());

export function vcard(version, props, { uid = null } = {}) {
  const lines = ['BEGIN:VCARD', `VERSION:${version}`, `UID:${uid || 'urn:uuid:' + cryptoUuid()}`, ...props, 'END:VCARD'];
  return lines.join('\r\n') + '\r\n';
}
let seq = 0;
export function cryptoUuid() {
  seq += 1;
  const hex = (n, l) => n.toString(16).padStart(l, '0');
  return `e2e${hex(process.pid % 0xfff, 3).slice(-3)}000-0000-4000-8000-${hex(Date.now() % 0xffffffff, 8)}${hex(seq, 4)}`;
}

// -------------------------------------------------------------------------------------------- photo
/** EXIF APP1 segment with orientation 6 (rotate 90 degrees clockwise to view). */
const EXIF_ORIENTATION_6 = Buffer.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

/**
 * A real JPEG, made by the browser's own encoder, with an EXIF orientation of 6 spliced in: raw size 300 x 150,
 * top half red, bottom half blue. Viewed upright (rotated 90 degrees clockwise) it is 150 x 300 with the blue
 * half on the left and the red half on the right.
 */
export async function makeExifJpeg(page, { w = 300, h = 150 } = {}) {
  const b64 = await page.evaluate(async ({ w, h }) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#d02020';
    g.fillRect(0, 0, w, h / 2);
    g.fillStyle = '#2020d0';
    g.fillRect(0, h / 2, w, h / 2);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  }, { w, h });
  const jpg = Buffer.from(b64, 'base64');
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) throw new Error('canvas did not produce a JPEG');
  return Buffer.concat([jpg.subarray(0, 2), EXIF_ORIENTATION_6, jpg.subarray(2)]);
}

/** Decode the PHOTO of a card text in the page and report its pixels (size and left/right colours). */
export async function decodePhoto(page, cardText) {
  const m = /^PHOTO[^:\n]*:(?:data:image\/[a-z]+;base64,)?([A-Za-z0-9+/=\s]+)$/im.exec(unfold(cardText).find((l) => propName(l) === 'PHOTO') || '');
  if (!m) return null;
  const b64 = m[1].replace(/\s+/g, '');
  const mime = /jpe?g/i.test(unfold(cardText).find((l) => propName(l) === 'PHOTO')) ? 'image/jpeg' : 'image/png';
  return page.evaluate(async ({ b64, mime }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { width: bmp.width, height: bmp.height, bytes: bytes.length, left: px(Math.floor(bmp.width * 0.15), Math.floor(bmp.height / 2)), right: px(Math.floor(bmp.width * 0.85), Math.floor(bmp.height / 2)) };
  }, { b64, mime });
}

// --------------------------------------------------------------------------------------- shipped bytes
export function shippedBytes(files) {
  let raw = 0;
  let gz = 0;
  for (const f of files) { const b = readFileSync(f); raw += b.length; gz += gzipSync(b).length; }
  return { raw, gzip: gz, files: files.length };
}

// ---------------------------------------------------------------------------------- misc page helpers
/** Wait until the rows of the list are exactly these names (in order unless `sorted`). */
export async function waitNames(page, names, { timeout = 15000, sorted = true } = {}) {
  const want = sorted ? [...names].sort() : names;
  try {
    await page.waitForFunction(({ want, sorted }) => {
      const got = [...document.querySelectorAll('[data-testid="contact-row"] .crow__name')].map((x) => x.textContent.trim());
      if (sorted) got.sort();
      return got.length === want.length && got.every((x, i) => x === want[i]);
    }, { want, sorted }, { timeout });
  } catch (e) {
    const got = await page.$$eval('[data-testid="contact-row"] .crow__name', (xs) => xs.map((x) => x.textContent.trim()).slice(0, 12));
    throw new Error(`waiting for rows ${JSON.stringify(want)}: got ${JSON.stringify(got)}`);
  }
}

/** Wait until the rows of the list are exactly `n`. */
export async function waitRows(page, n, timeout = 20000) {
  try {
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="contact-row"]').length === n, n, { timeout });
  } catch (e) {
    const got = await page.evaluate(() => `${document.querySelectorAll('[data-testid="contact-row"]').length} rows, count "${(document.querySelector('[data-testid="contacts-count"]') || {}).textContent}", state ${(document.querySelector('[data-testid="contacts-screen"]') || {}).dataset?.state}`);
    throw new Error(`waiting for ${n} contact rows: ${got}`);
  }
}

/** The text of the persistent status and alert regions. */
export async function feedback(page) {
  return page.evaluate(() => ({
    status: (document.querySelector('[data-testid="status-text"]') || {}).textContent || '',
    alert: (document.querySelector('[data-testid="alert-text"]') || {}).textContent || '',
  }));
}
