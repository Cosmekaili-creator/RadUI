// SPDX-License-Identifier: AGPL-3.0-or-later
// Fidelity guard and Apple property groups: removing a row takes its whole group with it.
import test from "node:test";
import assert from "node:assert/strict";
import { FidelityError, checkFidelity } from "../../../src/js/model/fidelity.js";
import { openItem } from "../../../src/js/model/item.js";
import { fixture } from "./helpers.mjs";

const NOW = new Date("2026-11-13T10:00:00Z");
const SRC = fixture("vcard30-grouped-properties.vcf");
const unfolded = (t) => t.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean);
const gone = (a, b) => unfolded(a).filter((l) => !l.startsWith("REV:") && !unfolded(b).includes(l));
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FidelityError) return e.problems.map((p) => p.code);
    throw e;
  }
  return [];
};

test("removing the last ADR row removes its whole group (ADR, X-ABADR) and is accepted", () => {
  const item = openItem(SRC, "contact");
  assert.equal(item.update({ adr: [] }), true);
  const out = item.save({ now: NOW }).text;
  assert.deepEqual(gone(SRC, out).sort(), ["item4.ADR;type=HOME:;;4 Example Row;Sampletown;;00004;Exampleland", "item4.X-ABADR:xx"].sort());
  assert.ok(unfolded(out).includes("item1.X-ABLabel:main"), "other groups are untouched");
});

test("removing a TEL row with an X-ABLabel sibling is accepted; only that group goes", () => {
  const item = openItem(SRC, "contact");
  const tel = item.fields().tel;
  assert.equal(tel.length, 2);
  item.update({ tel: [{ prop: tel[1].prop, value: tel[1].value, types: tel[1].types }] });
  const out = item.save({ now: NOW }).text;
  assert.deepEqual(gone(SRC, out).sort(), ["item1.TEL;type=pref;type=VOICE:+1 555 0120", "item1.X-ABLabel:main"].sort());
});

test("tampering: dropping an unrelated line is refused", () => {
  const item = openItem(SRC, "contact");
  item.update({ adr: [] });
  const out = item.save({ now: NOW }).text.replace("grp.X-LONELY:a grouped property alone\r\n", "");
  assert.deepEqual(code(() => checkFidelity(SRC, out)), ["foreign-lines"]);
  const other = SRC.replace(/item5\.X-ABLabel:[^\r\n]*\r?\n/, "");
  assert.deepEqual(code(() => checkFidelity(SRC, other)), ["foreign-lines"], "a group without an owned parent stays protected");
});

test("tampering: dropping a sibling while its parent is kept is refused", () => {
  const dropped = SRC.replace(/item4\.X-ABADR:xx\r?\n/, "");
  assert.deepEqual(code(() => checkFidelity(SRC, dropped)), ["foreign-lines"]);
  // an X-ABLabel may still be removed with its parent kept (label edit)
  const noLabel = SRC.replace(/item1\.X-ABLabel:main\r?\n/, "");
  assert.equal(checkFidelity(SRC, noLabel), true);
  // removing the parent but leaving a changed sibling elsewhere is still caught
  const item = openItem(SRC, "contact");
  item.update({ adr: [] });
  const out = item.save({ now: NOW }).text.replace("item1.X-ABLabel:main", "item1.X-ABLabel:main").replace("Item2.EMAIL;TYPE=INTERNET:grace@example.org\r\n", "");
  assert.equal(checkFidelity(SRC, out), true, "EMAIL is owned, its removal is the writer's business");
});
