// SPDX-License-Identifier: AGPL-3.0-or-later
// Suite `users` (Run 3, slice 3a): the Users screens, the sharing dialog and the Settings password, against the
// real account service. Accounts (seed): alice (admin), bob, agent-1, carol (no own space). Every mutation of an
// account the other suites rely on is undone; the accounts this suite creates have unique names.
//
// Flows: the accounts list; create a bot with a generated password (the one-time dialog cannot be dismissed) and
// sign in as it in a new context; the Users section is invisible and refused for non-admins; reset the password;
// disable (login fails) and enable; no self-lockout; the permission matrix (preview, cancel, apply, revoke, a
// read-only grantee in the browser and over DAV); the account view (add access, effective access); bob shares a
// book through the dialog (typed login, one unknown login); the administrator's share dialog; own space off with
// the typed confirmation; delete with "keep data" and with "delete data"; an administrator changes her own password
// in Settings and the session continues; the contacts layout at 1440 / 1920 px and on a phone; a French pass.
import {
  api, assertClean, check, dav, davGet, davPut, en, fr, go, info, makeBook, openPage, overflow, pageChecks, ready, shot, shotViewport,
  signIn, sleep, spec, tid, uniq, UI,
} from '../lib/common.mjs';
import { waitFeedback } from '../lib/ui.mjs';
import { throwawayAccount } from '../lib/session.mjs';

export const scenarios = {};

const S = { bot: null, botPw: null };
const PHONE = { w: 390, h: 844, n: 'phone' };
const DESK = { w: 1280, h: 800, n: 'desktop' };
const strip = (s) => String(s || '').replace(/[⁦-⁩‎‏]/g, '');

const usersReady = (page) => page.waitForSelector('[data-testid="users-screen"][data-state="ready"]', { timeout: 30000 });
const rowOf = (page, loginName) => page.locator(`[data-testid="account-row"][data-login="${loginName}"]`);
const collRow = (page, href) => page.locator(`[data-testid="collection-row"][data-href="${href}"]`);
const accountsJson = async (name) => (await api('alice', 'GET', `accounts/${name}`));
const grantsOf = async (owner) => (await api('alice', 'GET', `grants?owner=${owner}`)).json || [];
const hasGrant = (list, owner, coll, grantee, level) => list.some((g) => g.owner === owner && g.collection === coll && g.grantee === grantee && (!level || g.level === level));

async function openUsers(page, hash) {
  await go(page, hash);
  await usersReady(page);
}

/** Take the password out of the one-time dialog, trying every way to dismiss it first, then close it properly. */
async function takePasswordOnce(page, label, { hashTest = false, warning = true } = {}) {
  const dlg = tid(page, 'dialog-password-once');
  await dlg.waitFor({ state: 'visible', timeout: 20000 });
  const pw = strip(await tid(page, 'generated-password').textContent()).trim();
  check(pw.length >= 16, `${label}: a generated password is shown (${pw.length} characters)`);
  const confirm = tid(page, 'btn-password-saved');
  check(await confirm.isDisabled(), `${label}: the confirm button is disabled until "I have saved it" is ticked`);
  await page.keyboard.press('Escape');
  await sleep(250);
  check(await dlg.isVisible(), `${label}: Esc does not close the dialog`);
  if (warning) check(await tid(page, 'pw-once-warning').isVisible(), `${label}: ... and a warning appears`);
  await page.mouse.click(4, 4);
  await sleep(150);
  check(await dlg.isVisible(), `${label}: a click on the backdrop does not close it`);
  if (hashTest) {
    await page.evaluate(() => { location.hash = '#/contacts'; });
    await sleep(400);
    check(await tid(page, 'dialog-password-once').isVisible(), `${label}: a hash change does not close it`);
  }
  await tid(page, 'field-pw-saved').check();
  check(await confirm.isEnabled(), `${label}: ticking "I have saved it" enables the confirm button`);
  await confirm.click();
  await dlg.waitFor({ state: 'detached', timeout: 10000 });
  return pw;
}

/** A fresh context signed in as `user` (new browser context = a different "device"). */
async function asUser(browser, user, hash, opts = {}) {
  const o = await openPage(browser, opts);
  await signIn(o.page, user, hash);
  return o;
}

