// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic fictional contacts for the scale and import tests. Names are pseudo-words built from syllables,
// hosts are example.org, phone numbers are in the reserved 555-01xx range: nothing here describes a real person.

const SYL = ['ba', 'de', 'fi', 'go', 'hu', 'ju', 'ka', 'lo', 'mi', 'ne', 'pa', 'qui', 'ro', 'su', 'ta', 'vo', 'we', 'xa', 'yo', 'zu'];
const CITIES = ['Sampletown', 'Exampleville', 'Testburg', 'Demoton', 'Fictionville'];
const CATEGORIES = ['Friends', 'Work', 'Family', 'Club', 'Neighbours'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** Parts of the i-th fictional person. Distinct for every i below 8,000. */
export function person(i) {
  const given = cap(SYL[i % 20] + SYL[Math.floor(i / 20) % 20]);
  const family = cap(SYL[Math.floor(i / 400) % 20] + SYL[(i * 7) % 20] + 'ton');
  return { given, family, fn: `${given} ${family}`, email: `${given}.${family}@example.org`.toLowerCase() };
}

/** UID of the i-th generated card (urn:uuid form, fixed prefix, never a real identifier). */
export const generatedUid = (i) => `urn:uuid:7d3f4a00-0000-4000-8000-${String(100000 + i).padStart(12, '0')}`;

/** A payload of `bytes` pseudo-random bytes as base64 (a stand-in for a photo; it is never decoded). */
const photoB64 = (bytes, seed) => Buffer.from(Array.from({ length: bytes }, (_, k) => (k * 31 + seed * 17 + 5) % 256)).toString('base64');

/**
 * The i-th fictional card, CRLF. Even i: vCard 3.0, odd i: 4.0; every 20th card carries a photo of about 9 KB.
 * @param {number} i
 * @param {{uid?: string}} [o]
 */
export function fictionalCard(i, { uid = generatedUid(i) } = {}) {
  const p = person(i);
  const four = i % 2 === 1;
  const phone = `+1 555 01${String(i % 100).padStart(2, '0')}`;
  const lines = [
    'BEGIN:VCARD',
    `VERSION:${four ? '4.0' : '3.0'}`,
    'PRODID:-//Example Contacts//Contacts 1.0//EN',
    `UID:${uid}`,
    `FN:${p.fn}`,
    `N:${p.family};${p.given};;;`,
    `TEL;TYPE=${i % 3 === 0 ? 'WORK' : 'CELL'}:${phone}`,
    `EMAIL;TYPE=INTERNET:${p.email}`,
    `ORG:Example Org ${i % 50}`,
    `ADR;TYPE=HOME:;;${i % 200 + 1} Example Road;${CITIES[i % CITIES.length]};;${String(10000 + (i % 900))};Exampleland`,
    `CATEGORIES:${CATEGORIES[i % CATEGORIES.length]}`,
  ];
  if (i % 20 === 0) lines.push(four ? `PHOTO;ENCODING=b;MEDIATYPE=image/jpeg:${photoB64(6700, i)}` : `PHOTO;ENCODING=b;TYPE=JPEG:${photoB64(6700, i)}`);
  lines.push('END:VCARD');
  const out = [];
  for (const l of lines) {
    let rest = l;
    out.push(rest.slice(0, 75));
    rest = rest.slice(75);
    while (rest.length) {
      out.push(' ' + rest.slice(0, 74));
      rest = rest.slice(74);
    }
  }
  return out.join('\r\n') + '\r\n';
}

/** A `.vcf` text of `count` generated cards starting at index `from`. */
export const fictionalFile = (count, from = 0) => Array.from({ length: count }, (_, k) => fictionalCard(from + k)).join('');
