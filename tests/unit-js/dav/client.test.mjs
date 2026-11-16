// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, DavError, ConflictError } from '../../../src/js/dav/http.js';
import { createClient, parseMultistatus, canWriteItems, childHref } from '../../../src/js/dav/client.js';
import { NS, parseXml, find, findAll, text } from '../../../src/js/dav/xml.js';
import { makeFetch, recorded, fx, fxFile, etagOf, ORIGIN, AUTH } from './_helpers.mjs';

function setup(handler, opts) {
  const fetchImpl = makeFetch(handler);
  const transport = createTransport({ origin: ORIGIN, getAuth: () => AUTH, fetchImpl, timeoutMs: 2000 });
  return { client: createClient(transport, opts), fetchImpl };
}
const once = (name, tweak) => setup(() => recorded(name, tweak));
const lf = (s) => s.replace(/\r\n?/g, '\n');
const EV = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nEND:VEVENT\nEND:VCALENDAR\n';

test('principal() and homeSets()', async () => {
  const a = once('propfind-principal');
  assert.equal(await a.client.principal(), '/alice/');
  assert.equal(a.fetchImpl.calls[0].method, 'PROPFIND');
  assert.equal(a.fetchImpl.calls[0].path, '/');
  assert.equal(a.fetchImpl.calls[0].headers.depth, '0');
  const b = once('propfind-homesets');
  assert.deepEqual(await b.client.homeSets('/alice/'), { principal: '/alice/', calendarHomes: ['/alice/'], addressbookHomes: ['/alice/'] });
  // homeSets without argument discovers the principal first
  const c = setup((call) => (call.path === '/' ? recorded('propfind-principal') : recorded('propfind-homesets')));
  assert.equal((await c.client.homeSets()).principal, '/alice/');
  assert.equal(c.fetchImpl.calls.length, 2);
});

test('principal(): missing property is an invalid-response error; home sets default to the principal', async () => {
  const a = setup(() => ({ status: 207, body: '<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>' }));
  await assert.rejects(a.client.principal(), (e) => e.kind === 'invalid');
  const b = setup(() => ({ status: 207, body: '<multistatus xmlns="DAV:"><response><href>/bob/</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>' }));
  assert.deepEqual(await b.client.homeSets('/bob/'), { principal: '/bob/', calendarHomes: ['/bob/'], addressbookHomes: ['/bob/'] });
});

test('listCollections(): descriptors from the recorded home listing', async () => {
  const { client, fetchImpl } = once('propfind-home-depth1');
  const list = await client.listCollections('/alice/');
  assert.equal(fetchImpl.calls[0].headers.depth, '1');
  assert.deepEqual(list.map((c) => c.href).sort(), ['/alice/My%20Cal%20%2B%C3%A9%20%40~x/', '/alice/nocomp/', '/alice/people/', '/alice/shared-ro/', '/alice/shared-rw/', '/alice/work/']);
  const work = list.find((c) => c.href === '/alice/work/');
  assert.equal(work.kind, 'calendar');
  assert.equal(work.name, 'work');
  assert.equal(work.displayName, 'Work & <Play>');
  assert.equal(work.color, '#3366CC');
  assert.equal(work.description, 'Shared "team" calendar');
  assert.deepEqual(work.components, ['VEVENT', 'VTODO']);
  assert.match(work.ctag, /^"[0-9a-f]{64}"$/);
  assert.match(work.syncToken, /^http:\/\/radicale\.org\/ns\/sync\/[0-9a-f]{64}$/);
  assert.equal(work.etag, work.ctag);
  assert.deepEqual(work.privileges, ['read', 'read-free-busy', 'all', 'write', 'write-properties', 'write-content']);
  const book = list.find((c) => c.href === '/alice/people/');
  assert.equal(book.kind, 'addressbook');
  assert.deepEqual(book.components, ['VCARD']);
  assert.equal(book.description, 'Contacts');
  assert.equal(book.color, null);
  const odd = list.find((c) => c.name === 'My Cal +é @~x');
  assert.equal(odd.displayName, 'My Cal +é @~x');
  assert.equal(odd.href, '/alice/My%20Cal%20%2B%C3%A9%20%40~x/');
  assert.ok(!list.some((c) => c.href === '/alice/'), 'the home itself is not a collection');
});

