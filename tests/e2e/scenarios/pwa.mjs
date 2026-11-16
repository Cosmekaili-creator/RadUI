// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `pwa`: the manifest (valid, icons fetchable), the service worker reaches `activated`, an offline reload
// works (banner, disabled writes), the update flow (a rebuilt sw-manifest.js with a bumped version in the RUN directory,
// never in src/: banner, reload button, a dirty form asks first), a second tab that goes stale and closes its write gate
// on an unrequested update (review M4), DAV and api/ requests never served from cache, and a tampered precached file
// that makes the install fail.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BASE, REPO, UI, assertClean, check, davGet, en, go, info, login, makeBook, openPage, pageChecks, ready, shot, signIn, sleep, spec, tid, uniq, vcard,
} from '../lib/common.mjs';
import { listHash, openBook } from '../lib/ui.mjs';

export const scenarios = {};
const WWW = spec.www;

const rebuild = () => execFileSync('python3', [path.join(REPO, 'tools', 'build-sw-manifest.py'), '--src', WWW, '--out', path.join(WWW, 'sw-manifest.js')], { encoding: 'utf8' });
/** Change a served file so that the next manifest has a new version; returns a function that undoes it. */
function bump(tag) {
  const file = path.join(WWW, 'css', 'app.css');
  const orig = readFileSync(file);
  appendFileSync(file, `\n/* e2e bump ${tag} */\n`);
  rebuild();
  return () => { writeFileSync(file, orig); rebuild(); };
}
const version = (page) => page.evaluate(() => new Promise((resolve) => {
  const ctl = navigator.serviceWorker.controller;
  if (!ctl) return resolve(null);
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => resolve(e.data && e.data.version);
  ctl.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
  setTimeout(() => resolve('timeout'), 4000);
}));
/** Open the app and wait until the worker controls the page (the first visit installs it, the reload makes it control). */
async function controlled(page) {
  await page.goto(UI);
  await ready(page);
  await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return Boolean(r && r.active && r.active.state === 'activated'); }, null, { timeout: 30000 });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15000 }).catch(() => {});
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) { await page.reload(); await ready(page); }
}
const swState = (page) => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? { active: r.active && r.active.state, waiting: r.waiting && r.waiting.state, installing: r.installing && r.installing.state, scope: r.scope, updateViaCache: r.updateViaCache } : null; });

