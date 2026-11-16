// SPDX-License-Identifier: AGPL-3.0-or-later
// importics.js (RUN3 C2): the .ics split, grouping by UID, wrapper / VTIMEZONE / METHOD handling, skipped components,
// unknown TZIDs, lossy flags, limits. Fixtures live in tests/fixtures/ics/import/ (synthetic, example.org).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LIMITS, planIcsImport, resolveImport } from "../../../src/js/model/importplan.js";
import { ICS_LIMITS, calendarUidOf, icsFileName, lossyCalendarProperties, splitIcs } from "../../../src/js/model/importics.js";
import { FidelityError, checkNewItem, checkSplit } from "../../../src/js/model/fidelity.js";
import { openItem } from "../../../src/js/model/item.js";
import { parse, normalizeNewlines } from "../../../src/js/model/contentlines.js";
import { FIXTURES, logical } from "./helpers.mjs";

const COL = "/alice/cal/";
let n = 0;
const random = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const fx = (name) => readFileSync(path.join(FIXTURES, "ics", "import", `import-${name}.ics`), "utf8");
const plan = (name, known = [], opts = {}) => planIcsImport(fx(name), known, { collectionHref: COL, random, ...opts });
const byUid = (p) => Object.fromEntries(p.rows.filter((r) => r.uid).map((r) => [r.uid, r]));
const ev = (uid, extra = "") => `BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART:20260401T080000Z\nSUMMARY:E ${uid}\n${extra}END:VEVENT\n`;
const cal = (body, head = "VERSION:2.0\nPRODID:-//Example//EN\n") => `BEGIN:VCALENDAR\n${head}${body}END:VCALENDAR\n`;

test("ICS_LIMITS equals the .vcf LIMITS", () => {
  assert.deepEqual({ ...ICS_LIMITS }, { ...LIMITS });
});

test("splitIcs: calendars, top-level blocks with original folding and line numbers, stray text, unterminated parts", () => {
  const sp = splitIcs(fx("recurring-overrides"));
  assert.equal(sp.error, null);
  assert.equal(sp.calendars.length, 1);
  assert.deepEqual(sp.blocks.map((b) => b.name), ["VTIMEZONE", "VTIMEZONE", "VEVENT", "VEVENT", "VEVENT", "VEVENT", "VEVENT"]);
  assert.deepEqual(sp.calendars[0].header, ["VERSION:2.0", "PRODID:-//Example Corp//Calendar 1.0//EN"]);
  assert.ok(sp.blocks[2].text.startsWith("BEGIN:VEVENT\nUID:series-a@example.org\n") && sp.blocks[2].text.endsWith("END:VEVENT\n"));
  assert.equal(sp.blocks[2].line, 38);
  const folded = splitIcs(fx("method-request"));
  assert.ok(folded.blocks[0].text.includes("fold" + "ed at the usual width so that \n the continuation"), "folding kept as in the file");
  const odd = splitIcs("stray words\n" + cal(ev("a")) + "more stray\n" + "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:b\n");
  assert.equal(odd.stray.length, 2);
  assert.equal(odd.calendars.length, 2);
  assert.equal(odd.calendars[1].unterminated, true);
  assert.deepEqual(odd.blocks.map((b) => b.problem || null), [null, "unterminated"]);
  assert.equal(splitIcs(" starts with a continuation\nBEGIN:VCALENDAR\n").error, "unreadable");
  assert.equal(splitIcs("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nA:1\nBEGIN:VALARM\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR\n").blocks.length, 1, "a nested component stays inside its parent");
});

test("splitIcs honours maxChunks", () => {
  const many = "BEGIN:VCALENDAR\nVERSION:2.0\n" + ev("x").repeat(30) + "END:VCALENDAR\n";
  assert.equal(splitIcs(many, { maxChunks: 10 }).overflow, true);
  assert.equal(splitIcs(many, { maxChunks: 100 }).overflow, false);
});

