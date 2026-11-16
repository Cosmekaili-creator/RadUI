// SPDX-License-Identifier: AGPL-3.0-or-later
// resolveIcsImport (RUN3 C2): skip / replace / keep both for series with overrides, lossy confirmation, guard.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planIcsImport, resolveImport } from "../../../src/js/model/importplan.js";
import { resolveIcsImport } from "../../../src/js/model/importics.js";
import { parse } from "../../../src/js/model/contentlines.js";
import { checkNewItem } from "../../../src/js/model/fidelity.js";
import { FIXTURES } from "./helpers.mjs";

const COL = "/alice/cal/";
let n = 0;
const random = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const fx = (name) => readFileSync(path.join(FIXTURES, "ics", "import", `import-${name}.ics`), "utf8");
const known = [{ href: `${COL}weekly.ics`, etag: '"e1"', uid: "series-a@example.org" }];
const uidLines = (text) => text.replace(/\r\n/g, "\n").split("\n").filter((l) => /^UID[;:]/.test(l));

test("skip (default): a duplicate is kept as it is, everything else is created with If-None-Match semantics", () => {
  const p = planIcsImport(fx("recurring-overrides"), known, { collectionHref: COL, random });
  const res = resolveImport(p, "skip", { collectionHref: COL });
  assert.deepEqual(res.operations.map((o) => o.op), ["create", "create"]);
  assert.deepEqual(res.skipped, [{ index: 0, state: "duplicate", reason: "kept-existing" }]);
  assert.deepEqual(res.counts, { create: 2, replace: 0, skipped: 1, lossy: 0, lossySkipped: 0 });
  assert.equal(resolveImport(p, undefined, { collectionHref: COL }).operations.length, 2);
  assert.throws(() => resolveImport(p, "merge"), TypeError);
});

test("replace: PUT on the existing href with the existing ETag, the whole series text (master and both overrides)", () => {
  const p = planIcsImport(fx("recurring-overrides"), known, { collectionHref: COL, random });
  const res = resolveImport(p, "replace", { collectionHref: COL });
  const rep = res.operations.find((o) => o.op === "replace");
  assert.equal(rep.href, `${COL}weekly.ics`);
  assert.equal(rep.etag, '"e1"');
  assert.equal(rep.uid, "series-a@example.org");
  assert.deepEqual(parse(rep.text)[0].comps("VEVENT").length, 3);
  assert.deepEqual(res.counts, { create: 2, replace: 1, skipped: 0, lossy: 0, lossySkipped: 0 });
  assert.equal(res.operations.filter((o) => o.op === "create").length, 2);
});

test("keep both: master and overrides get ONE new UID together, a new href, nothing else changes", () => {
  n = 0;
  const p = planIcsImport(fx("recurring-overrides"), known, { collectionHref: COL, random });
  const res = resolveImport(p, "keep-both", { collectionHref: COL, random });
  const copy = res.operations.find((o) => o.uid !== "series-a@example.org" && /^00000000/.test(o.uid));
  assert.ok(copy);
  assert.equal(copy.op, "create");
  assert.match(copy.href, /^\/alice\/cal\/00000000-0000-4000-8000-\d{12}\.ics$/);
  assert.deepEqual(uidLines(copy.text), [`UID:${copy.uid}`, `UID:${copy.uid}`, `UID:${copy.uid}`]);
  assert.ok(!copy.text.includes("series-a@example.org"));
  const orig = p.rows[0].text.replace(/series-a@example\.org/g, copy.uid).replace(/\n/g, "\r\n");
  assert.equal(copy.text, orig, "only the UID lines differ from the source resource");
  assert.deepEqual(res.counts, { create: 3, replace: 0, skipped: 0, lossy: 0, lossySkipped: 0 });
  assert.equal(new Set(res.operations.map((o) => o.href)).size, 3);
});

test("keep both keeps the urn:uuid: style of the old UID", () => {
  const text = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//E//EN\nBEGIN:VEVENT\nUID:urn:uuid:11111111-2222-4333-8444-555555555555\nDTSTAMP:20260101T000000Z\nDTSTART:20260401T080000Z\nSUMMARY:A\nEND:VEVENT\nEND:VCALENDAR\n`;
  const p = planIcsImport(text, [{ href: `${COL}x.ics`, etag: '"1"', uid: "urn:uuid:11111111-2222-4333-8444-555555555555" }], { collectionHref: COL, random });
  const res = resolveImport(p, "keep-both", { collectionHref: COL, random });
  assert.match(res.operations[0].uid, /^urn:uuid:00000000-/);
  assert.equal(uidLines(res.operations[0].text)[0], `UID:${res.operations[0].uid}`);
});

