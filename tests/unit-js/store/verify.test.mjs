// SPDX-License-Identifier: AGPL-3.0-or-later
// store/verify.js: the normalised projection tolerates what Radicale does and catches what it must not tolerate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECTED_KEYS, keysOfPatch, lostNicknames, projectContact, verifyContact } from '../../../src/js/store/verify.js';
import { card, groupCard, model, radicaleLike, vcf } from './_helpers.mjs';

const v = (sent, got, keys) => verifyContact(model, { sentText: sent, gotText: got, keys });

const RICH = card('urn:uuid:u1', 'Rita Rich', [
  'N:Rich;Rita;;;',
  'item1.TEL;type=CELL;type=VOICE;type=pref:+1 555 0100',
  'item1.X-ABLabel:Night shift',
  'EMAIL;TYPE=INTERNET;TYPE=WORK:rita@example.org',
  'ADR;TYPE=HOME:;;1 Example St\\, Apt 2;Sampletown;;00000;Nowhere',
  'ORG:Example Org;Research',
  'BDAY:1990-04-01',
  'CATEGORIES:friends,colleagues',
  'NOTE:line one\\nline two\\, with comma',
  '',
].join('\n'));

test('every fixture survives a Radicale-like re-serialisation (order, case, parameter case) without a mismatch', () => {
  for (const f of ['vcard30-basic.vcf', 'vcard30-apple-labels.vcf', 'vcard30-types.vcf', 'vcard30-multi-type.vcf', 'vcard30-multi-pref.vcf', 'vcard40-multi-pref.vcf', 'vcard30-structured-lists.vcf', 'vcard30-category-comma.vcf', 'vcard30-bday-yearless.vcf', 'vcard40-tel-uri.vcf', 'vcard30-group-apple.vcf', 'vcard40-group-kind.vcf']) {
    const text = vcf(f);
    const res = v(text, radicaleLike(text));
    assert.deepEqual(res, { ok: true, mismatched: [] }, f);
  }
  assert.deepEqual(v(RICH, radicaleLike(RICH)), { ok: true, mismatched: [] });
});

test('TYPE order and repeated-vs-comma TYPE forms are irrelevant; pref and label are not', () => {
  const a = card('u', 'A', 'TEL;TYPE=CELL;TYPE=VOICE:+1 555 0100\n');
  const b = card('u', 'A', 'TEL;TYPE=voice,cell:+1 555 0100\n');
  assert.equal(v(a, b).ok, true);
  const c = card('u', 'A', 'TEL;TYPE=CELL;TYPE=pref:+1 555 0100\n');
  assert.deepEqual(v(a, c).mismatched, ['tel']);
  const d = card('u', 'A', 'item1.TEL:+1 555 0100\nitem1.X-ABLabel:Home\n');
  const e = card('u', 'A', 'item1.TEL:+1 555 0100\nitem1.X-ABLabel:Work\n');
  assert.deepEqual(v(d, e).mismatched, ['tel']);
});

test('what it must catch: changed value, missing row, truncated comma list, lost nickname, photo payload, members', () => {
  const sent = RICH;
  assert.deepEqual(v(sent, sent.replace('rita@example.org', 'rita@example.net')).mismatched, ['email']);
  assert.deepEqual(v(sent, sent.replace(/item1\.TEL.*\n/, '').replace(/item1\.X-ABLabel.*\n/, '')).mismatched, ['tel']);
  assert.deepEqual(v(sent, sent.replace('1 Example St\\, Apt 2', '1 Example St')).mismatched, ['adr']);
  assert.deepEqual(v(sent, sent.replace('line two\\, with comma', 'line two')).mismatched, ['note']);
  assert.deepEqual(v(card('u', 'A', 'NICKNAME:Jay,Janie\n'), card('u', 'A', 'NICKNAME:Jay\n')).mismatched, ['nickname']);
  assert.deepEqual(v(sent, sent.replace('friends,colleagues', 'friends')).mismatched, ['categories']);
  assert.deepEqual(v(sent, sent.replace('1990-04-01', '1990-04-02')).mismatched, ['bday']);
  assert.deepEqual(v(sent, sent.replace('ORG:Example Org;Research', 'ORG:Example Org')).mismatched, ['org']);
  const g1 = groupCard('g', 'G', ['urn:uuid:1', 'urn:uuid:2']);
  const g2 = groupCard('g', 'G', ['urn:uuid:2', 'URN:UUID:1']);
  assert.equal(v(g1, g2).ok, true); // a set, case-insensitive
  assert.deepEqual(v(g1, groupCard('g', 'G', ['urn:uuid:1'])).mismatched, ['members']);
});

test('nickname is checked even when only another key is asked for (the server cuts it on any PUT)', () => {
  const res = v(card('u', 'A', 'NICKNAME:a,b\nNOTE:x\n'), card('u', 'A', 'NICKNAME:a\nNOTE:x\n'), ['note']);
  assert.deepEqual(res.mismatched, ['nickname']);
});

test('photo: whitespace in the base64 and refolding are irrelevant, a different payload is not', () => {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
  const sent = card('u', 'A', `PHOTO;ENCODING=b;TYPE=PNG:${b64}\n`);
  const folded = card('u', 'A', `PHOTO;ENCODING=b;TYPE=PNG:${b64.slice(0, 40)}\n ${b64.slice(40)}\n`);
  assert.equal(v(sent, folded).ok, true);
  assert.deepEqual(v(sent, card('u', 'A', `PHOTO;ENCODING=b;TYPE=PNG:${b64.slice(0, 60)}AAAA\n`)).mismatched, ['photo']);
  assert.deepEqual(v(sent, card('u', 'A')).mismatched, ['photo']);
});

test('an unreadable read-back is a failure; an unreadable sent text is skipped', () => {
  const good = card('u', 'A');
  assert.deepEqual(v(good, 'garbage'), { ok: false, mismatched: [], unreadable: true });
  assert.equal(v('garbage', good).skipped, true);
});

test('keysOfPatch maps patch keys to projection keys', () => {
  assert.deepEqual(keysOfPatch({ fn: 'x', membersDelta: {}, members: [], unknown: 1, tel: [] }).sort(), ['fn', 'members', 'tel']);
  assert.deepEqual(keysOfPatch(null), []);
  assert.ok(PROJECTED_KEYS.includes('photo'));
  const item = model.openItem(RICH, 'contact');
  assert.deepEqual(Object.keys(projectContact(item, ['fn', 'tel'])), ['fn', 'tel']);
});

test('lostNicknames: only unescaped comma values after the first', () => {
  assert.deepEqual(lostNicknames('BEGIN:VCARD\nNICKNAME:a,b,c\nEND:VCARD'), ['b', 'c']);
  assert.deepEqual(lostNicknames('NICKNAME:a\\,b'), []);
  assert.deepEqual(lostNicknames('item1.NICKNAME;TYPE=x:a,\n b'), ['b']);
  assert.deepEqual(lostNicknames('FN:a,b'), []);
  assert.deepEqual(lostNicknames(vcf('vcard30-multi-nickname.vcf')), ['Nicky', 'Nine']);
});
