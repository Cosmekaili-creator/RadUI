// SPDX-License-Identifier: AGPL-3.0-or-later
// views/download.js: Blob + object URL + temporary <a download>, file name sanitising, no throw into the UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadText, exportFileName, safeFilename, safeMime, MAX_FILENAME_BYTES, MAX_FILENAME_LENGTH, REVOKE_DELAY_MS } from '../../../src/js/views/download.js';
import { makeDom } from '../widgets/_dom.mjs';

/** A document and a window-like object that record everything. */
function fakes({ clickThrows = false, noUrl = false, noTimer = false } = {}) {
  const log = [];
  const anchors = [];
  const timers = [];
  const doc = {
    body: {
      append(el) {
        log.push(['append', el.attrs.get('download')]);
        el.inBody = true;
        anchors.push(el);
      },
    },
    createElement(tag) {
      const el = {
        tag,
        attrs: new Map(),
        inBody: false,
        setAttribute(k, v) {
          this.attrs.set(k, v);
        },
        click() {
          log.push(['click', this.attrs.get('href'), this.attrs.get('download'), this.inBody]);
          if (clickThrows) throw new Error('click failed');
        },
        remove() {
          this.inBody = false;
          log.push(['remove']);
        },
      };
      return el;
    },
  };
  class FakeBlob {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = opts.type;
      log.push(['blob', parts.join(''), opts.type]);
    }
  }
  const win = {
    Blob: FakeBlob,
    URL: noUrl
      ? undefined
      : {
          createObjectURL(blob) {
            log.push(['create', blob.type]);
            return 'blob:fake-1';
          },
          revokeObjectURL(u) {
            log.push(['revoke', u]);
          },
        },
    setTimeout: noTimer ? undefined : (fn, ms) => timers.push({ fn, ms }),
  };
  return { doc, win, log, anchors, timers };
}

test('downloadText: blob, object URL, anchor appended, clicked, removed, URL revoked afterwards', () => {
  const { doc, win, log, timers } = fakes();
  const r = downloadText({ text: 'BEGIN:VCARD\r\nEND:VCARD\r\n', mime: 'text/vcard;charset=utf-8', filename: 'family-2026-11-13.vcf', doc, win });
  assert.deepEqual(r, { ok: true, filename: 'family-2026-11-13.vcf', bytes: 24 });
  assert.deepEqual(log, [
    ['blob', 'BEGIN:VCARD\r\nEND:VCARD\r\n', 'text/vcard;charset=utf-8'],
    ['create', 'text/vcard;charset=utf-8'],
    ['append', 'family-2026-11-13.vcf'],
    ['click', 'blob:fake-1', 'family-2026-11-13.vcf', true],
    ['remove'],
  ]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, REVOKE_DELAY_MS);
  timers[0].fn();
  assert.deepEqual(log.at(-1), ['revoke', 'blob:fake-1']);
  timers[0].fn();
  assert.equal(log.filter((e) => e[0] === 'revoke').length, 1, 'revoked once');
});

test('downloadText: without a timer the URL is revoked right after the click', () => {
  const { doc, win, log } = fakes({ noTimer: true });
  assert.equal(downloadText({ text: 'x', mime: 'text/plain', filename: 'a.txt', doc, win }).ok, true);
  assert.deepEqual(log.map((e) => e[0]), ['blob', 'create', 'append', 'click', 'revoke', 'remove']);
});

test('downloadText: bytes are UTF-8 bytes, not characters', () => {
  const { doc, win } = fakes();
  assert.equal(downloadText({ text: 'é€😀', filename: 'a.txt', doc, win }).bytes, 2 + 3 + 4);
  assert.equal(downloadText({ text: '', filename: 'a.txt', doc, win }).bytes, 0);
});

test('downloadText: a hostile file name and mime type are made safe before they reach the anchor and the blob', () => {
  const { doc, win, log, anchors } = fakes();
  const r = downloadText({ text: 'x', mime: 'text/html<script>', filename: '../../etc/passwd', doc, win });
  assert.equal(r.filename, 'etc-passwd');
  assert.equal(anchors[0].attrs.get('download'), 'etc-passwd');
  assert.equal(log.find((e) => e[0] === 'blob')[2], 'application/octet-stream');
  assert.equal(anchors[0].attrs.get('rel'), 'noopener');
});

test('downloadText never throws: a failing click gives {ok: false}, removes the anchor and revokes the URL', () => {
  const { doc, win, log } = fakes({ clickThrows: true });
  assert.deepEqual(downloadText({ text: 'x', filename: 'a.vcf', doc, win }), { ok: false, reason: 'failed' });
  assert.ok(log.some((e) => e[0] === 'remove'));
  assert.deepEqual(log.filter((e) => e[0] === 'revoke'), [['revoke', 'blob:fake-1']]);
});

test('downloadText: no text, no URL support, no document, a throwing Blob: {ok: false, reason}', () => {
  const f = fakes();
  assert.deepEqual(downloadText({ filename: 'a.vcf', doc: f.doc, win: f.win }), { ok: false, reason: 'no-text' });
  assert.deepEqual(downloadText({ text: 42, doc: f.doc, win: f.win }), { ok: false, reason: 'no-text' });
  const g = fakes({ noUrl: true });
  assert.deepEqual(downloadText({ text: 'x', doc: g.doc, win: { ...g.win, URL: undefined, Blob: g.win.Blob } }).ok, false);
  assert.deepEqual(downloadText({ text: 'x', doc: {}, win: f.win }), { ok: false, reason: 'unsupported' });
  const bad = fakes();
  bad.win.Blob = class {
    constructor() {
      throw new RangeError('too large');
    }
  };
  assert.deepEqual(downloadText({ text: 'x', doc: bad.doc, win: bad.win }), { ok: false, reason: 'failed' });
  assert.deepEqual(downloadText(), { ok: false, reason: 'no-text' });
  assert.equal(bad.log.length, 0);
});

