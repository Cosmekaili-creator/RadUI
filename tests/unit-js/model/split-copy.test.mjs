// SPDX-License-Identifier: AGPL-3.0-or-later
// Item.asCopy, the new-item UID rule and the split guard (checkSplit).
import test from "node:test";
import assert from "node:assert/strict";
import { FidelityError, checkNewItem, checkSplit } from "../../../src/js/model/fidelity.js";
import { ReadOnlyError, openItem } from "../../../src/js/model/item.js";
import { parse } from "../../../src/js/model/contentlines.js";
import { fixture } from "./helpers.mjs";

const NOW = new Date("2026-11-13T10:00:00Z");
const codes = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FidelityError) return e.problems.map((p) => p.code);
    throw e;
  }
  return [];
};
const CARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a1\r\nFN:A\r\nEND:VCARD\r\n";

// -- checkNewItem ----------------------------------------------------------------------------

test("checkNewItem: a VCARD needs exactly one UID; VERSION and PRODID are still required", () => {
  assert.equal(checkNewItem("BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//x//EN\r\nUID:a\r\nFN:A\r\nEND:VCARD\r\n"), true);
  assert.deepEqual(codes(() => checkNewItem("BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//x//EN\r\nFN:A\r\nEND:VCARD\r\n")), ["uid"]);
  assert.deepEqual(codes(() => checkNewItem("BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//x//EN\r\nUID:a\r\nUID:b\r\nFN:A\r\nEND:VCARD\r\n")), ["uid"]);
  assert.deepEqual(codes(() => checkNewItem("BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//x//EN\r\nUID:\r\nFN:A\r\nEND:VCARD\r\n")), ["uid"]);
  assert.deepEqual(codes(() => checkNewItem(CARD)), ["no-prodid"]);
  assert.equal(checkNewItem(CARD, { requireProdid: false }), true);
  assert.deepEqual(codes(() => checkNewItem("BEGIN:VCARD\r\nPRODID:x\r\nUID:a\r\nEND:VCARD\r\n")), ["no-version"]);
});

// -- asCopy --------------------------------------------------------------------------------------

test("asCopy (contact): new UID, new-item rules, edits so far included, source untouched", () => {
  const src = fixture("vcard30-types.vcf");
  const item = openItem(src, "contact");
  item.update({ title: "Copy title" });
  const copy = item.asCopy({ uid: "urn:uuid:aaaaaaaa-0000-4000-8000-0000000000c1" });
  assert.equal(copy.isNew, true);
  assert.equal(copy.uid, "urn:uuid:aaaaaaaa-0000-4000-8000-0000000000c1");
  assert.equal(item.uid, "urn:uuid:11111111-2222-3333-4444-555555555504", "the source item keeps its UID");
  const out = copy.save({ now: NOW });
  assert.equal(out.changed, true);
  const root = parse(out.text)[0];
  assert.equal(root.props("UID").length, 1);
  assert.ok(root.prop("PRODID"), "a PRODID is added when the source had none");
  assert.equal(root.prop("TITLE").value, "Copy title");
  assert.ok(root.prop("REV"));
  assert.equal(root.prop("VERSION").value, "3.0");
  // the untouched lines are the source lines
  const srcLines = src.replace(/\r\n[ \t]/g, "").split("\r\n");
  for (const l of srcLines.filter((x) => x.startsWith("TEL") || x.startsWith("EMAIL"))) assert.ok(out.text.replace(/\r\n[ \t]/g, "").includes(l));
});

test("asCopy keeps an existing PRODID and a card without UID gets one", async () => {
  const withProd = openItem(fixture("vcard30-basic.vcf"), "contact");
  const c = withProd.asCopy({ uid: "x-1" });
  assert.equal(parse(c.save({ now: NOW }).text)[0].props("PRODID").length, 1);
  const { readFileSync } = await import("node:fs");
  const { FIXTURES } = await import("./helpers.mjs");
  const none = openItem(readFileSync(`${FIXTURES}/vcf/server-refused/vcard30-no-uid.vcf`, "utf8"), "contact");
  const copy = none.asCopy({ uid: "fresh" });
  assert.equal(parse(copy.save({ now: NOW }).text)[0].prop("UID").value, "fresh");
});

test("asCopy (event): every component carries the new UID, overrides included", () => {
  const src = fixture("event-recur-exdate-override-moved.ics");
  const item = openItem(src, "event");
  const uidBefore = item.uid;
  const copy = item.asCopy({ uid: "copy-uid@example.org" });
  const out = copy.save({ now: NOW });
  const cal = parse(out.text)[0];
  const evs = cal.comps("VEVENT");
  assert.ok(evs.length >= 2, "master and override");
  assert.ok(evs.every((e) => e.prop("UID").value === "copy-uid@example.org"));
  assert.notEqual(uidBefore, "copy-uid@example.org");
  assert.ok(out.text.includes("RECURRENCE-ID"));
  assert.equal(checkNewItem(out.text), true);
});

test("asCopy refuses: group cards, a missing UID, read-only items", () => {
  const group = openItem(fixture("vcard40-group-unknown-member.vcf"), "contact");
  assert.throws(() => group.asCopy({ uid: "x" }), /group card cannot be copied/);
  assert.throws(() => openItem(fixture("vcard30-basic.vcf"), "contact").asCopy({}), /new UID/);
  assert.throws(() => openItem(fixture("vcard30-basic.vcf"), "contact").asCopy({ uid: "  " }), /new UID/);
  const ro = openItem(fixture("event-tzid-windows-name.ics"), "event");
  assert.throws(() => ro.asCopy({ uid: "x" }), ReadOnlyError);
  const apple = openItem(fixture("vcard30-group-apple-labels.vcf"), "contact");
  assert.throws(() => apple.asCopy({ uid: "x" }), /group card/);
});

