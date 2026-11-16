// SPDX-License-Identifier: AGPL-3.0-or-later
// Integration tests for the DAV layer against a throwaway Radicale.
// Run through tests/integration/dav/run.sh (starts and removes the instance).
import assert from 'node:assert/strict';
import { DavError, ConflictError } from '../../../src/js/dav/http.js';
import { NS } from '../../../src/js/dav/xml.js';
import { canWriteItems, childHref } from '../../../src/js/dav/client.js';
import { discoverAccessible } from '../../../src/js/dav/discovery.js';
import { createSyncState, syncStep, resetStatus } from '../../../src/js/dav/sync.js';
import { it, clientFor, rawFetch, uid, ics, todo, vcard, lf, semantic, unfold } from './env.mjs';

const alice = () => clientFor('alice');
const run = uid();
const CAL = '/alice/it-cal-' + run + '/';
const BOOK = '/alice/it-book-' + run + '/';
const ODD_NAME = 'My Cal +é @~x ' + run;
const ODD = childHref('/alice/', ODD_NAME, { collection: true });
const SHARED_RW = '/alice/shared-rw/';
const SHARED_RO = '/alice/shared-ro/';

it('principal, home sets and an empty listing', async () => {
  const c = alice();
  assert.equal(await c.principal(), '/alice/');
  assert.deepEqual(await c.homeSets(), { principal: '/alice/', calendarHomes: ['/alice/'], addressbookHomes: ['/alice/'] });
  assert.ok(Array.isArray(await c.listCollections('/alice/')));
});

it('mkcalendar and mkAddressbook create collections that list with their properties', async () => {
  const c = alice();
  await c.mkcalendar(CAL, { displayName: 'Integration <cal> & co', color: '#3366CC', description: 'Line one\nLine "two"', components: ['VEVENT', 'VTODO'] });
  await c.mkAddressbook(BOOK, { displayName: 'Integration book', description: 'People' });
  const list = await c.listCollections('/alice/');
  const cal = list.find((x) => x.href === CAL);
  assert.equal(cal.kind, 'calendar');
  assert.equal(cal.displayName, 'Integration <cal> & co');
  assert.equal(cal.color, '#3366CC');
  assert.equal(cal.description, 'Line one\nLine "two"');
  assert.deepEqual(cal.components.slice().sort(), ['VEVENT', 'VTODO']);
  assert.ok(cal.ctag && cal.syncToken && cal.etag);
  assert.ok(canWriteItems(cal));
  const book = list.find((x) => x.href === BOOK);
  assert.equal(book.kind, 'addressbook');
  assert.equal(book.displayName, 'Integration book');
  assert.equal(book.description, 'People');
  const one = await c.getCollection(CAL);
  assert.equal(one.href, CAL);
  assert.equal(one.displayName, cal.displayName);
});

it('creating an existing collection is a conflict error', async () => {
  const c = alice();
  await assert.rejects(c.mkcalendar(CAL, { displayName: 'again' }), (e) => e instanceof DavError && e.kind === 'conflict' && e.hasCondition(NS.DAV, 'resource-must-be-null'));
  await assert.rejects(c.mkAddressbook(BOOK, {}), (e) => e instanceof DavError && ['conflict', 'invalid'].includes(e.kind));
});

it('odd collection names (space, unicode, +, @, ~) round-trip end to end', async () => {
  const c = alice();
  await c.mkcalendar(ODD, { displayName: ODD_NAME, components: ['VEVENT'] });
  const found = (await c.listCollections('/alice/')).find((x) => x.name === ODD_NAME);
  assert.ok(found, 'listed with the decoded name');
  assert.equal(found.href, ODD);
  const href = ODD + 'o1.ics';
  const put = await c.putItem(href, ics('odd-' + run, 'Odd name event'), { create: true });
  assert.equal(put.created, true);
  const { items, missing } = await c.calendarMultiget(ODD, [href]);
  assert.deepEqual(missing, []);
  assert.equal(items[0].href, href);
  assert.equal(items[0].etag, put.etag);
  const sync = await c.syncCollection(ODD, '');
  assert.deepEqual(sync.changed.map((x) => x.href), [href]);
  const etag = (await c.getItem(href)).etag;
  await c.deleteItem(href, etag);
  const col = await c.getCollection(ODD);
  await c.deleteCollection(ODD, col.etag);
  await assert.rejects(c.getCollection(ODD), (e) => e.kind === 'notfound');
});