test('a calendar without supported-calendar-component-set counts as {VEVENT, VTODO} (D9)', async () => {
  const stripped = (b) => b.replace(/<C:supported-calendar-component-set>.*?<\/C:supported-calendar-component-set>/g, '');
  const { client } = once('propfind-home-depth1', stripped);
  const list = await client.listCollections('/alice/');
  assert.deepEqual(list.find((c) => c.href === '/alice/work/').components, ['VEVENT', 'VTODO']);
  assert.deepEqual(list.find((c) => c.href === '/alice/people/').components, ['VCARD']);
  const empty = (b) => b.replace(/<C:supported-calendar-component-set>.*?<\/C:supported-calendar-component-set>/g, '<C:supported-calendar-component-set />');
  const e = once('propfind-home-depth1', empty);
  assert.deepEqual((await e.client.listCollections('/alice/')).find((c) => c.href === '/alice/work/').components, ['VEVENT', 'VTODO']);
});

test('privileges: read-only grantee vs read-write grantee, canWriteItems', async () => {
  const ro = await once('propfind-bob-ro-grant').client.getCollection('/alice/shared-ro/');
  assert.deepEqual(ro.privileges, ['read', 'read-free-busy']);
  assert.equal(canWriteItems(ro), false);
  const rw = await once('propfind-bob-rw-grant').client.getCollection('/alice/shared-rw/');
  assert.equal(canWriteItems(rw), true);
  assert.equal(canWriteItems({ privileges: null }), true);
  assert.equal(canWriteItems({ privileges: ['read'] }), false);
});

test('getCollection(): depth 0, errors pass through typed', async () => {
  const a = once('propfind-work-depth0');
  const c = await a.client.getCollection('/alice/work/');
  assert.equal(c.href, '/alice/work/');
  assert.equal(a.fetchImpl.calls[0].headers.depth, '0');
  await assert.rejects(once('propfind-missing').client.getCollection('/alice/nothing-here/'), (e) => e.kind === 'notfound' && e.status === 404);
  await assert.rejects(once('propfind-bob-forbidden').client.getCollection('/alice/work/'), (e) => e.kind === 'forbidden');
  await assert.rejects(once('unauthenticated').client.getCollection('/alice/work/'), (e) => e.kind === 'auth');
  await assert.rejects(once('propfind-principal').client.getCollection('/alice/'), (e) => e.kind === 'invalid');
});

test('listItemEtags(): items only, no collection', async () => {
  const { client } = once('propfind-items-etags');
  const list = await client.listItemEtags('/alice/work/');
  assert.deepEqual(list.map((i) => i.href).sort(), ['/alice/work/l1.ics', '/alice/work/l2.ics']);
  assert.ok(list.every((i) => /^"[0-9a-f]{64}"$/.test(i.etag)));
});

test('calendarQuery(): items with LF text, equal to the GET text after normalisation', async () => {
  const { client, fetchImpl } = once('query-events');
  const items = await client.calendarQuery('/alice/work/', { comp: 'VEVENT', start: '20260601T000000Z', end: '20260630T000000Z' });
  assert.equal(fetchImpl.calls[0].method, 'REPORT');
  assert.equal(fetchImpl.calls[0].headers.depth, '1');
  assert.match(fetchImpl.calls[0].body, /time-range start="20260601T000000Z" end="20260630T000000Z"/);
  const e2 = items.find((i) => i.href === '/alice/work/e2.ics');
  assert.equal(e2.etag, etagOf('get-event'));
  assert.ok(!e2.text.includes('\r'));
  assert.equal(e2.text, lf(fxFile('get-event2.ics')));
  assert.ok(fxFile('get-event2.ics').includes('\r\n'), 'the GET text is CRLF');
  assert.equal(items.length, 2);
});

test('calendarMultiget(): items, missing hrefs, text equals GET', async () => {
  const { client, fetchImpl } = once('multiget-events');
  const hrefs = ['/alice/work/e1.ics', '/alice/work/e2.ics', '/alice/work/missing.ics'];
  const { items, missing } = await client.calendarMultiget('/alice/work/', hrefs);
  assert.deepEqual(missing, ['/alice/work/missing.ics']);
  assert.deepEqual(items.map((i) => i.href).sort(), ['/alice/work/e1.ics', '/alice/work/e2.ics']);
  assert.equal(items.find((i) => i.href === '/alice/work/e2.ics').text, lf(fxFile('get-event2.ics')));
  assert.equal((fetchImpl.calls[0].body.match(/<D:href>/g) || []).length, 3);
});