test("series and overrides stay in one resource; each resource carries exactly the VTIMEZONEs it references", () => {
  const p = plan("recurring-overrides");
  assert.equal(p.kind, "calendar");
  assert.equal(p.fatal, null);
  assert.deepEqual(p.rows.map((r) => r.state), ["new", "new", "new"]);
  const r = byUid(p);
  const series = r["series-a@example.org"];
  assert.equal(series.itemKind, "event");
  assert.equal(series.recurring, true);
  assert.equal(series.overrides, 2);
  assert.equal(series.title, "Weekly review");
  const root = parse(series.text)[0];
  assert.deepEqual(root.comps("VEVENT").map((c) => (c.prop("RECURRENCE-ID") ? "override" : "master")), ["master", "override", "override"], "file order, one resource");
  assert.deepEqual(root.comps("VTIMEZONE").map((c) => c.prop("TZID").value), ["Europe/Paris"]);
  assert.deepEqual(parse(r["single-ny@example.org"].text)[0].comps("VTIMEZONE").map((c) => c.prop("TZID").value), ["America/New_York"]);
  assert.equal(parse(r["single-utc@example.org"].text)[0].comps("VTIMEZONE").length, 0);
  assert.equal(series.href, `${COL}series-a%40example.org.ics`);
  assert.ok(series.line < r["single-ny@example.org"].line);
  assert.deepEqual(p.rows.map((x) => x.index), [0, 1, 2]);
});

test("the item text is the source text as it is: every line is a source line, none is re-folded or reordered", () => {
  for (const name of ["recurring-overrides", "method-request", "nouid", "mixed-components", "unknown-tzid", "unescaped-comma"]) {
    const src = fx(name);
    const sourceLines = logical(src);
    const p = plan(name);
    for (const row of p.rows.filter((x) => x.text)) {
      const left = [...sourceLines];
      for (const line of logical(row.text)) {
        const i = left.indexOf(line);
        if (i < 0) assert.match(line, /^(UID:00000000-|VERSION:2\.0$|PRODID:)/, `${name}: unexpected line ${line}`);
        else left.splice(i, 1);
      }
    }
  }
});

test("METHOD is dropped and reported; VERSION, PRODID and the folded lines are kept exactly", () => {
  const p = plan("method-request");
  assert.equal(p.rows.length, 2);
  for (const row of p.rows) {
    assert.deepEqual(row.notes, [{ code: "method-dropped", method: "REQUEST" }]);
    assert.ok(!/METHOD/i.test(row.text));
    assert.ok(row.text.includes("PRODID:-//Example Mail//Invitations 2.1//EN\nVERSION:2.0\nCALSCALE:GREGORIAN\nBEGIN:VEVENT"), "header order and text are the source's");
  }
  assert.ok(p.rows[0].text.includes("DESCRIPTION:A long agenda that the sender folded at the usual width so that \n the continuation line has to be kept exactly as it is in the file.\n"));
  assert.ok(p.rows[0].source.includes("METHOD:REQUEST"), "the source slice still has it (the guard compares with it)");
  const res = resolveImport(p, "skip", { collectionHref: COL });
  assert.equal(res.operations.length, 2);
  assert.ok(res.operations.every((o) => !/METHOD/.test(o.text) && o.text.includes("\r\n") && !/[^\r]\n/.test(o.text)));
});

test("a component without UID gets a generated UID (reported, inserted right after BEGIN)", () => {
  n = 0;
  const p = plan("nouid");
  assert.deepEqual(p.rows.map((r) => r.state), ["new", "new", "new", "new"]);
  const [a, b, t, c] = p.rows;
  assert.equal(a.generatedUid, "00000000-0000-4000-8000-000000000001");
  assert.ok(a.text.includes("BEGIN:VEVENT\nUID:00000000-0000-4000-8000-000000000001\nDTSTAMP"));
  assert.notEqual(a.generatedUid, b.generatedUid);
  assert.equal(t.itemKind, "task");
  assert.ok(t.text.includes("BEGIN:VTODO\nUID:"));
  assert.equal(c.generatedUid, null);
  assert.ok(a.notes.some((x) => x.code === "generated-uid"));
  assert.equal(a.source.includes("UID:"), false, "the source slice has no UID line");
  const res = resolveImport(p, "skip", { collectionHref: COL, random });
  assert.equal(res.operations.length, 4);
  assert.deepEqual(res.problems, []);
});

