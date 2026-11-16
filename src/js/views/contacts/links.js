// SPDX-License-Identifier: AGPL-3.0-or-later
// Link and display helpers of the contact screens (no DOM). Everything that ends up in an `href` is built
// here, from an allowlist: `tel:` with digits and a leading `+` only; `mailto:` only for a plain address,
// each part percent-encoded, never with `?` or `&`; `http(s)` URLs without credentials. Anything else is
// shown as plain text by the caller (the function answers null).

const MAIL_BAD = '\\s@?&,;<>"\'\\\\%#';
const MAIL_RE = new RegExp(`^[^${MAIL_BAD}]+@[^${MAIL_BAD}]+\\.[^${MAIL_BAD}]+$`);

/** `tel:+15550100` from a phone text; null when fewer than 3 digits remain. */
export function telHref(value) {
  const text = String(value ?? '').trim().replace(/^tel:/i, '');
  const lead = text.startsWith('+') ? '+' : '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits.length >= 3 ? `tel:${lead}${digits}` : null;
}

/** `mailto:` link for a plain e-mail address, else null. */
export function mailHref(value) {
  const v = String(value ?? '').trim();
  if (!MAIL_RE.test(v)) return null;
  const [local, domain] = v.split('@');
  return `mailto:${encodeURIComponent(local)}@${encodeURIComponent(domain)}`;
}

/** The normalised URL of an http(s) address without credentials, else null. */
export function webHref(value) {
  const v = String(value ?? '').trim();
  if (!v || v.length > 2000 || !/^https?:\/\//i.test(v)) return null;
  try {
    const u = new URL(v);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Replace PHOTO payloads of a card text by "[photo data, 34 KB]" (the raw viewer never shows megabytes of base64). */
export function abbreviatePhotos(text, label = (kb) => `[photo data, ${kb} KB]`) {
  const unfolded = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  return unfolded.replace(/^((?:[A-Za-z0-9-]+\.)?PHOTO(?:;[^:\n]*)?):(.*)$/gim, (whole, head, value) => {
    const v = value.trim();
    if (/^https?:\/\//i.test(v) && v.length < 300) return whole;
    const kb = Math.max(1, Math.round((v.replace(/^data:[^,]*,/i, '').length * 3) / 4 / 1024));
    return `${head}:${label(kb)}`;
  });
}

/** Cap a long text for display; returns {text, truncated}. */
export function capText(text, max = 100000) {
  const s = String(text ?? '');
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}
