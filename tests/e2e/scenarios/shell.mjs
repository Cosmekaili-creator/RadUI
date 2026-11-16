// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `shell`: the app shell (login, sessions, routes, dialog, language and theme, keyboard, the diagnostics
// page, the CSP surface) in the 8-combination matrix, plus the per-address login limiter (last: it blocks 127.0.0.1).
// These are the run-1 scenarios; after run 2 a good login lands on #/contacts, the navigation has three links,
// the tab order is skip link, brand, language, theme, Activity, sign-out, the three nav links, then the screen,
// and the PWA manifest exists.
import {
  BASE, COMBOS, DICT, UI, accessibility, assertClean, check, contrast, debugDone, en, fr, harvestCsp, info, login, openPage,
  overflow, ready, shot, sleep, spec, tid,
} from '../lib/common.mjs';

const FAST = process.argv.includes('--fast');

async function skipLink(page, label) {
  const r = await page.evaluate(() => { const e = document.getElementById('skip-link'); const b = e.getBoundingClientRect(); return { bottom: Math.round(b.bottom), focused: document.activeElement === e }; });
  check(r.focused || r.bottom <= 0, `the skip link is off-screen until it is focused: ${label}`, `bottom=${r.bottom} focused=${r.focused}`);
}

const debugRows = (page) => page.$$eval('[data-testid="debug-collection"]', (els) => els.map((e) => {
  const c = e.querySelector('[data-testid="debug-collection-count"]');
  const w = e.querySelector('[data-writable]');
  const items = [...e.querySelectorAll('[data-testid="debug-item-row"]')];
  return { href: e.dataset.href, status: e.dataset.status, source: e.dataset.source, kind: e.dataset.kind, count: c ? Number(c.dataset.count) : null, writable: w ? w.dataset.writable : null, accessText: w ? w.textContent.trim() : '', itemsOk: items.filter((i) => i.dataset.result === 'ok').length, items: items.length };
}));

const checkDebug = async (page, who, lang, label) => {
  const rows = await debugRows(page);
  const want = spec.expect[who].collections;
  const wantHrefs = Object.keys(want).sort();
  check(JSON.stringify(rows.map((r) => r.href).sort()) === JSON.stringify(wantHrefs), `${who} sees exactly the expected collections: ${label}`, rows.map((r) => r.href).join(', '));
  for (const r of rows) {
    const w = want[r.href];
    if (!w) continue;
    check(r.status === 'ok' && r.count === w.count && r.kind === w.kind && r.source === w.source && r.writable === String(w.writable), `${who}: ${r.href} is ${w.source}/${w.kind}, ${w.count} items, writable=${w.writable}: ${label}`, JSON.stringify(r));
    check(r.items === Math.min(5, w.count) && r.itemsOk === r.items, `${who}: ${r.href} opened ${r.items} items, all open normally: ${label}`, `${r.itemsOk}/${r.items}`);
    const dict = DICT[lang];
    const wantText = w.writable ? dict['debug.coll.access.rw'] : dict['debug.coll.access.ro'];
    check(r.accessText === wantText, `${who}: ${r.href} access label "${wantText}": ${label}`, r.accessText);
  }
};

