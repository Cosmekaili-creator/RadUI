// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `perf`: an address book of 2,000 synthetic contacts (generator tests/e2e/gen_contacts.py), seeded by a
// FILESYSTEM COPY into the throwaway storage by run.py. Radicale builds its item cache on the first read of such cards
// (22 to 35 s for 2,000), so a warm-up read comes before anything is timed. Then: time to data-state=ready (target
// under 3 s), search keystroke to render (under 100 ms), DOM node count (under 5,000), JS heap through CDP (under
// 150 MB). The numbers are printed as INFO lines; shipped bytes (raw and gzipped) are reported.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  UI, assertClean, check, dav, davGet, go, info, listItems, mem, openPage, ready, shippedBytes, shot, signIn, sleep, spec, tid,
} from '../lib/common.mjs';
import { listHash, rowsOf } from '../lib/ui.mjs';

export const scenarios = {};
const BOOK = '/alice/perf-book/';
const N = spec.big[BOOK];
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

scenarios.warmup = async () => {
  const t0 = Date.now();
  const r = await davGet('alice', BOOK);
  const s = (Date.now() - t0) / 1000;
  const cards = (r.text.match(/BEGIN:VCARD/g) || []).length;
  info(`warm-up read of ${N} file-seeded cards: ${s.toFixed(1)} s, ${(r.buf.length / 1048576).toFixed(2)} MB`);
  check(r.status === 200 && cards === N, `the seeded book has ${N} cards and the first read answered`, `${r.status}, ${cards} cards`);
  const t1 = Date.now();
  await davGet('alice', BOOK);
  info(`second read of the whole book (cache warm): ${((Date.now() - t1) / 1000).toFixed(2)} s`);
};

scenarios.load = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await page.goto(UI + `#/contacts?ab=${encodeURIComponent(BOOK)}`);
      await page.reload();
      await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]', { timeout: 60000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="contact-row"]').length > 0 && document.querySelector('#app').dataset.state === 'ready', null, { timeout: 60000 });
      times.push(Date.now() - t0);
    }
    info(`time from reload to data-state=ready (2,000 contacts, warm server cache): ${times.join(', ')} ms (median ${median(times)} ms)`);
    check(median(times) < 3000, 'time to data-state=ready is under 3 s (median of 3 reloads)', `${median(times)} ms`);
    const text = (await tid(page, 'contacts-count').textContent()).trim();
    check(text === `${N.toLocaleString('en-US')} contacts · showing 1–250` || text.includes('showing 1–250'), 'the list shows the first window of 250 and says how many there are', text);
    check((await page.getByTestId('contact-row').count()) === 250, '250 rows are in the DOM');
    // DOM nodes
    const dom = await page.evaluate(() => document.querySelectorAll('*').length);
    info(`DOM nodes with the first window shown: ${dom}`);
    check(dom < 5000, 'the DOM holds fewer than 5,000 nodes with 250 rows', String(dom));
    await tid(page, 'btn-show-more').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="contact-row"]').length === 500);
    const dom500 = await page.evaluate(() => document.querySelectorAll('*').length);
    info(`DOM nodes with 500 rows shown: ${dom500}`);
    // heap through CDP after a forced collection
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const mb = Math.round(heap.usedSize / 1048576);
    info(`JS heap in use after a forced GC (500 rows shown): ${mb} MB (total ${Math.round(heap.totalSize / 1048576)} MB)`);
    check(mb < 150, 'the JS heap is under 150 MB', `${mb} MB`);
    await cdp.detach();
    await shot(page, 'perf-list-2000-desktop-light-en');
    await assertClean(page, watch, 'perf load');
  } finally {
    await ctx.close();
  }
};