test('downloadText works with the fake DOM of the widget tests (a real anchor element, click event fired)', () => {
  const doc = makeDom();
  const f = fakes();
  let clicked = 0;
  const create = doc.createElement;
  doc.createElement = (tag) => {
    const el = create(tag);
    el.addEventListener('click', () => {
      clicked += 1;
      assert.equal(el.getAttribute('href'), 'blob:fake-1');
      assert.equal(el.getAttribute('download'), 'contacts-2026-11-13.vcf');
      assert.equal(doc.body.contains(el), true, 'attached while it is clicked');
    });
    return el;
  };
  const r = downloadText({ text: 'x', mime: 'text/vcard', filename: 'contacts-2026-11-13.vcf', doc, win: f.win });
  assert.equal(r.ok, true);
  assert.equal(clicked, 1);
  assert.equal(doc.body.childNodes.length, 0, 'the temporary anchor is removed');
});

// ------------------------------------------------------------------ names

test('safeFilename keeps a normal export name', () => {
  assert.equal(safeFilename('family-2026-11-13.vcf'), 'family-2026-11-13.vcf');
  assert.equal(safeFilename('My Contacts 2026-11-13.ics'), 'My Contacts 2026-11-13.ics');
});

test('safeFilename: no path separators, no traversal, no hidden file, no reserved characters', () => {
  const cases = new Map([
    ['../../etc/passwd', 'etc-passwd'],
    ['..\\..\\windows\\system32\\a.vcf', 'windows-system32-a.vcf'],
    ['/abs/path/book.vcf', 'abs-path-book.vcf'],
    ['.hidden.vcf', 'hidden.vcf'],
    ['..', 'download'],
    ['', 'download'],
    [null, 'download'],
    [undefined, 'download'],
    ['a<b>c:d"e|f?g*h.vcf', 'a-b-c-d-e-f-g-h.vcf'],
    ['trailing dots...', 'trailing dots'],
    ['  spaced   out  .vcf', 'spaced out.vcf'],
    ['line\nbreak\u0000nul.vcf', 'linebreaknul.vcf'],
    ['rtl‮evil.vcf', 'rtlevil.vcf'],
    ['zero​width﻿.ics', 'zerowidth.ics'],
    ['CON.vcf', '_CON.vcf'],
    ['nul', '_nul'],
    ['com1.txt', '_com1.txt'],
    ['console.vcf', 'console.vcf'],
  ]);
  for (const [input, expected] of cases) {
    const out = safeFilename(input);
    assert.equal(out, expected, JSON.stringify(input));
    assert.equal(/[\\/]/.test(out), false);
  }
});

test('safeFilename: the length is capped in characters and bytes and the extension survives; surrogate pairs are not cut', () => {
  const long = `${'a'.repeat(500)}.vcf`;
  const out = safeFilename(long);
  assert.equal(out.length, MAX_FILENAME_LENGTH);
  assert.ok(out.endsWith('.vcf'));
  const wide = safeFilename(`${'é'.repeat(300)}.ics`);
  assert.ok(new TextEncoder().encode(wide).length <= MAX_FILENAME_BYTES);
  assert.ok(wide.endsWith('.ics'));
  const emoji = safeFilename(`${'😀'.repeat(300)}.vcf`);
  assert.ok(new TextEncoder().encode(emoji).length <= MAX_FILENAME_BYTES);
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji), false, 'no lone surrogate');
  assert.ok(emoji.endsWith('.vcf'));
  assert.equal(safeFilename('x'.repeat(500)).length, MAX_FILENAME_LENGTH);
});

test('safeFilename: unicode names are kept (NFC), a fallback can be given', () => {
  assert.equal(safeFilename('Zoé.vcf'), 'Zoé.vcf');
  assert.equal(safeFilename('日本語.vcf'), '日本語.vcf');
  assert.equal(safeFilename('???', { fallback: 'book' }), 'book');
  assert.equal(safeFilename('...vcf'), 'vcf');
});

test('safeMime keeps type/subtype[;charset=x] and refuses anything else', () => {
  assert.equal(safeMime('text/vcard;charset=utf-8'), 'text/vcard;charset=utf-8');
  assert.equal(safeMime('text/calendar'), 'text/calendar');
  for (const bad of ['', 'text', 'text/html<script>', 'text/x y', undefined, null, 5, 'text/vcard;boundary=x']) assert.equal(safeMime(bad), 'application/octet-stream', String(bad));
});

test('exportFileName: <displayname-slug>-<YYYY-MM-DD>.<ext> (the store naming, re-exported for the views)', () => {
  assert.equal(exportFileName('Équipe Été / 2026', 'vcf', new Date(2026, 10, 3)), 'equipe-ete-2026-2026-11-03.vcf');
  assert.equal(exportFileName('', 'ics', new Date(2026, 0, 9)), 'export-2026-01-09.ics');
  assert.equal(safeFilename(exportFileName('../Secret', 'vcf', new Date(2026, 10, 3))), 'secret-2026-11-03.vcf');
});