it('event CRUD with correct ETags, 412 on a stale ETag, create-exists precondition', async () => {
  const c = alice();
  const href = CAL + 'e1.ics';
  const created = await c.putItem(href, ics('e1-' + run, 'First'), { create: true });
  assert.equal(created.created, true);
  assert.match(created.etag, /^"[0-9a-f]+"$/);
  // the ETag of the PUT response is the one GET reports
  const got = await c.getItem(href);
  assert.equal(got.etag, created.etag);
  assert.ok(got.text.includes('SUMMARY:First'));
  assert.ok(!got.text.includes('\r'), 'LF in memory');
  // create again: precondition failed
  await assert.rejects(c.putItem(href, ics('e1-' + run, 'Again'), { create: true }), (e) => e instanceof ConflictError && e.href === href && e.sentEtag === null && e.status === 412);
  // update with the right ETag
  const upd = await c.putItem(href, ics('e1-' + run, 'Second'), { etag: created.etag });
  assert.equal(upd.created, false);
  assert.notEqual(upd.etag, created.etag);
  assert.equal((await c.getItem(href)).etag, upd.etag);
  // update with the stale ETag
  await assert.rejects(c.putItem(href, ics('e1-' + run, 'Stale'), { etag: created.etag }), (e) => e instanceof ConflictError && e.sentEtag === created.etag && e.href === href);
  assert.ok((await c.getItem(href)).text.includes('SUMMARY:Second'), 'the stale write changed nothing');
  // delete with the stale ETag, then with the right one
  await assert.rejects(c.deleteItem(href, created.etag), (e) => e instanceof ConflictError && e.sentEtag === created.etag);
  await c.deleteItem(href, upd.etag);
  await assert.rejects(c.getItem(href), (e) => e.kind === 'notfound');
  await assert.rejects(c.deleteItem(href, upd.etag), (e) => e.kind === 'notfound');
});

it('putItem and deleteItem refuse to run without an ETag decision', async () => {
  const c = alice();
  await assert.rejects(c.putItem(CAL + 'x.ics', ics('x', 'x'), {}), TypeError);
  await assert.rejects(c.deleteItem(CAL + 'x.ics'), TypeError);
  await assert.rejects(c.deleteItem(CAL + 'x.ics', '*'), TypeError);
});

it('writes into a collection that does not exist fail with a typed error', async () => {
  const c = alice();
  await assert.rejects(c.putItem('/alice/no-such-' + run + '/x.ics', ics('x', 'x'), { create: true }), (e) => e instanceof DavError && ['conflict', 'notfound'].includes(e.kind));
});

it('contact CRUD, multiget text equals GET text after LF normalisation', async () => {
  const c = alice();
  const href = BOOK + 'c1.vcf';
  const long = 'NOTE:' + 'café 中文 '.repeat(30);
  const created = await c.putItem(href, vcard('c1-' + run, 'Ada Lovelace', [long, 'TEL;TYPE=CELL:+1-555-0100']), { create: true });
  const got = await c.getItem(href);
  assert.equal(got.etag, created.etag);
  assert.ok(!got.text.includes('\r'));
  assert.equal(unfold(got.text).includes(long), true, 'unfolded NOTE survives');
  const { items } = await c.addressbookMultiget(BOOK, [href]);
  assert.equal(items[0].text, got.text);
  assert.equal(items[0].etag, got.etag);
  const q = await c.addressbookQuery(BOOK);
  assert.equal(q.length, 1);
  assert.equal(q[0].text, got.text);
  const raw = await (await rawFetch('alice', href)).text();
  assert.ok(raw.includes('\r\n'), 'the server serves CRLF');
  assert.equal(lf(raw), got.text);
  const upd = await c.putItem(href, vcard('c1-' + run, 'Ada Byron'), { etag: created.etag });
  await assert.rejects(c.putItem(href, vcard('c1-' + run, 'Stale'), { etag: created.etag }), ConflictError);
  await c.deleteItem(href, upd.etag);
  assert.deepEqual(await c.addressbookQuery(BOOK), []);
});

