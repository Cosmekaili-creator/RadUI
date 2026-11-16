// SPDX-License-Identifier: AGPL-3.0-or-later
// Recurrence helpers (addExdate, upsertOverride, splitSeries), alarms, new events.
import test from "node:test";
import assert from "node:assert/strict";
import { createItem, openItem } from "../../../src/js/model/item.js";
import { checkFidelity } from "../../../src/js/model/fidelity.js";
import { semdiff, changedNames } from "../../lib/semdiff.js";
import { D, fixture, logical } from "./helpers.mjs";

const NOW = D("2026-11-12T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";
const starts = (item) => item.expand({}).occurrences.map((o) => (o.start.instant !== null ? iso(o.start.instant) : o.start.iso));
const paris = (isoLocal) => ({ kind: "zoned", iso: isoLocal, tzid: "Europe/Paris" });
const SERIES = "event-recur-exdate-override-moved.ics";

test("addExdate hides one occurrence, adds one line, and is idempotent", () => {
  const item = openItem(fixture("event-recur-weekly-dst.ics"), "event");
  assert.equal(item.addExdate(paris("2026-04-05T10:00:00")), true);
  assert.equal(item.addExdate(paris("2026-04-05T10:00:00")), false);
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("\r\nEXDATE;TZID=Europe/Paris:20260405T100000\r\n"));
  const d = semdiff(fixture("event-recur-weekly-dst.ics"), out, { ignoreManaged: true });
  assert.equal(d.diffs.length, 1);
  assert.equal(d.diffs[0].side, "b");
  const again = openItem(out, "event");
  assert.equal(again.expand({}).occurrences.length, 3);
  assert.equal(item.removeExdate(paris("2026-04-05T10:00:00")), true);
  assert.deepEqual(item.save(), { changed: false });
});

test("addExdate refuses a value of another kind than the series start", () => {
  const item = openItem(fixture("event-recur-weekly-dst.ics"), "event");
  assert.throws(() => item.addExdate({ kind: "date", iso: "2026-04-05" }), /same kind/);
});

test("addExdate on an all-day series uses VALUE=DATE", () => {
  const item = openItem(fixture("event-recur-allday.ics"), "event");
  item.addExdate({ kind: "date", iso: "2026-03-22" });
  assert.ok(item.save({ now: NOW }).text.includes("EXDATE;VALUE=DATE:20260322"));
  assert.deepEqual(starts(item), ["2026-03-01", "2026-03-15", "2026-03-29"]);
});

test("upsertOverride creates the override inside the SAME resource", () => {
  const src = fixture("event-recur-weekly-dst.ics");
  const item = openItem(src, "event");
  item.upsertOverride(paris("2026-04-05T10:00:00"), { summary: "Moved", start: paris("2026-04-05T15:00:00"), end: paris("2026-04-05T16:00:00") });
  const out = item.save({ now: NOW }).text;
  const re = openItem(out, "event");
  assert.equal(re.root.comps("VEVENT").length, 2, "master and override in one item");
  assert.equal(re.overrides.length, 1);
  const uids = new Set(re.root.comps("VEVENT").map((c) => c.prop("UID").value));
  assert.equal(uids.size, 1);
  const ov = re.overrides[0];
  assert.equal(ov.prop("RECURRENCE-ID").value, "20260405T100000");
  assert.equal(ov.prop("RRULE"), null);
  assert.equal(ov.prop("SUMMARY").value, "Moved");
  assert.deepEqual(starts(re), ["2026-03-22T09:00:00Z", "2026-03-29T08:00:00Z", "2026-04-05T13:00:00Z", "2026-04-12T08:00:00Z"]);
  checkFidelity(src, out);
  // the master text is untouched
  const master = logical(out).filter((l) => l.startsWith("RRULE:") || l.startsWith("DTSTART"));
  assert.ok(master.includes("RRULE:FREQ=WEEKLY;COUNT=4"));
});

test("a new override starts as a copy of the master (alarms, attendees) with the occurrence times", () => {
  const item = openItem(fixture(SERIES), "event");
  const ov = item.upsertOverride(paris("2026-04-13T09:30:00"), { location: "Elsewhere" });
  assert.equal(ov.prop("DTSTART").value, "20260413T093000");
  assert.equal(ov.prop("DTEND").value, "20260413T103000", "same length as the master");
  assert.equal(ov.comps("VALARM").length, 1);
  assert.equal(ov.prop("EXDATE"), null);
  assert.equal(ov.prop("LOCATION").value, "Elsewhere");
});

test("editing an existing override changes that VEVENT only", () => {
  const src = fixture(SERIES);
  const item = openItem(src, "event");
  item.upsertOverride(paris("2026-03-30T09:30:00"), { summary: "Moved again" });
  assert.equal(item.root.comps("VEVENT").length, 2, "no second override");
  const out = item.save({ now: NOW }).text;
  const d = semdiff(src, out, { ignoreManaged: true });
  assert.deepEqual(changedNames(d), ["SUMMARY"]);
  checkFidelity(src, out);
});

