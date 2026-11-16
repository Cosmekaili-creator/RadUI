// SPDX-License-Identifier: AGPL-3.0-or-later
// Change one owned field: the semantic diff shows only that property (plus the
// writer-managed ones), every untouched line is emitted unchanged, folding is
// at 75 octets, and a save without change sends nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { openItem } from "../../../src/js/model/item.js";
import { semdiff, changedNames } from "../../lib/semdiff.js";
import { BS, D, crlf, fixture, fixtures, logical, octets, physical } from "./helpers.mjs";

const NOW = D("2026-11-12T10:00:00Z");
const MANAGED = ["DTSTAMP", "SEQUENCE", "LAST-MODIFIED", "REV", "CREATED"];
const keyOf = (line) => line.split(/[;:]/)[0].toUpperCase().replace(/^[A-Z0-9-]+\./, (m) => m);

/** Lines of a CRLF text without the given property names (after unfolding). */
function without(text, names) {
  const set = new Set(names);
  return logical(text).filter((l) => !set.has(keyOf(l)));
}

const TEXT_EDIT = `Changed, text; with ${BS}backslash and\nnewline é 日本 😀`;
const PRIMARY = { event: ["summary", "SUMMARY"], task: ["summary", "SUMMARY"], contact: ["fn", "FN"] };

for (const f of fixtures().filter((x) => !x.meta.expect)) {
  const [field, prop] = PRIMARY[f.meta.kind];
  test(`edit ${field} only: ${f.name}`, () => {
    const item = openItem(f.text, f.meta.kind);
    assert.equal(item.update({ [field]: TEXT_EDIT }), true);
    const out = item.save({ now: NOW });
    assert.equal(out.changed, true);
    assert.ok(out.text.endsWith("\r\n") && !/[^\r]\n/.test(out.text), "CRLF only");
    for (const l of physical(out.text)) assert.ok(octets(l) <= 75, `line over 75 octets: ${l.slice(0, 30)}`);
    const d = semdiff(f.text, out.text, { ignoreManaged: true });
    assert.deepEqual(changedNames(d), [prop]);
    // every other line is emitted unchanged and in the same order
    assert.deepEqual(without(out.text, [prop, ...MANAGED]), without(crlf(f.text), [prop, ...MANAGED]));
    // the edit reads back
    const back = openItem(out.text, f.meta.kind);
    assert.equal(back.ok, true);
    assert.equal(back.fields()[field], TEXT_EDIT);
  });
}

test("writer-managed properties: DTSTAMP, LAST-MODIFIED and SEQUENCE+1 on events", () => {
  const item = openItem(fixture("event-existing-managed.ics"), "event");
  item.update({ summary: "New" });
  const t = item.save({ now: NOW }).text;
  assert.match(t, /\r\nDTSTAMP:20261112T100000Z\r\n/);
  assert.match(t, /\r\nLAST-MODIFIED:20261112T100000Z\r\n/);
  assert.match(t, /\r\nSEQUENCE:4\r\n/);
  assert.match(t, /\r\nCREATED:20251201T080000Z\r\n/, "CREATED is never touched");
});

test("SEQUENCE starts at 1 when the event had none; tasks get no SEQUENCE", () => {
  const e = openItem(fixture("event-floating.ics"), "event");
  e.update({ summary: "x" });
  assert.match(e.save({ now: NOW }).text, /\r\nSEQUENCE:1\r\n/);
  const t = openItem(fixture("todo-open.ics"), "task");
  t.update({ summary: "x" });
  const out = t.save({ now: NOW }).text;
  assert.doesNotMatch(out, /SEQUENCE/);
  assert.match(out, /\r\nLAST-MODIFIED:20261112T100000Z\r\n/);
});

