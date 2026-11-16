// SPDX-License-Identifier: AGPL-3.0-or-later
// Initials avatar (SPECS 5, D-R2-11): the first grapheme of the first two words of the name, a colour class
// chosen by a hash of the UID (eight `avatar--cN` classes, never an inline style), an optional photo through
// the audited `setDataImage` helper with a fall-back to initials, and bidi-safe name helpers (m6).

import { h, setDataImage } from '../ui.js';

export const AVATAR_TONES = 8;
export const AVATAR_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

let segmenter = null;
function graphemes(text) {
  try {
    segmenter = segmenter || new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  } catch {
    return Array.from(text);
  }
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/** The first grapheme of a word, skipping leading punctuation ('(Jane)' -> 'J'); falls back to the first grapheme. */
function firstMark(word) {
  const gs = graphemes(word);
  return gs.find((g) => LETTER_OR_DIGIT.test(g)) || gs[0] || '';
}

/**
 * Initials of a display name: the first grapheme of each of the first two words, upper-cased.
 * 'Jane Doe' -> 'JD', 'Jean-Pierre Dupont' -> 'JD', 'madonna' -> 'M', 'Émile Zola Jr' -> 'ÉZ', '' -> ''.
 */
export function initialsOf(name) {
  const words = String(name ?? '')
    .normalize('NFC')
    .split(/\s+/u)
    .filter((w) => w && LETTER_OR_DIGIT.test(w));
  return words
    .slice(0, 2)
    .map((w) => firstMark(w).toLocaleUpperCase())
    .join('');
}

/** FNV-1a 32-bit hash of a string (UTF-16 units): stable across sessions and engines. */
export function hashString(text) {
  let hash = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Colour index 0-7 for a seed (the UID; the name when there is none). */
export function toneIndex(seed) {
  return hashString(seed) % AVATAR_TONES;
}

/** `avatar--cN` class for a seed. */
export function toneClass(seed) {
  return `avatar--c${toneIndex(seed)}`;
}

/** Wrap a name in `<bdi>` so a right-to-left name cannot reorder the text around it (m6). */
export function bdiName(name, attrs) {
  return h('bdi', attrs || null, String(name ?? ''));
}

const FSI = '\u2068';
const PDI = '\u2069';
/** The same isolation for plain strings (aria-label, document title): the name between FSI and PDI. */
export function isolate(name) {
  const s = String(name ?? '').replace(/[\u2066-\u2069]/g, '');
  return s ? `${FSI}${s}${PDI}` : '';
}

/**
 * @param {object} o
 * @param {string} o.name
 * @param {string} [o.uid]          colour seed (falls back to the name)
 * @param {'sm'|'md'|'lg'|'xl'} [o.size='md']
 * @param {{mime: string, base64: string}|null} [o.photo]  shown through setDataImage; refused or broken -> initials
 * @param {boolean} [o.decorative=true]  true: aria-hidden (the name is next to it); false: role=img named after the person
 * @param {string} [o.noNameLabel]  accessible name when there is no name and the avatar is not decorative
 * @param {string} [o.testid]
 * @returns {HTMLElement} the avatar; `.dataset`-like state is exposed as data-photo="true|false"
 */
export function createAvatar({ name = '', uid = '', size = 'md', photo = null, decorative = true, noNameLabel = '', testid = 'contact-avatar' } = {}) {
  const initials = initialsOf(name);
  const el = h(
    'span',
    {
      class: ['avatar', `avatar--${AVATAR_SIZES.includes(size) ? size : 'md'}`, toneClass(uid || name)],
      testid,
      'data-photo': 'false',
      'aria-hidden': decorative ? 'true' : null,
      role: decorative ? null : 'img',
      'aria-label': decorative ? null : isolate(name) || noNameLabel || null,
    },
    h('span', { class: 'avatar__initials' }, initials || '?'),
  );
  if (photo && photo.mime && photo.base64) {
    const img = h('img', { class: 'avatar__img', alt: '', decoding: 'async', draggable: 'false' });
    if (setDataImage(img, photo.mime, photo.base64)) {
      img.addEventListener('error', () => {
        if (img.parentNode) img.parentNode.removeChild(img);
        el.setAttribute('data-photo', 'false');
      });
      el.append(img);
      el.setAttribute('data-photo', 'true');
    }
  }
  return el;
}