it('event text: multiget, calendar-query and GET agree after LF normalisation; PUT then GET is semantically equal', async () => {
  const c = alice();
  const href = CAL + 'e2.ics';
  const body = ics('e2-' + run, 'Café 中文 \u{1F600} a\\, b\\; c', '20260602T140000Z', ['DESCRIPTION:' + 'long line '.repeat(30) + 'end', 'X-CUSTOM;X-PARAM=a:custom value']);
  const created = await c.putItem(href, body, { create: true });
  const got = await c.getItem(href);
  assert.deepEqual(semantic(got.text), semantic(body), 'only order/folding may differ');
  const { items } = await c.calendarMultiget(CAL, [href]);
  assert.equal(items[0].text, got.text);
  const queried = (await c.calendarQuery(CAL, { comp: 'VEVENT' })).find((i) => i.href === href);
  assert.equal(queried.text, got.text);
  assert.equal(queried.etag, created.etag);
  const raw = await (await rawFetch('alice', href)).text();
  assert.equal(lf(raw), got.text);
  // CRLF on the wire: the server stores what we sent (LF input is converted)
  assert.ok(/\r\n/.test(raw) && !/[^\r]\n/.test(raw));
  await c.deleteItem(href, got.etag);
});

it('characterisation: Radicale truncates an unescaped comma in a TEXT value (writers must escape)', async () => {
  const c = alice();
  const href = CAL + 'comma.ics';
  const created = await c.putItem(href, ics('comma-' + run, 'Escaped\\, comma', '20260601T090000Z', ['DESCRIPTION:Unescaped, comma']), { create: true });
  const got = await c.getItem(href);
  const lines = unfold(got.text).split('\n');
  assert.ok(lines.includes('SUMMARY:Escaped\\, comma'), 'an escaped comma round-trips');
  // Documents server behaviour, not RadUI behaviour: if this starts failing, vobject changed.
  assert.ok(lines.includes('DESCRIPTION:Unescaped'), 'the text after an unescaped comma is dropped by the server');
  await c.deleteItem(href, created.etag);
});

it('calendar-query: time range and component filter', async () => {
  const c = alice();
  const inJune = CAL + 'q-june.ics';
  const inJuly = CAL + 'q-july.ics';
  const task = CAL + 'q-task.ics';
  await c.putItem(inJune, ics('qj-' + run, 'June', '20260610T100000Z'), { create: true });
  await c.putItem(inJuly, ics('qy-' + run, 'July', '20260710T100000Z'), { create: true });
  await c.putItem(task, todo('qt-' + run, 'A task'), { create: true });
  const june = await c.calendarQuery(CAL, { comp: 'VEVENT', start: new Date(Date.UTC(2026, 5, 1)), end: new Date(Date.UTC(2026, 5, 30)) });
  assert.deepEqual(june.map((i) => i.href), [inJune]);
  const all = await c.calendarQuery(CAL, { comp: 'VEVENT' });
  assert.deepEqual(all.map((i) => i.href).sort(), [inJuly, inJune].sort());
  const tasks = await c.calendarQuery(CAL, { comp: 'VTODO' });
  assert.deepEqual(tasks.map((i) => i.href), [task]);
  for (const h of [inJune, inJuly, task]) await c.deleteItem(h, (await c.getItem(h)).etag);
});

it('a large item (300 KB) survives PUT, GET and multiget', async () => {
  const c = alice();
  const href = CAL + 'big.ics';
  const desc = 'x'.repeat(300000);
  const body = ics('big-' + run, 'Big', '20260601T090000Z', ['DESCRIPTION:' + desc]);
  const created = await c.putItem(href, body, { create: true });
  const got = await c.getItem(href);
  assert.ok(unfold(got.text).includes('DESCRIPTION:' + desc));
  const { items } = await c.calendarMultiget(CAL, [href]);
  assert.equal(items[0].text, got.text);
  await c.deleteItem(href, created.etag);
});

it('multiget reports missing items; items outside the collection are refused', async () => {
  const c = alice();
  const href = CAL + 'm1.ics';
  await c.putItem(href, ics('m1-' + run, 'M'), { create: true });
  const r = await c.calendarMultiget(CAL, [href, CAL + 'does-not-exist.ics']);
  assert.deepEqual(r.items.map((i) => i.href), [href]);
  assert.deepEqual(r.missing, [CAL + 'does-not-exist.ics']);
  await assert.rejects(c.calendarMultiget(CAL, ['/alice/other/x.ics']), (e) => e.kind === 'invalid');
  await c.deleteItem(href, (await c.getItem(href)).etag);
});