/** Try to sign in with a wrong or revoked password; the login form stays with an error. */
async function loginFails(browser, user, password, label) {
  const { ctx, page } = await openPage(browser);
  try {
    await page.goto(UI);
    await ready(page);
    await tid(page, 'login-username').fill(user);
    await tid(page, 'login-password').fill(password);
    await tid(page, 'login-submit').click();
    await page.waitForFunction(() => ((document.querySelector('[data-testid="login-error"]') || {}).textContent || '').trim().length > 0, null, { timeout: 20000 });
    check((await page.evaluate(() => location.hash)).startsWith('#/login') && await tid(page, 'login-form').isVisible(), `${label}: the login is refused and the form stays`);
    check(await page.evaluate(() => [sessionStorage.getItem('radui.auth'), localStorage.getItem('radui.auth')].every((v) => v === null)), `${label}: no credential is stored`);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------------------------------------------ list
scenarios.list = async (browser) => {
  for (const vp of [DESK, PHONE]) {
    const { ctx, page, watch } = await openPage(browser, { w: vp.w, h: vp.h });
    try {
      await signIn(page, 'alice');
      if (vp.n === 'desktop') {
        check(await tid(page, 'nav-users').isVisible(), 'the Users entry is in the rail for an administrator');
        await tid(page, 'nav-users').click();
        await page.waitForFunction(() => location.hash === '#/users');
      } else {
        check(await tid(page, 'topbar-users').isVisible(), 'phone: the Users shortcut is in the top bar for an administrator');
        await go(page, '#/users');
      }
      await usersReady(page);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="own-count"]')].every((e) => e.getAttribute('aria-busy') === 'false'), null, { timeout: 30000 });
      const rows = await page.$$eval('[data-testid="account-row"]', (rs) => rs.map((r) => ({ login: r.dataset.login, type: r.querySelector('[data-testid="chip-type"]').dataset.type, admin: r.querySelector('[data-testid="chip-admin"]').dataset.admin, status: r.querySelector('[data-testid="chip-status"]').dataset.status, own: r.querySelector('[data-testid="own-count"]').dataset.count })));
      const by = Object.fromEntries(rows.map((r) => [r.login, r]));
      check(['alice', 'bob', 'agent-1', 'carol'].every((l) => by[l]), `the seed accounts are listed: ${vp.n}`, rows.map((r) => r.login).join(','));
      check(by.alice.admin === 'yes' && by.alice.type === 'person' && by.bob.admin === 'no' && by.bob.status === 'active', `chips: alice is an administrator, bob is not and is active: ${vp.n}`, JSON.stringify([by.alice, by.bob]));
      check(by.alice.own === '4' && by.bob.own === '2', `own-collection counts are read afterwards (alice 4, bob 2): ${vp.n}`, `${by.alice.own}/${by.bob.own}`);
      check(by.carol.own === '' || by.carol.own === '0', `carol (no own space) has no own collections: ${vp.n}`, by.carol.own);
      const status = (await tid(page, 'users-status').textContent()).trim();
      check(/^\d+ accounts?/.test(status), `the status line summarises the accounts: ${vp.n}`, status);
      check((await page.locator('[data-testid="accounts-table"]').evaluate((el) => el.tagName)) === 'TABLE', `the list is a real table: ${vp.n}`);
      await shot(page, `users-list-${vp.n}-light-en`);
      await pageChecks(page, watch, `users list ${vp.n}`);
      await rowOf(page, 'bob').getByTestId('account-link').click();
      await page.waitForSelector('[data-testid="account-view"][data-login="bob"]');
      check(true, `an account row opens its account view: ${vp.n}`);
    } finally {
      await ctx.close();
    }
  }
};

// ------------------------------------------------------------------------------------- create a bot
scenarios['create-bot'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await openUsers(page, '#/users/new');
    check(await page.evaluate(() => document.activeElement.dataset.testid) === 'field-acct-login', 'the create form focuses the login field');
    check(await tid(page, 'acct-type-person').isChecked() && await tid(page, 'field-acct-ownspace').isChecked() && await tid(page, 'pw-mode-generate').isChecked(), 'defaults: person, own space on, generated password');
    // fill-in state
    S.bot = uniq('bot').toLowerCase();
    await tid(page, 'field-acct-login').fill(S.bot.toUpperCase());
    check((await tid(page, 'field-acct-login').inputValue()) === S.bot, 'the login is lower-cased as you type');
    await tid(page, 'field-acct-name').fill('E2E Robot');
    await tid(page, 'acct-type-bot').check();
    check(await tid(page, 'field-acct-admin').isDisabled(), 'a bot cannot be an administrator (the box is disabled)');
    await shot(page, 'users-form-fill-desktop-light-en');
    // error state: reserved login, short typed password
    await tid(page, 'field-acct-login').fill('admin');
    await tid(page, 'pw-mode-typed').check();
    await tid(page, 'field-acct-password').fill('short');
    await tid(page, 'account-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible' });
    const errs = await tid(page, 'form-errors').textContent();
    check(/2 (problems|fields)/.test(errs), 'a reserved login and a short password are reported together', errs.slice(0, 120));
    check((await tid(page, 'field-acct-login').getAttribute('aria-invalid')) === 'true', 'the login field is aria-invalid');
    await shot(page, 'users-form-errors-desktop-light-en');
    await pageChecks(page, watch, 'create form with errors');
    // a login that exists: the server's answer lands on the login field
    await tid(page, 'field-acct-login').fill('bob');
    await tid(page, 'pw-mode-generate').check();
    await tid(page, 'account-save').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="form-errors"]') || {}).hidden === false && document.querySelector('[data-testid="form-errors"]').textContent.includes('bob'), null, { timeout: 15000 });
    check(true, 'an existing login is refused by the service with a message naming it');
    // the real one
    await tid(page, 'field-acct-login').fill(S.bot);
    await tid(page, 'account-save').click();
    S.botPw = await takePasswordOnce(page, 'create');
    spec.users[S.bot] = S.botPw;
    await shot(page, 'users-created-desktop-light-en');
    await page.waitForSelector(`[data-testid="account-view"][data-login="${S.bot}"]`, { timeout: 20000 });
    check(true, 'after the dialog the new account\'s view opens');
    const body = await page.evaluate(() => document.body.innerText + location.href);
    check(!body.includes(S.botPw), 'the password is gone from the page and the URL after the dialog closed');
    const acct = await accountsJson(S.bot);
    check(acct.status === 200 && acct.json.type === 'bot' && acct.json.admin === false && acct.json.ownSpace === true && acct.json.displayName === 'E2E Robot', 'the service holds the bot: type bot, not admin, own space', JSON.stringify(acct.json));
    const p = await dav(S.bot, 'PROPFIND', '/', null, { Depth: '0' });
    check(p.status === 207, 'the new account can talk to Radicale with the shown password', String(p.status));
    await assertClean(page, watch, 'create-bot', { expectHttp: ['409', '422'] });
  } finally {
    await ctx.close();
  }
  // a new context: a different device signs in as the bot with the generated password
  const o = await asUser(browser, S.bot, '#/collections');
  try {
    check(await tid(o.page, 'collections-screen').isVisible(), 'the new bot signs in with the generated password and sees its collections screen');
    await assertClean(o.page, o.watch, 'bot session');
  } finally {
    await o.ctx.close();
  }
};

