// SPDX-License-Identifier: AGPL-3.0-or-later
// Small helpers shared by the contact screens: injectable dependencies (so Node tests run without a
// browser), names, hashes, labels, number and date formatting.

import { buildHash, hashFor } from '../../router.js';
import { bdiName, isolate } from '../../widgets/avatar.js';
import { labelInfo } from '../../model/vcard.js';
import { downloadText } from '../download.js';
import { openConflictDialog } from '../conflictdialog.js';
import { processPhoto } from '../../contacts/photo.js';
import { keyFor } from '../../contacts/index.js';

/** The browser objects `processPhoto` needs; created only when a file is chosen. */
export function browserPhotoApi(win = globalThis.window, doc = globalThis.document) {
  return {
    createImageBitmap: (file, options) => (options ? win.createImageBitmap(file, options) : win.createImageBitmap(file)),
    createCanvas(w, h) {
      if (typeof win.OffscreenCanvas === 'function') return new win.OffscreenCanvas(w, h);
      const c = doc.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    },
  };
}

/** Dependencies the screens use; a test passes its own through `mount(ctx, deps)`. */
export function resolveDeps(deps = {}) {
  const win = deps.win || globalThis.window;
  const doc = deps.doc || globalThis.document;
  return {
    win,
    doc,
    now: () => new Date(),
    yieldFn: undefined,
    debounceMs: 250,
    isOnline: () => !win || !win.navigator || win.navigator.onLine !== false,
    loadImportDialog: () => import('../importdialog.js'),
    openConflictDialog,
    downloadText,
    processPhoto,
    photoApi: null,
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
    ...deps,
  };
}

export const photoApiOf = (d) => d.photoApi || browserPhotoApi(d.win, d.doc);

export const contactHash = (key, query) => hashFor('/contacts/:key', { key }, query);
export const editHash = (key, query) => hashFor('/contacts/:key/edit', { key }, query);
export const groupHash = (key, query) => hashFor('/contacts/groups/:key', { key }, query);
export const listHash = (query) => buildHash('/contacts', query);

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
export const cleanQuery = clean;

export const nameOf = (summary, t) => (summary && summary.name ? summary.name : t('contacts.unnamed'));
export { bdiName, isolate };

/** "1,234" in the display language. */
export function fmtNumber(lang, n) {
  try {
    return new Intl.NumberFormat(lang).format(n);
  } catch {
    return String(n);
  }
}

const KNOWN_TYPES = { tel: ['cell', 'home', 'work', 'main', 'fax', 'pager'], email: ['home', 'work'], adr: ['home', 'work'], url: ['home', 'work'] };
const NOISE = new Set(['internet', 'voice', 'pref', 'x-apple']);

/**
 * The visible label of an entry. A custom label is shown as written (an Apple built-in label becomes its
 * translated name); a TYPE token the form knows is translated; an unknown token is shown as written.
 */
export function typeLabel(kind, entry, t) {
  if (entry.label) {
    const info = labelInfo(entry.label);
    if (info.builtin) {
      const key = info.key ? `contact.applelabel.${info.key}` : null;
      const tr = key ? t(key) : null;
      return tr && tr !== key ? tr : info.text;
    }
    return info.text;
  }
  const tokens = (entry.types || []).map((x) => String(x).trim()).filter(Boolean);
  const known = tokens.find((x) => KNOWN_TYPES[kind].includes(x.toLowerCase()));
  if (known) return t(`contact.type.${known.toLowerCase()}`);
  const other = tokens.find((x) => !NOISE.has(x.toLowerCase()));
  return other || t('contact.type.other');
}

/** A birthday or anniversary as text: "March 4, 1990" (year known) or "March 4". Text-valued dates are shown as written. */
export function formatDay(date, lang) {
  if (!date) return '';
  if (date.text) return String(date.raw ?? '');
  try {
    const opts = { day: 'numeric', month: 'long', timeZone: 'UTC' };
    if (date.year) opts.year = 'numeric';
    return new Intl.DateTimeFormat(lang, opts).format(new Date(Date.UTC(date.year || 2000, date.month - 1, date.day)));
  } catch {
    return `${date.year ? date.year + '-' : ''}${date.month}-${date.day}`;
  }
}

/** Age in whole years on `now`; null when the year is unknown or the date lies in the future. */
export function ageOn(date, now = new Date()) {
  if (!date || date.text || !date.year) return null;
  let age = now.getFullYear() - date.year;
  if (now.getMonth() + 1 < date.month || (now.getMonth() + 1 === date.month && now.getDate() < date.day)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/** First message to show for a failed write result (the store already put the same text in the alert region). */
export const failureText = (res, t) => (res && res.message) || t('contacts.err.generic');

/** Key of a card in `#/contacts/<key>`, from precomputed UID counts (keyFor alone would scan the whole book per row). */
export function makeKeyer(all) {
  const counts = new Map();
  for (const s of all) if (s.uid) counts.set(s.uid, (counts.get(s.uid) || 0) + 1);
  return (s) => (s.uid && counts.get(s.uid) > 1 ? keyFor({ ...s, uid: null }, []) : keyFor(s, [s]));
}
