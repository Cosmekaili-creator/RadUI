// SPDX-License-Identifier: AGPL-3.0-or-later
// The contact list index (no DOM): one summary per item version, search, collation, letters,
// windowing, duplicates and route keys. Group cards are NOT contacts: they never appear in the
// list, the A-Z index, the count, the search or the duplicate hint (RUN2 addendum C, M10).
//
//   summarize(text, {href, etag})   -> summary (never throws; an unreadable item is `readOnly`)
//   buildList(summaries, opts)      -> sorted, filtered rows
//   windowRows(rows, {from, size})  -> the visible window and the data of "show more / earlier"
//   azIndex(rows)                   -> data of the A-Z buttons
//   keyFor / resolveKey             -> the `#/contacts/<key>` route key

import { openItem } from "../model/item.js";
import { foldText as baseFold } from "../widgets/fold.js";
import { stripTel } from "../model/vcard.js";

export const WINDOW_SIZE = 250;
export const MAX_KEY_LENGTH = 255;
export const LETTERS = Object.freeze([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"]);
const SEARCH_FIELD_CAP = 1000;
const NAME_PARTS = ["prefix", "given", "additional", "family", "suffix"];

// ---------------------------------------------------------------------------
// Folding, letters, collation

/**
 * Search folding: the shared `widgets/fold.js` folding (NFD, marks removed, lower case, oe/ae/ss,
 * typographic apostrophes) plus removal of format characters (bidi controls, zero-width), so that
 * a name with hidden characters is still found. Non-strings are coerced.
 */
export function foldText(s) {
  return baseFold(String(s === undefined || s === null ? "" : s).replace(/\p{Cf}/gu, ""));
}

/** The A-Z letter of a sort key (NFD, marks stripped, upper-cased); anything else is '#'. */
export function letterOf(sortKey) {
  const t = String(sortKey === undefined || sortKey === null ? "" : sortKey)
    .replace(/\p{Cf}/gu, "")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase();
  const first = t.length ? String.fromCodePoint(t.codePointAt(0)) : "";
  return /^[A-Z]$/.test(first) ? first : "#";
}

export function makeCollator(lang) {
  try {
    return new Intl.Collator(lang || undefined, { sensitivity: "base", numeric: true });
  } catch {
    return new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  }
}

const rankOf = (letter) => (letter === "#" ? 27 : letter.charCodeAt(0) - 64);

/** Comparator for rows: A-Z letters first (in order), '#' last, then collated sort key, name, href. */
export function compareRows(collator) {
  return (a, b) =>
    rankOf(a.letter) - rankOf(b.letter) ||
    collator.compare(a.sortKey, b.sortKey) ||
    collator.compare(a.name, b.name) ||
    (a.href < b.href ? -1 : a.href > b.href ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Summaries

const cap = (s) => String(s).slice(0, SEARCH_FIELD_CAP);
const digitsOf = (s) => String(s).replace(/\D/g, "");

function fileNameOf(href) {
  const seg = String(href || "")
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean)
    .pop();
  if (!seg) return "";
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function makeSearch(parts) {
  const hay = parts.filter(Boolean).map((p) => foldText(cap(p))).join("\n");
  return hay;
}

function base(href, etag) {
  return { uid: null, href: href || "", etag: etag === undefined ? null : etag, name: "", sortKey: "", letter: "#", org: "", emails: [], phones: [], categories: [], hasPhoto: false, isGroup: false, readOnly: false, reason: null };
}

function rawLine(raw, re) {
  const m = re.exec(raw);
  return m ? m[1] : null;
}

/** Best-effort summary of an item that does not open (shown read-only, never rewritten). */
function unreadable(text, href, etag, reason) {
  const s = base(href, etag);
  const raw = typeof text === "string" ? text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "") : "";
  const fn = rawLine(raw, /^FN(?:;[^:\n]*)?:(.*)$/im);
  const uid = rawLine(raw, /^UID(?:;[^:\n]*)?:(.*)$/im);
  s.name = fn ? fn.replace(/\\n/gi, " ").replace(/\\(.)/g, "$1").trim().slice(0, 200) : "";
  s.uid = uid && uid.trim() ? uid.trim().slice(0, MAX_KEY_LENGTH) : null;
  s.isGroup = /^(?:X-ADDRESSBOOKSERVER-)?KIND(?:;[^:\n]*)?:\s*group\s*$/im.test(raw);
  s.sortKey = s.name;
  s.letter = letterOf(s.sortKey);
  s.readOnly = true;
  s.reason = reason || "parse-error";
  s.search = { hay: makeSearch([s.name]), digits: [] };
  return s;
}

/**
 * Summary of an opened contact item. `{uid, href, etag, name, sortKey, letter, org, emails,
 * phones, categories, hasPhoto, isGroup, readOnly, reason, title, nickname, search}`.
 * `name` is the FN; when it is empty the composed N, the organisation, the first e-mail or phone
 * stand in. `sortKey` is N family + given when N has a family name, else the name.
 */
export function summarizeItem(item, { href, etag } = {}) {
  const s = base(href, etag);
  const f = item.fields();
  const n = f.n || {};
  const part = (k) => (n[k] === undefined || n[k] === null ? "" : String(n[k]));
  s.uid = item.uid || null;
  s.org = f.org ? f.org.name || "" : "";
  s.emails = f.email.map((e) => String(e.value).trim()).filter(Boolean);
  s.phones = f.tel.map((e) => stripTel(e.value)).filter(Boolean);
  s.categories = [...f.categories];
  s.hasPhoto = !!(f.photo && f.photo.present);
  s.isGroup = !!(f.group && f.group.isGroup);
  s.title = f.title || "";
  s.nickname = f.nickname[0] || "";
  s.name =
    (f.fn || "").trim() ||
    NAME_PARTS.map(part)
      .filter(Boolean)
      .join(" ")
      .trim() ||
    s.org ||
    s.emails[0] ||
    s.phones[0] ||
    "";
  const family = part("family").trim();
  s.sortKey = family ? [family, part("given").trim()].filter(Boolean).join(" ") : s.name;
  s.letter = letterOf(s.sortKey);
  s.readOnly = !!item.readOnly;
  s.reason = item.readOnly ? item.readOnlyReason : null;
  s.search = {
    hay: makeSearch([s.name, ...NAME_PARTS.map(part), s.nickname, s.org, s.title, ...s.emails, ...s.categories]),
    digits: s.phones.map(digitsOf).filter(Boolean),
  };
  return s;
}

/** Summary of the text of one item as Radicale serves it. Never throws. */
export function summarize(text, meta = {}) {
  let item;
  try {
    item = openItem(text, "contact");
  } catch {
    return unreadable(text, meta.href, meta.etag, "parse-error");
  }
  if (!item.ok) return unreadable(text, meta.href, meta.etag, item.reason);
  try {
    return summarizeItem(item, meta);
  } catch {
    return unreadable(text, meta.href, meta.etag, "parse-error");
  }
}

// ---------------------------------------------------------------------------
// List, count, search

/** {contacts, groups}: group cards are kept apart and never counted as contacts. */
export function splitBook(summaries) {
  const contacts = [];
  const groups = [];
  for (const s of summaries || []) (s.isGroup ? groups : contacts).push(s);
  return { contacts, groups };
}

export const countContacts = (summaries) => splitBook(summaries).contacts.length;

const PHONE_LIKE = /^[\d\s+()\-./#*]+$/;

/** Parse a search query once; use the result with `matches`. */
export function parseQuery(query) {
  const q = String(query === undefined || query === null ? "" : query).trim();
  const tokens = foldText(q).split(/\s+/).filter(Boolean);
  const phoneTokens = tokens.map((t) => (PHONE_LIKE.test(t) && digitsOf(t).length >= 3 ? digitsOf(t) : null));
  const whole = PHONE_LIKE.test(q) && digitsOf(q).length >= 3 ? digitsOf(q) : null;
  return { empty: tokens.length === 0, tokens, phoneTokens, whole };
}

/**
 * Does the summary match? Every token must be found in FN, N parts, nickname, organisation,
 * title, e-mails or categories (folded); a token (or the whole query) with at least 3 digits
 * also matches phone numbers, compared on digits only. Notes are not searched.
 */
export function matches(summary, pq) {
  if (pq.empty) return true;
  const hay = summary.search.hay;
  const phones = summary.search.digits;
  if (pq.whole && phones.some((d) => d.includes(pq.whole))) return true;
  return pq.tokens.every((t, i) => hay.includes(t) || (pq.phoneTokens[i] !== null && phones.some((d) => d.includes(pq.phoneTokens[i]))));
}

/** Contacts (never groups) matching the query, in the given order. */
export function search(summaries, query) {
  const pq = parseQuery(query);
  return splitBook(summaries).contacts.filter((s) => matches(s, pq));
}

/** Keep the rows that are members of a group (`keys` is groups.js `memberKeys(group)`). */
export function filterByMembers(rows, keys) {
  return rows.filter((r) => r.uid && keys.has(memberKey(r.uid)));
}

/** The member key of a UID or a `urn:uuid:` member URI (the prefix is optional, UUIDs are case-insensitive). */
export function memberKey(uidOrUri) {
  const c = String(uidOrUri === undefined || uidOrUri === null ? "" : uidOrUri)
    .trim()
    .replace(/^urn:uuid:/i, "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c) ? c.toLowerCase() : c;
}

/**
 * The list: contacts only, filtered by `query` and `members` (a Set of member keys), sorted.
 * Returns {rows, total} where `total` is the number of contacts in the book (the count line).
 */
export function buildList(summaries, { query = "", members = null, lang, collator } = {}) {
  const { contacts } = splitBook(summaries);
  const pq = parseQuery(query);
  let rows = pq.empty ? contacts : contacts.filter((s) => matches(s, pq));
  if (members) rows = filterByMembers(rows, members);
  rows = [...rows].sort(compareRows(collator || makeCollator(lang)));
  return { rows, total: contacts.length };
}

// ---------------------------------------------------------------------------
// Windowing and A-Z

/**
 * The visible window of a sorted list. `from` is a row index or a letter (A-Z, '#'; a letter
 * with no rows starts at the next one that has). Returns the rows, 1-based `from`/`to` and
 * `total` for the "showing 1-250 of 2,000" text, and the data of the two buttons:
 * showMore {count, hidden, nextSize} (`btn-show-more`: "Show 250 more (1,234 not shown)") and
 * showEarlier {count, hidden, from} (`btn-show-earlier`).
 */
export function windowRows(rows, { from = 0, size = WINDOW_SIZE } = {}) {
  const total = rows.length;
  const n = Math.max(1, Math.floor(size) || WINDOW_SIZE);
  let start = 0;
  if (typeof from === "number" && Number.isFinite(from)) start = Math.min(Math.max(0, Math.floor(from)), Math.max(0, total - 1));
  else if (typeof from === "string" && LETTERS.includes(from)) {
    const i = rows.findIndex((r) => rankOf(r.letter) >= rankOf(from));
    start = i < 0 ? Math.max(0, total - n) : i;
  }
  if (!total) start = 0;
  const end = Math.min(total, start + n);
  const hiddenBefore = start;
  const hiddenAfter = total - end;
  return {
    rows: rows.slice(start, end),
    start,
    end,
    total,
    from: total ? start + 1 : 0,
    to: end,
    hiddenBefore,
    hiddenAfter,
    showMore: hiddenAfter > 0 ? { testId: "btn-show-more", count: Math.min(n, hiddenAfter), hidden: hiddenAfter, nextSize: end - start + Math.min(n, hiddenAfter) } : null,
    showEarlier: hiddenBefore > 0 ? { testId: "btn-show-earlier", count: Math.min(n, hiddenBefore), hidden: hiddenBefore, from: Math.max(0, start - n) } : null,
  };
}

/** Data of the A-Z buttons: [{letter, testId: 'az-A' | 'az-hash', count, index, present}] for A-Z and '#'. */
export function azIndex(rows) {
  const out = LETTERS.map((letter) => ({ letter, testId: letter === "#" ? "az-hash" : `az-${letter}`, count: 0, index: -1, present: false }));
  rows.forEach((r, i) => {
    const e = out[rankOf(r.letter) - 1];
    if (e.index < 0) e.index = i;
    e.count++;
    e.present = true;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Duplicates (informational)

/**
 * Contacts that look like `summary`: same name (folded), a shared e-mail (case-insensitive) or a
 * shared phone number (digits, at least 5). `index` is the list of summaries of the book. The card
 * itself and group cards are skipped. [{summary, reasons: ['name'|'email'|'phone']}]
 */
export function findDuplicates(summary, index) {
  const name = foldText(summary.name).trim();
  const emails = new Set(summary.emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const phones = new Set(summary.phones.map(digitsOf).filter((d) => d.length >= 5));
  const out = [];
  for (const o of index || []) {
    if (o === summary || o.isGroup || (o.href && o.href === summary.href && summary.href)) continue;
    const reasons = [];
    if (name && foldText(o.name).trim() === name) reasons.push("name");
    if (o.emails.some((e) => emails.has(e.trim().toLowerCase()))) reasons.push("email");
    if (o.phones.some((p) => phones.has(digitsOf(p)))) reasons.push("phone");
    if (reasons.length) out.push({ summary: o, reasons });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Route keys

/**
 * The `<key>` of `#/contacts/<key>`: the UID when it is present, unique among the cards of the
 * book (`all`, group cards included), not 'new' or 'groups' and short enough; else the file name.
 */
export function keyFor(summary, all) {
  const uid = summary.uid;
  if (uid && uid !== "new" && uid !== "groups" && uid.length <= MAX_KEY_LENGTH) {
    let n = 0;
    for (const o of all || [summary]) if (o.uid === uid && ++n > 1) break;
    if (n <= 1) return uid;
  }
  return fileNameOf(summary.href);
}

/** The summary a route key designates: the UID first (when unique), then the file name; null when unknown or over-long. */
export function resolveKey(key, all) {
  if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH) return null;
  const byUid = (all || []).filter((s) => s.uid === key);
  if (byUid.length === 1) return byUid[0];
  return (all || []).find((s) => fileNameOf(s.href) === key) || null;
}