// ------------------------------------------------------------------------------ the matrix
async function matrixCombo(browser, combo) {
  const L = DICT[combo.lang];
  const tag = combo.name;
  const { ctx, page, watch } = await openPage(browser, { w: combo.w, h: combo.h, scheme: combo.scheme, lang: combo.lang });
  try {
    // login screen
    await page.goto(UI);
    await ready(page);
    check(await page.evaluate(() => location.hash) === '#/login', `unauthenticated visit lands on #/login: ${tag}`);
    check(await page.evaluate(() => document.documentElement.lang) === combo.lang, `html lang follows the browser language (${combo.lang}): ${tag}`);
    check((await tid(page, 'login-submit').textContent()).trim() === L['login.submit'], `login button text is the ${combo.lang.toUpperCase()} dictionary entry: ${tag}`);
    check((await page.title()).startsWith(L['login.title']), `document title is "${L['login.title']} - ...": ${tag}`, await page.title());
    await skipLink(page, `login ${tag}`);
    await shot(page, `login-${tag}`);
    await assertClean(page, watch, `login ${tag}`);
    await overflow(page, `login ${tag}`);
    await accessibility(page, `login ${tag}`);
    await contrast(page, `login ${tag}`, { tokens: combo.vp === 'desktop' && combo.lang === 'en' });

    // wrong password: persistent alert text, no native prompt
    await tid(page, 'login-username').fill('alice');
    await tid(page, 'login-password').fill('not-the-password');
    await tid(page, 'login-submit').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="login-error"]')?.textContent.trim().length > 0);
    const err = tid(page, 'login-error');
    check((await err.getAttribute('role')) === 'alert' && (await err.textContent()).trim() === L['login.err.bad'], `wrong password: role=alert text "${L['login.err.bad']}": ${tag}`);
    await shot(page, `login-error-${tag}`);
    await overflow(page, `login error ${tag}`);
    await contrast(page, `login error ${tag}`);
    await accessibility(page, `login error ${tag}`);
    await assertClean(page, watch, `login error ${tag}`);

    // good login -> lands on #/contacts, then open the diagnostics page
    await login(page, 'alice', spec.users.alice);
    check(page.url() === UI + '#/contacts', `good login lands on #/contacts: ${tag}`, page.url());
    check((await tid(page, 'nav-contacts').getAttribute('aria-current')) === 'page' && (await tid(page, 'btn-sign-out').count()) === 1, `the navigation marks Contacts as current and the header has the sign-out button: ${tag}`);
    check((await tid(page, 'status-text').textContent()).includes(L['login.ok'].replace('{login}', 'alice')), `persistent status "${L['login.ok'].replace('{login}', 'alice')}" on the landing screen: ${tag}`);
    await shot(page, `contacts-landing-${tag}`);
    await page.evaluate(() => { location.hash = '#/debug'; });
    await debugDone(page);
    check(page.url() === UI + '#/debug', `#/debug opens from the navigation target: ${tag}`, page.url());
    check((await page.getAttribute('#app', 'data-state')) === 'ready' && (await page.getAttribute('#app', 'aria-busy')) === 'false', `#app data-state=ready, aria-busy=false: ${tag}`);
    await checkDebug(page, 'alice', combo.lang, tag);
    check((await tid(page, 'debug-session-login').textContent()) === 'alice' && (await tid(page, 'debug-session-admin').textContent()) === L['common.yes'], `session card: login alice, administrator ${L['common.yes']}: ${tag}`);
    check((await tid(page, 'debug-health').getAttribute('data-result')) === 'ok', `backend health reachable and healthy: ${tag}`, await tid(page, 'debug-health').textContent());
    await skipLink(page, `debug ${tag}`);
    await shot(page, `debug-${tag}`);
    await assertClean(page, watch, `debug ${tag}`);
    await overflow(page, `debug ${tag}`);
    await accessibility(page, `debug ${tag}`);
    await contrast(page, `debug ${tag}`);

    // unknown route
    await page.evaluate(() => { location.hash = '#/no-such-page'; });
    await page.waitForSelector('[data-testid="notfound-screen"]');
    await ready(page);
    check((await page.getAttribute('#app', 'data-route')) === 'notfound', `unknown route shows the not-found screen: ${tag}`);
    check((await page.textContent('#notfound-title')).trim() === L['notfound.title'], `not-found title is translated: ${tag}`);
    await shot(page, `notfound-${tag}`);
    await overflow(page, `notfound ${tag}`);
    await accessibility(page, `notfound ${tag}`);
    await contrast(page, `notfound ${tag}`);
    await assertClean(page, watch, `notfound ${tag}`);

    // activity panel
    await page.evaluate(() => { location.hash = '#/debug'; });
    await debugDone(page);
    await tid(page, 'activity-toggle').click();
    const ops = await page.$$eval('[data-testid="activity-row"]', (rows) => rows.map((r) => `${r.dataset.op}:${r.dataset.result}`));
    check(ops.includes('login:ok') && ops.some((o) => o.startsWith('login:error')) && ops.includes('me:ok') && ops.some((o) => o.startsWith('discover')) && ops.some((o) => o.startsWith('count')), `Activity panel lists login (ok and failed), me, discover, count: ${tag}`, ops.join(','));
    await shot(page, `activity-${tag}`);
    await overflow(page, `activity ${tag}`);
    await contrast(page, `activity ${tag}`);
    await accessibility(page, `activity ${tag}`);
    await tid(page, 'activity-close').click();
    await assertClean(page, watch, `activity ${tag}`);

    // the PWA manifest of the app exists and is linked
    const man = await page.evaluate(async () => { const l = document.querySelector('link[rel="manifest"]'); if (!l) return null; const r = await fetch(l.href); return { status: r.status, type: r.headers.get('content-type'), json: await r.json() }; });
    check(man && man.status === 200 && /manifest\+json/.test(man.type || '') && man.json.display === 'standalone', `the PWA manifest is linked and served as application/manifest+json: ${tag}`, JSON.stringify(man && { s: man.status, t: man.type }));

    // sign out
    await tid(page, 'btn-sign-out').click();
    await page.waitForFunction(() => location.hash.startsWith('#/login'));
    check(await page.evaluate(() => [sessionStorage.getItem('radui.auth'), localStorage.getItem('radui.auth')].every((v) => v === null)), `sign out clears both storages: ${tag}`);
    check(watch.wwwAuth.length === 0, `no response of the whole flow carried WWW-Authenticate: ${tag}`, watch.wwwAuth.join(','));
  } finally {
    await ctx.close();
  }
}

