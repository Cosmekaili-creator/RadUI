// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, fire, one } from './_dom.mjs';
import { initialsOf, hashString, toneIndex, toneClass, createAvatar, bdiName, isolate, AVATAR_TONES } from '../../../src/js/widgets/avatar.js';

const doc = makeDom();
// 1x1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('initialsOf: first grapheme of the first two words', () => {
  assert.equal(initialsOf('Jane Doe'), 'JD');
  assert.equal(initialsOf('jane doe'), 'JD');
  assert.equal(initialsOf('Jean-Pierre Dupont'), 'JD');
  assert.equal(initialsOf('Mary Jane Watson'), 'MJ', 'only two words');
  assert.equal(initialsOf('Madonna'), 'M');
  assert.equal(initialsOf('  Éric   Zola '), 'ÉZ');
  assert.equal(initialsOf('(Jane) "JD" Doe'), 'JJ', 'leading punctuation is skipped');
  assert.equal(initialsOf('Åsa Öberg'), 'ÅÖ');
  assert.equal(initialsOf('山田 太郎'), '山太');
  assert.equal(initialsOf('عمر خالد'), 'عخ');
  assert.equal(initialsOf('ß Straße'), 'SSS', 'upper-casing may expand a letter');
  assert.equal(initialsOf(''), '');
  assert.equal(initialsOf('   '), '');
  assert.equal(initialsOf(null), '');
  assert.equal(initialsOf('--- ---'), '');
});

test('initialsOf: a grapheme is never split (emoji with joiner, combining marks)', () => {
  assert.equal(initialsOf('\u{1F469}\u200D\u{1F4BB} Dev'), '\u{1F469}\u200D\u{1F4BB}D'.toLocaleUpperCase());
  assert.equal(initialsOf('e\u0301mile Z'), '\u00c9Z', 'normalised to NFC');
  assert.equal(initialsOf('\u{1D7D8}x'), '\u{1D7D8}'.toLocaleUpperCase());
});

test('hashString is stable (FNV-1a) and toneIndex stays within the eight tones', () => {
  assert.equal(hashString(''), 0x811c9dc5);
  assert.equal(hashString('a'), 0xe40c292c);
  assert.equal(hashString('foobar'), 0xbf9cf968);
  assert.equal(hashString('urn:uuid:11111111-2222-3333-4444-555555555555'), hashString('urn:uuid:11111111-2222-3333-4444-555555555555'));
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    const idx = toneIndex(`uid-${i}`);
    assert.ok(idx >= 0 && idx < AVATAR_TONES);
    seen.add(idx);
  }
  assert.equal(seen.size, 8, 'the hash spreads over all eight classes');
  assert.match(toneClass('x'), /^avatar--c[0-7]$/);
  assert.equal(toneClass('same'), toneClass('same'));
});

test('createAvatar: initials, size and tone classes, aria-hidden when decorative, no style attribute', () => {
  const el = createAvatar({ name: 'Jane Doe', uid: 'uid-1', size: 'xl' });
  assert.equal(el.tagName, 'SPAN');
  assert.ok(el.classList.contains('avatar') && el.classList.contains('avatar--xl') && el.classList.contains(toneClass('uid-1')));
  assert.equal(el.textContent, 'JD');
  assert.equal(el.getAttribute('aria-hidden'), 'true');
  assert.equal(el.getAttribute('role'), null);
  assert.equal(el.getAttribute('data-testid'), 'contact-avatar');
  assert.equal(el.getAttribute('data-photo'), 'false');
  assert.equal(el.hasAttribute('style'), false);
  assert.equal(el.styleProps.size, 0);
  assert.ok(createAvatar({ name: 'A', size: 'bogus' }).classList.contains('avatar--md'));
  assert.ok(createAvatar({ name: 'A Name' }).classList.contains(toneClass('A Name')), 'the name seeds the colour when there is no uid');
  assert.equal(createAvatar({ name: '' }).textContent, '?');
});

test('createAvatar: not decorative gives role img named after the person (bidi isolated)', () => {
  const el = createAvatar({ name: 'Jane Doe', decorative: false });
  assert.equal(el.getAttribute('role'), 'img');
  assert.equal(el.getAttribute('aria-label'), isolate('Jane Doe'));
  assert.equal(el.getAttribute('aria-hidden'), null);
  assert.equal(createAvatar({ name: '', decorative: false, noNameLabel: 'No name' }).getAttribute('aria-label'), 'No name');
});

test('createAvatar: a photo goes through setDataImage; a broken photo falls back to initials', () => {
  const el = createAvatar({ name: 'Jane Doe', photo: { mime: 'image/png', base64: PNG } });
  const img = el.querySelector('img');
  assert.ok(img);
  assert.equal(img.getAttribute('src'), `data:image/png;base64,${PNG}`);
  assert.equal(img.getAttribute('alt'), '');
  assert.equal(el.getAttribute('data-photo'), 'true');
  assert.equal(el.querySelector('.avatar__initials').textContent, 'JD', 'initials stay behind the image');
  fire(img, 'error', { bubbles: false });
  assert.equal(el.querySelector('img'), null);
  assert.equal(el.getAttribute('data-photo'), 'false');
  assert.equal(el.textContent, 'JD');
});

test('createAvatar: refused photos never create an image (svg, bad base64, oversize, unknown mime)', () => {
  const huge = 'A'.repeat(Math.ceil((1.5 * 1024 * 1024 * 4) / 3) + 8);
  for (const photo of [
    { mime: 'image/svg+xml', base64: PNG },
    { mime: 'image/png', base64: 'not base64!!' },
    { mime: 'image/png', base64: huge },
    { mime: 'text/html', base64: PNG },
    { mime: '', base64: PNG },
    { mime: 'image/png', base64: '' },
    null,
  ]) {
    const el = createAvatar({ name: 'Jane Doe', photo });
    assert.equal(el.querySelector('img'), null, JSON.stringify(photo && photo.mime));
    assert.equal(el.getAttribute('data-photo'), 'false');
    assert.equal(el.textContent, 'JD');
  }
});

test('bdiName and isolate wrap names so a right-to-left name cannot reorder its surroundings (m6)', () => {
  const b = bdiName('محمد Ali');
  assert.equal(b.tagName, 'BDI');
  assert.equal(b.textContent, 'محمد Ali');
  assert.equal(bdiName('x', { 'data-testid': 'contact-name' }).getAttribute('data-testid'), 'contact-name');
  assert.equal(isolate('Jane'), '\u2068Jane\u2069');
  assert.equal(isolate('\u2069evil\u2066'), '\u2068evil\u2069', 'embedded isolate controls are removed');
  assert.equal(isolate(''), '');
  assert.equal(isolate(null), '');
});