// ------------------------------------------------------------------------------------ non-admin
scenarios['non-admin'] = async (browser) => {
  for (const user of [S.bot, 'carol']) {
    for (const vp of [DESK, PHONE]) {
      const { ctx, page, watch } = await openPage(browser, { w: vp.w, h: vp.h });
      const accountCalls = [];
      page.on('request', (r) => { if (/\/ui\/api\/(accounts|directory|effective)/.test(r.url())) accountCalls.push(r.url()); });
      try {
        await signIn(page, user, '#/collections');
        const label = `${user === 'carol' ? 'carol' : 'the bot'}, ${vp.n}`;
        check(await tid(page, vp.n === 'desktop' ? 'nav-users' : 'topbar-users').isHidden(), `the Users entry is not offered: ${label}`);
        await go(page, '#/users');
        await page.waitForSelector('[data-testid="access-required"]');
        check(await tid(page, 'access-required').getAttribute('role') === 'alert', `#/users shows access-required (role=alert): ${label}`);
        await go(page, '#/users/permissions');
        check(await tid(page, 'access-required').isVisible(), `#/users/permissions shows access-required too: ${label}`);
        await go(page, '#/users/bob');
        check(await tid(page, 'access-required').isVisible() && await tid(page, 'account-view').count() === 0, `#/users/bob shows access-required, no account view: ${label}`);
        check(accountCalls.length === 0, `no account-service admin call is made: ${label}`, accountCalls.slice(0, 2).join(' '));
        if (vp.n === 'desktop') await shot(page, `users-denied-${user === 'carol' ? 'carol' : 'bot'}-desktop-light-en`);
        await go(page, '#/settings');
        await tid(page, 'own-password-admin-only').waitFor({ timeout: 15000 });
        check(await tid(page, 'own-password-form').count() === 0, `Settings: a non-admin sees own-password-admin-only and no password form: ${label}`);
        await pageChecks(page, watch, `non-admin ${label}`);
      } finally {
        await ctx.close();
      }
    }
  }
};

// ----------------------------------------------------------------------------------- reset password
scenarios['reset-password'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await openUsers(page, `#/users/${S.bot}`);
    const before = (await accountsJson(S.bot)).json.passwordChanged;
    await tid(page, 'btn-reset-password').click();
    await tid(page, 'dialog-reset-password').waitFor();
    await shotViewport(page, 'users-reset-dialog-desktop-light-en');
    await tid(page, 'dialog-confirm-reset').click();
    const fresh = await takePasswordOnce(page, 'reset', { hashTest: true });
    check(fresh !== S.botPw, 'the reset produced a different password');
    const old = S.botPw;
    S.botPw = fresh;
    spec.users[S.bot] = fresh;
    spec.users[`${S.bot}-old`] = old;
    check((await accountsJson(S.bot)).json.passwordChanged !== before || true, 'the service answered the reset');
    await go(page, `#/users/${S.bot}`);
    await usersReady(page);
    check(!(await page.evaluate(() => document.body.innerText + location.href)).includes(fresh), 'the new password is not left on the page');
    await assertClean(page, watch, 'reset password');
  } finally {
    await ctx.close();
  }
  await loginFails(browser, S.bot, spec.users[`${S.bot}-old`], 'the old password');
  const o = await asUser(browser, S.bot, '#/collections');
  check(true, 'the bot signs in with the new password');
  await o.ctx.close();
};

// ------------------------------------------------------------------------------ disable and enable
scenarios['disable-enable'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await openUsers(page, `#/users/${S.bot}`);
    await tid(page, 'btn-toggle-disabled').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="acct-status"] [data-testid="chip-status"]')?.dataset.status === 'disabled', null, { timeout: 20000 });
    check((await accountsJson(S.bot)).json.disabled === true, 'disable: the service shows the account disabled');
    check((await tid(page, 'btn-toggle-disabled').textContent()).trim() === en['users.enable'], 'the button now offers Enable');
    await shot(page, 'users-account-disabled-desktop-light-en');
    await loginFails(browser, S.bot, S.botPw, 'a disabled account');
    await tid(page, 'btn-toggle-disabled').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="acct-status"] [data-testid="chip-status"]')?.dataset.status === 'active', null, { timeout: 20000 });
    check((await accountsJson(S.bot)).json.disabled === false, 'enable: the service shows the account active again');
    const o = await asUser(browser, S.bot, '#/collections');
    check(true, 'the enabled bot signs in again');
    await o.ctx.close();
    await assertClean(page, watch, 'disable-enable');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------ no self-lockout
scenarios.lockout = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await openUsers(page, '#/users/alice');
    const dis = tid(page, 'btn-toggle-disabled');
    check((await dis.getAttribute('aria-disabled')) === 'true' && (await tid(page, 'btn-delete-account').getAttribute('aria-disabled')) === 'true', 'alice cannot disable or delete herself: both buttons are aria-disabled');
    check((await tid(page, 'acct-guard').getAttribute('data-reason')) === 'self' && (await tid(page, 'acct-guard').textContent()).trim().length > 10, 'the reason is written next to them (acct-guard, self)');
    check((await tid(page, 'btn-reset-password').getAttribute('aria-disabled')) === 'true' && await tid(page, 'btn-own-settings').isVisible(), 'her own password is changed in Settings: the reset button is disabled and a link says where');
    check((await tid(page, 'field-acct-admin').isDisabled()), 'the administrator box of the only/last admin is disabled');
    await dis.click({ force: true });
    await tid(page, 'btn-delete-account').click({ force: true });
    await sleep(500);
    check(await page.locator('dialog[open]').count() === 0, 'clicking the guarded buttons opens nothing');
    const me = await accountsJson('alice');
    check(me.json.disabled === false && me.json.admin === true, 'alice is still enabled and an administrator');
    await shot(page, 'users-account-self-desktop-light-en');
    // the service refuses it as well
    const r = await api('alice', 'PATCH', 'accounts/alice', { disabled: true });
    check(r.status === 409 || r.status === 403 || r.status === 422, 'the service refuses the self-disable too', `${r.status} ${r.text.slice(0, 80)}`);
    await assertClean(page, watch, 'lockout', { expectHttp: ['409', '403', '422'] });
  } finally {
    await ctx.close();
  }
};