export const scenarios = {};

scenarios['auth-prompt'] = async (browser) => {
  // positive control first: a top-level request to Radicale WITHOUT credentials makes Chromium ask for
  // a password; this proves the detector works, so a zero below means something
  {
    const { ctx, page, watch } = await openPage(browser, { cdpAuth: true });
    try {
      await page.goto(BASE + '/alice/').catch(() => {});
      await sleep(500);
      check(watch.authRequired >= 1, 'control: a navigation to Radicale without credentials DOES raise Fetch.authRequired (the detector works)', `${watch.authRequired} event(s)`);
    } finally { await ctx.close(); }
  }
  const { ctx, page, watch } = await openPage(browser, { cdpAuth: true });
  try {
    await page.goto(UI);
    await ready(page);
    for (const attempt of ['wrong-1', 'wrong-2']) {
      await tid(page, 'login-username').fill('alice');
      await tid(page, 'login-password').fill(attempt);
      await tid(page, 'login-submit').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="login-error"]')?.textContent.trim().length > 0);
      await sleep(300);
    }
    check(watch.authRequired === 0, 'wrong password: the browser never shows its own authentication prompt (Fetch.authRequired count 0)', `${watch.authRequired}`);
    const text1 = await tid(page, 'login-error').textContent();
    await sleep(2500);
    check((await tid(page, 'login-error').textContent()) === text1 && text1.trim() === en['login.err.bad'], 'the error text is persistent (still there 2.5 s later, not a toast)');
    check(await page.evaluate(() => location.hash) === '#/login', 'the page stays on #/login after a wrong password');
    check(await tid(page, 'login-password').getAttribute('aria-invalid') === 'true', 'the password field is marked aria-invalid with a visible error line');
    check(await page.evaluate(() => document.activeElement.dataset.testid) === 'login-password', 'focus returns to the password field after a failed login');
    check(await page.evaluate(() => [sessionStorage.getItem('radui.auth'), localStorage.getItem('radui.auth')].every((v) => v === null)), 'nothing is stored after a failed login');
    await login(page, 'alice', spec.users.alice, { debug: true });
    await debugDone(page);
    check(watch.authRequired === 0, 'good login and the diagnostics run: still no native prompt', `${watch.authRequired}`);
    check(watch.wwwAuth.length === 0, 'no response carried WWW-Authenticate during wrong and good logins', watch.wwwAuth.join(','));
    // an expired/wrong credential on a protected screen: send the browser a stale credential
    await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('radui.auth') || sessionStorage.getItem('radui.auth')); r.h = 'Basic ' + btoa('alice:stale'); sessionStorage.setItem('radui.auth', JSON.stringify(r)); });
    await page.reload();
    await page.waitForFunction(() => location.hash.startsWith('#/login'), null, { timeout: 20000 });
    await ready(page);
    check(watch.authRequired === 0, 'a stale stored credential: the app returns to #/login, still no native prompt', `${watch.authRequired}`);
    const status = (await tid(page, 'status-text').textContent().catch(() => '')) || '';
    check(status.includes(en['login.expired']), 'expired session explained in persistent status text', status.trim());
    info(`expected 401 console lines from the deliberate wrong passwords: ${watch.expected.length}`);
    await assertClean(page, watch, 'auth-prompt scenario');
  } finally { await ctx.close(); }
};