scenarios.search = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice', `#/contacts?ab=${encodeURIComponent(BOOK)}`);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="contact-row"]').length > 0, null, { timeout: 60000 });
    // measure inside the page: key press, then the URL update the debounced search makes, then the frame that paints the new list
    await page.evaluate(() => {
      const list = document.querySelector('[data-testid="contact-list"]');
      window.__perf = { runs: [] };
      let cur = null;
      document.addEventListener('keydown', () => { cur = { key: performance.now(), hash: null, render: null }; window.__perf.runs.push(cur); }, true);
      // the debounced search puts q into the URL with replaceState (no hashchange event): that call is the end of the debounce
      const replace = history.replaceState.bind(history);
      history.replaceState = (...a) => { if (cur && cur.hash === null) cur.hash = performance.now(); return replace(...a); };
      window.addEventListener('hashchange', () => { if (cur && cur.hash === null) cur.hash = performance.now(); });
      new MutationObserver(() => {
        if (cur && cur.render === null && cur.hash !== null) requestAnimationFrame(() => { if (cur && cur.render === null) cur.render = performance.now(); });
      }).observe(list, { childList: true, subtree: true });
    });
    const search = tid(page, 'contacts-search');
    await search.focus();
    const queries = ['a', 'an', 'ann', 'annke', 'zora vale', 'example.org', '555 01', 'zzzz'];
    const out = [];
    let typed = '';
    for (const q of queries) {
      // type only what is new: one key at a time for growing queries, a fresh query otherwise
      const grow = q.startsWith(typed) && typed !== '';
      if (!grow) { await search.fill(''); await sleep(500); typed = ''; }
      for (const ch of q.slice(typed.length)) {
        await page.evaluate(() => { window.__perf.runs.length = 0; });
        await page.keyboard.type(ch);
        await page.waitForFunction(() => window.__perf.runs.length && window.__perf.runs[0].render !== null, null, { timeout: 2500 }).catch(() => {});
        await sleep(150);
        const r = await page.evaluate(() => window.__perf.runs[0]);
        const rows = await page.evaluate(() => document.querySelectorAll('[data-testid="contact-row"]').length);
        if (r && r.hash !== null && r.render !== null) out.push({ q: q.slice(0, typed.length + 1), total: r.render - r.key, debounce: r.hash - r.key, render: r.render - r.hash, rows });
        typed += ch;
      }
      typed = q;
    }
    for (const o of out) info(`search "${o.q}": ${o.rows} rows, key to painted ${o.total.toFixed(0)} ms (debounce ${o.debounce.toFixed(0)} ms + filter and render ${o.render.toFixed(0)} ms)`);
    const worst = out.length ? Math.max(...out.map((o) => o.render)) : Infinity;
    const worstTotal = out.length ? Math.max(...out.map((o) => o.total)) : Infinity;
    check(out.length >= 8, 'at least 8 keystrokes were measured end to end', String(out.length));
    check(Number.isFinite(worst) && worst < 100, 'filtering and rendering 2,000 contacts after a keystroke takes under 100 ms (worst case of the run, the 250 ms input debounce excluded)', `${worst.toFixed(0)} ms`);
    info(`worst key-to-painted time including the input debounce: ${worstTotal.toFixed(0)} ms`);
    check(Number.isFinite(worstTotal) && worstTotal < 450, 'a keystroke is on screen within 450 ms including the input debounce', `${worstTotal.toFixed(0)} ms`);
    await page.getByTestId('contacts-search').fill('');
    await assertClean(page, watch, 'perf search');
  } finally {
    await ctx.close();
  }
};

scenarios.bytes = async (browser) => {
  const files = walk(spec.www).filter((f) => !/(^|\/)(README\.md|\.gitkeep|package\.json|SHA256SUMS)$/.test(f));
  const abs = (list) => list.map((f) => path.join(spec.www, f));
  const groups = {
    'all files of the app': files,
    'JavaScript (app and vendored)': files.filter((f) => f.endsWith('.js') && f !== 'sw-manifest.js'),
    'CSS': files.filter((f) => f.endsWith('.css')),
    'dictionaries (i18n)': files.filter((f) => f.startsWith('i18n/')),
    'vendored library': files.filter((f) => f.startsWith('vendor/')),
    'icons': files.filter((f) => f.startsWith('icons/')),
  };
  for (const [name, list] of Object.entries(groups)) {
    const b = shippedBytes(abs(list));
    info(`shipped bytes, ${name}: ${(b.raw / 1024).toFixed(1)} KB raw, ${(b.gzip / 1024).toFixed(1)} KB gzipped (${b.files} files)`);
  }
  const all = shippedBytes(abs(files));
  check(all.files > 50 && all.raw > 100 * 1024, 'the app tree was measured', `${all.files} files`);
  // what the browser really loads: the login route, then the contact list
  const { ctx, page } = await openPage(browser, { sw: 'block' });
  try {
    const loaded = [];
    page.on('response', async (r) => { if (r.url().startsWith(UI) && !r.url().includes('/api/')) { const b = await r.body().catch(() => null); loaded.push({ url: r.url().slice(UI.length), n: b ? b.length : 0 }); } });
    await page.goto(UI);
    await ready(page);
    await sleep(300);
    const login = loaded.reduce((s, x) => s + x.n, 0);
    info(`bytes loaded for the login screen: ${(login / 1024).toFixed(1)} KB raw in ${loaded.length} requests`);
    const before = loaded.length;
    await page.evaluate((u) => { location.hash = '#/contacts'; }, UI);
    await sleep(100);
    await signIn(page, 'alice');
    await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]');
    await sleep(500);
    const after = loaded.reduce((s, x) => s + x.n, 0);
    info(`bytes loaded up to the first contact list: ${(after / 1024).toFixed(1)} KB raw in ${loaded.length} requests (${loaded.length - before} more than the login screen)`);
    check(login < after, 'the login screen loads less than the contact list (screens are loaded lazily)', `${(login / 1024).toFixed(0)} KB < ${(after / 1024).toFixed(0)} KB`);
  } finally {
    await ctx.close();
  }
};
