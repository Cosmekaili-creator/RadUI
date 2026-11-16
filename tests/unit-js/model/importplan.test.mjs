// SPDX-License-Identifier: AGPL-3.0-or-later
// importplan.js: splitting a .vcf, classification against the target, limits, policies.
import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, countRows, fileNameFor, lossyProperties, planImport, resolveImport, splitVcf } from "../../../src/js/model/importplan.js";
import { checkNewItem } from "../../../src/js/model/fidelity.js";
import { openItem } from "../../../src/js/model/item.js";
import { parse } from "../../../src/js/model/contentlines.js";
import { fixture } from "./helpers.mjs";

const COL = "/alice/book/";
let n = 0;
const random = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const U = (k) => `urn:uuid:22222222-3333-4444-5555-${String(k).padStart(12, "0")}`;
const mixed = () => fixture("import-mixed.vcf");
const byIndex = (plan) => Object.fromEntries(plan.rows.map((r) => [r.index, r]));
const card = (uid, fn, extra = "") => `BEGIN:VCARD\r\nVERSION:3.0\r\n${uid ? `UID:${uid}\r\n` : ""}FN:${fn}\r\n${extra}END:VCARD\r\n`;

test("splitVcf: cards with original folding, line numbers, stray content and unterminated cards", () => {
  const chunks = splitVcf(mixed());
  assert.equal(chunks.length, 8);
  assert.deepEqual(chunks.map((c) => c.problem || null), [null, null, null, null, null, null, "unterminated", null]);
  assert.equal(chunks[0].line, 1);
  assert.ok(chunks[0].text.startsWith("BEGIN:VCARD\n") && chunks[0].text.endsWith("END:VCARD\n"));
  const stray = splitVcf("hello\nBEGIN:VCARD\nVERSION:3.0\nUID:a\nFN:A\nEND:VCARD\ntrailing words\n");
  assert.deepEqual(stray.map((c) => c.problem || null), ["outside-card", null, "outside-card"]);
  assert.deepEqual(splitVcf("\n\n  \n"), []);
  assert.deepEqual(splitVcf("begin:vcard\nVERSION:3.0\nUID:a\nFN:A\nend:vcard\n").map((c) => c.problem || null), [null]);
  // a folded line that starts like BEGIN is a continuation, never a boundary
  const fold = splitVcf("BEGIN:VCARD\nVERSION:3.0\nUID:a\nNOTE:x\n BEGIN:VCARD\nFN:A\nEND:VCARD\n");
  assert.equal(fold.length, 1);
});

test("planImport (import-mixed.vcf): every card gets its state and reason", () => {
  const plan = planImport(mixed(), [], { collectionHref: COL, random });
  assert.equal(plan.fatal, null);
  const r = byIndex(plan);
  assert.deepEqual(plan.rows.map((x) => x.state), ["new", "new", "unsupported", "invalid", "file-duplicate", "new", "invalid", "new"]);
  assert.equal(r[2].reason, "unsupported-version");
  assert.equal(r[2].version, "2.1");
  assert.equal(r[3].reason, "parse-error");
  assert.equal(r[4].reason, "duplicate-uid");
  assert.equal(r[4].text, null);
  assert.equal(r[6].reason, "unterminated");
  assert.equal(r[5].fn, "Nora Nouid");
  assert.ok(r[5].generatedUid && r[5].uid === r[5].generatedUid, "a UID is generated and reported");
  assert.ok(r[5].text.includes(`UID:${r[5].generatedUid}`));
  assert.equal(r[0].generatedUid, null);
  assert.equal(r[7].isGroup, true);
  assert.deepEqual(plan.counts, { new: 4, duplicate: 0, invalid: 2, unsupported: 1, "file-duplicate": 1 });
  assert.deepEqual(countRows(plan.rows), plan.counts);
  assert.equal(r[3].line > 1, true);
});

test("planImport: the first of two cards with the same UID is kept; an invalid first card does not claim the UID", () => {
  const text = card("dup", "First") + card("dup", "Second") + card("dup", "Third");
  const plan = planImport(text, [], { collectionHref: COL, random });
  assert.deepEqual(plan.rows.map((x) => x.state), ["new", "file-duplicate", "file-duplicate"]);
  assert.equal(plan.rows[0].fn, "First");
  const badFirst = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:dup\r\nbroken line\r\nEND:VCARD\r\n" + card("dup", "Good");
  assert.deepEqual(planImport(badFirst, [], { collectionHref: COL, random }).rows.map((x) => x.state), ["invalid", "new"]);
});

