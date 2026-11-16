// SPDX-License-Identifier: AGPL-3.0-or-later
// Download helper: hands a text (an exported .vcf or .ics) to the browser as a file.
//
//   downloadText({text, mime, filename, doc, win}) -> {ok: true, filename, bytes} | {ok: false, reason}
//
// Blob + URL.createObjectURL + a temporary <a download> that is appended, clicked and removed; the object URL is
// revoked afterwards. It never throws into the UI: every failure comes back as {ok: false, reason}. `doc` and
// `win` can be injected (tests use fakes); they default to the page's own. The text is sent as given (the export
// layer already uses CRLF line ends); nothing is rewritten here.
// The anchor is built with setAttribute, not with h(): the builder's URL allowlist (rightly) refuses blob: URLs.

import { exportFileName } from '../store/export.js';

export { exportFileName };

/** Longest file name in characters, and in UTF-8 bytes (file systems allow 255). */
export const MAX_FILENAME_LENGTH = 120;
export const MAX_FILENAME_BYTES = 200;
/** How long the object URL stays valid after the click, so a slow browser still finds it (milliseconds). */
export const REVOKE_DELAY_MS = 1000;
export const FALLBACK_FILENAME = 'download';
export const FALLBACK_MIME = 'application/octet-stream';

const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MIME_RE = /^[a-z][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:;\s*charset=[a-z0-9._-]+)?$/i;
const EXT_RE = /^[A-Za-z0-9]{1,10}$/;

const byteLength = (s) => new TextEncoder().encode(s).length;

/** A mime type as given when it has the plain `type/subtype[;charset=x]` shape, else a generic binary type. */
export function safeMime(mime) {
  return typeof mime === 'string' && MIME_RE.test(mime.trim()) ? mime.trim() : FALLBACK_MIME;
}

function fit(stem, maxChars, maxBytes) {
  let chars = Array.from(stem);
  if (chars.length > maxChars) chars = chars.slice(0, maxChars);
  while (chars.length > 1 && byteLength(chars.join('')) > maxBytes) chars.pop();
  return chars.join('');
}

/**
 * A file name that is safe to offer to the browser: no path separators, no control or invisible characters, no
 * characters Windows refuses, no leading dot, no reserved device name, a length cap that keeps the extension.
 * Never empty: `fallback` stands in. The result has no `/` or `\`.
 */
export function safeFilename(name, { fallback = FALLBACK_FILENAME, maxLength = MAX_FILENAME_LENGTH, maxBytes = MAX_FILENAME_BYTES } = {}) {
  let s = String(name === undefined || name === null ? '' : name).normalize('NFC');
  s = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ''); // controls, bidi marks, zero-width characters, BOM
  s = s.replace(/[\\/:*?"<>|]+/g, '-'); // path separators and characters Windows refuses
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s-]+/, '').replace(/[.\s]+$/, ''); // no hidden file, no '..', no trailing dot or space
  let stem = s;
  let ext = '';
  const dot = s.lastIndexOf('.');
  if (dot > 0 && EXT_RE.test(s.slice(dot + 1))) {
    stem = s.slice(0, dot).replace(/[.\s]+$/, '');
    ext = s.slice(dot + 1);
  }
  const room = Math.max(1, maxLength - (ext ? ext.length + 1 : 0));
  const roomBytes = Math.max(1, maxBytes - (ext ? ext.length + 1 : 0));
  stem = fit(stem, room, roomBytes).replace(/[.\s]+$/, '');
  if (!stem) stem = fit(String(fallback || FALLBACK_FILENAME), room, roomBytes) || FALLBACK_FILENAME;
  if (RESERVED_NAMES.test(stem)) stem = `_${stem}`;
  return ext ? `${stem}.${ext}` : stem;
}

/**
 * Offer `text` as a download named `filename` (sanitised).
 * @param {object} o
 * @param {string} o.text
 * @param {string} [o.mime]       e.g. 'text/vcard;charset=utf-8'
 * @param {string} [o.filename]   e.g. 'family-2026-11-13.vcf'
 * @param {Document} [o.doc]      injected document (default: the page's)
 * @param {object} [o.win]        injected window-like: Blob, URL, setTimeout (default: the globals)
 * @returns {{ok: true, filename: string, bytes: number} | {ok: false, reason: 'no-text' | 'unsupported' | 'failed'}}
 */
export function downloadText({ text, mime, filename, doc, win } = {}) {
  let url = null;
  let urlApi = null;
  let anchor = null;
  const revoke = () => {
    if (url === null) return;
    const u = url;
    url = null;
    try {
      urlApi.revokeObjectURL(u);
    } catch {
      /* nothing to release */
    }
  };
  try {
    if (typeof text !== 'string') return { ok: false, reason: 'no-text' };
    const w = win || globalThis;
    const d = doc || w.document || globalThis.document;
    const BlobCtor = w.Blob || globalThis.Blob;
    urlApi = w.URL || globalThis.URL;
    if (!d || !d.body || typeof d.createElement !== 'function' || typeof BlobCtor !== 'function' || !urlApi || typeof urlApi.createObjectURL !== 'function' || typeof urlApi.revokeObjectURL !== 'function') {
      return { ok: false, reason: 'unsupported' };
    }
    const name = safeFilename(filename);
    const blob = new BlobCtor([text], { type: safeMime(mime) });
    url = urlApi.createObjectURL(blob);
    anchor = d.createElement('a');
    anchor.setAttribute('href', url);
    anchor.setAttribute('download', name);
    anchor.setAttribute('rel', 'noopener');
    anchor.setAttribute('hidden', '');
    d.body.append(anchor);
    anchor.click();
    const later = typeof w.setTimeout === 'function' ? w.setTimeout.bind(w) : null;
    if (later) later(revoke, REVOKE_DELAY_MS);
    else revoke();
    return { ok: true, filename: name, bytes: byteLength(text) };
  } catch {
    revoke();
    return { ok: false, reason: 'failed' };
  } finally {
    try {
      if (anchor && typeof anchor.remove === 'function') anchor.remove();
    } catch {
      /* already gone */
    }
  }
}