test("mixed components: journal, free/busy, repeated, mixed, invalid, override-only, empty UID, a calendar without VERSION", () => {
  const p = plan("mixed-components");
  assert.deepEqual(p.rows.map((r) => `${r.state}:${r.reason || ""}`), [
    "new:", "new:", "unsupported:unsupported-component", "unsupported:unsupported-component", "file-duplicate:duplicate-uid",
    "invalid:mixed-components", "invalid:invalid-value", "invalid:no-master", "invalid:empty-uid", "new:",
  ]);
  assert.deepEqual(p.rows.slice(2, 4).map((r) => r.component), ["VJOURNAL", "VFREEBUSY"]);
  assert.deepEqual(p.counts, { new: 3, duplicate: 0, invalid: 4, unsupported: 2, "file-duplicate": 1 });
  assert.equal(p.rows[4].text, null);
  const nv = p.rows[9];
  assert.deepEqual(nv.notes, [{ code: "wrapper-added", lines: 1 }]);
  assert.ok(nv.text.startsWith("BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example Corp//Second Calendar//EN\n"));
  const res = resolveImport(p, "skip", { collectionHref: COL });
  assert.equal(res.operations.length, 3);
  assert.equal(res.skipped.length, 7);
  assert.deepEqual(res.problems, []);
  // VJOURNAL / VFREEBUSY are never part of an output
  assert.ok(res.operations.every((o) => !/VJOURNAL|VFREEBUSY/.test(o.text)));
});

test("a PRODID-less calendar gets the default PRODID; a VERSION:1.0 calendar is unsupported", () => {
  const p = planIcsImport(cal(ev("a"), "VERSION:2.0\n"), [], { collectionHref: COL });
  assert.deepEqual(p.rows[0].notes, [{ code: "wrapper-added", lines: 1 }]);
  assert.match(p.rows[0].text, /\nPRODID:-\/\/RadUI\/\/Calendar\/\/EN\n/);
  assert.equal(resolveImport(p, "skip", { collectionHref: COL }).operations.length, 1);
  const old = planIcsImport(cal(ev("a"), "VERSION:1.0\nPRODID:-//Old//EN\n"), [], { collectionHref: COL });
  assert.equal(old.rows[0].state, "unsupported");
  assert.equal(old.rows[0].reason, "unsupported-version");
});

test("a target that does not accept VTODO: tasks are unsupported, events are not", () => {
  const p = plan("nouid", [], { components: ["VEVENT"] });
  assert.deepEqual(p.rows.map((r) => `${r.state}:${r.component}`), ["new:VEVENT", "new:VEVENT", "unsupported:VTODO", "new:VEVENT"]);
  const tasks = plan("nouid", [], { components: ["VTODO"] });
  assert.deepEqual(tasks.rows.map((r) => r.state), ["unsupported", "unsupported", "new", "unsupported"]);
});

test("unknown TZID: imported as it is with a warning, never rewritten; defined and Intl-known zones are fine", () => {
  const p = plan("unknown-tzid");
  const r = byUid(p);
  const unknown = r["unknown-zone@example.org"];
  assert.deepEqual(unknown.notes, [{ code: "unknown-tzid", tzids: ["Nowhere/Example"] }]);
  assert.ok(unknown.text.includes('DTSTART;TZID="Nowhere/Example":20260610T090000\nDTEND;TZID="Nowhere/Example":20260610T100000\n'));
  assert.deepEqual(r["custom-zone@example.org"].notes, []);
  assert.equal(parse(r["custom-zone@example.org"].text)[0].comps("VTIMEZONE")[0].prop("TZID").value, "Example Standard Time");
  assert.deepEqual(r["iana-no-vtimezone@example.org"].notes, []);
  assert.equal(parse(r["iana-no-vtimezone@example.org"].text)[0].comps("VTIMEZONE").length, 0, "no VTIMEZONE is invented");
  assert.equal(openItem(unknown.text, "event").readOnly, true);
  const res = resolveImport(p, "skip", { collectionHref: COL });
  assert.equal(res.operations.length, 3, "the unknown-zone item is still imported");
  assert.equal(res.operations[0].text.replace(/\r\n/g, "\n"), unknown.text);
});