test("planImport: file names: <uid>.vcf for a safe UID, else a UUID; no clash with known names", () => {
  const text = card("safe-uid_1@x.y", "A") + card("urn:uuid:abc", "B") + card("has space", "C") + card("." , "D") + card("a".repeat(101), "E");
  const plan = planImport(text, [{ href: `${COL}other.vcf`, etag: '"1"', uid: "other" }], { collectionHref: COL, random });
  const hrefs = plan.rows.map((r) => r.href);
  assert.equal(hrefs[0], `${COL}safe-uid_1%40x.y.vcf`.replace("%40", "%40"));
  for (const h of hrefs.slice(1)) assert.match(h, /^\/alice\/book\/00000000-0000-4000-8000-\d{12}\.vcf$/);
  assert.equal(new Set(hrefs).size, 5);
  assert.equal(fileNameFor("ok.1", random), "ok.1.vcf");
  assert.match(fileNameFor("ok.1", random, new Set(["ok.1.vcf"])), /^0000.*\.vcf$/);
  assert.match(fileNameFor("OK.1", random, new Set(["ok.1.vcf"])), /^0000.*\.vcf$/, "case-insensitive clash");
  assert.match(fileNameFor("x/y", random), /\.vcf$/);
});

test("planImport: duplicates by UID against the known items carry the existing href and ETag", () => {
  const known = [{ href: `${COL}gina.vcf`, etag: '"e1"', uid: U(21), fn: "Gina Good", emails: ["gina.good@example.org"] }];
  const plan = planImport(mixed(), known, { collectionHref: COL, random });
  const r = byIndex(plan);
  assert.equal(r[0].state, "duplicate");
  assert.equal(r[0].reason, "uid-exists");
  assert.deepEqual([r[0].href, r[0].existingHref, r[0].existingEtag], [`${COL}gina.vcf`, `${COL}gina.vcf`, '"e1"']);
  assert.equal(r[4].state, "file-duplicate");
  assert.equal(plan.counts.duplicate, 1);
});

test("planImport: same name or e-mail with a different UID is only a hint", () => {
  const known = [
    { href: `${COL}k1.vcf`, etag: '"1"', uid: "known-1", fn: "gina  GOOD", emails: [] },
    { href: `${COL}k2.vcf`, etag: '"2"', uid: "known-2", fn: "Someone", emails: ["GABE@example.org"] },
  ];
  const plan = planImport(mixed(), known, { collectionHref: COL, random });
  const r = byIndex(plan);
  assert.deepEqual(r[0].hints.map((h) => [h.kind, h.href]), [["same-name", `${COL}k1.vcf`]]);
  assert.deepEqual(r[1].hints.map((h) => [h.kind, h.href]), [["same-email", `${COL}k2.vcf`]]);
  assert.equal(r[0].state, "new", "information only");
  assert.deepEqual(r[7].hints, [], "group cards get no hints");
});

test("planImport: limits (file size, item count, item size) and empty input", () => {
  assert.equal(LIMITS.fileBytes, 10 * 1024 * 1024);
  assert.equal(LIMITS.items, 5000);
  assert.equal(LIMITS.itemBytes, 1024 * 1024);
  const small = { limits: { fileBytes: 200 } };
  const big = planImport(mixed(), [], small);
  assert.deepEqual(big.fatal, { reason: "file-too-large", limit: 200 });
  assert.deepEqual(big.rows, []);
  const many = planImport(card("a", "A") + card("b", "B") + card("c", "C"), [], { limits: { items: 2 } });
  assert.deepEqual(many.fatal, { reason: "too-many-items", count: 3, limit: 2 });
  const long = card("big", "Big", `NOTE:${"x".repeat(300)}\r\n`);
  const p = planImport(long + card("ok", "Ok"), [], { limits: { itemBytes: 200 }, collectionHref: COL, random });
  assert.deepEqual(p.rows.map((r) => [r.state, r.reason]), [["invalid", "too-large"], ["new", null]]);
  assert.deepEqual(planImport("", []).fatal, { reason: "empty" });
  assert.deepEqual(planImport("\n \n", []).fatal, { reason: "empty" });
  // multi-byte text is measured in bytes
  assert.equal(planImport(card("m", "é".repeat(60)), [], { limits: { itemBytes: 150 }, random }).rows[0].state, "invalid");
});

test("planImport handles a BOM and CR-only line endings", () => {
  const text = "﻿" + card("bom", "Bom").replace(/\r\n/g, "\r");
  const plan = planImport(text, [], { collectionHref: COL, random });
  assert.equal(plan.rows[0].state, "new");
});

