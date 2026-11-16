// SPDX-License-Identifier: AGPL-3.0-or-later
// Link helpers of the contact screens: allowlists for tel:, mailto: and web links; photo abbreviation in the raw view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { abbreviatePhotos, capText, mailHref, telHref, webHref } from '../../../src/js/views/contacts/links.js';

test('telHref keeps digits and a leading plus only', () => {
  assert.equal(telHref('+1 (555) 010-0100'), 'tel:+15550100100');
  assert.equal(telHref('tel:+1-555-0100'), 'tel:+15550100');
  assert.equal(telHref('555 0100 x12'), 'tel:555010012');
  assert.equal(telHref('12'), null);
  assert.equal(telHref('javascript:alert(1)'), null);
  assert.equal(telHref('+1 555;ext=<script>'), 'tel:+1555');
  assert.equal(telHref(''), null);
});

test('mailHref: only a plain address, encoded, never ? or &', () => {
  assert.equal(mailHref('jane@example.org'), 'mailto:jane@example.org');
  assert.equal(mailHref('a+b@example.org'), 'mailto:a%2Bb@example.org');
  assert.equal(mailHref('jane@example.org?subject=x'), null);
  assert.equal(mailHref('jane@example.org&cc=evil@example.org'), null);
  assert.equal(mailHref('a b@example.org'), null);
  assert.equal(mailHref('jane@@example.org'), null);
  assert.equal(mailHref('"x"@example.org'), null);
  assert.equal(mailHref('<jane@example.org>'), null);
  assert.equal(mailHref('javascript:alert(1)'), null);
  assert.equal(mailHref('jane@localhost'), null);
});

test('webHref: http and https without credentials; everything else is not a link', () => {
  assert.equal(webHref('https://example.org/a b'), 'https://example.org/a%20b');
  assert.equal(webHref(' http://example.org '), 'http://example.org/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.org', 'https://user:pw@example.org', '//example.org', 'example.org', 'https://', 'vbscript:x', 'JaVaScRiPt:alert(1)', '', null]) {
    assert.equal(webHref(bad), null, String(bad));
  }
});

test('abbreviatePhotos replaces the payload of every PHOTO line, folded or not, and keeps other lines', () => {
  const b64 = 'A'.repeat(4000);
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nPHOTO;ENCODING=b;TYPE=JPEG:${b64.slice(0, 60)}\r\n ${b64.slice(60)}\r\nitem1.PHOTO;VALUE=uri:data:image/png;base64,${b64}\r\nPHOTO;VALUE=uri:https://example.org/p.jpg\r\nEND:VCARD\r\n`;
  const out = abbreviatePhotos(text);
  assert.match(out, /PHOTO;ENCODING=b;TYPE=JPEG:\[photo data, 3 KB\]/);
  assert.match(out, /item1\.PHOTO;VALUE=uri:\[photo data, 3 KB\]/);
  assert.match(out, /PHOTO;VALUE=uri:https:\/\/example\.org\/p\.jpg/);
  assert.equal(out.includes('AAAA'), false);
  assert.match(out, /FN:X/);
});

test('capText cuts only long text', () => {
  assert.deepEqual(capText('abc', 10), { text: 'abc', truncated: false });
  assert.deepEqual(capText('abcdef', 3), { text: 'abc', truncated: true });
});