test("lossy: unescaped commas in SUMMARY, LOCATION (also on an override), COMMENT and X- text are flagged; escaped ones and CATEGORIES are not", () => {
  const p = plan("unescaped-comma");
  const r = byUid(p);
  assert.deepEqual(r["comma-summary@example.org"].lossy, ["SUMMARY"]);
  assert.deepEqual(r["comma-series@example.org"].lossy, ["LOCATION"]);
  assert.deepEqual(r["comma-clean@example.org"].lossy, []);
  assert.deepEqual(p.lossy.map((x) => x.uid), ["comma-summary@example.org", "comma-series@example.org"]);
  const root = parse(cal(ev("a", "X-FOO:one, two\nX-BAR;VALUE=URI:geo:1,2\nCOMMENT:x\\, y\nVALARM-LESS:1\n")))[0];
  assert.deepEqual(lossyCalendarProperties(root), ["X-FOO"]);
  const withAlarm = parse(cal(ev("a", "BEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT5M\nDESCRIPTION:wake, now\nEND:VALARM\n")))[0];
  assert.deepEqual(lossyCalendarProperties(withAlarm), ["DESCRIPTION"]);
});

test("planIcsImport: duplicates by UID carry the existing href and ETag; names never clash with known items", () => {
  const known = [{ href: `${COL}weekly.ics`, etag: '"e1"', uid: "series-a@example.org" }, { href: `${COL}single-ny%40example.org.ics`, etag: '"e2"', uid: "other" }];
  const p = plan("recurring-overrides", known);
  const r = byUid(p);
  assert.equal(r["series-a@example.org"].state, "duplicate");
  assert.equal(r["series-a@example.org"].existingHref, `${COL}weekly.ics`);
  assert.equal(r["series-a@example.org"].existingEtag, '"e1"');
  assert.equal(r["series-a@example.org"].reason, "uid-exists");
  assert.match(r["single-ny@example.org"].href, /^\/alice\/cal\/00000000-0000-4000-8000-\d{12}\.ics$/, "the name was taken");
  assert.deepEqual(p.counts, { new: 2, duplicate: 1, invalid: 0, unsupported: 0, "file-duplicate": 0 });
});

test("limits: file size, item count, chunk count, item size, empty and unreadable files", () => {
  assert.deepEqual(planIcsImport(fx("nouid"), [], { limits: { fileBytes: 100 } }).fatal, { reason: "file-too-large", limit: 100 });
  assert.deepEqual(planIcsImport(fx("nouid"), [], { limits: { items: 3 } }).fatal, { reason: "too-many-items", count: 4, limit: 3 });
  assert.deepEqual(planIcsImport(fx("nouid"), [], { limits: { chunks: 2 } }).fatal, { reason: "too-many-chunks", limit: 2 });
  assert.deepEqual(planIcsImport("hello\n").fatal, { reason: "empty" });
  assert.deepEqual(planIcsImport("").fatal, { reason: "empty" });
  assert.deepEqual(planIcsImport(" x\n").fatal, { reason: "unreadable" });
  const big = planIcsImport(cal(ev("a", `DESCRIPTION:${"x".repeat(300)}\n`)), [], { limits: { itemBytes: 200 } });
  assert.equal(big.rows[0].state, "invalid");
  assert.equal(big.rows[0].reason, "too-large");
  assert.equal(big.rows[0].text, null);
});

test("line endings: CRLF, LF and lone CR files give the same resources", () => {
  const lf = normalizeNewlines(fx("nouid"));
  const seed = () => {
    n = 0;
    return random;
  };
  const a = planIcsImport(lf, [], { collectionHref: COL, random: seed() });
  const b = planIcsImport(lf.replace(/\n/g, "\r"), [], { collectionHref: COL, random: seed() });
  const c = planIcsImport(lf.replace(/\n/g, "\r\n"), [], { collectionHref: COL, random: seed() });
  assert.deepEqual(a.rows.map((r) => r.text), b.rows.map((r) => r.text));
  assert.deepEqual(a.rows.map((r) => r.text), c.rows.map((r) => r.text));
});