// -- policies --------------------------------------------------------------------------------------

const KNOWN = [{ href: `${COL}gina.vcf`, etag: '"e1"', uid: U(21), fn: "Gina Good", emails: [] }];

test("resolveImport skip (default): duplicates and bad cards are reported, new cards are created", () => {
  const plan = planImport(mixed(), KNOWN, { collectionHref: COL, random });
  const res = resolveImport(plan, undefined, { collectionHref: COL, random });
  assert.deepEqual(res.operations.map((o) => [o.op, o.index]), [["create", 1], ["create", 5], ["create", 7]]);
  assert.deepEqual(res.skipped.map((s) => [s.index, s.state, s.reason]), [
    [0, "duplicate", "kept-existing"], [2, "unsupported", "unsupported-version"], [3, "invalid", "parse-error"], [4, "file-duplicate", "duplicate-uid"], [6, "invalid", "unterminated"],
  ]);
  assert.deepEqual(res.counts, { create: 3, replace: 0, skipped: 5, lossy: 0, lossySkipped: 0 });
  assert.deepEqual(res.problems, []);
  for (const o of res.operations) {
    assert.ok(o.text.endsWith("\r\n") && !/[^\r]\n/.test(o.text), "CRLF body");
    assert.equal(checkNewItem(o.text, { requireProdid: false }), true);
    assert.equal(o.op === "create" && o.etag, undefined);
    assert.ok(o.href.startsWith(COL) && o.href.endsWith(".vcf"));
  }
});

test("a generated UID is the only mutation of a card without UID", () => {
  const plan = planImport(mixed(), [], { collectionHref: COL, random });
  const op = resolveImport(plan, "skip", { collectionHref: COL, random }).operations.find((o) => o.index === 5);
  const src = splitVcf(mixed())[5].text.split("\n").filter(Boolean);
  const out = op.text.split("\r\n").filter(Boolean);
  assert.deepEqual(out.filter((l) => !src.includes(l)), [`UID:${plan.rows[5].generatedUid}`]);
  assert.equal(out.length, src.length + 1);
  assert.equal(op.uid, plan.rows[5].generatedUid);
});

test("every other line of an imported card is the source line, folded as it was", () => {
  const folded = "BEGIN:VCARD\nVERSION:3.0\nUID:fold-1\nFN:Folded\nNOTE:" + "word ".repeat(30).trim().slice(0, 60) + "\n " + "tail".repeat(5) + "\nEND:VCARD\n";
  const plan = planImport(folded, [], { collectionHref: COL, random });
  const op = resolveImport(plan, "skip", { collectionHref: COL, random }).operations[0];
  assert.equal(op.text, folded.replace(/\n/g, "\r\n"));
});

test("resolveImport replace: PUT on the existing href with the existing ETag", () => {
  const plan = planImport(mixed(), KNOWN, { collectionHref: COL, random });
  const res = resolveImport(plan, "replace", { collectionHref: COL, random });
  const rep = res.operations.find((o) => o.op === "replace");
  assert.deepEqual([rep.index, rep.href, rep.etag, rep.uid], [0, `${COL}gina.vcf`, '"e1"', U(21)]);
  assert.ok(rep.text.includes("FN:Gina Good"));
  assert.deepEqual(res.counts, { create: 3, replace: 1, skipped: 4, lossy: 0, lossySkipped: 0 });
  // a known item without an ETag cannot be replaced
  const noEtag = planImport(mixed(), [{ href: `${COL}gina.vcf`, uid: U(21) }], { collectionHref: COL, random });
  const r2 = resolveImport(noEtag, "replace", { collectionHref: COL, random });
  assert.deepEqual(r2.problems.map((p) => p.code), ["no-etag"]);
  assert.equal(r2.operations.some((o) => o.op === "replace"), false);
});