it('proppatch changes name, colour and removes the description', async () => {
  const c = alice();
  await c.proppatch(CAL, 'calendar', { displayName: 'Renamed', color: '#FF0000', description: null });
  const got = await c.getCollection(CAL);
  assert.equal(got.displayName, 'Renamed');
  assert.equal(got.color, '#FF0000');
  assert.equal(got.description, null);
  await c.proppatch(BOOK, 'addressbook', { displayName: 'Renamed book', description: 'New text' });
  const book = await c.getCollection(BOOK);
  assert.equal(book.displayName, 'Renamed book');
  assert.equal(book.description, 'New text');
});

it('sync-collection: token round trip with changes and removals', async () => {
  const c = alice();
  const a = CAL + 's-a.ics';
  const b = CAL + 's-b.ics';
  await c.putItem(a, ics('sa-' + run, 'A'), { create: true });
  const first = await c.syncCollection(CAL, '');
  assert.match(first.token, /^http:\/\/radicale\.org\/ns\/sync\/[0-9a-f]{64}$/);
  assert.ok(first.changed.some((x) => x.href === a));
  assert.deepEqual(first.removed, [], 'a full listing never reports removals (the server may list old deletions)');
  const idle = await c.syncCollection(CAL, first.token);
  assert.deepEqual([idle.changed, idle.removed], [[], []]);
  assert.equal(idle.token, first.token);
  const pb = await c.putItem(b, ics('sb-' + run, 'B'), { create: true });
  const aEtag = (await c.getItem(a)).etag;
  await c.deleteItem(a, aEtag);
  const inc = await c.syncCollection(CAL, first.token);
  assert.deepEqual(inc.changed, [{ href: b, etag: pb.etag }]);
  assert.deepEqual(inc.removed, [a]);
  assert.notEqual(inc.token, first.token);
  await c.deleteItem(b, pb.etag);
});

it('sync-collection: an invalid or garbage token is a 403 carrying DAV:valid-sync-token', async () => {
  const c = alice();
  for (const token of ['http://radicale.org/ns/sync/' + '0'.repeat(64), 'not-a-token']) {
    await assert.rejects(c.syncCollection(CAL, token), (e) => e instanceof DavError && e.kind === 'forbidden' && e.status === 403 && e.hasCondition(NS.DAV, 'valid-sync-token'));
  }
});

it('syncStep end to end: initial, incremental, invalid token resync (D5), ctag fallback', async () => {
  const c = alice();
  const name = 'sync-' + run + '/';
  const href = '/alice/' + name;
  await c.mkcalendar(href, { displayName: 'Sync test' });
  await c.putItem(href + 'a.ics', ics('sya-' + run, 'A'), { create: true });
  await c.putItem(href + 'b.ics', ics('syb-' + run, 'B'), { create: true });
  let r = await syncStep(c, createSyncState({ href, kind: 'calendar' }));
  assert.equal(r.via, 'sync');
  assert.deepEqual(r.upserted.map((i) => i.href).sort(), [href + 'a.ics', href + 'b.ics']);
  assert.ok(r.upserted.every((i) => i.text.startsWith('BEGIN:VCALENDAR\n')));
  let state = r.state;
  // incremental
  const aEtag = (await c.getItem(href + 'a.ics')).etag;
  await c.deleteItem(href + 'a.ics', aEtag);
  await c.putItem(href + 'c.ics', ics('syc-' + run, 'C'), { create: true });
  r = await syncStep(c, state);
  assert.equal(r.via, 'sync');
  assert.deepEqual(r.upserted.map((i) => i.href), [href + 'c.ics']);
  assert.deepEqual(r.removed, [href + 'a.ics']);
  state = r.state;
  // invalid token: dropped, one resync, nothing refetched, nothing lost
  r = await syncStep(c, { ...state, token: 'http://radicale.org/ns/sync/' + 'f'.repeat(64) });
  assert.equal(r.via, 'resync');
  assert.equal(r.signals.tokenReset, true);
  assert.deepEqual(r.upserted, []);
  assert.deepEqual(r.removed, []);
  state = r.state;
  // ctag mode against the real server
  await c.putItem(href + 'd.ics', ics('syd-' + run, 'D'), { create: true });
  const cb = await syncStep(c, { ...state, mode: 'ctag', token: null });
  assert.equal(cb.via, 'etag-list');
  assert.deepEqual(cb.upserted.map((i) => i.href), [href + 'd.ics']);
  const again = await syncStep(c, cb.state);
  assert.equal(again.via, 'ctag');
  assert.deepEqual([again.upserted, again.removed], [[], []]);
  const col = await c.getCollection(href);
  await c.deleteCollection(href, col.etag);
});

