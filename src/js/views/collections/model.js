// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers of the collections screens (no DOM, no network): the colour palette, technical-name rules that
// mirror the backend (names.py), kind and component labels, grouping of the list, the "shared with" summary and
// the name a delete has to type. Everything coming from DAV is only ever treated as text.

/** Eight colour-blind-safe swatches (Okabe-Ito set). The id is a test id and a dictionary key (`colour.<id>`). */
export const PALETTE = Object.freeze([
  Object.freeze({ id: 'orange', hex: '#E69F00' }),
  Object.freeze({ id: 'skyblue', hex: '#56B4E9' }),
  Object.freeze({ id: 'green', hex: '#009E73' }),
  Object.freeze({ id: 'yellow', hex: '#F0E442' }),
  Object.freeze({ id: 'blue', hex: '#0072B2' }),
  Object.freeze({ id: 'vermillion', hex: '#D55E00' }),
  Object.freeze({ id: 'purple', hex: '#CC79A7' }),
  Object.freeze({ id: 'black', hex: '#000000' }),
]);
export const DEFAULT_COLOUR_ID = 'blue';

/** Whitelist for every colour that reaches the DOM (`vars`): #RRGGBB or #RRGGBBAA, any case. */
export const COLOUR_ALLOW = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
/** What the custom colour field accepts when the user types a new colour. */
export const CUSTOM_COLOUR_RE = /^#[0-9a-f]{6}$/i;

export const MAX_NAME = 100;
export const MAX_DESCRIPTION = 2000;
export const RESERVED_PREFIX = 'radui-gen-';
const SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9._@~+-]{0,127}$/;

/** The palette entry with this colour (case-insensitive, alpha ignored), or null. */
export function paletteFor(color) {
  if (typeof color !== 'string') return null;
  const c = color.trim().toLowerCase().slice(0, 7);
  return PALETTE.find((p) => p.hex.toLowerCase() === c) || null;
}

/** Technical (URL) name check, the same rules as the backend: returns an error code or null. */
export function checkSlug(slug) {
  if (typeof slug !== 'string' || slug === '') return 'empty';
  if (slug.toLowerCase().startsWith(RESERVED_PREFIX)) return 'reserved';
  if (!SLUG_RE.test(slug)) return 'pattern';
  if (slug.endsWith('~')) return 'tilde';
  return null;
}

/** NFD, ASCII letters and digits only, lower case, runs of anything else become one '-'. */
export function slugify(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** Six random hex digits. `random` returns a number 0..1 (tests inject it). */
export function randomHex6(random) {
  let out = '';
  if (!random && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(3));
    for (const x of b) out += x.toString(16).padStart(2, '0');
    return out;
  }
  const r = random || Math.random;
  for (let i = 0; i < 6; i++) out += Math.floor(r() * 16).toString(16);
  return out;
}

/**
 * The technical name for a display name: its slug, or `<prefix>-<6 hex>` when the slug comes out empty
 * (or is not allowed). `prefix` is 'calendar' for calendars and 'addressbook' for address books.
 */
export function generateSlug(displayName, { prefix = 'calendar', random } = {}) {
  const s = slugify(displayName);
  if (s && !checkSlug(s)) return s;
  return `${prefix}-${randomHex6(random)}`;
}

/** Control and format characters (including bidi marks and newlines) in a name. */
export const hasHiddenChars = (s) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(String(s ?? ''));

/** Error code for a display name, or null. */
export function checkDisplayName(name) {
  const s = String(name ?? '').trim();
  if (!s) return 'required';
  if ([...s].length > MAX_NAME) return 'long';
  if (hasHiddenChars(s)) return 'control';
  return null;
}

const fold = (s) => String(s ?? '').normalize('NFC').trim().toLowerCase();

/** Does another own collection already carry this display name? (`except` is the href being edited.) */
export function displayNameTaken(name, collections, { except = null } = {}) {
  const want = fold(name);
  if (!want) return false;
  return (collections || []).some((c) => c && c.level === 'own' && c.href !== except && fold(c.displayName) === want);
}