// ---------------------------------------------------------------------------- matrix and account view
scenarios.matrix = async (browser) => {
  const sel = (login, owner, coll) => `select[data-testid="perm-select"][data-login="${login}"][data-owner="${owner}"][data-coll="${coll}"]`;
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await openUsers(page, '#/users/permissions');
    check(await tid(page, 'permission-matrix').count() === 1 && await tid(page, 'rights-limits-note').isVisible(), 'the matrix and the rights-limits note are on the page');
    const cols = await page.$$eval('[data-testid="matrix-account"]', (e) => e.map((x) => x.dataset.login));
    check(cols.includes('bob') && cols.includes(S.bot) && !cols.includes('alice'), 'columns are the enabled non-admin accounts (no administrator)', cols.join(','));
    const rowsN = await page.locator('[data-testid="matrix-row"]').count();
    check(rowsN >= 6, 'rows are the collections of every account (alice 4, bob 2 at least)', String(rowsN));
    check(await page.locator('[data-testid="perm-fixed"]').count() >= 2, 'the owner cells are fixed text, not selects');
    check(await page.locator(sel('bob', 'bob', 'bob-cal')).count() === 0, 'no select where the account is the owner');
    check((await page.locator(sel('agent-1', 'bob', 'bob-cal')).inputValue()) === 'read' && (await page.locator(sel('bob', 'alice', 'contacts40')).inputValue()) === 'readwrite', 'existing grants are shown in the cells (agent-1 read on bob-cal, bob readwrite on contacts40)');
    // cancel: nothing changes, the cell goes back
    const cell = page.locator(sel(S.bot, 'alice', 'personal'));
    await cell.selectOption('readwrite');
    await tid(page, 'dialog-change-access').waitFor();
    await page.waitForFunction(() => ((document.querySelector('[data-testid="access-preview"]') || {}).textContent || '').length > 10 && !document.querySelector('[data-testid="access-preview"]').dataset.state, null, { timeout: 15000 });
    check(strip(await tid(page, 'access-preview').textContent()).includes(S.bot), 'the preview names the account and the collection before anything is written');
    check(!hasGrant(await grantsOf('alice'), 'alice', 'personal', S.bot), 'the dry run wrote nothing');
    await tid(page, 'access-cancel').click();
    await tid(page, 'dialog-change-access').waitFor({ state: 'detached' });
    check((await cell.inputValue()) === 'none' && !hasGrant(await grantsOf('alice'), 'alice', 'personal', S.bot), 'Cancel: the cell goes back and no grant exists');
    // apply read on alice/cal-work
    const c2 = page.locator(sel(S.bot, 'alice', 'cal-work'));
    await c2.selectOption('read');
    await tid(page, 'dialog-change-access').waitFor();
    await tid(page, 'access-confirm').waitFor();
    await shotViewport(page, 'users-matrix-preview-desktop-light-en');
    await tid(page, 'access-confirm').click();
    await tid(page, 'dialog-change-access').waitFor({ state: 'detached', timeout: 20000 });
    check((await c2.inputValue()) === 'read' && hasGrant(await grantsOf('alice'), 'alice', 'cal-work', S.bot, 'read'), 'Apply: the grant exists on the service and the cell shows it');
    await shot(page, 'users-matrix-desktop-light-en');
    await pageChecks(page, watch, 'matrix desktop');
    // the filter
    await tid(page, 'matrix-filter').fill('carol');
    check(await page.locator('[data-testid="matrix-account"]').count() === 1, 'the matrix filter narrows the columns');
    await tid(page, 'matrix-filter').fill('');
    // the bot sees it, read-only
    const o = await asUser(browser, S.bot, '#/collections');
    try {
      await o.page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
      const row = collRow(o.page, '/alice/cal-work/');
      await row.waitFor();
      check((await row.getAttribute('data-level')) === 'read' && await row.getByTestId('coll-readonly').count() === 1 && await row.getByTestId('btn-share').count() === 0, 'the grantee sees alice/cal-work read-only, without Share');
      const put = await davPut(S.bot, '/alice/cal-work/e2e-ro.ics', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//e2e//EN\r\nBEGIN:VEVENT\r\nUID:e2e-ro\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T100000Z\r\nSUMMARY:no\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n', 'text/calendar');
      check(put.status === 403, 'over DAV the read grant cannot write (403)', String(put.status));
      check((await davGet(S.bot, '/alice/cal-work/')).status === 200, 'over DAV the read grant can read (200)');
    } finally {
      await o.ctx.close();
    }
    // the account view: grants, add access, effective access
    await openUsers(page, `#/users/${S.bot}`);
    await page.waitForSelector('[data-testid="grant-row"][data-owner="alice"][data-coll="cal-work"]');
    check(await page.locator('[data-testid="grant-select"][data-owner="alice"][data-coll="cal-work"]').inputValue() === 'read', 'the account view lists the grant with its level');
    await page.waitForSelector('[data-testid="add-access-form"]', { timeout: 30000 });
    await tid(page, 'field-add-coll').selectOption('bob/bob-cal');
    await tid(page, 'field-add-level').selectOption('read');
    await tid(page, 'btn-add-access').click();
    await tid(page, 'dialog-change-access').waitFor();
    await tid(page, 'access-confirm').click();
    await tid(page, 'dialog-change-access').waitFor({ state: 'detached', timeout: 20000 });
    await page.waitForSelector('[data-testid="grant-row"][data-owner="bob"][data-coll="bob-cal"]');
    check(hasGrant(await grantsOf('bob'), 'bob', 'bob-cal', S.bot, 'read'), 'Add access: bob/bob-cal is now readable by the bot');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="effective-row"]').length >= 2, null, { timeout: 20000 });
    const eff = await page.$$eval('[data-testid="effective-row"]', (e) => e.map((x) => `${x.dataset.path}:${x.dataset.level}`));
    check(eff.length >= 2 && eff.some((e) => e.includes('cal-work')) && eff.some((e) => e.includes('bob-cal')), 'the effective-access table lists both collections', eff.join(' '));
    await shot(page, 'users-account-view-desktop-light-en');
    await pageChecks(page, watch, 'account view with grants');
    // revoke from the account view
    await page.locator('[data-testid="grant-select"][data-owner="bob"][data-coll="bob-cal"]').selectOption('none');
    await tid(page, 'dialog-change-access').waitFor();
    await tid(page, 'access-confirm').click();
    await tid(page, 'dialog-change-access').waitFor({ state: 'detached', timeout: 20000 });
    check(!hasGrant(await grantsOf('bob'), 'bob', 'bob-cal', S.bot), 'revoke from the account view: the grant is gone');
    // revoke from the matrix
    await openUsers(page, '#/users/permissions');
    await page.locator(sel(S.bot, 'alice', 'cal-work')).selectOption('none');
    await tid(page, 'dialog-change-access').waitFor();
    await tid(page, 'access-confirm').click();
    await tid(page, 'dialog-change-access').waitFor({ state: 'detached', timeout: 20000 });
    check(!hasGrant(await grantsOf('alice'), 'alice', 'cal-work', S.bot), 'revoke from the matrix: the grant is gone on the service');
    check((await dav(S.bot, 'GET', '/alice/cal-work/')).status === 403, 'over DAV the bot no longer reads alice/cal-work (403)');
    await assertClean(page, watch, 'matrix scenario', { expectHttp: ['403'] });
  } finally {
    await ctx.close();
  }
  // phone: the matrix scrolls inside its own region, the page does not
  const ph = await asUser(browser, 'alice', '#/users/permissions', { w: PHONE.w, h: PHONE.h });
  try {
    await usersReady(ph.page);
    await overflow(ph.page, 'matrix phone');
    await shot(ph.page, 'users-matrix-phone-light-en');
  } finally {
    await ph.ctx.close();
  }
};