it('deleteCollection needs the right collection ETag', async () => {
  const c = alice();
  const href = '/alice/del-' + run + '/';
  await c.mkcalendar(href, { displayName: 'to delete' });
  const col = await c.getCollection(href);
  await assert.rejects(c.deleteCollection(href, '"stale"'), (e) => e instanceof ConflictError && e.sentEtag === '"stale"');
  await assert.rejects(c.deleteCollection(href, '*'), TypeError);
  await c.deleteCollection(href, col.etag);
  await assert.rejects(c.getCollection(href), (e) => e.kind === 'notfound');
});

it('wrong password: one auth error, no retry; the hook fires once', async () => {
  const calls = [];
  let hooks = 0;
  const bad = clientFor('alice', { pw: 'definitely-wrong', calls, onUnauthorized: () => hooks++ });
  await assert.rejects(bad.principal(), (e) => e instanceof DavError && e.kind === 'auth' && e.status === 401);
  assert.equal(calls.length, 1);
  assert.equal(hooks, 1);
});

it('10 parallel creates all succeed with distinct ETags', async () => {
  const c = alice();
  const names = Array.from({ length: 10 }, (_, i) => CAL + 'p' + i + '.ics');
  const results = await Promise.all(names.map((h, i) => c.putItem(h, ics('par' + i + '-' + run, 'P' + i), { create: true })));
  assert.equal(new Set(results.map((r) => r.etag)).size, 10);
  const { items } = await c.calendarMultiget(CAL, names);
  assert.equal(items.length, 10);
  for (const r of results) await c.deleteItem(r.href, r.etag);
});

// ------------------------------------------------------------ sharing (bob)

it('grants: setup by the owner', async () => {
  const c = alice();
  for (const [href, name] of [[SHARED_RW, 'Shared RW'], [SHARED_RO, 'Shared RO']]) {
    await c.mkcalendar(href, { displayName: name, components: ['VEVENT'] }).catch((e) => {
      if (!(e.kind === 'conflict')) throw e;
    });
  }
  await c.putItem(SHARED_RO + 'ro-' + run + '.ics', ics('ro-' + run, 'Read-only item'), { create: true });
});

it('discovery for a grantee: own home plus grants, with a missing/forbidden grant flagged', async () => {
  const bob = clientFor('bob');
  const api = { meAccess: async () => ({ grants: [
    { href: SHARED_RW, owner: 'alice', collection: 'shared-rw', level: 'readwrite' },
    { href: SHARED_RO, owner: 'alice', collection: 'shared-ro', level: 'read' },
    { href: CAL, owner: 'alice', collection: CAL.split('/')[2], level: 'read' }, // not granted by the rights file
  ] }) };
  const r = await discoverAccessible(bob, api);
  assert.equal(r.apiError, null);
  const by = Object.fromEntries(r.collections.map((x) => [x.href, x]));
  assert.equal(by[SHARED_RW].status, 'ok');
  assert.equal(by[SHARED_RW].source, 'grant');
  assert.equal(canWriteItems(by[SHARED_RW]), true);
  assert.equal(by[SHARED_RO].status, 'ok');
  assert.equal(canWriteItems(by[SHARED_RO]), false);
  assert.deepEqual(by[SHARED_RO].privileges, ['read', 'read-free-busy']);
  assert.equal(by[CAL].status, 'inaccessible');
  // the owner's collections are never listed to bob without a grant
  assert.ok(!r.collections.some((x) => x.source === 'own' && x.href.startsWith('/alice/')));
  // with the backend down, bob's own listing still works
  const down = await discoverAccessible(bob, { meAccess: async () => { throw new DavError('network', { message: 'backend down' }); } });
  assert.ok(down.apiError);
  assert.deepEqual(down.collections.filter((x) => x.source === 'grant'), []);
});