scenarios['storage'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    // --- "Stay signed in" OFF
    await page.goto(UI);
    await ready(page);
    check((await tid(page, 'login-stay').isChecked()) === false, '"Stay signed in" is off by default');
    await login(page, 'alice', spec.users.alice, { stay: false, debug: true });
    let st = await page.evaluate(() => ({ s: sessionStorage.getItem('radui.auth'), l: localStorage.getItem('radui.auth') }));
    check(st.s !== null && st.l === null, 'stay OFF: the credential is in sessionStorage only', `session=${st.s !== null} local=${st.l !== null}`);
    check(st.s && !st.s.includes(spec.users.alice) && /"h":"Basic /.test(st.s), 'the stored value is the Basic header, never the plain password');
    await page.reload();
    await ready(page);
    check(page.url() === UI + '#/debug', 'stay OFF: the credential survives a reload (still on #/debug)', page.url());
    const p2 = await ctx.newPage();
    await p2.goto(UI);
    await ready(p2);
    check(await p2.evaluate(() => location.hash) === '#/login', 'stay OFF: a NEW TAB is not signed in (sessionStorage is per tab)');
    await p2.close();
    // sign out clears everything
    await tid(page, 'debug-signout').click();
    await page.waitForFunction(() => location.hash.startsWith('#/login'));
    st = await page.evaluate(() => ({ s: sessionStorage.getItem('radui.auth'), l: localStorage.getItem('radui.auth') }));
    check(st.s === null && st.l === null, 'sign out (stay OFF) clears sessionStorage and localStorage');
    check((await tid(page, 'status-text').textContent()).trim() === en['login.signedOut'], 'sign out says so in persistent status text');
    await page.goto(UI + '#/debug');
    await page.waitForFunction(() => location.hash.startsWith('#/login'));
    check((await page.evaluate(() => location.hash)).includes('next='), 'a protected deep link while signed out goes to login and remembers where to return (next=)');
    // --- "Stay signed in" ON
    await login(page, 'alice', spec.users.alice, { stay: true, debug: true });
    st = await page.evaluate(() => ({ s: sessionStorage.getItem('radui.auth'), l: localStorage.getItem('radui.auth') }));
    check(st.l !== null && st.s === null, 'stay ON: the credential is in localStorage only', `session=${st.s !== null} local=${st.l !== null}`);
    const p3 = await ctx.newPage();
    await p3.goto(UI);
    await ready(p3);
    check(p3.url() === UI + '#/contacts', 'stay ON: a new page of the same browser context is signed in (lands on #/contacts)', p3.url());
    await p3.close();
    await page.reload();
    await ready(page);
    check(page.url() === UI + '#/debug', 'stay ON: survives a reload');
    await tid(page, 'debug-signout').click();
    await page.waitForFunction(() => location.hash.startsWith('#/login'));
    st = await page.evaluate(() => ({ s: sessionStorage.getItem('radui.auth'), l: localStorage.getItem('radui.auth') }));
    check(st.s === null && st.l === null, 'sign out (stay ON) clears both storages');
    const p4 = await ctx.newPage();
    await p4.goto(UI);
    await ready(p4);
    check(await p4.evaluate(() => location.hash) === '#/login', 'after sign out a new page of the same context is signed out');
    await p4.close();
    await assertClean(page, watch, 'storage scenario');
  } finally { await ctx.close(); }
};

scenarios['routes'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await page.goto(UI + '#/nope');
    await ready(page);
    check((await page.getAttribute('#app', 'data-route')) === 'notfound' && (await page.locator('[data-testid="notfound-screen"]').count()) === 1, 'unknown route (signed out) shows the not-found page, not a blank screen');
    await tid(page, 'notfound-home').click();
    await page.waitForFunction(() => location.hash.startsWith('#/login'));
    check((await page.getAttribute('#app', 'data-route')) === 'login', 'the not-found "start page" link leads to login when signed out');
    await login(page, 'alice', spec.users.alice, { debug: true });
    await debugDone(page);
    for (const bad of ['#/debug/extra', '#/%E0%A4%A', '#/login/x', '#/?x=1', '#/DEBUG']) {
      await page.evaluate((h) => { location.hash = h; }, bad);
      await sleep(300);
      const route = await page.getAttribute('#app', 'data-route');
      check(['notfound', 'debug', 'contacts'].includes(route), `odd hash ${bad} gives a defined screen (${route})`);
    }
    await page.evaluate(() => { location.hash = '#/login?next=%23%2Fdebug'; });
    await page.waitForFunction(() => location.hash.startsWith('#/debug'));
    await ready(page);
    check((await page.getAttribute('#app', 'data-route')) === 'debug', 'signed in, #/login?next=#/debug redirects to #/debug');
    await page.evaluate(() => { location.hash = '#/debug?items=0'; });
    await debugDone(page);
    const rows = await debugRows(page);
    check(rows.length === Object.keys(spec.expect.alice.collections).length && rows.every((r) => r.items === 0 && r.count > 0), '#/debug?items=0 counts items without opening any (deep-linkable state)', JSON.stringify(rows.map((r) => [r.href, r.count, r.items])));
    // the new routes are known to the router
    for (const [hash, , screen] of [['#/contacts', 'contacts', 'contacts-screen'], ['#/collections', 'collections', 'collections-screen'], ['#/calendar', 'calendar', 'calendar-screen'], ['#/tasks', 'tasks', 'tasks-screen'], ['#/events/new', 'event-new', 'event-form-screen'], ['#/tasks/new', 'task-new', 'task-form-screen'], ['#/contacts/groups', 'contact-groups', 'groups-screen'], ['#/collections/new-calendar', 'collection-new-calendar', 'collection-form-screen']]) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await ready(page);
      const r = await page.getAttribute('#app', 'data-route');
      check((await page.getByTestId(screen).count()) === 1, `${hash} opens its screen (${screen}, route ${r})`, r);
    }
    // an open redirect through next= is ignored
    await page.evaluate(() => { location.hash = '#/debug'; });
    await debugDone(page);
    await tid(page, 'debug-signout').click();
    await page.goto(UI + '#/login?next=https://evil.example.net/');
    await ready(page);
    await login(page, 'alice', spec.users.alice);
    check(page.url() === UI + '#/contacts', 'next=<foreign url> is ignored after login (lands on #/contacts)', page.url());
    await assertClean(page, watch, 'routes scenario');
  } finally { await ctx.close(); }
};