test("UID, VERSION and PRODID of a foreign item are never changed", () => {
  for (const [name, kind] of [["event-vendor-cloud.ics", "event"], ["vcard30-basic.vcf", "contact"], ["event-tzid-custom-embedded.ics", "event"]]) {
    const src = fixture(name);
    const item = openItem(src, kind);
    item.update(kind === "event" ? { summary: "z" } : { fn: "z" });
    const out = item.save({ now: NOW }).text;
    for (const k of ["UID", "VERSION", "PRODID"]) {
      const pick = (t) => logical(t).filter((l) => l.startsWith(k + ":"));
      assert.deepEqual(pick(out), pick(src), `${name} ${k}`);
    }
  }
});

test("a save with no change to any owned property returns {changed:false}", () => {
  const item = openItem(fixture("event-utc-basic.ics"), "event");
  assert.deepEqual(item.save(), { changed: false });
  const f = item.fields();
  // setting every field to its current value is a no-op as well
  assert.equal(item.update({ summary: f.summary, description: f.description, location: f.location, url: f.url, categories: f.categories, status: f.status, transp: f.transp, start: f.start, end: f.end, rrule: f.rrule, alarms: f.alarms }), false);
  assert.deepEqual(item.save(), { changed: false });
  const c = openItem(fixture("vcard30-groups.vcf"), "contact");
  const cf = c.fields();
  assert.equal(c.update({ fn: cf.fn, n: cf.n, tel: cf.tel, email: cf.email, url: cf.url, note: cf.note, categories: cf.categories, bday: cf.bday && { year: cf.bday.year, month: cf.bday.month, day: cf.bday.day } }), false);
  assert.deepEqual(c.save(), { changed: false });
});

test("setting a value and then restoring it is not a change", () => {
  const item = openItem(fixture("event-utc-basic.ics"), "event");
  item.update({ summary: "Temp" });
  item.update({ summary: "Planning meeting" });
  assert.deepEqual(item.save(), { changed: false });
});

test("save does not mutate the item: repeating it gives the same text", () => {
  const item = openItem(fixture("event-existing-managed.ics"), "event");
  item.update({ summary: "A" });
  const a = item.save({ now: NOW }).text;
  const b = item.save({ now: NOW }).text;
  assert.equal(a, b);
  assert.match(a, /SEQUENCE:4/);
});

test("escaping: comma, semicolon, backslash and newline in TEXT values", () => {
  const item = openItem(fixture("event-utc-basic.ics"), "event");
  item.update({ description: `a,b;c${BS}d\ne`, location: "Hall, Room; 3", categories: ["x,y", "z"] });
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes(`DESCRIPTION:a${BS},b${BS};c${BS}${BS}d${BS}ne`));
  assert.ok(out.includes(`LOCATION:Hall${BS}, Room${BS}; 3`));
  assert.ok(out.includes(`CATEGORIES:x${BS},y,z`));
  const back = openItem(out, "event").fields();
  assert.equal(back.description, `a,b;c${BS}d\ne`);
  assert.deepEqual(back.categories, ["x,y", "z"]);
});

test("URL is not escaped (it is a URI)", () => {
  const item = openItem(fixture("event-utc-basic.ics"), "event");
  item.update({ url: "https://example.org/a,b;c" });
  assert.ok(item.save({ now: NOW }).text.includes("URL:https://example.org/a,b;c\r\n"));
});

test("an edited property keeps its original name case, a new one is upper-case", () => {
  const src = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//X//EN\r\nBEGIN:VEVENT\r\nuid:low@example.org\r\ndtstart:20260401T100000Z\r\nsummary:lower\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const item = openItem(src, "event");
  item.update({ summary: "Edited", location: "Somewhere" });
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("\r\nsummary:Edited\r\n"));
  assert.ok(out.includes("\r\nLOCATION:Somewhere\r\n"));
  assert.ok(out.includes("\r\nuid:low@example.org\r\n"));
});