test('multiget: hrefs outside the collection are refused, duplicates collapse, chunking, omitted hrefs are missing', async () => {
  const { client, fetchImpl } = once('multiget-events');
  for (const bad of ['/alice/other/e1.ics', '/alice/work/', '/alice/work/sub/e1.ics', '/alice/work/../x.ics', 'http://evil.example.net/alice/work/e1.ics']) {
    await assert.rejects(client.calendarMultiget('/alice/work/', [bad]), (e) => e.kind === 'invalid', bad);
  }
  assert.equal(fetchImpl.calls.length, 0);
  const chunks = [];
  const c = setup((call) => { chunks.push((call.body.match(/<D:href>/g) || []).length); return { status: 207, body: '<multistatus xmlns="DAV:"/>' }; }, { multigetChunk: 2 });
  const r = await c.client.calendarMultiget('/alice/work/', ['/alice/work/1.ics', '/alice/work/2.ics', '/alice/work/3.ics', '/alice/work/3.ics']);
  assert.deepEqual(chunks, [2, 1]);
  assert.deepEqual(r.missing.sort(), ['/alice/work/1.ics', '/alice/work/2.ics', '/alice/work/3.ics']);
});

test('multiget with an odd collection name keeps encoded hrefs', async () => {
  const { client } = once('multiget-odd');
  const href = '/alice/My%20Cal%20%2B%C3%A9%20%40~x/';
  const { items } = await client.calendarMultiget(href, [href + 'o1.ics']);
  assert.equal(items.length, 1);
  assert.equal(items[0].href, href + 'o1.ics');
  assert.ok(items[0].text.includes('SUMMARY:Odd collection event'));
});

test('addressbookQuery() and addressbookMultiget()', async () => {
  const q = await once('query-contacts').client.addressbookQuery('/alice/people/');
  assert.equal(q.length, 3);
  assert.ok(q.every((i) => i.text.startsWith('BEGIN:VCARD\nVERSION:3.0\n') && !i.text.includes('\r')));
  const m = await once('multiget-contacts').client.addressbookMultiget('/alice/people/', ['/alice/people/c1.vcf', '/alice/people/c2.vcf']);
  assert.equal(m.items.length, 2);
  assert.deepEqual(m.missing, []);
  assert.equal(m.items.find((i) => i.href === '/alice/people/c1.vcf').text, lf(fxFile('get-contact1.vcf')));
});