scenarios['dialog'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await page.goto(UI);
    await ready(page);
    await login(page, 'alice', spec.users.alice, { debug: true });
    await debugDone(page);
    const opener = tid(page, 'debug-dialog-test');
    await opener.focus();
    await opener.click();
    const dlg = page.locator('dialog[data-testid="debug-dialog"]');
    check((await dlg.count()) === 1 && (await dlg.evaluate((d) => d.open)), 'the blocking dialog opens as a modal');
    check((await dlg.getAttribute('aria-labelledby')) !== null && (await dlg.getAttribute('data-dismissible')) === 'false', 'dialog is labelled and marked non-dismissible');
    check(await page.evaluate(() => document.activeElement.dataset.testid) === 'debug-dialog-ack', 'focus moves into the dialog (the first field)');
    for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await sleep(150); }
    await sleep(300);
    check((await dlg.count()) === 1 && (await dlg.evaluate((d) => d.open)), 'Escape pressed TWICE does not close the blocking dialog');
    check((await page.locator('dialog[open]').count()) === 1, 'exactly one dialog is open after two Escape presses');
    await page.mouse.click(3, 3); // the backdrop
    await sleep(200);
    check((await dlg.count()) === 1 && (await dlg.evaluate((d) => d.open)), 'a click outside (backdrop) does not close it');
    await page.evaluate(() => { location.hash = '#/login'; });
    await sleep(400);
    check(await page.evaluate(() => location.hash) === '#/debug' && (await dlg.count()) === 1, 'navigating away is vetoed: the URL goes back to #/debug and the dialog stays');
    const confirm = tid(page, 'debug-dialog-confirm');
    check(await confirm.isDisabled(), 'the confirm button is disabled until the box is ticked');
    // Chromium's modal dialog makes the page behind it inert: Tab cycles through the dialog and the browser's
    // own UI (document.activeElement is then <body>); it must never land on a control behind the dialog.
    const stops = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => { const a = document.activeElement; const d = document.querySelector('dialog[open]'); return !a || a === document.body ? 'browser-ui' : d.contains(a) ? 'dialog:' + (a.dataset.testid || a.tagName) : 'BEHIND:' + (a.dataset.testid || a.tagName); }));
    }
    check(stops.every((x) => !x.startsWith('BEHIND')) && stops.some((x) => x.startsWith('dialog:')), 'Tab never reaches a control behind the dialog (the page is inert)', stops.join(' > '));
    await page.keyboard.press('Escape');
    await sleep(200);
    check((await dlg.count()) === 1, 'Escape while the box is still unticked: still open');
    await tid(page, 'debug-dialog-ack').check();
    check(!(await confirm.isDisabled()), 'ticking the box enables the confirm button');
    await page.keyboard.press('Escape');
    await sleep(200);
    check((await dlg.count()) === 1, 'Escape after ticking: STILL open until the explicit confirm');
    await shot(page, 'dialog-desktop-light-en');
    await confirm.click();
    await sleep(200);
    check((await page.locator('dialog').count()) === 0, 'the explicit confirm closes the dialog and removes it');
    check(await page.evaluate(() => document.activeElement.dataset.testid) === 'debug-dialog-test', 'focus returns to the button that opened the dialog');
    await page.evaluate(() => { location.hash = '#/login'; });
    await ready(page);
    check((await page.getAttribute('#app', 'data-route')) === 'contacts' && (await page.locator('dialog').count()) === 0, 'after the dialog is closed navigation is free again (signed in, #/login redirects to the landing route #/contacts)');
    await assertClean(page, watch, 'dialog scenario');
  } finally { await ctx.close(); }
};