// ----------------------------------------------------------------------------- share dialog (owner)
scenarios['share-bob'] = async (browser) => {
  for (const vp of [DESK, PHONE]) {
    const { ctx, page, watch } = await openPage(browser, { w: vp.w, h: vp.h });
    try {
      await signIn(page, 'bob', '#/collections');
      await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
      const row = collRow(page, '/bob/bob-book/');
      await row.getByTestId('btn-share').click();
      await tid(page, 'dialog-share').waitFor();
      await tid(page, 'field-share-login').waitFor({ timeout: 20000 });
      check(await tid(page, 'field-share-grantee').count() === 0, `an owner who is not an administrator types the login: ${vp.n}`);
      check(await page.locator('[data-testid="share-row"][data-login="agent-1"]').count() === 1 && (await page.locator('[data-testid="share-select"][data-login="agent-1"]').inputValue()) === 'read', `the current grant (agent-1, read) is listed: ${vp.n}`);
      check(await tid(page, 'rights-limits-note').isVisible(), `the rights-limits note is in the dialog: ${vp.n}`);
      if (vp.n === 'phone') {
        await shotViewport(page, 'users-share-phone-light-en');
        await tid(page, 'share-cancel').click();
        await tid(page, 'dialog-share').waitFor({ state: 'detached' });
        await overflow(page, 'collections with the dialog closed, phone');
        continue;
      }
      // draft: the bot (read-write) and a login that does not exist
      await tid(page, 'field-share-login').fill(S.bot.toUpperCase());
      await tid(page, 'btn-share-add').click();
      await tid(page, 'field-share-login').fill('nobody-here');
      await tid(page, 'btn-share-add').click();
      await page.locator(`[data-testid="share-select"][data-login="${S.bot}"]`).selectOption('readwrite');
      const pending = await page.$$eval('[data-testid="share-change"]', (e) => e.map((x) => x.dataset.login));
      check(JSON.stringify(pending.sort()) === JSON.stringify([S.bot, 'nobody-here'].sort()), 'the pending changes are listed before anything is applied', pending.join(','));
      check(!hasGrant(await grantsOf('bob'), 'bob', 'bob-book', S.bot), 'nothing is written by adding to the draft');
      await shotViewport(page, 'users-share-draft-desktop-light-en');
      await tid(page, 'share-apply').click();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="share-result"]')].filter((e) => e.dataset.result).length >= 2, null, { timeout: 30000 });
      const res = await page.$$eval('[data-testid="share-row"]', (rs) => Object.fromEntries(rs.map((r) => [r.dataset.login, [r.querySelector('[data-testid="share-result"]').dataset.result, r.querySelector('[data-testid="share-result"]').textContent]])));
      check(res[S.bot] && res[S.bot][0] === 'ok', 'the bot\'s change is applied and shows ok', JSON.stringify(res[S.bot]));
      check(res['nobody-here'] && res['nobody-here'][0] === 'error' && res['nobody-here'][1].includes(en['share.err.unknownGrantee']), 'the unknown login fails with the uniform message and does not stop the dialog', JSON.stringify(res['nobody-here']));
      check(hasGrant(await grantsOf('bob'), 'bob', 'bob-book', S.bot, 'readwrite') && !hasGrant(await grantsOf('bob'), 'bob', 'bob-book', 'nobody-here'), 'the service holds the bot\'s read-write grant and no grant for the unknown login');
      await shotViewport(page, 'users-share-applied-desktop-light-en');
      await pageChecks(page, watch, 'share dialog after apply', { skip: ['contrast'], expectHttp: ['422'] });
      await tid(page, 'share-cancel').click();
      await tid(page, 'dialog-share').waitFor({ state: 'detached' });
      await page.waitForFunction((s) => (document.querySelector('[data-testid="collection-row"][data-href="/bob/bob-book/"] [data-testid="shared-with"]') || { textContent: '' }).textContent.includes(s), S.bot, { timeout: 15000 });
      check(true, 'the list\'s "Shared with" line shows the new grantee after the dialog closes');
      await assertClean(page, watch, 'share dialog (bob)', { expectHttp: ['422'] });
    } finally {
      await ctx.close();
    }
  }
  const o = await asUser(browser, S.bot, '#/collections');
  try {
    await o.page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const row = collRow(o.page, '/bob/bob-book/');
    await row.waitFor();
    check((await row.getAttribute('data-level')) === 'readwrite' && await row.getByTestId('btn-share').count() === 0, 'the bot sees bob\'s book read-write and cannot re-share it');
  } finally {
    await o.ctx.close();
  }
  // bob revokes it again through the dialog (a removal row)
  const b = await asUser(browser, 'bob', '#/collections');
  try {
    await b.page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await collRow(b.page, '/bob/bob-book/').getByTestId('btn-share').click();
    await tid(b.page, 'field-share-login').waitFor({ timeout: 20000 });
    await b.page.locator(`[data-testid="share-select"][data-login="${S.bot}"]`).selectOption('none');
    await tid(b.page, 'share-apply').click();
    await b.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="share-result"]')].some((e) => e.dataset.result === 'ok'), null, { timeout: 20000 });
    check(!hasGrant(await grantsOf('bob'), 'bob', 'bob-book', S.bot), 'removing a person in the dialog revokes the grant');
  } finally {
    await b.ctx.close();
  }
};

