// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseXml, XmlError, el, serializeXml, xmlEscape, text, find, findAll, findPath, is, NS, DEFAULT_LIMITS } from '../../../src/js/dav/xml.js';
import { fx } from './_helpers.mjs';

const DAV = 'DAV:';

test('every recorded Radicale XML body parses', () => {
  const dir = new URL('./fixtures/', import.meta.url);
  let parsed = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.xml')) continue;
    const body = readFileSync(new URL(f, dir), 'utf8');
    if (!body.startsWith('<?xml')) continue; // plain-text error bodies
    const root = parseXml(body);
    assert.ok(['multistatus', 'error'].includes(root.name), f);
    assert.equal(root.ns, DAV, f);
    parsed++;
  }
  assert.ok(parsed >= 20, 'fixture corpus is present (' + parsed + ')');
});

test('default namespace, prefixes and empty elements (recorded PROPFIND)', () => {
  const root = parseXml(fx('propfind-home-depth1'));
  assert.equal(root.name, 'multistatus');
  const responses = findAll(root, DAV, 'response');
  assert.equal(responses.length, 7);
  const work = responses.find((r) => text(find(r, DAV, 'href')) === '/alice/work/');
  const prop = findPath(work, [[DAV, 'propstat'], [DAV, 'prop']]);
  assert.equal(text(find(prop, DAV, 'displayname')), 'Work & <Play>');
  assert.equal(text(find(prop, NS.ICAL, 'calendar-color')), '#3366CC');
  const set = find(prop, NS.CALDAV, 'supported-calendar-component-set');
  assert.deepEqual(findAll(set, NS.CALDAV, 'comp').map((c) => c.attrs.name), ['VEVENT', 'VTODO']);
});

test('REPORT bodies: literal CRLF becomes LF, text is intact', () => {
  const raw = fx('query-events');
  assert.ok(raw.includes('\r\n'));
  const root = parseXml(raw);
  const data = text(findAll(root, DAV, 'response')[0].children[1].children[0].children[1]);
  assert.ok(data.startsWith('BEGIN:VCALENDAR\nVERSION:2.0\n'));
  assert.ok(!data.includes('\r'));
  assert.ok(data.includes('café 中文'));
});

test('prefix redefinition and scoping', () => {
  const root = parseXml('<a:r xmlns:a="urn:one"><a:x xmlns:a="urn:two"/><a:y/></a:r>');
  assert.equal(root.ns, 'urn:one');
  assert.equal(root.children[0].ns, 'urn:two');
  assert.equal(root.children[1].ns, 'urn:one');
});

test('default namespace undeclaration and attributes', () => {
  const root = parseXml('<r xmlns="urn:d" xmlns:p="urn:p" a="1" p:b="2"><c xmlns=""/></r>');
  assert.equal(root.ns, 'urn:d');
  assert.equal(root.attrs.a, '1');
  assert.equal(root.attrs['{urn:p}b'], '2');
  assert.equal(Object.keys(root.attrs).length, 2); // xmlns declarations are consumed
  assert.equal(root.children[0].ns, '');
});

test('predefined entities and numeric references', () => {
  const root = parseXml('<r a="&quot;&apos;&lt;&#65;&#x42;">&lt;&gt;&amp;&quot;&apos; &#x1F600; &#67;</r>');
  assert.equal(root.attrs.a, '"\'<AB');
  assert.equal(root.text, '<>&"\' \u{1F600} C');
});

test('attribute whitespace is normalised, numeric CR kept', () => {
  const root = parseXml('<r a="x\ty\nz&#13;"/>');
  assert.equal(root.attrs.a, 'x y z\r');
});

test('CDATA, comments and processing instructions', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><?pi data?><r>a<![CDATA[<b>&amp;]]>c<!-- x -->d<?p?></r><!-- tail -->');
  assert.equal(root.text, 'a<b>&amp;cd');
});

