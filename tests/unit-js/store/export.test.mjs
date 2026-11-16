// SPDX-License-Identifier: AGPL-3.0-or-later
// store/export.js: file naming, whole-book export (groups filtered), fallback, calendars, single item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DavError } from '../../../src/js/dav/http.js';
import { exportCollection, exportFileName, exportItem, isGroupCardText, slugify, splitCards } from '../../../src/js/store/export.js';
import { COLL, card, groupCard, makeEnv, ops, vcf } from './_helpers.mjs';

const when = () => new Date(2026, 10, 3, 12, 0, 0); // local 2026-11-03

test('file names: <displayname-slug>-<YYYY-MM-DD>.<ext>', () => {
  assert.equal(exportFileName('Famille & Amis', 'vcf', when()), 'famille-amis-2026-11-03.vcf');
  assert.equal(exportFileName('Été à Genève', 'ics', when()), 'ete-a-geneve-2026-11-03.ics');
  assert.equal(exportFileName('', 'vcf', when()), 'export-2026-11-03.vcf');
  assert.equal(exportFileName('日本語', 'vcf', when()), 'export-2026-11-03.vcf');
  assert.equal(slugify('  --A  B--  '), 'a-b');
  assert.ok(slugify('x'.repeat(200)).length <= 60);
});

test('splitCards and isGroupCardText', () => {
  const text = card('u1', 'A') + groupCard('g', 'G', ['urn:uuid:u1']) + 'noise\n' + groupCard('g2', 'H', [], false);
  const cards = splitCards(text);
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map(isGroupCardText), [false, true, true]);
  assert.equal(isGroupCardText('BEGIN:VCARD\nNOTE:KIND:group\nEND:VCARD'), false);
});

test('whole book: one GET of the collection, group cards filtered out, CRLF text, Blob, count, Activity', async () => {
  const env = await makeEnv({ items: { 'a.vcf': card('u1', 'Alice'), 'g.vcf': groupCard('g1', 'Family', ['urn:uuid:u1']), 'k.vcf': vcf('vcard40-group-kind.vcf'), 'b.vcf': card('u2', 'Bob') } });
  env.server.calls.length = 0;
  const r = await exportCollection({ client: env.server.client, collection: { href: COLL, kind: 'addressbook', displayName: 'My Book' }, reporter: env.reporter, now: when });
  assert.equal(r.ok, true);
  assert.equal(r.filename, 'my-book-2026-11-03.vcf');
  assert.equal(r.count, 2);
  assert.equal(r.groupsExcluded, 2);
  assert.match(r.text, /FN:Alice/);
  assert.doesNotMatch(r.text, /KIND:group|Family/);
  assert.ok(r.text.includes('\r\n') && !/[^\r]\n/.test(r.text));
  assert.equal(r.blob.type, 'text/vcard;charset=utf-8');
  assert.equal(r.bytes, new TextEncoder().encode(r.text).length);
  assert.deepEqual(env.server.calls, ['GETCOLL ' + COLL]);
  assert.ok(ops(env).includes('export:ok'));
  const withGroups = await exportCollection({ client: env.server.client, collection: { href: COLL, kind: 'addressbook', displayName: 'x' }, includeGroups: true, reporter: env.reporter, now: when });
  assert.equal(withGroups.count, 4);
});

test('an empty book exports an empty file with count 0', async () => {
  const env = await makeEnv({ items: {} });
  const r = await exportCollection({ client: env.server.client, collection: { href: COLL, kind: 'addressbook', name: 'book' }, now: when });
  assert.deepEqual([r.ok, r.count, r.empty, r.text], [true, 0, true, '']);
  assert.equal(r.filename, 'book-2026-11-03.vcf');
});

test('fallback: when the collection GET fails with a server-side problem the book is built from the store item texts', async () => {
  const env = await makeEnv({ items: { 'a.vcf': card('u1', 'Alice'), 'g.vcf': groupCard('g1', 'Family', []), 'b.vcf': card('u2', 'Bob') } });
  env.server.fail('GETCOLL', new DavError('server', { status: 500 }));
  const r = await exportCollection({ client: env.server.client, collection: { href: COLL, kind: 'addressbook', displayName: 'Book' }, store: env.store, now: when });
  assert.equal(r.ok, true);
  assert.equal(r.fallback, true);
  assert.equal(r.count, 2);
  env.server.fail('GETCOLL', new DavError('invalid', {}));
  assert.equal((await exportCollection({ client: env.server.client, collection: { href: COLL, kind: 'addressbook' }, store: env.store, now: when })).fallback, true);
});

test('no fallback for auth, permission and network errors; no store means no fallback', async () => {
  const env = await makeEnv({ items: { 'a.vcf': card('u1', 'Alice') } });
  for (const [kind, status] of [['auth', 'auth'], ['forbidden', 'forbidden'], ['network', 'error']]) {
    env.server.fail('GETCOLL', new DavError(kind, {}));
    const r = await exportCollection({ client: env.server.client, collection: { href: COLL, kind: 'addressbook' }, store: env.store, reporter: env.reporter, now: when });
    assert.deepEqual([r.ok, r.status], [false, status]);
  }
  env.server.fail('GETCOLL', new DavError('server', {}));
  const nostore = await exportCollection({ client: env.server.client, collection: { href: COLL, kind: 'addressbook' }, reporter: env.reporter, now: when });
  assert.equal(nostore.ok, false);
  assert.equal(env.feedback.alert.text, 'store.err.exportFailed');
});

test('calendar: the merged VCALENDAR is returned as is (.ics), items counted', async () => {
  const ics = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:e1\nSUMMARY:One\nEND:VEVENT\nBEGIN:VEVENT\nUID:e2\nSUMMARY:Two\nEND:VEVENT\nEND:VCALENDAR\n';
  const client = { getCollectionText: async () => ({ text: ics, kind: 'calendar' }) };
  const r = await exportCollection({ client, collection: { href: '/alice/cal/', kind: 'calendar', displayName: 'Work' }, now: when });
  assert.equal(r.filename, 'work-2026-11-03.ics');
  assert.equal(r.count, 2);
  assert.equal(r.mime, 'text/calendar;charset=utf-8');
  assert.match(r.text, /^BEGIN:VCALENDAR\r\n/);
});

test('single contact: its text, named after the display name', () => {
  const r = exportItem({ text: card('u1', 'Alice'), displayName: 'Alice Example', now: when });
  assert.equal(r.filename, 'alice-example-2026-11-03.vcf');
  assert.equal(r.count, 1);
  assert.match(r.text, /^BEGIN:VCARD\r\n/);
  assert.equal(exportItem({ text: 'x', displayName: 'Cal', kind: 'calendar', now: when }).ext, 'ics');
});