test("update(patch, {recurrenceId}) is the same as upsertOverride", () => {
  const item = openItem(fixture(SERIES), "event");
  item.update({ summary: "Via update" }, { recurrenceId: paris("2026-04-06T09:30:00") });
  assert.equal(item.overrides.length, 2);
});

test("removeOverride and deleteOccurrence", () => {
  const src = fixture(SERIES);
  const item = openItem(src, "event");
  assert.equal(item.removeOverride(paris("2026-03-30T09:30:00")), true);
  assert.equal(item.overrides.length, 0);
  assert.equal(item.removeOverride(paris("2026-03-30T09:30:00")), false);
  assert.ok(starts(item).includes("2026-03-30T07:30:00Z"), "the occurrence is back");
  item.deleteOccurrence(paris("2026-04-06T09:30:00"));
  assert.ok(!starts(item).includes("2026-04-06T07:30:00Z"));
  const out = item.save({ now: NOW }).text;
  checkFidelity(src, out);
  const item2 = openItem(src, "event");
  item2.deleteOccurrence(paris("2026-03-30T09:30:00"));
  assert.equal(item2.overrides.length, 0);
  assert.ok(!starts(item2).some((s) => s.startsWith("2026-03-30")));
});

test("splitSeries (this and following): UNTIL on the head, new UID on the tail", () => {
  const src = fixture(SERIES);
  const head = openItem(src, "event");
  const { tailText, tailUid } = head.splitSeries(paris("2026-03-23T09:30:00"), { newUid: "tail-1@example.org", now: NOW });
  const headOut = head.save({ now: NOW }).text;
  assert.ok(headOut.includes("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260323T082959Z"), headOut);
  assert.doesNotMatch(headOut, /COUNT=/);
  assert.equal(tailUid, "tail-1@example.org");
  checkFidelity(src, headOut);
  const h = openItem(headOut, "event");
  assert.deepEqual(starts(h), ["2026-03-02T08:30:00Z", "2026-03-09T08:30:00Z"], "16 March stays excluded in the head");
  assert.equal(h.overrides.length, 0, "the later override moved out");
  assert.equal(h.uid, "override-moved@example.org");

  const t = openItem(tailText, "event");
  assert.equal(t.ok, true);
  assert.equal(t.uid, "tail-1@example.org");
  assert.deepEqual(starts(t), ["2026-03-23T08:30:00Z", "2026-03-30T12:00:00Z", "2026-04-06T07:30:00Z", "2026-04-13T07:30:00Z", "2026-04-20T07:30:00Z"]);
  assert.match(tailText, /RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO/);
  assert.equal(t.root.comps("VTIMEZONE").length, 1, "the tail carries the VTIMEZONE it needs");
  assert.ok(t.root.comps("VEVENT").every((c) => c.prop("UID").value === "tail-1@example.org"));
  assert.equal(t.root.prop("PRODID").value, "-//RadUI//Calendar//EN", "new item: PRODID is ours");
  assert.ok(tailText.endsWith("\r\n"));
});

test("splitSeries keeps the head PRODID/UID and lets the caller choose the tail PRODID", () => {
  const head = openItem(fixture(SERIES), "event");
  const { tailText } = head.splitSeries(paris("2026-03-23T09:30:00"), { newUid: "t2@example.org", prodid: "-//Test//Tail//EN", now: NOW });
  assert.match(tailText, /PRODID:-\/\/Test\/\/Tail\/\/EN/);
  const out = head.save({ now: NOW }).text;
  assert.match(out, /PRODID:-\/\/Example Corp\/\/Calendar 1\.0\/\/EN/);
});

test("splitSeries on an all-day series: date UNTIL and COUNT arithmetic", () => {
  const src = fixture("event-recur-allday.ics");
  const head = openItem(src, "event");
  const { tailText } = head.splitSeries({ kind: "date", iso: "2026-03-22" }, { newUid: "t3@example.org", now: NOW });
  const out = head.save({ now: NOW }).text;
  assert.ok(out.includes("UNTIL=20260321"), out);
  assert.deepEqual(starts(openItem(out, "event")), ["2026-03-01", "2026-03-15"]);
  const t = openItem(tailText, "event");
  assert.match(tailText, /COUNT=2/);
  assert.deepEqual(starts(t), ["2026-03-22", "2026-03-29"]);
  assert.match(tailText, /DTSTART;VALUE=DATE:20260322/);
});