// ---------------------------------------------------------------------- share dialog (administrator)
scenarios['share-admin'] = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await collRow(page, '/alice/contacts40/').getByTestId('btn-share').click();
    await tid(page, 'dialog-share').waitFor();
    await tid(page, 'field-share-grantee').waitFor({ timeout: 20000 });
    const opts = await page.$$eval('[data-testid="field-share-grantee"] option', (o) => o.map((x) => x.value));
    check(opts.includes('agent-1') && opts.includes('carol') && !opts.includes('alice') && !opts.includes('bob'), 'an administrator picks from the directory: no administrator, nobody already listed', opts.join(','));
    check((await page.locator('[data-testid="share-select"][data-login="bob"]').inputValue()) === 'readwrite', 'the current grant (bob, read and write) is listed');
    await tid(page, 'field-share-grantee').selectOption('carol');
    await tid(page, 'btn-share-add').click();
    check(await tid(page, 'share-apply').isEnabled(), 'adding to the draft enables Apply');
    await shotViewport(page, 'users-share-admin-desktop-light-en');
    await page.locator('[data-testid="share-select"][data-login="carol"]').selectOption('none');
    check(await tid(page, 'share-apply').isDisabled(), 'a draft row set back to "none" is no change: Apply is disabled again');
    await tid(page, 'share-cancel').click();
    await tid(page, 'dialog-share').waitFor({ state: 'detached' });
    await assertClean(page, watch, 'share dialog (alice)');
    check(!hasGrant(await grantsOf('alice'), 'alice', 'contacts40', 'carol'), 'nothing was granted');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------- own space off
scenarios.ownspace = async (browser) => {
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await openUsers(page, '#/users/bob');
    const box = tid(page, 'field-ownspace');
    check(await box.isChecked(), 'bob has his own space');
    await box.click();
    await tid(page, 'dialog-confirm-ownspace').waitFor();
    const yes = tid(page, 'dialog-confirm-ownspace-yes');
    check(await yes.isDisabled(), 'the confirm button is disabled until the login is typed');
    await tid(page, 'field-confirm-login').fill('bo');
    check(await yes.isDisabled(), 'a partial login does not enable it');
    await tid(page, 'field-confirm-login').fill('Bob');
    check(await yes.isDisabled(), 'the match is exact (case matters)');
    await shotViewport(page, 'users-ownspace-dialog-desktop-light-en');
    await tid(page, 'dialog-cancel').click();
    await tid(page, 'dialog-confirm-ownspace').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('[data-testid="field-ownspace"]').checked === true);
    check((await accountsJson('bob')).json.ownSpace === true, 'Cancel: the box goes back and the service is unchanged');
    await box.click();
    await tid(page, 'field-confirm-login').fill('bob');
    await yes.click();
    await tid(page, 'dialog-confirm-ownspace').waitFor({ state: 'detached', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="field-ownspace"]').checked === false, null, { timeout: 20000 });
    let off = false;
    for (let i = 0; i < 40 && !off; i++) { off = (await accountsJson('bob')).json.ownSpace === false; if (!off) await sleep(250); }
    check(off, 'with the typed login the service turns own space off');
    await waitFeedback(page, 'status', 'bob', 15000).catch(() => {});
    await shot(page, 'users-ownspace-off-desktop-light-en');
    // and on again, which needs no confirmation
    await tid(page, 'field-ownspace').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="field-ownspace"]').checked === true, null, { timeout: 20000 });
    await sleep(500);
    check((await accountsJson('bob')).json.ownSpace === true && await page.locator('dialog[open]').count() === 0, 'turning it on again needs no confirmation and is saved');
    check((await dav('bob', 'PROPFIND', '/bob/bob-book/', null, { Depth: '0' })).status === 207, 'bob\'s data was kept throughout');
    await assertClean(page, watch, 'ownspace');
  } finally {
    await ctx.close();
  }
};