test('syncCollection(): initial, incremental (changed + removed), no change', async () => {
  const init = await once('sync-initial').client.syncCollection('/alice/work/', '');
  assert.match(init.token, /^http:\/\/radicale\.org\/ns\/sync\//);
  assert.deepEqual(init.changed.map((c) => c.href).sort(), ['/alice/work/e1.ics', '/alice/work/e2.ics', '/alice/work/e3.ics']);
  assert.deepEqual(init.removed, []);
  assert.ok(init.changed.every((c) => c.etag.startsWith('"')));
  const { client, fetchImpl } = once('sync-incremental');
  const inc = await client.syncCollection('/alice/work/', init.token);
  assert.deepEqual(inc.changed.map((c) => c.href), ['/alice/work/e4.ics']);
  assert.deepEqual(inc.removed, ['/alice/work/e3.ics']);
  assert.ok(fetchImpl.calls[0].body.includes(init.token));
  const none = await once('sync-nochange').client.syncCollection('/alice/work/', inc.token);
  assert.deepEqual([none.changed, none.removed], [[], []]);
  assert.ok(none.token);
});

test('syncCollection(): a full listing drops 404 entries for old deletions (Radicale lists them)', async () => {
  const body = '<multistatus xmlns="DAV:"><sync-token>t1</sync-token><response><href>/alice/work/old.ics</href><status>HTTP/1.1 404 Not Found</status></response><response><href>/alice/work/new.ics</href><propstat><prop><getetag>"1"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
  const full = await setup(() => ({ status: 207, body })).client.syncCollection('/alice/work/', '');
  assert.deepEqual(full.removed, []);
  assert.deepEqual(full.changed, [{ href: '/alice/work/new.ics', etag: '"1"' }]);
  const inc = await setup(() => ({ status: 207, body })).client.syncCollection('/alice/work/', 't0');
  assert.deepEqual(inc.removed, ['/alice/work/old.ics']);
});

test('syncCollection(): the 403 bodies stay available to the caller (D5)', async () => {
  const bad = await once('sync-invalid-token').client.syncCollection('/alice/work/', 'x').catch((e) => e);
  assert.ok(bad instanceof DavError);
  assert.equal(bad.kind, 'forbidden');
  assert.ok(bad.hasCondition(NS.DAV, 'valid-sync-token'));
  const lost = await once('sync-forbidden').client.syncCollection('/alice/work/', '').catch((e) => e);
  assert.equal(lost.kind, 'forbidden');
  assert.ok(!lost.hasCondition(NS.DAV, 'valid-sync-token'));
  const noToken = setup(() => ({ status: 207, body: '<multistatus xmlns="DAV:"/>' }));
  await assert.rejects(noToken.client.syncCollection('/alice/work/', ''), (e) => e.kind === 'invalid');
});

test('getItem(): etag header, LF text, content type', async () => {
  const { client, fetchImpl } = setup(() => ({ status: 200, headers: { etag: etagOf('get-event'), 'content-type': 'text/calendar; charset=utf-8' }, body: fxFile('get-event2.ics') }));
  const it = await client.getItem('/alice/work/e2.ics');
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(it.href, '/alice/work/e2.ics');
  assert.equal(it.etag, etagOf('get-event'));
  assert.equal(it.text, lf(fxFile('get-event2.ics')));
  assert.equal(it.contentType, 'text/calendar; charset=utf-8');
  await assert.rejects(once('get-missing').client.getItem('/alice/work/none.ics'), (e) => e.kind === 'notfound');
});

test('putItem(): create sends If-None-Match: *, CRLF body, content type by extension', async () => {
  const { client, fetchImpl } = once('put-event-created');
  const r = await client.putItem('/alice/work/e1.ics', EV, { create: true });
  const c = fetchImpl.calls[0];
  assert.equal(c.method, 'PUT');
  assert.equal(c.headers['if-none-match'], '*');
  assert.equal(c.headers['if-match'], undefined);
  assert.equal(c.headers['content-type'], 'text/calendar; charset=utf-8');
  assert.equal(c.body, EV.replace(/\n/g, '\r\n'));
  assert.deepEqual(r, { href: '/alice/work/e1.ics', etag: etagOf('put-event-created'), created: true });
  const v = setup(() => recorded('put-contact-c1'));
  await v.client.putItem('/alice/people/c1.vcf', 'BEGIN:VCARD\r\nEND:VCARD\r\n', { create: true });
  assert.equal(v.fetchImpl.calls[0].headers['content-type'], 'text/vcard; charset=utf-8');
  assert.equal(v.fetchImpl.calls[0].body, 'BEGIN:VCARD\r\nEND:VCARD\r\n');
});

test('putItem(): update sends If-Match with the given ETag; 204 is not "created"', async () => {
  const { client, fetchImpl } = once('put-event-updated');
  const r = await client.putItem('/alice/work/e1.ics', EV, { etag: etagOf('put-event-created') });
  const c = fetchImpl.calls[0];
  assert.equal(c.headers['if-match'], etagOf('put-event-created'));
  assert.equal(c.headers['if-none-match'], undefined);
  assert.equal(r.created, false);
  assert.equal(r.etag, etagOf('put-event-updated'));
});

test('putItem(): neither or both of {etag}/{create} throws, nothing is sent', async () => {
  const { client, fetchImpl } = once('put-event-created');
  for (const opts of [undefined, {}, { create: false }, { etag: null }, { etag: '"a"', create: true }, { etag: '*' }, { etag: '' }, { etag: '   ' }]) {
    await assert.rejects(client.putItem('/alice/work/e1.ics', EV, opts), TypeError, JSON.stringify(opts));
  }
  await assert.rejects(client.putItem('/alice/work/', EV, { create: true }), TypeError);
  await assert.rejects(client.putItem('/alice/work/e1.ics', '', { create: true }), TypeError);
  assert.equal(fetchImpl.calls.length, 0);
});

test('putItem(): a stale ETag gives ConflictError{href, sentEtag}', async () => {
  const { client } = once('put-event-stale');
  const err = await client.putItem('/alice/work/e1.ics', EV, { etag: '"old"' }).catch((e) => e);
  assert.ok(err instanceof ConflictError);
  assert.ok(err instanceof DavError);
  assert.equal(err.kind, 'precondition');
  assert.equal(err.status, 412);
  assert.equal(err.href, '/alice/work/e1.ics');
  assert.equal(err.sentEtag, '"old"');
});

test('putItem(): create of an existing item is a ConflictError with sentEtag null', async () => {
  const { client } = once('put-event-exists');
  const err = await client.putItem('/alice/work/e1.ics', EV, { create: true }).catch((e) => e);
  assert.ok(err instanceof ConflictError);
  assert.equal(err.sentEtag, null);
});

test('putItem(): read-only collection is forbidden, missing collection is a conflict, other errors pass through', async () => {
  const ro = await once('put-bob-readonly').client.putItem('/alice/shared-ro/b1.ics', EV, { create: true }).catch((e) => e);
  assert.equal(ro.kind, 'forbidden');
  assert.ok(!(ro instanceof ConflictError));
  const nf = await setup(() => ({ status: 409, body: '' })).client.putItem('/alice/nope/x.ics', EV, { create: true }).catch((e) => e);
  assert.equal(nf.kind, 'conflict');
  assert.ok(!(nf instanceof ConflictError));
  const big = await setup(() => ({ status: 413 })).client.putItem('/alice/work/x.ics', EV, { create: true }).catch((e) => e);
  assert.equal(big.kind, 'toolarge');
  const srv = await setup(() => ({ status: 500 })).client.putItem('/alice/work/x.ics', EV, { create: true }).catch((e) => e);
  assert.equal(srv.kind, 'server');
});

test('deleteItem(): If-Match with a real ETag, never *', async () => {
  const { client, fetchImpl } = once('delete-event3');
  const r = await client.deleteItem('/alice/work/e3.ics', '"abc"');
  assert.deepEqual(r, { href: '/alice/work/e3.ics' });
  assert.equal(fetchImpl.calls[0].method, 'DELETE');
  assert.equal(fetchImpl.calls[0].headers['if-match'], '"abc"');
  for (const bad of [undefined, null, '', '*', ' * ']) await assert.rejects(client.deleteItem('/alice/work/e3.ics', bad), TypeError, String(bad));
  assert.equal(fetchImpl.calls.length, 1);
});

test('deleteItem(): stale ETag is a ConflictError, missing item is notfound', async () => {
  const err = await once('delete-stale').client.deleteItem('/alice/work/e2.ics', '"deadbeef"').catch((e) => e);
  assert.ok(err instanceof ConflictError);
  assert.equal(err.sentEtag, '"deadbeef"');
  const nf = await setup(() => ({ status: 404, body: 'gone' })).client.deleteItem('/alice/work/e2.ics', '"x"').catch((e) => e);
  assert.equal(nf.kind, 'notfound');
});

test('mkcalendar(): MKCALENDAR with the properties; existing collection is a conflict', async () => {
  const { client, fetchImpl } = once('mkcalendar-ok');
  const r = await client.mkcalendar('/alice/work/', { displayName: 'Work & <Play>', color: '#3366CC', description: 'd', components: ['VEVENT', 'VTODO'] });
  assert.deepEqual(r, { href: '/alice/work/' });
  const c = fetchImpl.calls[0];
  assert.equal(c.method, 'MKCALENDAR');
  assert.match(c.headers['content-type'], /xml/);
  const prop = find(find(parseXml(c.body), NS.DAV, 'set'), NS.DAV, 'prop');
  assert.equal(text(find(prop, NS.DAV, 'displayname')), 'Work & <Play>');
  const ex = await once('mkcalendar-exists').client.mkcalendar('/alice/work/', { displayName: 'x' }).catch((e) => e);
  assert.equal(ex.kind, 'conflict');
  assert.ok(ex.hasCondition(NS.DAV, 'resource-must-be-null'));
  await assert.rejects(client.mkcalendar('/alice/work', {}), TypeError);
});

test('mkAddressbook(): extended MKCOL', async () => {
  const { client, fetchImpl } = once('mkaddressbook-ok');
  await client.mkAddressbook('/alice/people/', { displayName: 'People' });
  assert.equal(fetchImpl.calls[0].method, 'MKCOL');
  assert.match(fetchImpl.calls[0].body, /addressbook/);
  await assert.rejects(client.mkAddressbook('/alice/people', {}), TypeError);
});

test('proppatch(): success, refused request and refused property', async () => {
  const { client, fetchImpl } = once('proppatch-ok');
  assert.deepEqual(await client.proppatch('/alice/work/', 'calendar', { displayName: 'Renamed', color: '#FF0000', description: null }), { href: '/alice/work/' });
  assert.equal(fetchImpl.calls[0].method, 'PROPPATCH');
  const denied = await once('proppatch-bob-denied').client.proppatch('/alice/shared-ro/', 'calendar', { displayName: 'x' }).catch((e) => e);
  assert.equal(denied.kind, 'forbidden');
  const partial = setup(() => ({ status: 207, body: '<multistatus xmlns="DAV:"><response><href>/alice/work/</href><propstat><prop><displayname/></prop><status>HTTP/1.1 403 Forbidden</status></propstat></response></multistatus>' }));
  await assert.rejects(partial.client.proppatch('/alice/work/', 'calendar', { displayName: 'x' }), (e) => e.kind === 'forbidden' && e.status === 403);
  await assert.rejects(client.proppatch('/alice/work/', 'calendar', {}), TypeError);
});

test('deleteCollection(): needs the collection ETag, never *; stale is a ConflictError', async () => {
  const ok = once('delete-collection-ok');
  assert.deepEqual(await ok.client.deleteCollection('/alice/nocomp/', '"abc"'), { href: '/alice/nocomp/' });
  assert.equal(ok.fetchImpl.calls[0].headers['if-match'], '"abc"');
  for (const bad of [undefined, '', '*']) await assert.rejects(ok.client.deleteCollection('/alice/nocomp/', bad), TypeError);
  await assert.rejects(ok.client.deleteCollection('/alice/nocomp', '"a"'), TypeError);
  const stale = await once('delete-collection-stale').client.deleteCollection('/alice/nocomp/', '"deadbeef"').catch((e) => e);
  assert.ok(stale instanceof ConflictError);
  const bob = await once('delete-collection-bob').client.deleteCollection('/alice/shared-ro/', '"x"').catch((e) => e);
  assert.equal(bob.kind, 'forbidden');
});

test('every request goes through the transport rules (same-origin, no-store, omit)', async () => {
  const { client, fetchImpl } = once('propfind-work-depth0');
  await client.getCollection('/alice/work/');
  const c = fetchImpl.calls[0];
  assert.equal(c.init.cache, 'no-store');
  assert.equal(c.init.credentials, 'omit');
  assert.equal(c.headers.authorization, AUTH);
  await assert.rejects(client.getCollection('http://evil.example.net/alice/work/'), (e) => e.kind === 'invalid');
  await assert.rejects(client.getItem('/alice/../etc/x'), (e) => e.kind === 'invalid');
});

test('hrefs in server responses are validated: a foreign href is rejected', async () => {
  const evil = setup(() => ({ status: 207, body: '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>http://evil.example.net/x.ics</href><propstat><prop><getetag>"1"</getetag><C:calendar-data>x</C:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>' }));
  await assert.rejects(evil.client.calendarQuery('/alice/work/'), (e) => e.kind === 'invalid');
  const trav = setup(() => ({ status: 207, body: '<multistatus xmlns="DAV:"><sync-token>t</sync-token><response><href>/alice/work/../../x</href><status>HTTP/1.1 404 Not Found</status></response></multistatus>' }));
  await assert.rejects(trav.client.syncCollection('/alice/work/', ''), (e) => e.kind === 'invalid');
});

test('malformed or hostile response XML is an invalid-response error', async () => {
  for (const body of ['not xml', '<!DOCTYPE x><multistatus xmlns="DAV:"/>', '<other/>', '<multistatus xmlns="DAV:"><response>']) {
    const { client } = setup(() => ({ status: 207, body }));
    await assert.rejects(client.getCollection('/alice/work/'), (e) => e instanceof DavError && e.kind === 'invalid', body);
  }
  const plain = setup(() => ({ status: 200, body: 'ok' }));
  await assert.rejects(plain.client.getCollection('/alice/work/'), (e) => e.kind === 'invalid');
});

test('parseMultistatus and childHref', () => {
  const ms = parseMultistatus(fx('sync-incremental'));
  assert.match(ms.syncToken, /^http/);
  assert.equal(ms.responses.length, 2);
  assert.equal(ms.responses[0].status, 404);
  assert.equal(ms.responses[1].propstats[0].status, 200);
  assert.equal(childHref('/alice/', 'My Cal +é @~x', { collection: true }), '/alice/My%20Cal%20%2B%C3%A9%20%40~x/');
  assert.equal(childHref('/alice', 'e1.ics'), '/alice/e1.ics');
  for (const bad of ['', '.', '..', 'a/b', 'a\\b']) assert.throws(() => childHref('/alice/', bad), DavError);
});