test("resolveImport keep-both: new UID and href for a duplicate, MEMBER lines of imported groups follow", () => {
  const plan = planImport(mixed(), KNOWN, { collectionHref: COL, random });
  const res = resolveImport(plan, "keep-both", { collectionHref: COL, random });
  assert.equal(res.operations.every((o) => o.op === "create"), true);
  assert.deepEqual(res.operations.map((o) => o.index), [0, 1, 5, 7]);
  const copy = res.operations.find((o) => o.index === 0);
  assert.notEqual(copy.uid, U(21));
  assert.match(copy.uid, /^urn:uuid:00000000-/, "the urn:uuid: style of the UID is kept");
  assert.notEqual(copy.href, `${COL}gina.vcf`);
  const parsed = parse(copy.text)[0];
  assert.equal(parsed.props("UID").length, 1);
  assert.equal(parsed.prop("UID").value, copy.uid);
  const group = res.operations.find((o) => o.index === 7);
  const members = parse(group.text)[0].props("MEMBER").map((p) => p.value);
  assert.deepEqual(members, [copy.uid, U(22)], "the re-keyed member follows, the other stays");
  const lines = (t) => t.split("\r\n").filter(Boolean);
  const src = splitVcf(mixed())[7].text.split("\n").filter(Boolean);
  assert.deepEqual(lines(group.text).filter((l) => !src.includes(l)), [`MEMBER:${copy.uid}`]);
  assert.equal(res.operations.find((o) => o.index === 1).uid, U(22), "other cards keep their UID");
  assert.equal(new Set(res.operations.map((o) => o.href)).size, res.operations.length);
});

