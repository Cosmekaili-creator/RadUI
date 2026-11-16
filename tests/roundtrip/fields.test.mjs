// SPDX-License-Identifier: AGPL-3.0-or-later
// (b) For every owned field of the registry: set it to a new value and check
// that the semantic diff against the input shows ONLY that field's property
// (plus the writer-managed DTSTAMP, SEQUENCE, LAST-MODIFIED, REV), in the
// component that was edited. Read-only items must refuse every edit.
import test from "node:test";
import assert from "node:assert/strict";
import { ReadOnlyError, openItem } from "../../src/js/model/item.js";
import { checkEdit, editsFor, loadFixtures } from "./lib.mjs";

/** Returns a list of problems (empty when the edit is clean). */
const check = (f, edit) => {
  const r = checkEdit(f.text, f.meta.kind, edit);
  return r.problems.map((p) => (r.message ? `${p} (${r.message})` : p));
};

for (const f of loadFixtures()) {
  const probe = openItem(f.text, f.meta.kind);
  if (!probe.ok) continue;
  if (probe.readOnly) {
    test(`read-only item refuses every edit: ${f.name}`, () => {
      assert.throws(() => probe.update({ summary: "x" }), ReadOnlyError);
      assert.throws(() => probe.save(), ReadOnlyError);
    });
    continue;
  }
  const edits = editsFor(probe);
  test(`one owned field at a time: ${f.name}`, () => {
    const failures = [];
    for (const edit of edits) {
      const p = check(f, edit);
      if (p.length) failures.push(`${edit.field}: ${p.join("; ")}`);
    }
    assert.deepEqual(failures, []);
  });
}