it('discovery for the owner lists everything she owns and the backend failure changes nothing', async () => {
  const c = alice();
  const r = await discoverAccessible(c, null);
  const hrefs = r.collections.map((x) => x.href);
  for (const h of [CAL, BOOK, SHARED_RW, SHARED_RO]) assert.ok(hrefs.includes(h), h);
  assert.ok(r.collections.every((x) => x.source === 'own' && x.status === 'ok' && x.owner === 'alice'));
});

it('a read-only grantee can read but gets forbidden on PUT, DELETE, PROPPATCH and collection delete', async () => {
  const bob = clientFor('bob');
  const alicec = alice();
  const roItem = SHARED_RO + 'ro-' + run + '.ics';
  const got = await bob.getItem(roItem);
  assert.ok(got.text.includes('Read-only item'));
  const col = await bob.getCollection(SHARED_RO);
  const list = await bob.calendarQuery(SHARED_RO, { comp: 'VEVENT' });
  assert.ok(list.some((i) => i.href === roItem));
  await assert.rejects(bob.putItem(SHARED_RO + 'bob-' + run + '.ics', ics('bob-' + run, 'Nope'), { create: true }), (e) => e instanceof DavError && e.kind === 'forbidden' && !(e instanceof ConflictError));
  await assert.rejects(bob.putItem(roItem, ics('ro-' + run, 'Changed'), { etag: got.etag }), (e) => e.kind === 'forbidden');
  await assert.rejects(bob.deleteItem(roItem, got.etag), (e) => e.kind === 'forbidden');
  await assert.rejects(bob.proppatch(SHARED_RO, 'calendar', { displayName: 'hijack' }), (e) => e.kind === 'forbidden');
  await assert.rejects(bob.deleteCollection(SHARED_RO, col.etag), (e) => e.kind === 'forbidden');
  await assert.rejects(bob.syncCollection(CAL, ''), (e) => e.kind === 'forbidden' && !e.hasCondition(NS.DAV, 'valid-sync-token'), 'no access to the owner\'s other collections');
  // nothing changed
  assert.equal((await alicec.getItem(roItem)).text, got.text);
});

it('a read-write grantee can create, update and delete items, but not delete the collection', async () => {
  const bob = clientFor('bob');
  const href = SHARED_RW + 'bob-' + run + '.ics';
  const created = await bob.putItem(href, ics('bobrw-' + run, 'From bob'), { create: true });
  const seenByOwner = await alice().getItem(href);
  assert.equal(seenByOwner.etag, created.etag);
  const upd = await bob.putItem(href, ics('bobrw-' + run, 'From bob\\, edited'), { etag: created.etag });
  await assert.rejects(alice().putItem(href, ics('bobrw-' + run, 'Owner edit on stale'), { etag: created.etag }), ConflictError);
  await bob.deleteItem(href, upd.etag);
  const col = await bob.getCollection(SHARED_RW);
  await assert.rejects(bob.deleteCollection(SHARED_RW, col.etag), (e) => e.kind === 'forbidden');
  await assert.rejects(bob.proppatch(SHARED_RW, 'calendar', { displayName: 'hijack' }), (e) => e.kind === 'forbidden');
  assert.equal((await alice().getCollection(SHARED_RW)).displayName, 'Shared RW');
});

it('syncStep as a grantee loses access cleanly (D5: 403 without valid-sync-token)', async () => {
  const bob = clientFor('bob');
  const state = createSyncState({ href: CAL, kind: 'calendar' }); // bob has no rights here
  const r = await syncStep(bob, state);
  assert.equal(r.state.status, 'inaccessible');
  assert.equal(r.signals.refetchAccess, true);
  assert.equal(resetStatus(r.state).status, 'ok');
  const ok = await syncStep(bob, createSyncState({ href: SHARED_RW, kind: 'calendar' }));
  assert.equal(ok.state.status, 'ok');
  assert.equal(ok.via, 'sync');
});

it('cleanup: owner removes the test collections', async () => {
  const c = alice();
  for (const href of [CAL, BOOK]) {
    const col = await c.getCollection(href);
    await c.deleteCollection(href, col.etag);
  }
});