test("splitSeries on a UTC series with RDATE/EXDATE moves the later ones to the tail", () => {
  const src = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//X//EN\r\nBEGIN:VEVENT\r\nUID:s@example.org\r\nDTSTART:20260601T080000Z\r\nDTEND:20260601T090000Z\r\nRRULE:FREQ=DAILY;UNTIL=20260610T080000Z\r\nEXDATE:20260604T080000Z,20260608T080000Z\r\nRDATE:20260620T080000Z\r\nSUMMARY:s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const head = openItem(src, "event");
  const { tailText } = head.splitSeries({ kind: "utc", iso: "2026-06-06T08:00:00" }, { newUid: "t4@example.org", now: NOW });
  const hOut = head.save({ now: NOW }).text;
  assert.match(hOut, /RRULE:FREQ=DAILY;UNTIL=20260606T075959Z/);
  assert.match(hOut, /EXDATE:20260604T080000Z\r\n/);
  assert.doesNotMatch(hOut, /RDATE|20260608/);
  assert.match(tailText, /RRULE:FREQ=DAILY;UNTIL=20260610T080000Z/);
  assert.match(tailText, /EXDATE:20260608T080000Z\r\n/);
  assert.match(tailText, /RDATE:20260620T080000Z/);
  assert.doesNotMatch(tailText, /20260604/);
});

test("splitSeries refuses the first occurrence and non-recurring events", () => {
  const item = openItem(fixture(SERIES), "event");
  assert.throws(() => item.splitSeries(paris("2026-03-02T09:30:00"), { newUid: "x" }), /first occurrence/);
  const single = openItem(fixture("event-utc-basic.ics"), "event");
  assert.throws(() => single.splitSeries({ kind: "utc", iso: "2026-04-02T10:00:00" }, { newUid: "x" }), /not a recurring/);
});

test("alarms: only relative DISPLAY alarms are modelled, all others are preserved", () => {
  const src = fixture("event-alarms.ics");
  const item = openItem(src, "event");
  const f = item.fields();
  assert.deepEqual(f.alarms, [{ seconds: -900, related: "START" }, { seconds: 300, related: "END" }]);
  assert.equal(f.foreignAlarms, 3, "absolute, audio and repeating alarms");
  assert.equal(item.update({ alarms: f.alarms }), false);
  item.update({ alarms: [{ seconds: -900 }, { seconds: -86400 }] });
  const out = item.save({ now: NOW }).text;
  const re = openItem(out, "event");
  assert.deepEqual(re.fields().alarms, [{ seconds: -900, related: "START" }, { seconds: -86400, related: "START" }]);
  assert.equal(re.fields().foreignAlarms, 3);
  for (const keep of ["TRIGGER;VALUE=DATE-TIME:20260501T080000Z", "ACTION:AUDIO", "ATTACH;FMTTYPE=audio/basic:https://example.org/sounds/ding", "REPEAT:2", "DURATION:PT10M"]) {
    assert.ok(out.includes(keep), keep);
  }
  checkFidelity(src, out);
  assert.match(out, /TRIGGER:-P1D/);
});

test("alarms can be cleared; unmodelled ones stay", () => {
  const item = openItem(fixture("event-alarms.ics"), "event");
  item.update({ alarms: [] });
  const f = openItem(item.save({ now: NOW }).text, "event").fields();
  assert.deepEqual(f.alarms, []);
  assert.equal(f.foreignAlarms, 3);
});

test("createItem(event): UID and PRODID are set on a NEW item only", () => {
  const item = createItem("event", { summary: "New, with; escapes", start: { kind: "zoned", iso: "2026-05-01T09:00:00", tzid: "Europe/Paris" }, end: { kind: "zoned", iso: "2026-05-01T10:00:00", tzid: "Europe/Paris" }, alarms: [{ seconds: -600 }], categories: ["a"] }, { uid: "new-1@example.org" });
  const out = item.save({ now: NOW });
  assert.equal(out.changed, true);
  assert.match(out.text, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/RadUI\/\/Calendar\/\/EN\r\n/);
  assert.match(out.text, /\r\nUID:new-1@example\.org\r\n/);
  assert.match(out.text, /\r\nDTSTAMP:20261112T100000Z\r\n/);
  assert.match(out.text, /\r\nSEQUENCE:0\r\n/);
  const re = openItem(out.text, "event");
  assert.equal(re.ok, true);
  assert.equal(re.fields().summary, "New, with; escapes");
  assert.deepEqual(re.tz, { "Europe/Paris": "embedded" }); // WP B5: a new event carries its own VTIMEZONE
  assert.match(out.text, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Paris/);
});

test("createItem without a start is refused; task creation works", () => {
  assert.throws(() => createItem("event", { summary: "x" }, { uid: "u" }), /start/);
  const t = createItem("task", { summary: "Do it", due: { kind: "date", iso: "2026-05-01" }, priority: 3 }, { uid: "t-1@example.org" });
  const out = t.save({ now: NOW }).text;
  assert.match(out, /BEGIN:VTODO/);
  assert.equal(openItem(out, "task").fields().priority, 3);
});
