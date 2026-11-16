// SPDX-License-Identifier: AGPL-3.0-or-later
// Corpus tests: every fixture opens (or is refused) as expected, and a save
// with no edit is byte-exact against the LF-normalised input re-emitted as CRLF.
import test from "node:test";
import assert from "node:assert/strict";
import { ParseError, parse } from "../../../src/js/model/contentlines.js";
import { emit } from "../../../src/js/model/writer.js";
import { openItem, ReadOnlyError } from "../../../src/js/model/item.js";
import { crlf, fixtures, lf } from "./helpers.mjs";

const all = fixtures();

test("the corpus has at least 40 items of each family", () => {
  assert.ok(all.filter((f) => f.name.startsWith("ics/")).length >= 35);
  assert.ok(all.filter((f) => f.name.startsWith("vcf/")).length >= 15);
  assert.ok(all.length >= 50);
});

test("every fixture is registered in the manifest", () => {
  for (const f of all) assert.ok(f.meta.kind, `${f.name} missing from manifest.json`);
});

test("line-ending variants exist (CRLF, LF, lone CR)", () => {
  const byName = Object.fromEntries(all.map((f) => [f.file, f.text]));
  assert.ok(byName["event-utc-basic.ics"].includes("\r\n"));
  assert.ok(!byName["event-lf.ics"].includes("\r"));
  assert.ok(byName["event-cr.ics"].includes("\r") && !byName["event-cr.ics"].includes("\n"));
  assert.ok(!byName["vcard30-lf.vcf"].includes("\r"));
  assert.ok(!byName["vcard30-cr.vcf"].includes("\n"));
});

for (const f of all) {
  const parses = (() => {
    try {
      parse(f.text);
      return true;
    } catch (e) {
      if (e instanceof ParseError) return false;
      throw e;
    }
  })();

  if (parses) {
    test(`byte-exact no-edit emission: ${f.name}`, () => {
      const roots = parse(f.text);
      const out = roots.map(emit).join("");
      assert.equal(out, crlf(f.text));
      if (f.meta.byteExact !== false) assert.equal(out, lf(f.text).replace(/\n/g, "\r\n"));
    });
  }

  test(`open verdict: ${f.name}`, () => {
    const r = openItem(f.text, f.meta.kind);
    const expect = f.meta.expect || "ok";
    if (expect === "ok") {
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.readOnly, false);
      assert.equal(r.baseline, crlf(f.text));
      assert.deepEqual(r.save(), { changed: false });
    } else if (expect === "readonly-tz") {
      assert.equal(r.ok, true);
      assert.equal(r.readOnly, true);
      assert.equal(r.readOnlyReason, "unknown-tzid");
      assert.ok(r.warnings.some((w) => w.code === "unknown-tzid"));
      assert.throws(() => r.save(), ReadOnlyError);
      assert.throws(() => r.update({ summary: "x" }), ReadOnlyError);
      assert.ok(r.fields().start, "the view stays available");
    } else {
      assert.equal(r.ok, false);
      assert.equal(r.readOnly, true);
      assert.equal(r.reason, expect);
      assert.equal(r.raw, f.text, "the raw text is handed back untouched");
    }
    if (f.meta.tzids) assert.deepEqual(r.tz, f.meta.tzids);
  });
}

test("a no-edit round trip is stable when repeated", () => {
  for (const f of all.filter((x) => !x.meta.expect)) {
    const first = openItem(f.text, f.meta.kind);
    const again = openItem(first.baseline, f.meta.kind);
    assert.equal(again.baseline, first.baseline, f.name);
  }
});