// -- checkSplit ------------------------------------------------------------------------------------

const SRC = "BEGIN:VCARD\nVERSION:4.0\nUID:urn:uuid:old-1\nKIND:group\nFN:Team\nMEMBER:urn:uuid:m-1\nMEMBER:mailto:x@example.org\nEND:VCARD\n";

test("checkSplit: an identical copy passes; folding and line endings do not matter", () => {
  assert.equal(checkSplit(SRC, SRC), true);
  assert.equal(checkSplit(SRC, SRC.replace(/\n/g, "\r\n"), { complete: true }), true);
  const folded = SRC.replace("FN:Team", "FN:Te\n am");
  assert.equal(checkSplit(SRC, folded, { complete: true }), true);
});

test("checkSplit: UID and MEMBER rewrites from uidMap are the only allowed changes", () => {
  const out = SRC.replace("UID:urn:uuid:old-1", "UID:urn:uuid:new-1").replace("MEMBER:urn:uuid:m-1", "MEMBER:urn:uuid:m-2");
  assert.equal(checkSplit(SRC, out, { uidMap: { "urn:uuid:old-1": "urn:uuid:new-1", "m-1": "m-2" }, complete: true }), true);
  assert.equal(checkSplit(SRC, out, { uidMap: new Map([["urn:uuid:old-1", "urn:uuid:new-1"], ["m-1", "m-2"]]) }), true);
  assert.deepEqual(codes(() => checkSplit(SRC, out, { uidMap: { "urn:uuid:old-1": "urn:uuid:new-1" } })), ["split-member"], "member rewrite not in the map");
  assert.deepEqual(codes(() => checkSplit(SRC, out, {})), ["split-uid", "split-member"]);
  // a plain (non-urn) member form is kept
  const plain = "BEGIN:VCARD\nVERSION:4.0\nUID:u1\nKIND:group\nFN:T\nMEMBER:m-1\nEND:VCARD\n";
  assert.equal(checkSplit(plain, plain.replace("MEMBER:m-1", "MEMBER:m-9"), { uidMap: { "m-1": "m-9" } }), true);
  assert.equal(checkSplit(SRC.replace("urn:uuid:m-1", "ABCD"), SRC.replace("urn:uuid:m-1", "WXYZ"), { uidMap: { ABCD: "WXYZ" } }), true);
});

test("checkSplit: a UID line may be added only for a source without one, and only as mapped", () => {
  const src = "BEGIN:VCARD\nVERSION:3.0\nFN:A\nEND:VCARD\n";
  const out = "BEGIN:VCARD\nVERSION:3.0\nFN:A\nUID:gen-1\nEND:VCARD\n";
  assert.equal(checkSplit(src, out, { uidMap: { "": "gen-1" }, complete: true }), true);
  assert.deepEqual(codes(() => checkSplit(src, out)), ["split-uid"]);
  assert.deepEqual(codes(() => checkSplit(src, out, { uidMap: { "": "other" } })), ["split-uid"]);
  assert.deepEqual(codes(() => checkSplit(SRC, SRC.replace("UID:urn:uuid:old-1", "UID:urn:uuid:old-1\nUID:gen-1"), { uidMap: { "": "gen-1" } })), ["split-uid"]);
});

test("checkSplit: any other new or changed line is refused", () => {
  assert.deepEqual(codes(() => checkSplit(SRC, SRC.replace("FN:Team", "FN:Other"))), ["split-foreign-line"]);
  assert.deepEqual(codes(() => checkSplit(SRC, SRC.replace("END:VCARD", "NOTE:x\nEND:VCARD"))), ["split-foreign-line"]);
  assert.deepEqual(codes(() => checkSplit(SRC, SRC.replace("MEMBER:mailto:x@example.org", "MEMBER:mailto:y@example.org"), { uidMap: { "urn:uuid:old-1": "q" } })), ["split-member"]);
  assert.deepEqual(codes(() => checkSplit(SRC, SRC.replace("KIND:group", "KIND:individual"))), ["split-foreign-line"]);
});

test("checkSplit: lines are consumed one for one; unparseable output is refused", () => {
  const twice = SRC.replace("END:VCARD", "FN:Team\nEND:VCARD");
  assert.deepEqual(codes(() => checkSplit(SRC, twice)), ["split-foreign-line"]);
  assert.deepEqual(codes(() => checkSplit(SRC, "BEGIN:VCARD\nFN:Team\n")), ["split-parse"]);
  assert.deepEqual(codes(() => checkSplit(SRC, "garbage line\n")), ["split-parse"]);
});

test("checkSplit: complete mode reports lines missing from the output", () => {
  const missing = SRC.replace("MEMBER:mailto:x@example.org\n", "");
  assert.equal(checkSplit(SRC, missing), true, "a subset is fine by default");
  assert.deepEqual(codes(() => checkSplit(SRC, missing, { complete: true })), ["split-missing-line"]);
  // two cards in the source, one in the output (the shape of a later calendar split)
  const two = SRC + SRC.replace("old-1", "old-2");
  assert.equal(checkSplit(two, SRC.replace("old-1", "old-2")), true);
});