scenarios['language-theme'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { scheme: 'light', lang: 'en' });
  try {
    await page.goto(UI);
    await ready(page);
    await tid(page, 'login-username').fill('typed-login');
    await tid(page, 'login-password').fill('typed-secret');
    await tid(page, 'login-stay').check();
    await tid(page, 'lang-select').selectOption('fr');
    await sleep(300);
    check((await tid(page, 'login-submit').textContent()).trim() === fr['login.submit'], 'switching to FR translates the form (no reload)');
    check(await tid(page, 'login-username').inputValue() === 'typed-login' && await tid(page, 'login-password').inputValue() === 'typed-secret' && await tid(page, 'login-stay').isChecked(), 'FR switch keeps the typed login, password and the stay box');
    check(await page.evaluate(() => document.documentElement.lang) === 'fr', 'html lang is now fr');
    await tid(page, 'lang-select').selectOption('en');
    await sleep(300);
    check(await tid(page, 'login-username').inputValue() === 'typed-login' && (await tid(page, 'login-submit').textContent()).trim() === en['login.submit'], 'FR to EN switch keeps the typed login too');
    // error state survives the language switch and is retranslated
    await tid(page, 'login-password').fill('wrong');
    await tid(page, 'login-submit').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="login-error"]')?.textContent.trim().length > 0);
    await tid(page, 'lang-select').selectOption('fr');
    await sleep(300);
    check((await tid(page, 'login-error').textContent()).trim() === fr['login.err.bad'], 'the visible error is retranslated when the language changes');
    await page.reload();
    await ready(page);
    check(await page.evaluate(() => document.documentElement.lang) === 'fr' && (await tid(page, 'lang-select').inputValue()) === 'fr', 'the language choice is remembered across a reload');
    // theme
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const attr = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check(await bg() === 'rgb(242, 242, 238)' && (await attr()) === null, 'theme auto + light OS: light tokens, no data-theme');
    await tid(page, 'theme-select').selectOption('dark');
    check(await bg() === 'rgb(22, 23, 22)' && (await attr()) === 'dark', 'theme "dark": dark tokens, data-theme=dark');
    await shot(page, 'login-theme-dark-forced-fr');
    await contrast(page, 'forced dark', { tokens: true });
    await tid(page, 'theme-select').selectOption('light');
    check(await bg() === 'rgb(242, 242, 238)' && (await attr()) === 'light', 'theme "light": light tokens, data-theme=light');
    await contrast(page, 'forced light', { tokens: true });
    await tid(page, 'theme-select').selectOption('dark');
    await page.reload();
    await ready(page);
    check(await bg() === 'rgb(22, 23, 22)', 'the theme choice survives a reload');
    await tid(page, 'theme-select').selectOption('auto');
    check((await attr()) === null && await bg() === 'rgb(242, 242, 238)', 'theme "auto" follows the (light) OS again');
    await page.emulateMedia({ colorScheme: 'dark' });
    check(await bg() === 'rgb(22, 23, 22)', 'theme "auto" follows a dark OS scheme live');
    await page.emulateMedia({ colorScheme: 'light' });
    await assertClean(page, watch, 'language and theme scenario');
  } finally { await ctx.close(); }
};