scenarios.manifest = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await page.goto(UI);
    await ready(page);
    const link = await page.evaluate(() => ({ manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'), theme: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => `${m.content}|${m.media}`), apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'), icon: [...document.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute('href')) }));
    check(Boolean(link.manifest) && link.theme.length >= 2 && Boolean(link.apple), 'index.html links the manifest, two theme-color metas (light and dark) and an apple-touch-icon', JSON.stringify(link));
    const res = await page.evaluate(async (href) => { const r = await fetch(href, { cache: 'no-store' }); return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), json: await r.json() }; }, link.manifest);
    const m = res.json;
    check(res.status === 200 && /^application\/manifest\+json/.test(res.type) && /no-cache/.test(res.cache), 'the manifest is served as application/manifest+json with Cache-Control: no-cache', `${res.type} ${res.cache}`);
    check(m.name === 'RadUI' && m.short_name === 'RadUI' && m.display === 'standalone' && m.start_url === './' && m.scope === './' && m.id === './', 'name, short_name, standalone display, relative start_url, scope and id', JSON.stringify({ n: m.name, d: m.display, s: m.start_url, sc: m.scope }));
    check(/^#[0-9a-f]{6}$/i.test(m.theme_color) && /^#[0-9a-f]{6}$/i.test(m.background_color), 'theme and background colours are hex colours');
    const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
    check(sizes.includes('192x192:any') && sizes.includes('512x512:any') && sizes.includes('512x512:maskable'), 'icons: 192 any, 512 any, 512 maskable', sizes.join(','));
    const urls = [...m.icons.map((i) => i.src), link.apple, ...link.icon, ...m.shortcuts.flatMap((s) => (s.icons || []).map((i) => i.src))];
    const fetched = await page.evaluate(async (list) => Promise.all([...new Set(list)].map(async (u) => { const r = await fetch(new URL(u, location.href).href); const b = await r.arrayBuffer(); return { u, status: r.status, type: r.headers.get('content-type'), n: b.byteLength }; })), urls);
    check(fetched.every((x) => x.status === 200 && /^image\//.test(x.type) && x.n > 100), `every icon is fetchable and is an image (${fetched.length} files)`, fetched.filter((x) => x.status !== 200).map((x) => x.u).join());
    // each declared PNG size is the real size of the file
    const dims = await page.evaluate(async (icons) => Promise.all(icons.filter((i) => /png/.test(i.type)).map(async (i) => { const bmp = await createImageBitmap(await (await fetch(new URL(i.src, location.href).href)).blob()); return { src: i.src, declared: i.sizes, actual: `${bmp.width}x${bmp.height}` }; })), m.icons);
    check(dims.every((d) => d.declared === d.actual), 'the declared icon sizes are the real pixel sizes', JSON.stringify(dims));
    check(JSON.stringify(m.shortcuts.map((x) => x.url)) === JSON.stringify(['./#/contacts/new', './#/events/new', './#/tasks/new']), 'three shortcuts: New contact, New event, New task (all hash routes)', JSON.stringify(m.shortcuts.map((x) => x.url)));
    await assertClean(page, watch, 'manifest');
  } finally {
    await ctx.close();
  }
};

scenarios['service-worker'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await controlled(page);
    const st = await swState(page);
    check(st.active === 'activated' && /\/ui\/$/.test(st.scope) && st.updateViaCache === 'none', 'the service worker is activated, scoped to the app, with updateViaCache "none"', JSON.stringify(st));
    const v = await version(page);
    check(/^[0-9a-f]{16}$/.test(v), 'the worker answers GET_VERSION with a 16-hex content version', String(v));
    const caches = await page.evaluate(async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname.replace(/^\/ui\//, '')); return out; });
    const names = Object.keys(caches);
    check(names.length === 1 && names[0] === `radui-shell-${v}`, 'exactly one cache, named radui-shell-<version>', names.join());
    const files = caches[names[0]];
    const mf = readFileSync(path.join(WWW, 'sw-manifest.js'), 'utf8');
    const listed = [...mf.matchAll(/"path": "([^"]+)"/g)].map((x) => x[1]);
    check(listed.length === files.length && listed.every((p) => files.includes(p) || p === '' || files.includes(p)), `the cache holds every file of the manifest (${listed.length})`, `${files.length} cached`);
    check(!files.some((f) => /^(alice|bob|agent-1|carol)\b|api\/|\.vcf|\.ics/.test(f)), 'no DAV or api/ URL is in the cache');
    check(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL.endsWith('/ui/sw.js')), 'the controlling script is sw.js');
    await assertClean(page, watch, 'service worker');
  } finally {
    await ctx.close();
  }
};

scenarios['never-cached'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    const book = await makeBook('alice', uniq('swd'), 'No cache', [['a.vcf', vcard('3.0', ['FN:Cache Probe', 'N:Probe;Cache;;;'])]]);
    await controlled(page);
    await login(page, 'alice', spec.users.alice);
    const seen = [];
    page.on('response', (r) => { seen.push({ url: r.url().replace(BASE, ''), sw: r.fromServiceWorker(), status: r.status() }); });
    await openBook(page, book);
    await page.getByTestId('contact-row').first().click();
    await page.getByTestId('contact-detail').waitFor();
    await tid(page, 'btn-export-contact').waitFor();
    await go(page, '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const dynamic = seen.filter((x) => !/^\/ui\/(?!api\/)/.test(x.url));
    check(dynamic.length > 5, 'the page made DAV and api requests', `${dynamic.length}: ${[...new Set(dynamic.map((d) => d.url.split('?')[0].replace(/[^/]+\.vcf$/, '*.vcf')))].slice(0, 6).join(' ')}`);
    check(dynamic.every((x) => x.sw === false), 'no DAV or api/ response came from the service worker', dynamic.filter((x) => x.sw).map((x) => x.url).join());
    const statics = seen.filter((x) => /^\/ui\/(js|css|i18n)\//.test(x.url));
    info(`static files answered by the worker: ${statics.filter((x) => x.sw).length} of ${statics.length}`);
    // after reading, still nothing of the data is in any cache
    const inCache = await page.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
    check(!inCache.some((p) => /\/(alice|bob)\/|\/api\//.test(p)), 'after use, the caches still hold no collection and no api response', String(inCache.length));
    const live = await page.evaluate(async (u) => { const a = await fetch(u, { cache: 'no-store' }); return a.status; }, `${BASE}/ui/api/me`).catch(() => 0);
    check(live === 401, 'a direct api request without credentials is answered by the server (401), not by a cached copy', String(live));
    await assertClean(page, watch, 'never cached');
  } finally {
    await ctx.close();
  }
};

scenarios.offline = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await controlled(page);
    await login(page, 'alice', spec.users.alice);
    const book = await makeBook('alice', uniq('swo'), 'Offline book', [['a.vcf', vcard('3.0', ['FN:Offline Probe', 'N:Probe;Offline;;;'])]]);
    await go(page, '#/contacts');
    await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('#app:not([data-state="loading"])', { timeout: 30000 });
    const banner = tid(page, 'banner-offline');
    await banner.waitFor({ state: 'visible' });
    check((await banner.textContent()).includes(en['shell.offline']) && (await banner.getAttribute('role')) === 'status', 'an offline reload opens the app from the worker cache with the persistent offline banner');
    await page.waitForSelector('[data-testid="contacts-offline"]', { timeout: 30000 });
    check((await tid(page, 'contacts-offline').textContent()).includes('no data is stored on this device'), 'the list says nothing is stored on the device (cold start offline)', await tid(page, 'contacts-offline').textContent());
    check((await tid(page, 'btn-retry').count()) === 1 && (await tid(page, 'btn-sign-out').isVisible()), 'the page is a working app: Retry and Sign out are there');
    await shot(page, 'pwa-offline-cold-start-desktop-light-en');
    watch.errors.length = 0; // the browser logs every request that failed because the network is off, on purpose
    watch.failed.length = 0;
    await pageChecks(page, watch, 'offline cold start');
    // back online: Retry loads the list
    await ctx.setOffline(false);
    await banner.waitFor({ state: 'hidden' });
    await tid(page, 'btn-retry').click();
    await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
    await page.getByTestId('contact-row').first().waitFor({ timeout: 20000 });
    check((await page.getByTestId('contact-row').count()) >= 1, 'back online, Retry loads the address book');
    // the same cold start on a deep link that names the book (every link of the list carries ab= when several books exist)
    await go(page, listHash(book));
    await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('[data-testid="contacts-screen"]:not([data-state="loading"])', { timeout: 30000 });
    const status = await page.evaluate(() => (document.querySelector('[data-testid="contacts-pane"]') || {}).dataset?.status);
    await shot(page, 'pwa-offline-cold-start-book-link-desktop-light-en');
    check(status === 'offline', 'an offline cold start on #/contacts?ab=<book> says "You are offline" (contacts-offline) (F7)', `the list shows the "${status}" state: "${await page.evaluate(() => (document.querySelector('[data-testid="contact-list"]') || {}).innerText?.slice(0, 60))}"`);
    await ctx.setOffline(false);
    await watch.errors.splice(0);
    watch.failed.length = 0;
    await assertClean(page, watch, 'offline scenario');
  } finally {
    await ctx.close();
  }
};

scenarios.update = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  let undo = null;
  try {
    await controlled(page);
    await login(page, 'alice', spec.users.alice);
    const v1 = await version(page);
    check(await tid(page, 'banner-update').isHidden(), 'no update banner while the version is current');
    undo = bump('one');
    // the page checks for a new worker when it becomes visible (at most hourly): ask the browser directly
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await tid(page, 'banner-update').waitFor({ state: 'visible', timeout: 30000 });
    const banner = tid(page, 'banner-update');
    check((await banner.getAttribute('role')) === 'status' && (await banner.textContent()).includes(en['shell.update.text']) && (await tid(page, 'btn-reload-update').count()) === 1, 'a new version shows a persistent banner (role=status) with a reload button');
    check((await swState(page)).waiting === 'installed' && (await version(page)) === v1, 'the new worker waits; the page still runs the old version (no automatic reload)');
    await shot(page, 'pwa-update-banner-desktop-light-en');
    await pageChecks(page, watch, 'update banner');
    // a dirty form: the reload button asks first
    await go(page, '#/contacts/new');
    await page.getByTestId('contact-form').waitFor();
    await tid(page, 'field-given').fill('Typed before the update');
    await tid(page, 'btn-reload-update').click();
    await tid(page, 'dialog-discard-changes').waitFor();
    await shot(page, 'pwa-update-dirty-dialog-desktop-light-en');
    await tid(page, 'dialog-keep-editing').click();
    await sleep(500);
    check(await tid(page, 'field-given').inputValue() === 'Typed before the update' && (await swState(page)).waiting === 'installed', 'with unsaved input the button asks first; "Keep editing" changes nothing and keeps the text');
    await tid(page, 'btn-reload-update').click();
    await tid(page, 'dialog-discard').click();
    await page.waitForFunction(async (old) => { const c = navigator.serviceWorker.controller; return Boolean(c); }, v1, { timeout: 30000 });
    await ready(page);
    await sleep(1500);
    const v2 = await version(page);
    check(v2 && v2 !== v1 && v2 !== 'timeout', 'after "Discard" the page reloads under the new worker (new content version)', `${v1} -> ${v2}`);
    check((await page.evaluate(async () => (await fetch('css/app.css')).text())).includes('e2e bump one') && (await tid(page, 'banner-update').isHidden()), 'the reloaded page runs the new files and the banner is gone');
    const names = await page.evaluate(async () => (await caches.keys()));
    check(names.length === 1 && names[0] === `radui-shell-${v2}`, 'the old cache was deleted when the new worker activated', names.join());
    await assertClean(page, watch, 'update flow');
  } finally {
    if (undo) undo();
    await ctx.close();
  }
};

scenarios['second-tab'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  let undo = null;
  try {
    await controlled(page);
    await login(page, 'alice', spec.users.alice, { stay: true });
    const book = await makeBook('alice', uniq('swt'), 'Two tabs', [['a.vcf', vcard('3.0', ['FN:Tab Probe', 'N:Probe;Tab;;;'])]]);
    await go(page, listHash(book));
    const tab2 = await ctx.newPage();
    const w2 = { errors: [], pageErrors: [] };
    tab2.on('pageerror', (e) => w2.pageErrors.push(String(e)));
    await tab2.goto(UI);
    await ready(tab2);
    await go(tab2, listHash(book));
    check((await tab2.evaluate(() => Boolean(navigator.serviceWorker.controller))) && (await tid(tab2, 'btn-new-contact').isEnabled()), 'a second tab runs under the same worker and has its write controls');
    undo = bump('two');
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await tid(page, 'banner-update').waitFor({ state: 'visible', timeout: 30000 });
    await tid(tab2, 'banner-update').waitFor({ state: 'visible', timeout: 15000 });
    check(await tid(tab2, 'btn-new-contact').isEnabled(), 'before anyone applies the update the second tab is still fine');
    // tab 1 applies the update (reload button), which also takes control of tab 2
    await Promise.all([page.waitForEvent('load', { timeout: 30000 }), tid(page, 'btn-reload-update').click()]);
    await ready(page);
    await tab2.waitForFunction(() => /out of date|Reload to continue/i.test(document.body.textContent), null, { timeout: 20000 });
    const stale = tab2.getByTestId('banner-update');
    check(await stale.isVisible() && (await stale.textContent()).includes('out of date') && (await tid(tab2, 'btn-reload-update').count()) === 1, 'the second tab did not reload by itself: its banner says the page is out of date and offers Reload');
    const nm = await tid(tab2, 'btn-new-contact').getAttribute('aria-label');
    const disabled = await tid(tab2, 'btn-new-contact').isDisabled();
    check(disabled && (nm || '').includes('Reload to continue'), 'its write gate is closed: New contact is disabled and its accessible name says "Reload to continue"', `${disabled} ${nm}`);
    await shot(tab2, 'pwa-stale-tab-desktop-light-en');
    await tab2.getByTestId('btn-reload-update').click();
    await tab2.waitForLoadState('load');
    await ready(tab2);
    await go(tab2, listHash(book));
    check(await tid(tab2, 'btn-new-contact').isEnabled() && (await tid(tab2, 'banner-update').isHidden()), 'after its own reload the second tab has its write controls back and no banner');
    check(w2.pageErrors.length === 0, 'no uncaught error in the stale tab', w2.pageErrors.join(' | '));
    await assertClean(page, watch, 'second tab');
  } finally {
    if (undo) undo();
    await ctx.close();
  }
};

scenarios.tampered = async (browser) => {
  const file = path.join(WWW, 'js', 'ui.js');
  const orig = readFileSync(file);
  const { ctx, page, watch } = await openPage(browser);
  try {
    // a precached file changes after the manifest was built (a half-finished deploy): the install must fail as a whole
    appendFileSync(file, '\n// tampered by the e2e suite\n');
    await page.goto(UI);
    await ready(page);
    const outcome = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const sw = reg && (reg.installing || reg.waiting || reg.active);
      if (!sw) return { state: 'no worker' };
      if (sw.state === 'installing' || sw.state === 'parsed') await new Promise((r) => { const f = () => { if (sw.state !== 'installing' && sw.state !== 'parsed') { sw.removeEventListener('statechange', f); r(); } }; sw.addEventListener('statechange', f); setTimeout(r, 20000); });
      return { state: sw.state, caches: await caches.keys(), active: Boolean((await navigator.serviceWorker.getRegistration()) && (await navigator.serviceWorker.getRegistration()).active) };
    });
    check(outcome.state === 'redundant' && outcome.active === false, 'a hash mismatch in one precached file makes the install fail: the worker becomes redundant and never activates', JSON.stringify(outcome));
    check(Array.isArray(outcome.caches) && outcome.caches.length === 0, 'the half-filled cache is deleted (no mixed tree)', JSON.stringify(outcome.caches));
    check(await tid(page, 'login-form').isVisible(), 'the app itself keeps working over the network without a worker');
    watch.errors.splice(0); // the browser logs the failed worker install
    watch.pageErrors.length = 0;
    watch.failed.length = 0;
    await assertClean(page, watch, 'tampered install');
  } finally {
    writeFileSync(file, orig);
    await ctx.close();
  }
};
