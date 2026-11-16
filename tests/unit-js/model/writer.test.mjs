// SPDX-License-Identifier: AGPL-3.0-or-later
// Writer primitives: folding at 75 octets, value-type registry, emission.
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../../../src/js/model/contentlines.js";
import { FieldError, emit, emitLF, encodeValue, foldLine, formatProperty, makeParam, newProp, utf8Length, valueTypeOf } from "../../../src/js/model/writer.js";
import { BS, octets, unfold } from "./helpers.mjs";

const lines = (folded) => folded.split("\n");

test("a line of exactly 75 octets is not folded, 76 is", () => {
  assert.equal(foldLine("X:" + "a".repeat(73)), "X:" + "a".repeat(73));
  const f = foldLine("X:" + "a".repeat(74));
  assert.equal(lines(f).length, 2);
  assert.equal(octets(lines(f)[0]), 75);
});

test("continuation lines are at most 75 octets including the leading space", () => {
  const f = foldLine("DESCRIPTION:" + "a".repeat(500));
  const ls = lines(f);
  assert.equal(octets(ls[0]), 75);
  for (const l of ls.slice(1)) {
    assert.ok(l.startsWith(" "));
    assert.ok(octets(l) <= 75, `${octets(l)}`);
  }
  assert.equal(octets(ls[1]), 75, "full continuation lines use all 75 octets");
  assert.equal(f.replace(/\n /g, ""), "DESCRIPTION:" + "a".repeat(500));
});

test("multi-byte characters are never split, whatever the alignment", () => {
  const chars = ["é", "€", "日", "😀"];
  for (const ch of chars) {
    for (let pad = 0; pad < 6; pad++) {
      const text = "X:" + "a".repeat(pad) + ch.repeat(120);
      const f = foldLine(text);
      assert.equal(f.replace(/\n /g, ""), text);
      for (const l of lines(f)) {
        assert.ok(octets(l) <= 75, `${ch} pad ${pad}: ${octets(l)}`);
        assert.ok(!l.includes("�"));
      }
      // every physical line decodes on its own to whole characters
      for (const l of lines(f)) assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(l)), l);
    }
  }
});

test("a 4-byte character at the boundary moves whole to the next line", () => {
  const f = foldLine("X:" + "a".repeat(72) + "😀tail");
  const ls = lines(f);
  assert.equal(ls[0], "X:" + "a".repeat(72));
  assert.equal(ls[1], " 😀tail");
});

test("utf8Length", () => {
  assert.equal(utf8Length("aé€😀"), 1 + 2 + 3 + 4);
});

test("value-type registry", () => {
  assert.equal(valueTypeOf("summary"), "text");
  assert.equal(valueTypeOf("CATEGORIES"), "text-list");
  assert.equal(valueTypeOf("N"), "structured");
  assert.equal(valueTypeOf("URL"), "uri");
  assert.equal(valueTypeOf("PHOTO"), "binary");
  assert.equal(valueTypeOf("X-UNKNOWN"), "text", "unknown names are escaped (safe default)");
});

test("encodeValue: TEXT is escaped, URI and binary are not", () => {
  assert.equal(encodeValue("SUMMARY", `a,b;c${BS}d\ne`), `a${BS},b${BS};c${BS}${BS}d${BS}ne`);
  assert.equal(encodeValue("URL", "https://example.org/a,b;c"), "https://example.org/a,b;c");
  assert.equal(encodeValue("PHOTO", "QUJD+/=="), "QUJD+/==");
  assert.equal(encodeValue("CATEGORIES", ["a,b", "c"]), `a${BS},b,c`);
  assert.equal(encodeValue("N", ["F;x", ["g", "h,i"], null, "", "s"]), `F${BS};x;g,h${BS},i;;;s`);
  assert.equal(encodeValue("DTSTART", { kind: "utc", iso: "2026-01-02T03:04:05" }), "20260102T030405Z");
  assert.throws(() => encodeValue("URL", "a\nb"), FieldError);
});

test("formatProperty keeps group, name case and parameter form; quotes only when needed", () => {
  const p = parse("BEGIN:X\nitem1.tel;type=pref;TYPE=\"a,b\";X-P=\"q\":123\nEND:X\n")[0].items[0];
  p.dirty = true;
  assert.equal(formatProperty(p), 'item1.tel;type=pref;TYPE="a,b";X-P="q":123');
  const n = newProp("note", "v", { params: [makeParam("X-A", ["a:b"]), makeParam("X-B", ['say "hi"'])] });
  assert.equal(formatProperty(n), "NOTE;X-A=\"a:b\";X-B=say ^'hi^':v");
  assert.throws(() => newProp("X", "a\nb"), FieldError);
});

test("emit: CRLF everywhere, final CRLF, untouched properties re-emitted from their original text", () => {
  const src = "BEGIN:X\nA:1\nB:long\n line\n\tmore\nEND:X\n";
  const root = parse(src)[0];
  assert.equal(emit(root), "BEGIN:X\r\nA:1\r\nB:long\r\n line\r\n\tmore\r\nEND:X\r\n");
  assert.equal(emitLF(root), src);
  assert.equal(unfold(emit(root)).includes("B:longlinemore"), true);
});

test("a dirty property is serialised by our own serializer, not from its old text", () => {
  const root = parse("BEGIN:X\nSUMMARY:old\nEND:X\n")[0];
  const p = root.prop("SUMMARY");
  p.value = "new";
  assert.equal(emit(root).includes("SUMMARY:old"), true, "an unflagged edit is not emitted");
  p.dirty = true;
  assert.equal(emit(root), "BEGIN:X\r\nSUMMARY:new\r\nEND:X\r\n");
});
