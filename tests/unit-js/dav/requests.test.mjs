// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import * as RQ from '../../../src/js/dav/requests.js';
import { parseXml, find, findAll, findPath, text, NS } from '../../../src/js/dav/xml.js';

const D = NS.DAV;
const C = NS.CALDAV;
const CR = NS.CARDDAV;

test('propfind: props, depth, escaping of nothing user-controlled', () => {
  const r = RQ.propfind([RQ.PROP.displayname, RQ.PROP.calendarColor, RQ.PROP.privileges], { depth: 1 });
  assert.equal(r.method, 'PROPFIND');
  assert.equal(r.depth, 1);
  const root = parseXml(r.body);
  assert.equal(root.name, 'propfind');
  assert.deepEqual(find(root, D, 'prop').children.map((c) => c.ns + '|' + c.name), [D + '|displayname', NS.ICAL + '|calendar-color', D + '|current-user-privilege-set']);
  assert.throws(() => RQ.propfind([RQ.PROP.displayname], { depth: 2 }), TypeError);
  assert.equal(RQ.propfind([RQ.PROP.displayname]).depth, 0);
});

test('calendarQuery: comp filter and UTC time range from Date or string', () => {
  const r = RQ.calendarQuery({ comp: 'VEVENT', start: new Date(Date.UTC(2026, 5, 1, 0, 0, 0)), end: '20260701T000000Z' });
  assert.equal(r.method, 'REPORT');
  assert.equal(r.depth, 1);
  const root = parseXml(r.body);
  assert.equal(root.ns, C);
  assert.equal(root.name, 'calendar-query');
  const outer = findPath(root, [[C, 'filter'], [C, 'comp-filter']]);
  assert.equal(outer.attrs.name, 'VCALENDAR');
  const inner = find(outer, C, 'comp-filter');
  assert.equal(inner.attrs.name, 'VEVENT');
  const tr = find(inner, C, 'time-range');
  assert.equal(tr.attrs.start, '20260601T000000Z');
  assert.equal(tr.attrs.end, '20260701T000000Z');
  assert.deepEqual(find(root, D, 'prop').children.map((c) => c.name), ['getetag', 'calendar-data']);
});

test('calendarQuery: no range, open range, VTODO, validation', () => {
  const none = parseXml(RQ.calendarQuery({ comp: 'VTODO' }).body);
  const inner = find(findPath(none, [[C, 'filter'], [C, 'comp-filter']]), C, 'comp-filter');
  assert.equal(inner.attrs.name, 'VTODO');
  assert.equal(find(inner, C, 'time-range'), null);
  const open = parseXml(RQ.calendarQuery({ start: '20260101T000000Z' }).body);
  const tr = find(findPath(open, [[C, 'filter'], [C, 'comp-filter']]), C, 'comp-filter');
  assert.equal(find(tr, C, 'time-range').attrs.end, undefined);
  assert.throws(() => RQ.calendarQuery({ comp: 'VEVENT"><x' }), TypeError);
  assert.throws(() => RQ.calendarQuery({ comp: 'vevent' }), TypeError);
  assert.throws(() => RQ.calendarQuery({ start: '2026-06-01' }), TypeError);
  assert.throws(() => RQ.calendarQuery({ start: new Date('nope') }), TypeError);
  assert.equal(RQ.toUtcStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678))), '20260102T030405Z');
});

test('multiget builders: hrefs escaped, chunks validated', () => {
  const hrefs = ['/alice/work/a.ics', '/alice/work/a&b<c>.ics'];
  for (const [fn, ns, name] of [[RQ.calendarMultiget, C, 'calendar-multiget'], [RQ.addressbookMultiget, CR, 'addressbook-multiget']]) {
    const r = fn(hrefs);
    assert.equal(r.method, 'REPORT');
    const root = parseXml(r.body);
    assert.equal(root.ns, ns);
    assert.equal(root.name, name);
    assert.deepEqual(findAll(root, D, 'href').map((h) => text(h)), hrefs);
    assert.throws(() => fn([]), TypeError);
  }
  assert.deepEqual(find(parseXml(RQ.addressbookMultiget(['/a/b.vcf']).body), D, 'prop').children.map((c) => c.name), ['getetag', 'address-data']);
});

test('addressbookQuery', () => {
  const r = RQ.addressbookQuery();
  const root = parseXml(r.body);
  assert.equal(root.ns, CR);
  assert.equal(root.name, 'addressbook-query');
  assert.deepEqual(find(root, D, 'prop').children.map((c) => c.name), ['getetag', 'address-data']);
});

