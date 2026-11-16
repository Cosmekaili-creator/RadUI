// SPDX-License-Identifier: AGPL-3.0-or-later
// Export (D-R2-15). Whole collection: `client.getCollectionText` (Radicale serves a book as the cards one after
// the other and a calendar as ONE merged VCALENDAR with its VTIMEZONEs de-duplicated, so no client-side merge is
// needed). If that request fails for a reason other than auth, permission or the network, an address book is
// rebuilt from the item texts the store holds. The book export is "contacts only": group cards are filtered out
// (M10) unless `includeGroups` is true. Single contact: its own text.
//
// The result is data for the view to download (no DOM here): {filename, mime, text (CRLF), blob, count, ...}.
// File name: `<displayname-slug>-<YYYY-MM-DD>.<vcf|ics>`.

import { classify } from './errors.js';
import { createReporter } from './report.js';

const MIME = { vcf: 'text/vcard;charset=utf-8', ics: 'text/calendar;charset=utf-8' };

/** Lower-case ASCII slug of a name (accents stripped); `fallback` when nothing is left. */
export function slugify(name, fallback = 'export') {
  const s = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || fallback;
}

/** Local date as YYYY-MM-DD. */
export function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `<displayname-slug>-<YYYY-MM-DD>.<vcf|ics>` */
export function exportFileName(displayName, ext, date = new Date()) {
  return `${slugify(displayName)}-${isoDate(date)}.${ext}`;
}

const toCrlf = (t) => String(t).replace(/\r\n?|\n/g, '\r\n');
const unfold = (t) => String(t).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
const GROUP_LINE = /^(?:[A-Za-z0-9-]+\.)?(?:X-ADDRESSBOOKSERVER-)?KIND(?:;[^:]*)?:\s*group\s*$/im;

/** Split concatenated vCards into card texts (original folding kept, LF). Text outside cards is dropped. */
export function splitCards(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const cards = [];
  let cur = null;
  for (const l of lines) {
    if (!cur) {
      if (/^BEGIN:VCARD\s*$/i.test(l)) cur = [l];
    } else {
      cur.push(l);
      if (/^END:VCARD\s*$/i.test(l)) {
        cards.push(cur.join('\n'));
        cur = null;
      }
    }
  }
  return cards;
}

export const isGroupCardText = (cardText) => GROUP_LINE.test(unfold(cardText));

function build({ text, ext, displayName, now, count, extra }) {
  const out = toCrlf(text);
  const filename = exportFileName(displayName, ext, now());
  const blob = typeof Blob === 'function' ? new Blob([out], { type: MIME[ext] }) : null;
  return { ok: true, status: 'ok', filename, mime: MIME[ext], text: out, blob, count, bytes: new TextEncoder().encode(out).length, ext, ...extra };
}

/**
 * Export one collection.
 * @param {object} o
 * @param {object} o.client DAV client
 * @param {{href: string, kind: 'calendar'|'addressbook', displayName?: string, name?: string}} o.collection
 * @param {object} [o.store] item store, used for the fallback only
 * @param {boolean} [o.includeGroups] keep group cards in a book export (default false)
 */
export async function exportCollection({ client, collection, store = null, includeGroups = false, reporter = createReporter(), now = () => new Date() }) {
  const href = collection.href.endsWith('/') ? collection.href : collection.href + '/';
  const label = collection.displayName || collection.name || href.split('/').filter(Boolean).pop() || 'export';
  const target = href.split('/').filter(Boolean).pop() || '';
  let got = null;
  try {
    got = await client.getCollectionText(href);
  } catch (e) {
    const c = classify(e);
    const fallbackOk = (c.kind === 'invalid' || c.kind === 'server' || c.kind === 'unknown') && collection.kind === 'addressbook' && store && store.size > 0;
    if (!fallbackOk) {
      reporter.log('export', target, 'error', c.kind + (c.status ? ' ' + c.status : ''));
      if (c.kind === 'auth') return { ok: false, status: 'auth', message: '' };
      return { ok: false, status: c.kind === 'forbidden' ? 'forbidden' : 'error', message: reporter.alert('store.err.exportFailed', undefined) };
    }
    got = { kind: 'addressbook', text: store.list().map((x) => x.text.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n')).join(''), fallback: true };
  }
  const isBook = collection.kind === 'addressbook';
  let text = got.text;
  let count;
  let groupsExcluded = 0;
  if (isBook) {
    let cards = splitCards(text);
    if (!includeGroups) {
      const kept = cards.filter((c) => !isGroupCardText(c));
      groupsExcluded = cards.length - kept.length;
      cards = kept;
    }
    count = cards.length;
    text = cards.length ? cards.join('\n') + '\n' : '';
  } else {
    count = (text.match(/^BEGIN:(?:VEVENT|VTODO)\s*$/gim) || []).length;
  }
  const res = build({ text, ext: isBook ? 'vcf' : 'ics', displayName: label, now, count, extra: { kind: collection.kind, groupsExcluded, fallback: Boolean(got.fallback), empty: count === 0 } });
  reporter.log('export', target, 'ok', `${count} item(s)${res.fallback ? ', from item texts' : ''}`);
  reporter.status('store.status.exported', { count });
  return res;
}

/** One contact (or any single item text) as a download. `displayName` names the file. */
export function exportItem({ text, displayName, kind = 'addressbook', reporter = createReporter(), now = () => new Date(), target = '' }) {
  const ext = kind === 'calendar' ? 'ics' : 'vcf';
  const res = build({ text, ext, displayName, now, count: 1, extra: { kind, groupsExcluded: 0, fallback: false, empty: false } });
  reporter.log('export', target, 'ok', '1 item');
  reporter.status('store.status.exported', { count: 1 });
  return res;
}