scenarios['keyboard'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await page.goto(UI);
    await ready(page);
    const focused = () => page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return 'body'; const cs = getComputedStyle(e); const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2; return `${e.dataset.testid || e.id || e.tagName}|${e.matches(':focus-visible') ? 'visible' : 'hidden'}|${ring ? 'ring' : 'noring'}`; });
    const first = await focused();
    check(first.startsWith('login-username'), 'on load the user name field has focus (login page)', first);
    await page.keyboard.type('alice');
    await page.keyboard.press('Tab');
    check((await focused()).startsWith('login-password'), 'Tab: user name -> password');
    await page.keyboard.type(spec.users.alice);
    await page.keyboard.press('Tab');
    check((await focused()).startsWith('login-stay'), 'Tab: password -> "Stay signed in"');
    await page.keyboard.press('Space');
    check(await tid(page, 'login-stay').isChecked(), 'Space toggles the checkbox');
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    const submit = await focused();
    check(submit.startsWith('login-submit') && submit.endsWith('visible|ring'), 'Tab: stay -> submit button, with a visible focus ring', submit);
    await page.keyboard.press('Shift+Tab');
    check((await focused()).startsWith('login-stay'), 'Shift+Tab goes back');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash.startsWith('#/contacts'), null, { timeout: 20000 });
    await ready(page);
    check(page.url() === UI + '#/contacts', 'keyboard only: Enter on the submit button signs in and lands on #/contacts');
    check(await page.evaluate(() => document.activeElement.id) === 'main', 'after login the focus is on the main region', await focused());
    // the whole Tab order on the diagnostics page, each stop with a visible ring
    const order = [];
    await page.goto(UI + '#/debug');
    await page.reload();
    await debugDone(page);
    for (let i = 0; i < 16; i++) { await page.keyboard.press('Tab'); order.push(await focused()); }
    const names = order.map((o) => o.split('|')[0]);
    info('tab order on #/debug: ' + names.join(' > '));
    // DOM order: header (brand, language, theme, Activity, sign-out), then the navigation, then the screen
    const want = ['skip-link', 'brand', 'lang-select', 'theme-select', 'activity-toggle', 'btn-sign-out', 'nav-calendar', 'nav-tasks', 'nav-contacts', 'nav-collections', 'nav-users', 'nav-settings', 'nav-debug', 'debug-refresh', 'debug-dialog-test', 'debug-signout'];
    check(want.every((n, i) => names[i] === n), 'Tab order on #/debug follows the visual order', names.slice(0, want.length).join(','));
    check(order.slice(0, want.length).every((o) => o.endsWith('visible|ring')), 'every Tab stop shows a focus ring', order.filter((o) => !o.endsWith('visible|ring')).join(','));
    // skip link
    await page.reload();
    await debugDone(page);
    await page.keyboard.press('Tab');
    check((await focused()).startsWith('skip-link'), 'first Tab stop is the skip link');
    await page.keyboard.press('Enter');
    check(await page.evaluate(() => document.activeElement.id) === 'main', 'the skip link moves focus to the main region');
    // activity panel by keyboard, focus handling
    await tid(page, 'activity-toggle').focus();
    await page.keyboard.press('Enter');
    check(await tid(page, 'activity-toggle').getAttribute('aria-expanded') === 'true' && await page.evaluate(() => document.activeElement.id) === 'activity-title', 'Enter on Activity opens the panel and moves focus to its title');
    await page.locator('#activity-close').focus();
    await page.keyboard.press('Enter');
    check(await tid(page, 'activity-toggle').getAttribute('aria-expanded') === 'false' && await page.evaluate(() => document.activeElement.dataset.testid) === 'activity-toggle', 'closing the panel returns focus to the Activity button');
    await assertClean(page, watch, 'keyboard scenario');
  } finally { await ctx.close(); }
};

scenarios['agent-account'] = async (browser) => {
  for (const lang of ['en', 'fr']) {
    const { ctx, page, watch } = await openPage(browser, { lang });
    try {
      await page.goto(UI);
      await ready(page);
      await login(page, 'agent-1', spec.users['agent-1'], { debug: true });
      await debugDone(page);
      await checkDebug(page, 'agent-1', lang, `agent-1 ${lang}`);
      const L = DICT[lang];
      check((await tid(page, 'debug-session-login').textContent()) === 'agent-1' && (await tid(page, 'debug-session-admin').textContent()) === L['common.no'] && (await tid(page, 'debug-session-type').textContent()) === L['account.type.bot'], `agent-1 session card: bot, not an administrator: ${lang}`);
      const summary = (await tid(page, 'debug-summary').textContent()).trim();
      const n = Object.keys(spec.expect['agent-1'].collections).length;
      check(summary.startsWith(`${n} `), `summary line counts ${n} collections: ${lang}`, summary);
      const ro = page.locator('[data-testid="debug-collection"][data-href="/bob/bob-cal/"] [data-writable]');
      check((await ro.getAttribute('data-writable')) === 'false' && (await ro.textContent()).trim() === L['debug.coll.access.ro'], `the read-only grant is shown as read only: ${lang}`);
      check((await page.locator('[data-testid="debug-collection"][data-href^="/alice/personal"]').count()) === 0, `an ungranted collection of the same owner is not listed: ${lang}`);
      await shot(page, `debug-agent-1-${lang}`);
      await assertClean(page, watch, `agent-1 ${lang}`);
    } finally { await ctx.close(); }
  }
};

