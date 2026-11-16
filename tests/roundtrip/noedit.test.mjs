// SPDX-License-Identifier: AGPL-3.0-or-later
// (a) A no-edit round trip is byte-exact: the item re-emitted by the writer
// equals the LF-normalised input re-emitted with CRLF. Fixtures flagged
// byteExact:false (blank lines, no final newline) are compared against the
// normalised form instead. A save with no change sends nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { ParseError, parse } from "../../src/js/model/contentlines.js";
import { emit } from "../../src/js/model/writer.js";
import { openItem } from "../../src/js/model/item.js";
import { crlf, lf, loadFixtures } from "./lib.mjs";

for (const f of loadFixtures()) {
  test(`no-edit round trip: ${f.name}`, () => {
    let roots = null;
    try {
      roots = parse(f.text);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
    }
    if (!roots) {
      assert.equal(openItem(f.text, f.meta.kind).ok, false, "unparseable input must be refused");
      return;
    }
    const out = roots.map(emit).join("");
    if (f.meta.byteExact === false) assert.equal(out, crlf(f.text));
    else assert.equal(out, lf(f.text).replace(/\n/g, "\r\n"), "byte-exact against the LF-normalised input as CRLF");
    const item = openItem(f.text, f.meta.kind);
    if (item.ok) {
      assert.equal(item.baseline, out);
      if (!item.readOnly) assert.deepEqual(item.save(), { changed: false });
    }
    // re-opening the baseline is stable
    if (item.ok) assert.equal(openItem(item.baseline, f.meta.kind).baseline, item.baseline);
  });
}