test("an unterminated calendar still yields its complete items; the calendar itself is reported", () => {
  const p = planIcsImport("BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example//EN\n" + ev("done"), [], { collectionHref: COL });
  assert.ok(p.rows.some((r) => r.state === "invalid" && r.reason === "unterminated" && r.component === "VCALENDAR"));
  const ok = p.rows.find((r) => r.state === "new");
  assert.ok(ok.text.endsWith("END:VEVENT\nEND:VCALENDAR\n"));
  const res = resolveImport(p, "skip", { collectionHref: COL });
  assert.equal(res.operations.length, 1);
  assert.deepEqual(res.problems, []);
});

test("a malformed component is invalid on its own; the others in the file are still planned", () => {
  const bad = "BEGIN:VEVENT\nUID:broken\nthis line has no colon\nEND:VEVENT\n";
  const p = planIcsImport(cal(ev("a") + bad + ev("b")), [], { collectionHref: COL });
  assert.deepEqual(p.rows.map((r) => `${r.state}:${r.reason || ""}`), ["new:", "invalid:parse-error", "new:"]);
});

test("file names and helpers", () => {
  assert.equal(icsFileName("ok.1", random), "ok.1.ics");
  assert.match(icsFileName("ok.1", random, new Set(["ok.1.ics"])), /^0000.*\.ics$/);
  assert.match(icsFileName("OK.1", random, new Set(["ok.1.ics"])), /^0000.*\.ics$/);
  assert.match(icsFileName("a/b", random), /\.ics$/);
  assert.match(icsFileName(".hidden", random), /^0000/);
  assert.equal(calendarUidOf(fx("recurring-overrides")), "series-a@example.org");
  assert.equal(calendarUidOf("BEGIN:VCALENDAR\nEND:VCALENDAR\n"), null);
  assert.equal(calendarUidOf("BEGIN:VEVENT\nUID;X-A=1:abc\nEND:VEVENT\n"), "abc");
});

test("checkSplit for a calendar split: dropped METHOD, added wrapper lines, mapped UID rewrites; tampering is refused", () => {
  const src = cal(ev("u1"), "VERSION:2.0\nMETHOD:PUBLISH\nPRODID:-//E//EN\n");
  const out = cal(ev("u1"), "VERSION:2.0\nPRODID:-//E//EN\n");
  assert.throws(() => checkSplit(src, out, { complete: true }), (e) => e instanceof FidelityError && e.problems[0].code === "split-missing-line");
  assert.equal(checkSplit(src, out, { complete: true, dropped: ["method"] }), true);
  const noVersion = cal(ev("u1"), "PRODID:-//E//EN\n");
  const added = out;
  assert.throws(() => checkSplit(noVersion, added), (e) => e.problems[0].code === "split-foreign-line");
  assert.equal(checkSplit(noVersion, added, { added: ["VERSION:2.0"] }), true);
  const twice = cal(ev("u1") + ev("u1"));
  assert.equal(checkSplit(twice, twice.replace(/UID:u1/g, "UID:u2"), { uidMap: { u1: "u2" }, complete: true }), true, "both UID lines of the series are rewritten");
  assert.throws(() => checkSplit(src, out.replace("SUMMARY:E u1", "SUMMARY:E u1 changed"), { dropped: ["METHOD"] }), (e) => e.problems[0].code === "split-foreign-line");
  assert.throws(() => checkSplit(src, out.replace("UID:u1", "UID:other"), { dropped: ["METHOD"] }), (e) => e.problems[0].code === "split-uid");
});

test("every operation text is a valid new item and opens as an unchanged-by-default item", () => {
  for (const name of ["recurring-overrides", "method-request", "nouid", "mixed-components", "unknown-tzid", "unescaped-comma"]) {
    const res = resolveImport(plan(name), "skip", { collectionHref: COL, random });
    assert.ok(res.operations.length > 0, name);
    for (const o of res.operations) {
      assert.equal(o.op, "create");
      assert.equal(checkNewItem(o.text.replace(/\r\n/g, "\n"), { requireProdid: false }), true);
      const item = openItem(o.text, null);
      assert.equal(item.ok, true, `${name}: ${item.reason}`);
      if (!item.readOnly) assert.deepEqual(item.save(), { changed: false }, name);
    }
  }
});