test("editing DTSTART keeps unrelated parameters, replaces VALUE/TZID", () => {
  const src = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//X//EN\r\nBEGIN:VEVENT\r\nUID:p@example.org\r\nDTSTART;X-KEEP=1;VALUE=DATE:20260401\r\nSUMMARY:s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const item = openItem(src, "event");
  item.update({ start: { kind: "zoned", iso: "2026-04-02T09:00:00", tzid: "Europe/Paris" } });
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("\r\nDTSTART;X-KEEP=1;TZID=Europe/Paris:20260402T090000\r\n"), out);
  item.update({ start: { kind: "date", iso: "2026-04-03" } });
  assert.ok(item.save({ now: NOW }).text.includes("\r\nDTSTART;X-KEEP=1;VALUE=DATE:20260403\r\n"));
});

test("all-day, floating and zoned values are kept as they are when another field changes", () => {
  for (const [name, needle] of [["event-allday-single.ics", "DTSTART;VALUE=DATE:20260401"], ["event-floating.ics", "DTSTART:20260402T090000\r\n"], ["event-tzid-embedded.ics", "DTSTART;TZID=America/New_York:20260308T013000"]]) {
    const item = openItem(fixture(name), "event");
    item.update({ location: "L" });
    assert.ok(item.save({ now: NOW }).text.includes(needle), name);
  }
});

test("DURATION: editing the end rewrites DURATION, not DTEND", () => {
  const item = openItem(fixture("event-duration.ics"), "event");
  item.update({ end: { kind: "utc", iso: "2026-05-09T12:00:00" } });
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("\r\nDURATION:PT2H\r\n"));
  assert.doesNotMatch(out, /DTEND/);
  assert.deepEqual(changedNames(semdiff(fixture("event-duration.ics"), out, { ignoreManaged: true })), ["DURATION"]);
});

test("DURATION on an all-day event is rewritten in days", () => {
  const item = openItem(fixture("event-allday-duration.ics"), "event");
  item.update({ end: { kind: "date", iso: "2026-05-12" } });
  assert.ok(item.save({ now: NOW }).text.includes("\r\nDURATION:P2D\r\n"));
});

test("DTEND edit on a zoned event", () => {
  const item = openItem(fixture("event-tzid-embedded.ics"), "event");
  item.update({ end: { kind: "zoned", iso: "2026-03-08T05:00:00", tzid: "America/New_York" } });
  const d = semdiff(fixture("event-tzid-embedded.ics"), item.save({ now: NOW }).text, { ignoreManaged: true });
  assert.deepEqual(changedNames(d), ["DTEND"]);
});

test("categories spread over several lines are merged into one only when they change", () => {
  const item = openItem(fixture("event-existing-managed.ics"), "event");
  assert.deepEqual(item.fields().categories, ["alpha", "beta", "gamma"]);
  assert.equal(item.update({ categories: ["alpha", "beta", "gamma"] }), false);
  item.update({ categories: ["alpha", "delta"] });
  const out = item.save({ now: NOW }).text;
  assert.equal(logical(out).filter((l) => l.startsWith("CATEGORIES")).length, 1);
});

test("status and transparency are validated", () => {
  const item = openItem(fixture("event-utc-basic.ics"), "event");
  assert.throws(() => item.update({ status: "MAYBE" }), /STATUS/);
  assert.throws(() => item.update({ transp: "X" }), /TRANSP/);
  item.update({ status: "cancelled" });
  assert.ok(item.save({ now: NOW }).text.includes("\r\nSTATUS:CANCELLED\r\n"));
});

test("removing a field removes its line only", () => {
  const item = openItem(fixture("event-utc-basic.ics"), "event");
  item.update({ location: "", url: "" });
  const out = item.save({ now: NOW }).text;
  assert.doesNotMatch(out, /LOCATION|URL/);
  assert.deepEqual(changedNames(semdiff(fixture("event-utc-basic.ics"), out, { ignoreManaged: true })), ["LOCATION", "URL"]);
});

