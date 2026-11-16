// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers that drive the contact and collection screens by their test ids (shared by several suites).
import { DICT, check, davGet, feedback, go, listItems, ready, sleep, tid, uniq, waitRows } from './common.mjs';

export const enc = encodeURIComponent;
export const bookQ = (href) => `ab=${enc(href)}`;
export const listHash = (href, extra = '') => `#/contacts?${bookQ(href)}${extra}`;
export const newHash = (href) => `#/contacts/new?${bookQ(href)}`;
export const detailHash = (href, uid) => `#/contacts/${enc(uid)}?${bookQ(href)}`;
export const editHash = (href, uid) => `#/contacts/${enc(uid)}/edit?${bookQ(href)}`;

/** Open the contact list of a book and wait until its rows are drawn (or a state box is). */
export async function openBook(page, href, extra = '') {
  await go(page, listHash(href, extra));
  await page.waitForSelector('[data-testid="contacts-screen"][data-state="ready"], [data-testid="contacts-screen"][data-state="error"]', { timeout: 30000 });
}

export const rowByName = (page, name) => page.getByTestId('contact-row').filter({ hasText: name });

/** The rows of the list as {name, letter, uid}. */
export const rowsOf = (page) => page.$$eval('[data-testid="contact-row"]', (rs) => rs.map((r) => ({ name: r.querySelector('.crow__name').textContent.trim(), letter: r.dataset.letter, uid: r.dataset.uid, href: r.dataset.href })));

/** Wait for the status/alert text of the persistent regions to contain `text`. */
export async function waitFeedback(page, kind, text, timeout = 15000) {
  await page.waitForFunction(({ kind, text }) => ((document.querySelector(`[data-testid="${kind}-text"]`) || {}).textContent || '').includes(text), { kind, text }, { timeout });
}

/** Type into a text field (fill replaces; this one also fires the events the form listens to). */
export async function type(page, testid, value, { nth = 0 } = {}) {
  const el = page.getByTestId(testid).nth(nth);
  await el.fill(value);
}

/** The last row of a repeatable kind (phone, email, address, url). */
export const lastRow = (page, kind) => page.getByTestId(`${kind}-row`).last();

/** Add one row to a repeatable and fill it. `values` is {value} or {street, locality, ...}. */
export async function addRow(page, kind, { type: typeSel, value, custom, address } = {}) {
  await page.getByTestId(`btn-add-${kind}`).click();
  const row = lastRow(page, kind);
  if (typeSel) await row.getByTestId(`field-${kind}-type`).selectOption(typeSel);
  if (custom !== undefined) await row.getByTestId(`field-${kind}-custom`).fill(custom);
  if (address) {
    for (const [k, v] of Object.entries(address)) {
      const more = row.getByTestId(`field-address-${k}`);
      if (!(await more.isVisible())) await row.getByTestId('address-more').locator('summary').click();
      await more.fill(v);
    }
  } else if (value !== undefined) await row.getByTestId(`field-${kind}-value`).fill(value);
  return row;
}

/** Submit the contact form and wait until it left the form (detail) or an error appeared. */
export async function saveContact(page, { expectLeave = true } = {}) {
  await tid(page, 'contact-save').click();
  if (expectLeave) {
    try {
      await page.waitForFunction(() => !/\/(new|edit)(\?|$)/.test(location.hash), null, { timeout: 30000 });
    } catch (e) {
      const why = await page.evaluate(() => `errors: "${((document.querySelector('[data-testid="form-errors"]') || {}).innerText || '').trim()}" alert: "${((document.querySelector('[data-testid="alert-text"]') || {}).textContent || '').trim()}" status: "${((document.querySelector('[data-testid="status-text"]') || {}).textContent || '').trim()}"`);
      throw new Error('the form did not close after Save: ' + why);
    }
  }
  await ready(page);
}

/** New hrefs of a book after an action (compares with a listing taken before). */
export async function newItems(user, bookHref, before) {
  const seen = new Set(before.map((i) => i.href));
  return (await listItems(user, bookHref)).filter((i) => !seen.has(i.href));
}

/** The text of the card with this UID in the book (by scanning the whole collection GET). */
export async function cardByUid(user, bookHref, uid) {
  const r = await davGet(user, bookHref);
  const cards = r.text.split(/(?=BEGIN:VCARD)/).filter((c) => c.includes('BEGIN:VCARD'));
  return cards.find((c) => c.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).some((l) => l === `UID:${uid}`)) || null;
}

/** Open a contact's detail by its UID and wait for the detail pane. */
export async function openDetail(page, href, uid) {
  await go(page, detailHash(href, uid));
  await page.getByTestId('contact-detail').waitFor({ timeout: 20000 });
}

/** Text of the accessible dictionary entry. */
export const L = (lang, key, params = {}) => DICT[lang][key].replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));

export { uniq, sleep, feedback, waitRows, check };
