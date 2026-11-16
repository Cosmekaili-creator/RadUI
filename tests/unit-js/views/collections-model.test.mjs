// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLOUR_ALLOW, CUSTOM_COLOUR_RE, PALETTE, checkDisplayName, checkSlug, componentsAttr, displayNameTaken, generateSlug, groupCollections, grantsByCollection, hasHiddenChars, labelOf, paletteFor, pool, slugTaken, slugify, typeOf, typedNameFor } from '../../../src/js/views/collections/model.js';
import { validateCollectionName } from '../../../src/js/store/writes.js';
import { book, entry, shared } from './collections-helpers.mjs';

test('slugify: NFD, ASCII, lower case, dashes', () => {
  assert.equal(slugify('Café Équipe 2026!'), 'cafe-equipe-2026');
  assert.equal(slugify('  --Hello__World--  '), 'hello-world');
  assert.equal(slugify('日本語'), '');
  assert.equal(slugify('a'.repeat(100)).length, 60);
});

test('generateSlug: the slug, or <prefix>-<6 hex> when it is empty or not allowed', () => {
  assert.equal(generateSlug('Work Calendar'), 'work-calendar');
  assert.match(generateSlug('日本語'), /^calendar-[0-9a-f]{6}$/);
  assert.match(generateSlug('???', { prefix: 'addressbook' }), /^addressbook-[0-9a-f]{6}$/);
  assert.match(generateSlug('radui gen x'), /^calendar-[0-9a-f]{6}$/); // radui-gen- is reserved
  assert.equal(generateSlug('', { prefix: 'calendar', random: () => 0.5 }), 'calendar-888888');
});

test('checkSlug mirrors the backend rules', () => {
  const good = ['a', 'work', 'a.b_c@d~e+f-g', '_x', 'A1', 'a'.repeat(128)];
  const bad = ['', '-x', '.x', 'a b', 'a/b', 'é', 'a~', 'radui-gen-1', 'RADUI-GEN-x', 'a'.repeat(129), 'x\n'];
  for (const s of good) assert.equal(checkSlug(s), null, s);
  for (const s of bad) assert.notEqual(checkSlug(s), null, JSON.stringify(s));
  // the same decisions as the store's own validator (which mirrors names.py)
  for (const s of [...good, ...bad]) assert.equal(checkSlug(s) === null, validateCollectionName(s) === null, JSON.stringify(s));
  assert.equal(checkSlug('a~'), 'tilde');
  assert.equal(checkSlug('radui-gen-1'), 'reserved');
});

test('display names: required, 100 characters, no control characters', () => {
  assert.equal(checkDisplayName(''), 'required');
  assert.equal(checkDisplayName('   '), 'required');
  assert.equal(checkDisplayName('x'.repeat(101)), 'long');
  assert.equal(checkDisplayName('x'.repeat(100)), null);
  assert.equal(checkDisplayName('a\nb'), 'control');
  assert.equal(checkDisplayName('a‮b'), 'control');
  assert.equal(checkDisplayName('Café'), null);
  assert.equal(hasHiddenChars('plain'), false);
});

test('collisions: display names among own collections only, technical names by leaf', () => {
  const list = [entry({ displayName: 'Family' }), shared({ displayName: 'Team' }), book({ displayName: 'Contacts', href: '/alice/people/', name: 'people' })];
  assert.equal(displayNameTaken('family', list), true);
  assert.equal(displayNameTaken(' FAMILY ', list), true);
  assert.equal(displayNameTaken('Team', list), false, 'shared collections are not yours');
  assert.equal(displayNameTaken('Family', list, { except: '/alice/cal/' }), false, 'the collection being edited does not collide with itself');
  assert.equal(slugTaken('cal', list), true);
  assert.equal(slugTaken('CAL', list), true);
  assert.equal(slugTaken('people', list), true);
  assert.equal(slugTaken('team', list), false);
});