test('XML declaration is optional, BOM is accepted', () => {
  assert.equal(parseXml('﻿<r/>').name, 'r');
  assert.equal(parseXml('<?xml version="1.0" encoding="utf-8"?>\n<r/>\n').name, 'r');
});

test('rejects DOCTYPE, entity declarations and other declarations', () => {
  assert.throws(() => parseXml('<!DOCTYPE r><r/>'), XmlError);
  assert.throws(() => parseXml('<!doctype r><r/>'), XmlError);
  assert.throws(() => parseXml('<!DOCTYPE r SYSTEM "file:///etc/hostname"><r>&x;</r>'), /DOCTYPE/);
  assert.throws(() => parseXml('<r><!ENTITY a "b"></r>'), XmlError);
  assert.throws(() => parseXml('<r><!ELEMENT a ANY></r>'), XmlError);
  assert.throws(() => parseXml('<?xml version="1.0"?><r/><!DOCTYPE r>'), XmlError);
});

test('entity bomb (billion laughs) is rejected, never expanded', () => {
  const bomb =
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
    '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>';
  assert.throws(() => parseXml(bomb), XmlError);
});

test('undefined or malformed entities are errors', () => {
  for (const bad of ['<r>&nbsp;</r>', '<r>&lol;</r>', '<r>&amp</r>', '<r>a & b</r>', '<r>&#;</r>', '<r>&#x;</r>', '<r>&#xZZ;</r>', '<r>&#0;</r>', '<r>&#xD800;</r>', '<r>&#1114112;</r>', '<r>&#99999999999;</r>', '<r>&#8;</r>']) {
    assert.throws(() => parseXml(bad), XmlError, bad);
  }
});

test('decoding never expands the input', () => {
  const n = 200000;
  const root = parseXml('<r>' + '&amp;'.repeat(n) + '</r>');
  assert.equal(root.text.length, n);
});

test('limits: depth, elements, attributes, name length, size', () => {
  const deep = (d) => '<a>'.repeat(d) + '</a>'.repeat(d);
  assert.equal(parseXml(deep(DEFAULT_LIMITS.maxDepth)).name, 'a');
  assert.throws(() => parseXml(deep(DEFAULT_LIMITS.maxDepth + 1)), /too deep/);
  assert.throws(() => parseXml(deep(100000)), /too deep/);
  assert.throws(() => parseXml('<r>' + '<a/>'.repeat(11) + '</r>', { maxElements: 10 }), /too many elements/);
  const attrs = (n) => Array.from({ length: n }, (_, i) => ' a' + i + '="x"').join('');
  assert.equal(parseXml('<r' + attrs(DEFAULT_LIMITS.maxAttributes) + '/>').name, 'r');
  assert.throws(() => parseXml('<r' + attrs(DEFAULT_LIMITS.maxAttributes + 1) + '/>'), /too many attributes/);
  assert.throws(() => parseXml('<r' + attrs(100000) + '/>'), /too many attributes/);
  assert.throws(() => parseXml('<' + 'n'.repeat(300) + '/>'), /name too long/);
  assert.throws(() => parseXml('<r>' + 'x'.repeat(100) + '</r>', { maxBytes: 50 }), /too large/);
});

test('a large flat document parses', () => {
  const n = 100000;
  const root = parseXml('<r>' + '<i k="v">t</i>'.repeat(n) + '</r>');
  assert.equal(root.children.length, n);
});

test('malformed documents are rejected', () => {
  const bad = [
    '', '   ', 'plain text', '<r>', '<r></s>', '<r><a></r></a>', '<r/><r/>', 'x<r/>', '<r/>x', '<r a=1/>', '<r a="1" a="2"/>',
    '<r xmlns:p="u" xmlns:q="u" p:a="1" q:a="2"/>', '<p:r/>', '<r p:a="1"/>', '<r a="<"/>', '<r a="1"b="2"/>', '<r a/>',
    '<r xmlns:p=""/>', '<r xmlns:xmlns="u"/>', '<r><![CDATA[x</r>', '<r><!-- x</r>', '<r><?pi</r>', '<1r/>', '<a:b:c xmlns:a="u" xmlns:b="u"/>',
    '<r>\u0000</r>', '<r>\u0001</r>', '<r a="\u0008"/>', 5, null, undefined,
  ];
  for (const b of bad) assert.throws(() => parseXml(b), XmlError, JSON.stringify(b));
});