test("keep-both with a plain (non-urn) UID keeps the plain style and a bare member form", () => {
  const text = card("plain-1", "P") + `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:g1\r\nKIND:group\r\nFN:G\r\nMEMBER:plain-1\r\nEND:VCARD\r\n`;
  const plan = planImport(text, [{ href: `${COL}p.vcf`, etag: '"1"', uid: "plain-1" }], { collectionHref: COL, random });
  const res = resolveImport(plan, "keep-both", { collectionHref: COL, random });
  const p = res.operations[0];
  assert.match(p.uid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(parse(res.operations[1].text)[0].props("MEMBER").map((x) => x.value), [p.uid]);
});

test("an imported group whose members were not re-keyed is imported as it stands", () => {
  const plan = planImport(card("c1", "C") + `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:g1\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nFN:G\r\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:c1\r\nEND:VCARD\r\n`, [], { collectionHref: COL, random });
  const res = resolveImport(plan, "keep-both", { collectionHref: COL, random });
  assert.ok(res.operations[1].text.includes("X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:c1"));
});

test("resolveImport rejects an unknown policy; every operation opens as an editable contact", () => {
  assert.throws(() => resolveImport({ rows: [] }, "overwrite"), /unknown policy/);
  const plan = planImport(mixed(), KNOWN, { collectionHref: COL, random });
  for (const policy of ["skip", "replace", "keep-both"]) {
    for (const o of resolveImport(plan, policy, { collectionHref: COL, random }).operations) {
      const it = openItem(o.text, "contact");
      assert.equal(it.ok && !it.readOnly, true, `${policy} ${o.index}`);
      assert.equal(it.uid, o.uid);
    }
  }
});

test("a whole book export imports cleanly (every fixture card is accepted or refused with a reason)", () => {
  const files = ["vcard30-basic.vcf", "vcard30-groups.vcf", "vcard40-groups.vcf", "vcard30-apple-labels.vcf", "vcard40-hostile.vcf", "vcard30-bidi.vcf", "vcard21-basic.vcf", "vcard30-group-apple-labels.vcf", "vcard40-group-unknown-member.vcf"];
  const text = files.map((f) => fixture(f)).join("");
  const plan = planImport(text, [], { collectionHref: COL, random });
  assert.equal(plan.rows.length, files.length);
  assert.equal(plan.rows.filter((r) => r.state === "unsupported").length, 1);
  const res = resolveImport(plan, "skip", { collectionHref: COL, random });
  assert.equal(res.problems.length, 0);
  assert.equal(res.operations.length, files.length - 1);
});

// -- lossy cards (Radicale damages them on storage) ---------------------------------------------------------

const lossyCard = (uid) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:Lossy ${uid}\r\nNOTE:one, two\r\nTITLE:Boss\\, Jr.\r\nX-CUSTOM:a,b\r\nX-OTHER:fine\r\nEND:VCARD\r\n`;
const photo4 = (uid) => `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:${uid}\r\nFN:Photo ${uid}\r\nPHOTO:data:image/jpeg;base64,QUJDRA==\r\nEND:VCARD\r\n`;

test("lossyProperties: unescaped commas in NOTE/TITLE/NICKNAME/X- properties and a data: PHOTO", () => {
  const props = (t) => lossyProperties(openItem(t, "contact")).sort();
  assert.deepEqual(props(lossyCard("a")), ["NOTE", "X-CUSTOM"], "an escaped comma is fine");
  assert.deepEqual(props(photo4("b")), ["PHOTO"]);
  assert.deepEqual(props(card("c", "Plain", "NICKNAME:a,b\r\n")), ["NICKNAME"]);
  assert.deepEqual(props(card("d", "Plain", "NOTE:escaped\\, comma\r\nCATEGORIES:a,b\r\nADR:;;1 Road,Bldg 2;T;;1;X\r\n")), [], "structured and list properties are not text");
  assert.deepEqual(props(card("e", "Plain", "PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==\r\n")), []);
  assert.deepEqual(lossyProperties(openItem(fixture("vcard40-photo.vcf"), "contact")), ["PHOTO"]);
});

test("planImport flags lossy rows without rewriting the text", () => {
  const text = lossyCard("l1") + photo4("p1") + card("ok", "Fine");
  const plan = planImport(text, [], { collectionHref: COL, random });
  assert.deepEqual(plan.rows.map((r) => r.lossy), [["NOTE", "X-CUSTOM"], ["PHOTO"], []]);
  assert.deepEqual(plan.lossy, [
    { index: 0, uid: "l1", fn: "Lossy l1", properties: ["NOTE", "X-CUSTOM"] },
    { index: 1, uid: "p1", fn: "Photo p1", properties: ["PHOTO"] },
  ]);
  assert.deepEqual(plan.counts, { new: 3, duplicate: 0, invalid: 0, unsupported: 0, "file-duplicate": 0 });
  const res = resolveImport(plan, "skip", { collectionHref: COL, random });
  assert.equal(res.operations[0].text, lossyCard("l1"), "the card goes out exactly as written");
  assert.deepEqual(res.operations[0].lossy, ["NOTE", "X-CUSTOM"]);
  assert.deepEqual(res.counts, { create: 3, replace: 0, skipped: 0, lossy: 2, lossySkipped: 0 });
});

test("replace policy: a lossy card is not allowed to replace an existing one unless its UID is confirmed", () => {
  const text = lossyCard("l1") + photo4("p1") + card("ok", "Fine") + lossyCard("n1");
  const known = ["l1", "p1", "ok"].map((u) => ({ href: `${COL}${u}.vcf`, etag: `"${u}"`, uid: u }));
  const plan = planImport(text, known, { collectionHref: COL, random });
  const res = resolveImport(plan, "replace", { collectionHref: COL, random });
  assert.deepEqual(res.operations.map((o) => [o.op, o.uid]), [["replace", "ok"], ["create", "n1"]], "a new lossy card is still created (nothing is overwritten)");
  assert.deepEqual(res.skipped.map((s) => [s.index, s.reason, s.properties]), [[0, "lossy-needs-confirmation", ["NOTE", "X-CUSTOM"]], [1, "lossy-needs-confirmation", ["PHOTO"]]]);
  assert.deepEqual(res.problems.map((p) => [p.index, p.code]), [[0, "lossy-skipped"], [1, "lossy-skipped"]]);
  assert.deepEqual(res.counts, { create: 1, replace: 1, skipped: 2, lossy: 1, lossySkipped: 2 });
  const ok = resolveImport(plan, "replace", { collectionHref: COL, random, confirmLossy: ["p1"] });
  assert.deepEqual(ok.operations.map((o) => [o.op, o.uid]), [["replace", "p1"], ["replace", "ok"], ["create", "n1"]]);
  assert.ok(ok.operations.some((o) => o.op === "replace" && o.uid === "p1"));
  assert.ok(!ok.operations.some((o) => o.uid === "l1"));
  assert.deepEqual(ok.counts.lossySkipped, 1);
  const kb = resolveImport(plan, "keep-both", { collectionHref: COL, random });
  assert.equal(kb.counts.lossySkipped, 0, "keep-both creates new cards");
  assert.equal(resolveImport(plan, "skip", { collectionHref: COL, random }).counts.lossySkipped, 0);
});

test("planImport caps the number of chunks (a file of bare BEGIN:VCARD lines)", () => {
  assert.equal(LIMITS.chunks, 20000);
  const bare = "BEGIN:VCARD\n".repeat(50);
  const p = planImport(bare, [], { limits: { chunks: 10 } });
  assert.deepEqual(p.fatal, { reason: "too-many-chunks", limit: 10 });
  assert.deepEqual(p.rows, []);
  assert.ok(splitVcf(bare, { maxChunks: 10 }).length <= 12, "the scan stops early");
  const big = "BEGIN:VCARD\n".repeat(Math.floor((10 * 1024 * 1024) / 13));
  const t0 = Date.now();
  assert.equal(planImport(big, []).fatal.reason, "too-many-chunks");
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(planImport(card("a", "A"), [], { limits: { chunks: 1 }, collectionHref: COL, random }).fatal, null);
});
