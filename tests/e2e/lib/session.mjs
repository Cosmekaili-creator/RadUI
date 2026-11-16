// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers for the "the session ends while a dialog is open" scenarios (review M1): a throwaway account whose password
// the admin resets behind the page's back (the next request is a 401), and a second tab that signs out (the first
// tab hears about it through the storage event).
import { api, check, dav, login, openPage, ready, shot, sleep, spec, tid, UI, uniq, assertClean } from './common.mjs';

/** A person account of its own (so that revoking it disturbs nobody else). Known to spec.users, so the log check covers its password. */
export async function throwawayAccount(prefix = 'eve') {
  const name = uniq(prefix).replace(/[^a-z0-9-]/g, '').slice(0, 24).toLowerCase();
  const r = await api('alice', 'POST', 'accounts', { login: name, displayName: name, type: 'person', generate: true });
  if (r.status !== 201) throw new Error(`could not create ${name}: ${r.status} ${r.text}`);
  spec.users[name] = r.json.password;
  const p = await dav(name, 'PROPFIND', '/', null, { Depth: '0' });
  if (p.status !== 207) throw new Error(`principal of ${name}: ${p.status}`);
  return name;
}

/** The admin sets a new password: the credential in the browser is wrong from now on. */
export async function revokePassword(name) {
  const r = await api('alice', 'POST', `accounts/${name}/password`, { generate: true });
  if (r.status !== 200) throw new Error(`reset of ${name}: ${r.status} ${r.text}`);
  spec.users[`${name}-new`] = r.json.password;
}

/** Requests of the page that are not the static application files (DAV and account service). */
export function dataRequests(page) {
  const log = [];
  page.on('request', (r) => {
    let u;
    try { u = new URL(r.url()); } catch { return; }
    if (u.host !== `${spec.host}:${spec.port}`) return;
    if (u.pathname.startsWith('/ui/') && !u.pathname.startsWith('/ui/api/')) return;
    log.push(`${r.method()} ${u.pathname}`);
  });
  return log;
}

/**
 * Run one case.
 * @param {object} o
 * @param {'password'|'tab'} o.way
 * @param {(user: string) => Promise<object>} o.prepare creates the data through DAV, returns what open() needs
 * @param {(page, data) => Promise<void>} o.open signs in nothing: it only opens the dialog on the signed-in page
 * @param {(page, data) => Promise<void>} o.trigger (password way) the user action that makes a request after the reset
 * @param {string} o.dialog test id of the dialog
 * @param {string} o.label
 */
export async function sessionEndCase(browser, { way, prepare, open, trigger, dialog, label }) {
  const user = way === 'password' ? await throwawayAccount() : 'alice';
  const data = await prepare(user);
  const { ctx, page, watch } = await openPage(browser);
  try {
    await page.goto(UI);
    await ready(page);
    await login(page, user, spec.users[user], { stay: way === 'tab' });
    await open(page, data);
    await tid(page, dialog).waitFor({ timeout: 20000 });
    const log = dataRequests(page);
    if (way === 'password') {
      await revokePassword(user);
      await trigger(page, data);
    } else {
      const other = await ctx.newPage();
      await other.goto(UI);
      await ready(other);
      await tid(other, 'btn-sign-out').click();
      await other.getByTestId('login-form').waitFor();
    }
    await page.getByTestId('login-form').waitFor({ timeout: 20000 });
    check((await page.locator('dialog[open]').count()) === 0 && (await page.getByTestId(dialog).count()) === 0, `${label}: the open dialog is closed when the session ends`);
    check((await page.evaluate(() => location.hash)).startsWith('#/login'), `${label}: the login screen is shown`);
    check(await tid(page, 'login-form').isVisible() && (await page.locator('[data-testid="contact-form"], [data-testid="conflict-diff"], [data-testid="import-preview"]').count()) === 0, `${label}: nothing of the previous screen is left (no form, no diff, no preview)`);
    await shot(page, `session-end-${way}-${dialog}-desktop-light-en`);
    const mark = log.length;
    await sleep(2500);
    check(log.length === mark, `${label}: no DAV or account-service request follows the end of the session`, log.slice(mark).join(' | '));
    check(await page.evaluate(() => [sessionStorage.getItem('radui.auth'), localStorage.getItem('radui.auth')].every((v) => v === null)), `${label}: no credential is left in either storage`);
    await assertClean(page, watch, label, { expectHttp: ['401', '412'] });
  } finally {
    await ctx.close();
  }
}