test("lossy items: a REPLACE needs the confirmed UID; creates go ahead and are counted; keep-both is not a replace", () => {
  const dup = [
    { href: `${COL}a.ics`, etag: '"a"', uid: "comma-summary@example.org" },
    { href: `${COL}b.ics`, etag: '"b"', uid: "comma-clean@example.org" },
  ];
  const p = planIcsImport(fx("unescaped-comma"), dup, { collectionHref: COL, random });
  const res = resolveImport(p, "replace", { collectionHref: COL });
  assert.deepEqual(res.skipped, [{ index: 0, state: "duplicate", reason: "lossy-needs-confirmation", properties: ["SUMMARY"] }]);
  assert.deepEqual(res.problems.map((x) => x.code), ["lossy-skipped"]);
  assert.deepEqual(res.counts, { create: 1, replace: 1, skipped: 1, lossy: 1, lossySkipped: 1 });
  const ok = resolveImport(p, "replace", { collectionHref: COL, confirmLossy: ["comma-summary@example.org"] });
  assert.equal(ok.skipped.length, 0);
  assert.equal(ok.operations.find((o) => o.uid === "comma-summary@example.org").lossy[0], "SUMMARY");
  assert.deepEqual(ok.counts, { create: 1, replace: 2, skipped: 0, lossy: 2, lossySkipped: 0 });
  const kb = resolveImport(p, "keep-both", { collectionHref: COL, random });
  assert.equal(kb.skipped.length, 0);
  assert.equal(kb.counts.lossySkipped, 0);
  assert.equal(kb.counts.lossy, 2, "the series with a LOCATION comma and the SUMMARY one are flagged creates");
});

test("a replace without an ETag is skipped; invalid, unsupported and repeated rows are skipped with their reason", () => {
  const p = planIcsImport(fx("recurring-overrides"), [{ href: `${COL}w.ics`, uid: "series-a@example.org" }], { collectionHref: COL, random });
  const res = resolveImport(p, "replace", { collectionHref: COL });
  assert.deepEqual(res.skipped, [{ index: 0, state: "invalid", reason: "no-etag" }]);
  const mixed = planIcsImport(readFileSync(path.join(FIXTURES, "ics", "import", "import-mixed-components.ics"), "utf8"), [], { collectionHref: COL });
  const r2 = resolveIcsImport(mixed, "skip", { collectionHref: COL });
  assert.deepEqual(r2.skipped.map((s) => `${s.state}:${s.reason}`), [
    "unsupported:unsupported-component", "unsupported:unsupported-component", "file-duplicate:duplicate-uid", "invalid:mixed-components", "invalid:invalid-value", "invalid:no-master", "invalid:empty-uid",
  ]);
});

test("the guard refuses a tampered plan row: the item is skipped as guard-failed, never produced", () => {
  const p = planIcsImport(fx("method-request"), [], { collectionHref: COL, random });
  p.rows[0].text = p.rows[0].text.replace("SUMMARY:Planning session", "SUMMARY:Planning session (rewritten)");
  const res = resolveImport(p, "skip", { collectionHref: COL });
  assert.equal(res.operations.length, 1);
  assert.deepEqual(res.skipped, [{ index: 0, state: "invalid", reason: "guard-failed" }]);
  assert.equal(res.problems[0].code, "split-foreign-line");
});

test("every output of every fixture passes checkNewItem and has exactly one UID", () => {
  for (const name of ["recurring-overrides", "method-request", "nouid", "mixed-components", "unknown-tzid", "unescaped-comma"]) {
    const p = planIcsImport(fx(name), [], { collectionHref: COL, random });
    for (const policy of ["skip", "replace", "keep-both"]) {
      for (const o of resolveImport(p, policy, { collectionHref: COL, random }).operations) {
        assert.equal(checkNewItem(o.text.replace(/\r\n/g, "\n"), { requireProdid: false }), true);
        assert.equal(new Set(uidLines(o.text)).size, 1, `${name}: one UID per resource`);
      }
    }
  }
});