test('typedNameFor: the display name, or the technical name when there is none or it cannot be typed', () => {
  assert.equal(typedNameFor(entry({ displayName: 'Family' })), 'Family');
  assert.equal(typedNameFor(entry({ displayName: null, name: 'cal' })), 'cal');
  assert.equal(typedNameFor(entry({ displayName: '   ', name: 'cal' })), 'cal');
  assert.equal(typedNameFor(entry({ displayName: 'two\nlines', name: 'cal' })), 'cal');
  assert.equal(labelOf(entry({ displayName: null, name: 'cal' })), 'cal');
});

test('types and component attributes', () => {
  assert.equal(typeOf(entry({ components: ['VEVENT'] })), 'events');
  assert.equal(typeOf(entry({ components: ['VTODO'] })), 'tasks');
  assert.equal(typeOf(entry({ components: ['VEVENT', 'VTODO'] })), 'both');
  assert.equal(typeOf(book()), 'addressbook');
  assert.equal(componentsAttr(entry({ components: ['VEVENT', 'VTODO'] })), 'vevent,vtodo');
  assert.equal(componentsAttr(book()), 'vcard');
});

test('palette: eight Okabe-Ito swatches, all valid colours; hostile values are rejected by the whitelist', () => {
  assert.equal(PALETTE.length, 8);
  assert.equal(new Set(PALETTE.map((p) => p.id)).size, 8);
  for (const p of PALETTE) assert.match(p.hex, CUSTOM_COLOUR_RE);
  assert.equal(paletteFor('#0072b2').id, 'blue');
  assert.equal(paletteFor('#0072B2FF').id, 'blue');
  assert.equal(paletteFor('#123456'), null);
  for (const bad of ['red;background:url(x)', '#12345', 'red', '#12345g', '#0072B2;x', 'url(x)', '']) assert.equal(COLOUR_ALLOW.test(bad), false, bad);
  for (const good of ['#0072B2', '#0072b2ff', '#ABCDEF']) assert.equal(COLOUR_ALLOW.test(good), true, good);
});

test('groupCollections: own and shared, calendars before address books, then by name', () => {
  const list = [book({ displayName: 'Z' }), entry({ href: '/alice/b/', displayName: 'beta' }), entry({ href: '/alice/a/', displayName: 'Alpha' }), shared({ displayName: 'Team' })];
  const g = groupCollections(list, 'en');
  assert.deepEqual(g.own.map((c) => c.displayName), ['Alpha', 'beta', 'Z']);
  assert.deepEqual(g.shared.map((c) => c.displayName), ['Team']);
});

test('grantsByCollection: only the owner’s grants with a level', () => {
  const m = grantsByCollection(
    [
      { owner: 'alice', collection: 'cal', grantee: 'carol', level: 'readwrite' },
      { owner: 'alice', collection: 'cal', grantee: 'bob', level: 'read' },
      { owner: 'alice', collection: 'cal', grantee: 'dave', level: 'none' },
      { owner: 'zed', collection: 'cal', grantee: 'bob', level: 'read' },
      null,
    ],
    'Alice',
  );
  assert.deepEqual(m.get('cal'), [
    { grantee: 'bob', level: 'read' },
    { grantee: 'carol', level: 'readwrite' },
  ]);
});

test('pool runs at most `limit` workers at a time and stops on abort', async () => {
  let inflight = 0;
  let max = 0;
  const seen = [];
  await pool([1, 2, 3, 4, 5, 6], 2, async (x) => {
    inflight++;
    max = Math.max(max, inflight);
    await new Promise((r) => setImmediate(r));
    seen.push(x);
    inflight--;
  });
  assert.equal(max, 2);
  assert.equal(seen.length, 6);
  const ac = new AbortController();
  const done = [];
  await pool([1, 2, 3, 4], 1, async (x) => {
    done.push(x);
    if (x === 2) ac.abort();
  }, ac.signal);
  assert.deepEqual(done, [1, 2]);
});