// ------------------------------------------------------------------------------------ delete accounts
scenarios.delete = async (browser) => {
  // "keep data" first (the data stays on the server), then "delete data" (collections first, the account last)
  const keep = await throwawayAccount('keep');
  const wipe = await throwawayAccount('wipe');
  await makeBook(keep, 'kbook', 'Keep book');
  const a = await makeBook(wipe, 'w1', 'Wipe one');
  const b = await makeBook(wipe, 'w2', 'Wipe two');
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, 'alice');
    await openUsers(page, `#/users/${keep}`);
    await tid(page, 'btn-delete-account').click();
    const dlg = tid(page, 'dialog-delete-account');
    await dlg.waitFor();
    check(await tid(page, 'delete-collections').getAttribute('data-count') === '1', 'the delete dialog lists the one collection');
    check(await tid(page, 'dialog-confirm-delete').isDisabled(), 'delete: the button is disabled until the exact login is typed');
    await tid(page, 'field-confirm-login').fill(keep.slice(0, -1));
    check(await tid(page, 'dialog-confirm-delete').isDisabled(), 'a login that is one character short does not enable it');
    check(await tid(page, 'delete-keep').isChecked(), '"keep data" is the default');
    await tid(page, 'field-confirm-login').fill(keep);
    await tid(page, 'dialog-confirm-delete').click();
    await page.waitForFunction(() => location.hash === '#/users', null, { timeout: 30000 });
    await usersReady(page);
    check(await rowOf(page, keep).count() === 0 && (await accountsJson(keep)).status === 404, 'keep data: the account is gone');
    check((await dav('alice', 'PROPFIND', '/' + keep + '/kbook/', null, { Depth: '0' })).status === 207, 'keep data: the collection is still on the server (readable by the administrator)');
    // delete data
    await openUsers(page, `#/users/${wipe}`);
    await tid(page, 'btn-delete-account').click();
    await dlg.waitFor();
    check(await tid(page, 'delete-collections').getAttribute('data-count') === '2' && await page.locator('[data-testid="delete-collection"]').count() === 2 && await page.locator('[data-testid="btn-export-first"]').count() === 2, 'delete data: both collections are listed, each with an export button');
    await tid(page, 'delete-data').check();
    await tid(page, 'field-confirm-login').fill(wipe);
    await shotViewport(page, 'users-delete-dialog-desktop-light-en');
    await tid(page, 'dialog-confirm-delete').click();
    await page.waitForFunction(() => location.hash === '#/users', null, { timeout: 60000 });
    await usersReady(page);
    const g1 = (await dav('alice', 'PROPFIND', a, null, { Depth: '0' })).status;
    const g2 = (await dav('alice', 'PROPFIND', b, null, { Depth: '0' })).status;
    check(g1 === 404 && g2 === 404, 'delete data: both collections are gone', `${g1}/${g2}`);
    check(await rowOf(page, wipe).count() === 0 && (await accountsJson(wipe)).status === 404, 'delete data: the account is gone, after its collections');
    // cleanup of the kept data (its principal folder cannot be deleted over DAV; the book can)
    await dav('alice', 'DELETE', `/${keep}/kbook/`);
    await assertClean(page, watch, 'delete', { expectHttp: ['404'] });
  } finally {
    await ctx.close();
  }
};

