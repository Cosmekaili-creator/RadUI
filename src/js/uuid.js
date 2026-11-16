// SPDX-License-Identifier: AGPL-3.0-or-later
// The one source of new UUIDs (UIDs of new items, file names, keep-both re-keying).
//
//   1. crypto.randomUUID() when the browser has it (a secure context);
//   2. otherwise a version 4 UUID built from crypto.getRandomValues();
//   3. otherwise an Error is thrown. There is NEVER a Math.random fallback: a predictable identifier
//      could collide with, or be guessed from, another client's items.

/** @returns {string} a version 4 UUID, lower case */
export function newUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error('no secure random source');
}
