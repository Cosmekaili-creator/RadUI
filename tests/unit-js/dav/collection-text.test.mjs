// SPDX-License-Identifier: AGPL-3.0-or-later
// getCollectionText(): GET of a whole collection (export).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../../src/js/dav/http.js';
import { createClient } from '../../../src/js/dav/client.js';
import { makeFetch, ORIGIN, AUTH } from './_helpers.mjs';

function setup(handler, transportOpts) {
  const fetchImpl = makeFetch(handler);
  const transport = createTransport({ origin: ORIGIN, getAuth: () => AUTH, fetchImpl, timeoutMs: 2000, ...(transportOpts || {}) });
  return { client: createClient(transport), fetchImpl };
}
const CAL = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//EN\r\nBEGIN:VEVENT\r\nUID:a\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const CARDS = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a\r\nFN:A\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nUID:b\r\nFN:B\r\nEND:VCARD\r\n';
const ok = (body, type, extra = {}) => ({ status: 200, headers: { 'content-type': type, etag: '"c1"', ...extra }, body });

test('getCollectionText(): a calendar comes back as one LF text with its ETag and content type', async () => {
  const { client, fetchImpl } = setup(() => ok(CAL, 'text/calendar; charset=utf-8'));
  const r = await client.getCollectionText('/alice/work/');
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(fetchImpl.calls[0].path, '/alice/work/');
  assert.equal(fetchImpl.calls[0].headers.authorization, AUTH);
  assert.deepEqual([r.href, r.kind, r.etag, r.contentType], ['/alice/work/', 'calendar', '"c1"', 'text/calendar; charset=utf-8']);
  assert.equal(r.text, CAL.replace(/\r\n/g, '\n'));
  assert.ok(!r.text.includes('\r'));
});

test('getCollectionText(): an address book (several vCards one after the other)', async () => {
  const { client } = setup(() => ok(CARDS, 'text/vcard; charset=utf-8'));
  const r = await client.getCollectionText('/alice/people/');
  assert.equal(r.kind, 'addressbook');
  assert.equal(r.text.match(/BEGIN:VCARD/g).length, 2);
});

test('getCollectionText(): an empty collection is text "" and kind empty', async () => {
  const { client } = setup(() => ({ status: 200, headers: { 'content-type': 'text/calendar' }, body: '' }));
  assert.deepEqual(await client.getCollectionText('/alice/work/'), { href: '/alice/work/', etag: null, text: '', contentType: 'text/calendar', kind: 'empty' });
});

test('getCollectionText(): href checks (collection path, same origin, canonical)', async () => {
  const { client, fetchImpl } = setup(() => ok(CAL, 'text/calendar'));
  await assert.rejects(client.getCollectionText('/alice/work'), TypeError);
  await assert.rejects(client.getCollectionText('/alice/../etc/'), (e) => e.kind === 'invalid');
  await assert.rejects(client.getCollectionText('http://evil.example.net/x/'), (e) => e.kind === 'invalid');
  assert.equal(fetchImpl.calls.length, 0, 'nothing is sent for a bad href');
  const odd = await client.getCollectionText('/alice/My Cal/');
  assert.equal(odd.href, '/alice/My%20Cal/');
});

test('getCollectionText(): typed errors (auth, forbidden, notfound, server, network, toolarge, invalid)', async () => {
  const kinds = { 401: 'auth', 403: 'forbidden', 404: 'notfound', 500: 'server' };
  for (const [status, kind] of Object.entries(kinds)) {
    const { client } = setup(() => ({ status: Number(status), body: 'no' }));
    await assert.rejects(client.getCollectionText('/alice/work/'), (e) => e.kind === kind && e.status === Number(status), status);
  }
  const net = setup(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(net.client.getCollectionText('/alice/work/'), (e) => e.kind === 'network');
  // the caller's cap, and the transport's cap on Content-Length
  const small = setup(() => ok(CAL, 'text/calendar'));
  await assert.rejects(small.client.getCollectionText('/alice/work/', { maxBytes: 50 }), (e) => e.kind === 'toolarge');
  const capped = setup(() => ok(CAL, 'text/calendar', { 'content-length': String(CAL.length) }), { maxResponseBytes: 10 });
  await assert.rejects(capped.client.getCollectionText('/alice/work/'), (e) => e.kind === 'toolarge');
  // an HTML error page from a proxy is not collection data
  const html = setup(() => ok('<html><body>Bad gateway</body></html>', 'text/html'));
  await assert.rejects(html.client.getCollectionText('/alice/work/'), (e) => e.kind === 'invalid');
});

test('getCollectionText(): leading blank lines and a lower-case BEGIN are tolerated for the kind check', async () => {
  const { client } = setup(() => ok('\n\nbegin:vcalendar\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', 'text/calendar'));
  assert.equal((await client.getCollectionText('/a/b/')).kind, 'calendar');
});