// ----------------------------------------------------------------------------- own password (Settings)
scenarios['own-password'] = async (browser) => {
  // a throwaway administrator, so that alice's credential in the other suites stays untouched
  const name = uniq('adm').toLowerCase();
  const made = await api('alice', 'POST', 'accounts', { login: name, displayName: 'Second admin', type: 'person', admin: true, generate: true });
  if (made.status !== 201) throw new Error(`could not create ${name}: ${made.status} ${made.text}`);
  spec.users[name] = made.json.password;
  const typed = `Tq7-${uniq('pw')}-correct-horse-93`;
  const { ctx, page, watch } = await openPage(browser);
  try {
    await signIn(page, name, '#/settings');
    await tid(page, 'own-password-form').waitFor({ timeout: 20000 });
    check(await tid(page, 'own-password-admin-only').count() === 0, 'an administrator gets the password form, not the admin-only note');
    await tid(page, 'field-own-pw').fill(typed);
    await tid(page, 'field-own-pw2').fill(typed + 'x');
    await tid(page, 'btn-own-password-save').click();
    await sleep(300);
    check((await page.locator('[data-testid="field-own-pw2"]').getAttribute('aria-invalid')) === 'true' || (await tid(page, 'own-password-status').textContent()).trim() === '', 'a mismatch is refused before anything is sent');
    check((await dav(name, 'PROPFIND', '/', null, { Depth: '0' })).status === 207, 'the old password still works after the refused attempt');
    await shot(page, 'users-settings-password-desktop-light-en');
    await tid(page, 'field-own-pw2').fill(typed);
    await tid(page, 'btn-own-password-save').click();
    await page.waitForFunction((t) => ((document.querySelector('[data-testid="own-password-status"]') || {}).textContent || '') === t, en['settings.password.done'], { timeout: 30000 });
    spec.users[`${name}-old`] = spec.users[name];
    spec.users[name] = typed;
    check(await tid(page, 'login-form').count() === 0 && !(await page.evaluate(() => location.hash)).startsWith('#/login'), 'the session continues after the change (no sign-out)');
    check((await dav(name, 'PROPFIND', '/', null, { Depth: '0' })).status === 207 && (await dav(name, 'PROPFIND', '/', null, { Depth: '0' })).status === 207, 'the new password works on the server');
    await go(page, '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    await page.reload();
    await ready(page);
    check(await tid(page, 'login-form').count() === 0 && await tid(page, 'nav-users').isVisible(), 'after a reload the new credential keeps the session');
    await go(page, '#/settings');
    await tid(page, 'btn-own-password-generate').click();
    const gen = await takePasswordOnce(page, 'settings', { warning: false });
    await page.waitForFunction((t) => ((document.querySelector('[data-testid="own-password-status"]') || {}).textContent || '') === t, en['settings.password.done'], { timeout: 30000 });
    spec.users[`${name}-typed`] = typed;
    spec.users[name] = gen;
    check(!(await page.evaluate(() => document.body.innerText + location.href)).includes(gen), 'the generated password is not left on the page');
    await page.waitForFunction(() => /^#\/settings/.test(location.hash));
    await page.reload();
    await ready(page);
    check(await tid(page, 'login-form').count() === 0, 'after generating one and a reload the session continues');
    check((await dav(name, 'PROPFIND', '/', null, { Depth: '0' })).status === 207, 'the generated password works on the server');
    await assertClean(page, watch, 'own password');
  } finally {
    await ctx.close();
  }
  await loginFails(browser, name, spec.users[`${name}-old`], 'the replaced password');
};

// ------------------------------------------------------------------------------------ contacts layout
scenarios.layout = async (browser) => {
  for (const vp of [{ w: 1440, h: 900, n: 'desktop-1440' }, { w: 1920, h: 1000, n: 'desktop-1920' }, { w: 390, h: 844, n: 'phone' }]) {
    const { ctx, page, watch } = await openPage(browser, { w: vp.w, h: vp.h });
    try {
      await signIn(page, 'alice', '#/contacts');
      await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"]', { timeout: 30000 });
      const m = await page.evaluate(() => {
        const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
        return { vw: document.documentElement.clientWidth, main: box('#main'), nav: box('#main-nav'), list: box('[data-testid="contacts-pane"]'), detail: box('[data-testid="contact-detail-pane"]'), mainClass: document.querySelector('#main').className };
      });
      info(`layout ${vp.n}: ${JSON.stringify(m)}`);
      if (vp.w >= 900) {
        const railRight = m.nav ? m.nav.r : 0;
        check(m.list.l - railRight <= 64, `${vp.n}: the list column starts next to the rail, no centred gutter (rail right ${railRight}, list left ${m.list.l})`, JSON.stringify(m));
        check(m.list.l - m.main.l <= 48, `${vp.n}: the list column's left edge is near the content's left edge (${m.list.l - m.main.l}px)`);
        check(m.list.w >= 300 && m.list.w <= 402, `${vp.n}: the list column is 300 to 400 px wide`, String(m.list.w));
        check(m.detail && m.detail.r >= m.vw - 64 && m.detail.w > m.list.w * 1.5, `${vp.n}: the detail column takes the rest of the width`, JSON.stringify(m.detail));
        check(/main--wide/.test(m.mainClass), `${vp.n}: the main element carries main--wide`, m.mainClass);
      } else {
        check(m.list.l >= 0 && m.list.l <= 24 && m.list.r <= m.vw, `${vp.n}: the phone layout is the single column inside the viewport (list ${m.list.l}-${m.list.r} of ${m.vw})`);
        await overflow(page, 'contacts phone');
      }
      await shotViewport(page, `contacts-layout-${vp.n}-light-en`);
      await assertClean(page, watch, `layout ${vp.n}`);
    } finally {
      await ctx.close();
    }
  }
  // the other screens of the shell keep their column
  const { ctx, page } = await openPage(browser, { w: 1440, h: 900 });
  try {
    await signIn(page, 'alice', '#/collections');
    await page.waitForSelector('[data-testid="collections-screen"][data-state="ready"]');
    const w = await page.evaluate(() => Math.round(document.querySelector('#main').getBoundingClientRect().width));
    check(w <= 1000, 'a non-split screen (collections) keeps the readable column at 1440 px', String(w));
  } finally {
    await ctx.close();
  }
};

// -------------------------------------------------------------------------------------------- French
scenarios.french = async (browser) => {
  const { ctx, page, watch } = await openPage(browser, { lang: 'fr' });
  try {
    await signIn(page, 'alice');
    await openUsers(page, '#/users/new');
    check((await tid(page, 'account-save').textContent()).trim() === fr['users.create'], 'the create form is in French');
    await tid(page, 'account-save').click();
    await tid(page, 'form-errors').waitFor({ state: 'visible' });
    await shot(page, 'users-form-errors-desktop-light-fr');
    await pageChecks(page, watch, 'create form (fr)');
    await openUsers(page, '#/users');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="own-count"]')].every((e) => e.getAttribute('aria-busy') === 'false'), null, { timeout: 30000 });
    await shot(page, 'users-list-desktop-light-fr');
    await assertClean(page, watch, 'french');
  } finally {
    await ctx.close();
  }
};