/** Is this technical name already used by one of the own collections? */
export function slugTaken(slug, collections) {
  const want = String(slug || '').toLowerCase();
  return (collections || []).some((c) => c && c.level === 'own' && String(c.name || leafOfHref(c.href)).toLowerCase() === want);
}

/** Last path segment of an href, decoded. */
export function leafOfHref(href) {
  const segs = String(href || '').split('/').filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** What the person sees as the name of a collection. */
export const labelOf = (c) => (c && (c.displayName || c.name)) || leafOfHref(c && c.href);

/** The text to type before a delete: the display name, or the technical name when there is none (or it holds hidden characters). */
export function typedNameFor(c) {
  const dn = c && c.displayName;
  if (typeof dn === 'string' && dn.trim() !== '' && !hasHiddenChars(dn)) return dn;
  return (c && c.name) || leafOfHref(c && c.href);
}

/** 'events' | 'tasks' | 'both' | 'addressbook' */
export function typeOf(c) {
  if (c && c.kind === 'addressbook') return 'addressbook';
  const comps = Array.isArray(c && c.components) ? c.components.map((x) => String(x).toUpperCase()) : [];
  const ev = comps.includes('VEVENT');
  const td = comps.includes('VTODO');
  if (ev && td) return 'both';
  if (td && !ev) return 'tasks';
  if (!comps.length) return 'both';
  return 'events';
}

/** Lower-case component list for `data-components`: 'vevent,vtodo', 'vcard'. */
export function componentsAttr(c) {
  const comps = Array.isArray(c && c.components) && c.components.length ? c.components : c && c.kind === 'addressbook' ? ['VCARD'] : ['VEVENT', 'VTODO'];
  return comps.map((x) => String(x).toLowerCase()).join(',');
}

/** Split the access list into the own and the shared sections, sorted (calendars first, then by name). */
export function groupCollections(list, lang = 'en') {
  let collator;
  try {
    collator = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
  } catch {
    collator = new Intl.Collator('en');
  }
  const rank = (c) => (c.kind === 'addressbook' ? 1 : 0);
  const cmp = (a, b) => rank(a) - rank(b) || collator.compare(labelOf(a), labelOf(b)) || (a.href < b.href ? -1 : 1);
  const own = [];
  const shared = [];
  for (const c of list || []) (c.level === 'own' ? own : shared).push(c);
  own.sort(cmp);
  shared.sort(cmp);
  return { own, shared };
}

/** grants -> Map<collection name, [{grantee, level}]> for the collections of `owner`. */
export function grantsByCollection(grants, owner) {
  const map = new Map();
  const me = String(owner || '').toLowerCase();
  for (const g of grants || []) {
    if (!g || !g.level || g.level === 'none') continue;
    if (String(g.owner || '').toLowerCase() !== me) continue;
    const list = map.get(g.collection) || [];
    list.push({ grantee: String(g.grantee), level: g.level === 'readwrite' ? 'readwrite' : 'read' });
    map.set(g.collection, list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.grantee < b.grantee ? -1 : 1));
  return map;
}

/** Run `worker` over `items`, at most `limit` at a time; stops taking new items once `signal` is aborted. */
export async function pool(items, limit, worker, signal) {
  let next = 0;
  const run = async () => {
    while (next < items.length && !(signal && signal.aborted)) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** Show `text` in the alert slot unless the slot already holds it (the store may have shown it). */
export function ensureAlert(feedback, text, opts) {
  if (!feedback || !text) return;
  const cur = feedback.alert;
  if (cur && cur.text === text) return;
  feedback.setAlert(text, opts);
}

/** Same for the status slot. */
export function ensureStatus(feedback, text, opts) {
  if (!feedback || !text) return;
  const cur = feedback.status;
  if (cur && cur.text === text) return;
  feedback.setStatus(text, opts);
}

/** Text for the grants that could not be revoked after a delete (persistent alert), or null. */
export function grantsLeftText(res, t, name) {
  if (!res || !res.grantsLeft) return null;
  const r = res.revoke || {};
  if (r.listError) return t('store.err.revokeCheck', { name });
  const names = (r.failed || []).map((f) => (f.unrevokable ? `${f.grantee} (${name})*` : f.grantee)).join(', ');
  return t('store.err.revokeLeft', { name, names: names || name });
}