scenarios['security-surface'] = async (browser) => {
  // what a script on the page can and cannot do against the stack (CSP, headers), from the browser's side
  const { ctx, page, watch } = await openPage(browser);
  try {
    await page.goto(UI);
    await ready(page);
    const res = await page.evaluate(async (base) => {
      const out = {};
      try { await fetch('http://127.0.0.1:1/x', { mode: 'no-cors' }); out.external = 'allowed'; } catch (e) { out.external = 'blocked'; }
      try { const r = await fetch(base + '/ui/api/accounts', { credentials: 'omit' }); out.anon = r.status; } catch (e) { out.anon = 'error'; }
      try { const r = await fetch(base + '/ui/api/accounts', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'text/plain' }, body: '{}' }); out.post = r.status; } catch (e) { out.post = 'error'; }
      try { const r = await fetch(base + '/ui/api/accounts', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', 'X-RadUI': '1' }, body: '{}' }); out.postJson = r.status; } catch (e) { out.postJson = 'error'; }
      out.inlineScript = await new Promise((resolve) => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.head.append(s); setTimeout(() => resolve(window.__inline === 1 ? 'ran' : 'blocked'), 100); });
      return out;
    }, BASE);
    check(res.external === 'blocked', 'CSP blocks a request to another origin from the page', JSON.stringify(res));
    check(res.inlineScript === 'blocked', 'CSP blocks an inline script injected into the page');
    check(res.anon === 401 && res.post === 400 && res.postJson === 401, 'admin API through nginx without credentials: GET 401; a text/plain POST without X-RadUI is refused 400; a well-formed POST 401', `${res.anon}/${res.post}/${res.postJson}`);
    await harvestCsp(page, watch);
    info(`CSP violations provoked on purpose: ${watch.csp.length}; console errors of that probe: ${watch.errors.length + watch.expected.length}`);
    watch.csp.length = 0; watch.errors.length = 0; watch.expected.length = 0; watch.external.length = 0;
    const hdrs = await page.evaluate(async (u) => { const r = await fetch(u); return Object.fromEntries(r.headers.entries()); }, UI);
    check(/default-src 'self'/.test(hdrs['content-security-policy'] || '') && hdrs['x-content-type-options'] === 'nosniff' && hdrs['x-frame-options'] === 'DENY', 'the app is served with the CSP, nosniff and X-Frame-Options headers');
    const cfg = await page.evaluate(async (u) => (await fetch(u + 'config.json')).json(), UI);
    check(cfg.apiBasePath === 'api/' && cfg.basePath === './', 'config.json is served next to index.html', JSON.stringify(cfg));
    await assertClean(page, watch, 'security-surface');
  } finally { await ctx.close(); }
};

scenarios['matrix'] = async (browser) => {
  const combos = FAST ? COMBOS.filter((c) => c.scheme === 'light') : COMBOS;
  for (const combo of combos) {
    console.log(`\n== matrix: ${combo.name}`);
    try { await matrixCombo(browser, combo); } catch (e) { check(false, `matrix ${combo.name} threw`, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
  }
};

// the per-address limiter of the backend, seen from the login screen (must run LAST: it blocks 127.0.0.1)
scenarios['rate-limit'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await page.goto(UI);
    await ready(page);
    const out = await page.evaluate(async (api) => {
      const codes = [];
      let last = null;
      for (let i = 0; i < 42; i++) {
        last = await fetch(api + 'me', { headers: { Authorization: 'Basic ' + btoa('alice:wrong-' + i) }, credentials: 'omit', cache: 'no-store' });
        codes.push(last.status);
      }
      return { codes, retry: last.headers.get('retry-after'), www: last.headers.get('www-authenticate') };
    }, UI + 'api/');
    const first = out.codes.indexOf(429);
    check(first > 0 && first <= 40 && out.codes.slice(0, first).every((c) => c === 401) && out.codes.slice(first).every((c) => c === 429), 'per-address limiter: wrong passwords answer 401 until the limit (40 failures in the run), then every request answers 429', `${first} x 401 here (+ ${40 - first} earlier in the run), then ${out.codes.length - first} x 429`);
    check(Number(out.retry) >= 1 && out.www === null, '429 carries Retry-After and no WWW-Authenticate', `retry-after ${out.retry}`);
    await tid(page, 'login-username').fill('alice');
    await tid(page, 'login-password').fill(spec.users.alice);
    await tid(page, 'login-submit').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="login-error"]')?.textContent.trim().length > 0);
    check((await tid(page, 'login-error').textContent()).trim() === en['login.err.rateLimited'] && (await tid(page, 'login-error').getAttribute('role')) === 'alert', 'the login screen explains the 429 in persistent alert text (even for the right password)');
    check(await page.evaluate(() => location.hash) === '#/login', 'and stays on the login screen');
    await shot(page, 'login-rate-limited-desktop-light-en');
    await assertClean(page, watch, 'rate-limit scenario');
  } finally { await ctx.close(); }
};