test('prototype pollution attempts are inert', () => {
  const root = parseXml('<r __proto__="x" constructor="y"/>');
  assert.equal(root.attrs.__proto__, 'x');
  assert.equal({}.x, undefined);
  assert.equal(Object.getPrototypeOf(root.attrs), null);
  const r2 = parseXml('<__proto__:r xmlns:__proto__="u"/>');
  assert.equal(r2.ns, 'u');
});

test('helpers: is, find, findAll, findPath, text', () => {
  const root = parseXml('<r xmlns="u"><a><b>x</b><b>y</b></a><c>z<d>w</d></c></r>');
  assert.ok(is(root, 'u', 'r'));
  assert.ok(!is(root, 'v', 'r'));
  assert.ok(!is(null, 'u', 'r'));
  assert.equal(findAll(find(root, 'u', 'a'), 'u', 'b').length, 2);
  assert.equal(text(findPath(root, [['u', 'a'], ['u', 'b']])), 'x');
  assert.equal(findPath(root, [['u', 'zz']]), null);
  assert.equal(text(find(root, 'u', 'c')), 'zw');
  assert.equal(text(null), '');
});

test('xmlEscape', () => {
  assert.equal(xmlEscape('a&b<c>d"e\r\n\tf\u0001'), 'a&amp;b&lt;c&gt;d&quot;e&#13;&#10;&#9;f');
  assert.equal(xmlEscape(5), '5');
});

test('builder: namespaces, escaping, round trip', () => {
  const doc = el('{DAV:}propfind', null,
    el('{DAV:}prop', null, el('{DAV:}displayname'), el('{urn:ietf:params:xml:ns:caldav}calendar-data'), el('{urn:other}x', { '{urn:attr}k': 'v"1', plain: '<' })),
    el('{DAV:}href', null, 'a & b <c>'),
    [null, undefined, false, el('{DAV:}empty')]);
  const s = serializeXml(doc);
  assert.ok(s.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ns1="urn:other" xmlns:ns2="urn:attr">'));
  assert.ok(s.includes('<D:href>a &amp; b &lt;c&gt;</D:href>'));
  assert.ok(s.includes('<ns1:x ns2:k="v&quot;1" plain="&lt;"/>'));
  const back = parseXml(s);
  assert.equal(text(find(back, DAV, 'href')), 'a & b <c>');
  const x = findPath(back, [[DAV, 'prop'], ['urn:other', 'x']]);
  assert.equal(x.attrs['{urn:attr}k'], 'v"1');
  assert.equal(x.attrs.plain, '<');
});

test('builder: invalid names and children are rejected (no injection)', () => {
  assert.throws(() => el('{DAV:}a b'), TypeError);
  assert.throws(() => el('{DAV:}a><b'), TypeError);
  assert.throws(() => el('{DAV:}a', { 'x y': '1' }), TypeError);
  assert.throws(() => el('{DAV:}a', null, {}), TypeError);
  assert.throws(() => el('{DAV:}'), TypeError);
  assert.equal(serializeXml(el('{DAV:}a', null, 'x</a><b>'), { declaration: false }), '<D:a xmlns:D="DAV:">x&lt;/a&gt;&lt;b&gt;</D:a>');
});

test('builder: unnamespaced element and text with newlines survive a round trip', () => {
  const s = serializeXml(el('plain', null, 'line1\nline2 é'), { declaration: false });
  assert.equal(s, '<plain>line1&#10;line2 é</plain>');
  assert.equal(parseXml(s).text, 'line1\nline2 é');
});