test('syncCollection: token escaped, empty token, level 1', () => {
  let root = parseXml(RQ.syncCollection('').body);
  assert.equal(text(find(root, D, 'sync-token')), '');
  assert.equal(text(find(root, D, 'sync-level')), '1');
  assert.equal(find(root, D, 'prop').children[0].name, 'getetag');
  root = parseXml(RQ.syncCollection('http://example.org/sync/a&b<1>').body);
  assert.equal(text(find(root, D, 'sync-token')), 'http://example.org/sync/a&b<1>');
  assert.equal(parseXml(RQ.syncCollection(null).body).children[0].text, '');
});

test('mkcalendar: components, name, color, description; hostile text is escaped', () => {
  const r = RQ.mkcalendar({ displayName: 'Work & <Play>', color: '#3366CC', description: 'a "b"\nc', components: ['VEVENT', 'VTODO'] });
  assert.equal(r.method, 'MKCALENDAR');
  assert.equal(r.depth, undefined);
  const root = parseXml(r.body);
  assert.equal(root.ns, C);
  const prop = findPath(root, [[D, 'set'], [D, 'prop']]);
  assert.equal(text(find(prop, D, 'displayname')), 'Work & <Play>');
  assert.equal(text(find(prop, NS.ICAL, 'calendar-color')), '#3366CC');
  assert.equal(text(find(prop, C, 'calendar-description')), 'a "b"\nc');
  const set = find(prop, C, 'supported-calendar-component-set');
  assert.deepEqual(findAll(set, C, 'comp').map((c) => c.attrs.name), ['VEVENT', 'VTODO']);
  assert.throws(() => RQ.mkcalendar({ color: 'red' }), TypeError);
  assert.throws(() => RQ.mkcalendar({ color: '#12345' }), TypeError);
  assert.throws(() => RQ.mkcalendar({ components: ['VEVENT" x="'] }), TypeError);
  assert.ok(RQ.mkcalendar({ color: '#33669980' }));
  const min = parseXml(RQ.mkcalendar().body);
  assert.deepEqual(findAll(findPath(min, [[D, 'set'], [D, 'prop'], [C, 'supported-calendar-component-set']]), C, 'comp').map((c) => c.attrs.name), ['VEVENT']);
});

test('mkAddressbook: extended MKCOL body', () => {
  const r = RQ.mkAddressbook({ displayName: 'People', description: 'Contacts' });
  assert.equal(r.method, 'MKCOL');
  const root = parseXml(r.body);
  assert.equal(root.name, 'mkcol');
  const prop = findPath(root, [[D, 'set'], [D, 'prop']]);
  const rt = find(prop, D, 'resourcetype');
  assert.ok(find(rt, D, 'collection'));
  assert.ok(find(rt, CR, 'addressbook'));
  assert.equal(text(find(prop, D, 'displayname')), 'People');
  assert.equal(text(find(prop, CR, 'addressbook-description')), 'Contacts');
});

test('proppatch: set, remove, kind-specific description, validation', () => {
  const r = RQ.proppatch('calendar', { displayName: 'New', color: '#FF0000', description: null });
  assert.equal(r.method, 'PROPPATCH');
  const root = parseXml(r.body);
  assert.equal(root.name, 'propertyupdate');
  const set = findPath(root, [[D, 'set'], [D, 'prop']]);
  assert.equal(text(find(set, D, 'displayname')), 'New');
  assert.equal(text(find(set, NS.ICAL, 'calendar-color')), '#FF0000');
  const rem = findPath(root, [[D, 'remove'], [D, 'prop']]);
  assert.deepEqual(rem.children.map((c) => c.ns + '|' + c.name), [C + '|calendar-description']);
  const ab = parseXml(RQ.proppatch('addressbook', { description: 'x', color: '#FFFFFF' }).body);
  assert.deepEqual(findPath(ab, [[D, 'set'], [D, 'prop']]).children.map((c) => c.ns + '|' + c.name), [CR + '|addressbook-description']);
  assert.equal(find(parseXml(RQ.proppatch('calendar', { displayName: 'only' }).body), D, 'remove'), null);
  assert.throws(() => RQ.proppatch('calendar', {}), TypeError);
  assert.throws(() => RQ.proppatch('folder', { displayName: 'x' }), TypeError);
  assert.throws(() => RQ.proppatch('calendar', { color: 'x' }), TypeError);
});