test("foreign properties survive an edit untouched (attendees, X-, ATTACH, GEO)", () => {
  for (const name of ["event-attendees.ics", "event-xprops.ics", "event-alarms.ics"]) {
    const src = fixture(name);
    const item = openItem(src, "event");
    item.update({ summary: "Z" });
    const out = item.save({ now: NOW }).text;
    const keep = logical(src).filter((l) => !/^(SUMMARY|DTSTAMP|SEQUENCE|LAST-MODIFIED)/.test(l));
    const got = logical(out);
    for (const l of keep) assert.ok(got.includes(l), `${name}: lost ${l.slice(0, 50)}`);
  }
});

test("folded multi-byte text: edits fold at 75 octets and never split a character", () => {
  const item = openItem(fixture("event-folded-multibyte.ics"), "event");
  item.update({ description: "日本語のテキスト、€uro ✓ 😀 ".repeat(20) });
  const out = item.save({ now: NOW }).text;
  for (const l of physical(out)) assert.ok(octets(l) <= 75);
  const back = openItem(out, "event").fields();
  assert.equal(back.description, "日本語のテキスト、€uro ✓ 😀 ".repeat(20));
  assert.ok(!out.includes("�"));
});

test("foreign folding of untouched lines is preserved exactly", () => {
  const src = fixture("event-fold-foreign.ics");
  const item = openItem(src, "event");
  item.update({ location: "Elsewhere" });
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("SUMMARY:Folded by a foreign writer at 76 octets and with a tab continuation li\r\n ne after it\r\n\tand another one\r\n"));
  assert.ok(out.includes("DESCRIPTION:fold in the middle of a wo\r\n rd and a trailing space \r\n kept\r\n"));
});

test("LF and lone-CR items are saved with CRLF", () => {
  for (const name of ["event-lf.ics", "event-cr.ics"]) {
    const item = openItem(fixture(name), "event");
    item.update({ summary: "S" });
    const out = item.save({ now: NOW }).text;
    assert.ok(!/(^|[^\r])\n/.test(out) && !/\r(?!\n)/.test(out), name);
  }
});

test("tasks: owned fields and one-tap complete", () => {
  const src = fixture("todo-open.ics");
  const item = openItem(src, "task");
  assert.equal(item.fields().priority, 5);
  item.completeTask(NOW);
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("\r\nSTATUS:COMPLETED\r\n"));
  assert.ok(out.includes("\r\nCOMPLETED:20261112T100000Z\r\n"));
  assert.ok(out.includes("\r\nPERCENT-COMPLETE:100\r\n"));
  assert.deepEqual(changedNames(semdiff(src, out, { ignoreManaged: true })), ["COMPLETED", "PERCENT-COMPLETE", "STATUS"]);
  const re = openItem(out, "task");
  re.reopenTask();
  const out2 = re.save({ now: NOW }).text;
  assert.doesNotMatch(out2, /COMPLETED:|PERCENT-COMPLETE/);
  assert.ok(out2.includes("\r\nSTATUS:NEEDS-ACTION\r\n"));
});

test("tasks: due, priority, percent, start, rrule, categories", () => {
  const item = openItem(fixture("todo-recurring.ics"), "task");
  item.update({ due: { kind: "date", iso: "2026-04-08" }, priority: 1, percent: 60, start: { kind: "date", iso: "2026-04-02" }, rrule: "FREQ=DAILY;COUNT=2", categories: ["a"] });
  const f = openItem(item.save({ now: NOW }).text, "task").fields();
  assert.equal(f.due.iso, "2026-04-08");
  assert.equal(f.priority, 1);
  assert.equal(f.percent, 60);
  assert.equal(f.rrule, "FREQ=DAILY;COUNT=2");
  assert.throws(() => item.update({ priority: 12 }), /PRIORITY/);
  assert.throws(() => item.update({ completed: { kind: "floating", iso: "2026-04-01T10:00:00" } }), /UTC/);
});

test("the completed task in the corpus keeps its COMPLETED value when the summary changes", () => {
  const item = openItem(fixture("todo-due-completed.ics"), "task");
  item.update({ summary: "Renamed" });
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("COMPLETED:20260409T120000Z"));
  assert.ok(out.includes("DUE:20260410T170000Z"));
});
