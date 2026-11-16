// SPDX-License-Identifier: AGPL-3.0-or-later
// shiftExceptions, truncateSeries, untilFor and the exception helpers (RUN3 WP B1, addendum M1 M2 M3 M4 m6).
import test from "node:test";
import assert from "node:assert/strict";
import { openItem } from "../../../src/js/model/item.js";
import { SeriesError, untilDateOf, untilFor } from "../../../src/js/model/event.js";
import { createZones } from "../../../src/js/model/icalview.js";
import { parse } from "../../../src/js/model/contentlines.js";
import { D, fixture } from "./helpers.mjs";

const NOW = D("2026-11-12T10:00:00Z");
const PARIS = "Europe/Paris";
const zp = (iso) => ({ kind: "zoned", iso, tzid: PARIS });

const ics = (lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//x//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
const vevent = (lines) => ["BEGIN:VEVENT", "UID:u1", "DTSTAMP:20260101T000000Z", ...lines, "END:VEVENT"];
const open = (text) => {
  const it = openItem(text, "event");
  assert.equal(it.ok, true, it.message);
  return it;
};
const starts = (item) => item.expand({}).occurrences.map((o) => (o.start.instant !== null ? new Date(o.start.instant).toISOString().slice(0, 19) + "Z" : o.start.iso));
const props = (text, name) => text.split("\r\n").filter((l) => l.startsWith(name));

// Paris winter -> summer on 2026-03-29; a weekly Monday series crosses it.
const WEEKLY = (extra = []) =>
  ics(
    vevent([
      "DTSTART;TZID=Europe/Paris:20260316T100000",
      "DTEND;TZID=Europe/Paris:20260316T110000",
      "RRULE:FREQ=WEEKLY;COUNT=6",
      "SUMMARY:S",
      ...extra,
    ]),
  );

test("shiftExceptions: EXDATE and override RECURRENCE-ID move by the same wall-clock delta across the Paris DST change", () => {
  const text = ics([
    ...vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;COUNT=6", "EXDATE;TZID=Europe/Paris:20260330T100000", "SUMMARY:S"]),
    ...vevent(["RECURRENCE-ID;TZID=Europe/Paris:20260406T100000", "DTSTART;TZID=Europe/Paris:20260406T100000", "DTEND;TZID=Europe/Paris:20260406T110000", "SUMMARY:Special"]),
  ]);
  const item = open(text);
  const before = starts(item);
  item.shiftExceptions(zp("2026-03-16T10:00:00"), zp("2026-03-16T14:30:00"));
  item.update({ start: zp("2026-03-16T14:30:00"), end: zp("2026-03-16T15:30:00") });
  const out = item.save({ now: NOW }).text;
  assert.ok(props(out, "EXDATE").some((l) => l.includes("20260330T143000")), out);
  assert.ok(out.includes("RECURRENCE-ID;TZID=Europe/Paris:20260406T143000"));
  const again = open(out);
  assert.equal(starts(again).length, before.length, "no exception is orphaned: same number of occurrences");
  assert.equal(again.orphanedExceptions().length, 0);
  // the 30 March occurrence is still hidden (summer time starts 29 March: 14:30 local = 12:30Z)
  assert.ok(!starts(again).includes("2026-03-30T12:30:00Z"));
});

test("shiftExceptions: an override the user moved keeps its own DTSTART, an unmoved one follows the series", () => {
  const text = ics([
    ...vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;COUNT=6", "SUMMARY:S"]),
    ...vevent(["RECURRENCE-ID;TZID=Europe/Paris:20260323T100000", "DTSTART;TZID=Europe/Paris:20260323T160000", "DTEND;TZID=Europe/Paris:20260323T170000", "SUMMARY:Moved"]),
    ...vevent(["RECURRENCE-ID;TZID=Europe/Paris:20260330T100000", "DTSTART;TZID=Europe/Paris:20260330T100000", "DTEND;TZID=Europe/Paris:20260330T110000", "SUMMARY:Renamed"]),
  ]);
  const item = open(text);
  item.shiftExceptions(zp("2026-03-16T10:00:00"), zp("2026-03-16T11:00:00"));
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("RECURRENCE-ID;TZID=Europe/Paris:20260323T110000"));
  assert.ok(out.includes("DTSTART;TZID=Europe/Paris:20260323T160000"), "the moved override keeps where the user put it");
  assert.ok(out.includes("RECURRENCE-ID;TZID=Europe/Paris:20260330T110000"));
  assert.ok(out.includes("DTSTART;TZID=Europe/Paris:20260330T110000"), "the unmoved override follows");
});

test("M2: a UTC UNTIL moves with the start, so the occurrence count is unchanged", () => {
  const text = ics(vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;UNTIL=20260420T080000Z", "SUMMARY:S"]));
  const item = open(text);
  const n = starts(item).length;
  assert.equal(n, 6, "16 Mar .. 20 Apr: UNTIL is the start of the last occurrence");
  item.shiftExceptions(zp("2026-03-16T10:00:00"), zp("2026-03-16T11:00:00"));
  item.update({ start: zp("2026-03-16T11:00:00"), end: zp("2026-03-16T12:00:00") });
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("UNTIL=20260420T090000Z"), out);
  assert.equal(starts(open(out)).length, n);
  // WITHOUT the shift the last occurrence would be lost
  const naive = open(text);
  naive.update({ start: zp("2026-03-16T11:00:00"), end: zp("2026-03-16T12:00:00") });
  assert.equal(starts(open(naive.save({ now: NOW }).text)).length, n - 1);
});

test("M2: a DATE UNTIL of an all-day series moves by calendar days; an all-day EXDATE too", () => {
  const text = ics(vevent(["DTSTART;VALUE=DATE:20260301", "DTEND;VALUE=DATE:20260302", "RRULE:FREQ=WEEKLY;UNTIL=20260329", "EXDATE;VALUE=DATE:20260308", "SUMMARY:S"]));
  const item = open(text);
  item.shiftExceptions({ kind: "date", iso: "2026-03-01" }, { kind: "date", iso: "2026-03-03" });
  item.update({ start: { kind: "date", iso: "2026-03-03" }, end: { kind: "date", iso: "2026-03-04" } });
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("UNTIL=20260331"));
  assert.ok(out.includes("EXDATE;VALUE=DATE:20260310"));
});

test("m6: exceptions written in UTC or in another TZID are shifted in the master's zone, not as text", () => {
  const text = ics([
    ...vevent([
      "DTSTART;TZID=Europe/Paris:20260316T100000",
      "DTEND;TZID=Europe/Paris:20260316T110000",
      "RRULE:FREQ=WEEKLY;COUNT=8",
      "EXDATE:20260323T090000Z",
      "EXDATE;TZID=America/New_York:20260330T040000",
      "SUMMARY:S",
    ]),
    ...vevent(["RECURRENCE-ID:20260406T080000Z", "DTSTART;TZID=Europe/Paris:20260406T100000", "DTEND;TZID=Europe/Paris:20260406T110000", "SUMMARY:Mixed form"]),
  ]);
  const item = open(text);
  assert.equal(item.orphanedExceptions().length, 0, "the fixture itself is consistent");
  const n = starts(item).length;
  item.shiftExceptions(zp("2026-03-16T10:00:00"), zp("2026-03-16T15:00:00"));
  item.update({ start: zp("2026-03-16T15:00:00"), end: zp("2026-03-16T16:00:00") });
  const out = item.save({ now: NOW }).text;
  // 23 Mar 10:00 Paris = 09:00Z (CET still: DST starts 29 Mar) -> 15:00 Paris = 14:00Z
  assert.ok(out.includes("EXDATE:20260323T140000Z"), out);
  // 30 Mar 10:00 Paris CEST = 04:00 EDT; 15:00 Paris CEST = 09:00 EDT
  assert.ok(out.includes("EXDATE;TZID=America/New_York:20260330T090000"), out);
  // 6 Apr: UTC RECURRENCE-ID 08:00Z = 10:00 CEST -> 15:00 CEST = 13:00Z
  assert.ok(out.includes("RECURRENCE-ID:20260406T130000Z"), out);
  const again = open(out);
  assert.equal(starts(again).length, n);
  assert.equal(again.orphanedExceptions().length, 0);
});

test("a multi-value EXDATE keeps working after a shift", () => {
  const text = WEEKLY(["EXDATE;TZID=Europe/Paris:20260323T100000,20260330T100000"]);
  const item = open(text);
  item.shiftExceptions(zp("2026-03-16T10:00:00"), zp("2026-03-16T12:00:00"));
  const out = item.save({ now: NOW }).text;
  assert.ok(out.includes("EXDATE;TZID=Europe/Paris:20260323T120000,20260330T120000"), out);
});

test("M4: shiftExceptions refuses when the master's DTSTART is not the expected one", () => {
  const item = open(WEEKLY());
  assert.throws(() => item.shiftExceptions(zp("2026-03-16T09:00:00"), zp("2026-03-16T11:00:00")), (e) => e instanceof SeriesError && e.code === "start-mismatch");
});

test("an all-day <-> timed change with exceptions is refused; without exceptions it converts UNTIL", () => {
  const withEx = open(WEEKLY(["EXDATE;TZID=Europe/Paris:20260323T100000"]));
  assert.throws(() => withEx.shiftExceptions(zp("2026-03-16T10:00:00"), { kind: "date", iso: "2026-03-16" }), (e) => e.code === "allday-toggle-with-exceptions");
  const plain = open(ics(vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;UNTIL=20260420T080000Z", "SUMMARY:S"])));
  plain.shiftExceptions(zp("2026-03-16T10:00:00"), { kind: "date", iso: "2026-03-16" });
  assert.ok(plain.root.comps("VEVENT")[0].prop("RRULE").value.includes("UNTIL=20260420"));
  assert.match(plain.root.comps("VEVENT")[0].prop("RRULE").value, /UNTIL=\d{8}$/, "a DATE start needs a DATE UNTIL");
  const rev = open(ics(vevent(["DTSTART;VALUE=DATE:20260316", "DTEND;VALUE=DATE:20260317", "RRULE:FREQ=WEEKLY;UNTIL=20260420", "SUMMARY:S"])));
  rev.shiftExceptions({ kind: "date", iso: "2026-03-16" }, zp("2026-03-16T10:00:00"));
  assert.match(rev.root.comps("VEVENT")[0].prop("RRULE").value, /UNTIL=20260420T215959Z/, "end of the day in Paris, in UTC (CEST)");
});

test("shiftExceptions: no change when the start does not move; read-only items refuse", () => {
  const item = open(WEEKLY(["EXDATE;TZID=Europe/Paris:20260323T100000"]));
  assert.equal(item.shiftExceptions(zp("2026-03-16T10:00:00"), zp("2026-03-16T10:00:00")), false);
  assert.deepEqual(item.save(), { changed: false });
  const unknown = open(fixture("event-tzid-quoted-unknown.ics"));
  assert.equal(unknown.readOnly, true);
  assert.throws(() => unknown.truncateSeries({ kind: "floating", iso: "2026-01-01T00:00:00" }), /read-only/);
});

test("untilFor: the value type follows DTSTART (date, UTC, zoned, floating)", () => {
  assert.equal(untilFor({ kind: "date", iso: "2026-03-01" }, "2026-12-31"), "20261231");
  assert.equal(untilFor({ kind: "utc", iso: "2026-03-01T10:00:00" }, "2026-12-31"), "20261231T235959Z");
  assert.equal(untilFor({ kind: "floating", iso: "2026-03-01T10:00:00" }, "2026-12-31"), "20261231T235959");
  assert.equal(untilFor(zp("2026-03-01T10:00:00"), "2026-12-31"), "20261231T225959Z", "23:59:59 CET in UTC");
  assert.equal(untilFor(zp("2026-03-01T10:00:00"), "2026-07-14"), "20260714T215959Z", "23:59:59 CEST in UTC");
  assert.equal(untilFor({ kind: "zoned", iso: "2026-03-01T10:00:00", tzid: "Asia/Kathmandu" }, "2026-06-01"), "20260601T181459Z", "UTC+05:45");
  assert.throws(() => untilFor(zp("2026-03-01T10:00:00"), "31/12/2026"), /UNTIL needs a date/);
  assert.throws(() => untilFor({ kind: "zoned", iso: "2026-03-01T10:00:00", tzid: "Nowhere/Land" }, "2026-06-01"), (e) => e.code === "unknown-zone");
});

test("untilDateOf is the reverse of untilFor", () => {
  const zones = createZones(parse("BEGIN:VCALENDAR\nEND:VCALENDAR\n")[0]);
  for (const start of [zp("2026-03-01T10:00:00"), { kind: "date", iso: "2026-03-01" }, { kind: "utc", iso: "2026-03-01T10:00:00" }, { kind: "floating", iso: "2026-03-01T10:00:00" }]) {
    for (const day of ["2026-06-30", "2026-12-31", "2027-03-28"]) assert.equal(untilDateOf(untilFor(start, day, { zones }), start, { zones }), day);
  }
});

test("truncateSeries: COUNT becomes UNTIL, later EXDATE and overrides are removed, the head is one save", () => {
  const text = ics([
    ...vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;COUNT=6", "EXDATE;TZID=Europe/Paris:20260323T100000", "EXDATE;TZID=Europe/Paris:20260413T100000", "SUMMARY:S"]),
    ...vevent(["RECURRENCE-ID;TZID=Europe/Paris:20260406T100000", "DTSTART;TZID=Europe/Paris:20260406T120000", "DTEND;TZID=Europe/Paris:20260406T130000", "SUMMARY:Later"]),
    ...vevent(["RECURRENCE-ID;TZID=Europe/Paris:20260330T100000", "DTSTART;TZID=Europe/Paris:20260330T120000", "DTEND;TZID=Europe/Paris:20260330T130000", "SUMMARY:Earlier"]),
  ]);
  const item = open(text);
  item.truncateSeries(zp("2026-04-06T10:00:00"));
  const out = item.save({ now: NOW }).text;
  const rr = props(out, "RRULE")[0];
  assert.match(rr, /UNTIL=20260406T075959Z/, rr);
  assert.ok(!rr.includes("COUNT"));
  assert.ok(out.includes("EXDATE;TZID=Europe/Paris:20260323T100000"), "an earlier EXDATE stays");
  assert.ok(!out.includes("20260413"), "a later EXDATE goes");
  assert.ok(out.includes("SUMMARY:Earlier") && !out.includes("SUMMARY:Later"));
  const re = open(out);
  assert.equal(starts(re).length, 2, "16 Mar and the moved 30 Mar (23 Mar is excluded, 6 Apr and later are gone)");
});

test("truncateSeries at the first occurrence is refused (that is a delete of the item)", () => {
  const item = open(WEEKLY());
  assert.throws(() => item.truncateSeries(zp("2026-03-16T10:00:00")), /first occurrence/);
});

test("truncateSeries on a series whose COUNT ends right there does not fail on the discarded tail", () => {
  const item = open(WEEKLY());
  item.truncateSeries(zp("2026-04-20T10:00:00"));
  assert.match(item.save({ now: NOW }).text, /UNTIL=/);
});

test("exceptions() and orphanedExceptions(): a start on another weekday leaves the BYDAY exceptions dangling (M3)", () => {
  const text = ics(vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8", "EXDATE;TZID=Europe/Paris:20260323T100000", "SUMMARY:S"]));
  const item = open(text);
  assert.equal(item.exceptions().length, 1);
  assert.equal(item.orphanedExceptions().length, 0);
  item.update({ rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=8" });
  const orphans = item.orphanedExceptions();
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].type, "exdate");
  assert.equal(orphans[0].spec.iso, "2026-03-23T10:00:00");
});

test("splitSeries tailPatch (M1): the tail's exceptions and UNTIL shift when its start changes; all-day toggle is refused", () => {
  const text = ics([
    ...vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;UNTIL=20260615T080000Z", "EXDATE;TZID=Europe/Paris:20260427T100000", "SUMMARY:S"]),
    ...vevent(["RECURRENCE-ID;TZID=Europe/Paris:20260504T100000", "DTSTART;TZID=Europe/Paris:20260504T100000", "DTEND;TZID=Europe/Paris:20260504T110000", "SUMMARY:O"]),
  ]);
  const item = open(text);
  const { tailText } = item.splitSeries(zp("2026-04-20T10:00:00"), { newUid: "tail-1", tailPatch: { start: zp("2026-04-20T11:00:00"), end: zp("2026-04-20T12:00:00") }, now: NOW });
  const tail = open(tailText);
  assert.ok(tailText.includes("EXDATE;TZID=Europe/Paris:20260427T110000"), tailText);
  assert.ok(tailText.includes("RECURRENCE-ID;TZID=Europe/Paris:20260504T110000"));
  assert.ok(tailText.includes("UNTIL=20260615T090000Z"));
  assert.equal(tail.orphanedExceptions().length, 0);
  assert.equal(tail.uid, "tail-1");
  const again = open(text);
  assert.throws(() => again.splitSeries(zp("2026-04-20T10:00:00"), { newUid: "t2", tailPatch: { start: { kind: "date", iso: "2026-04-20" }, end: { kind: "date", iso: "2026-04-21" } } }), (e) => e.code === "allday-toggle-with-exceptions");
});

test("splitSeries exceptions option: 'remove' and 'remove-orphans'", () => {
  const text = ics(vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=Europe/Paris:20260427T100000", "EXDATE;TZID=Europe/Paris:20260511T100000", "SUMMARY:S"]));
  const a = open(text).splitSeries(zp("2026-04-20T10:00:00"), { newUid: "t", exceptions: "remove" });
  assert.ok(!a.tailText.includes("EXDATE"));
  // Tuesday rule: both exdates (Mondays) are orphaned
  const b = open(text).splitSeries(zp("2026-04-20T10:00:00"), { newUid: "t", tailPatch: { rrule: "FREQ=WEEKLY;BYDAY=TU" }, exceptions: "remove-orphans" });
  assert.ok(!b.tailText.includes("EXDATE"));
  const c = open(text).splitSeries(zp("2026-04-20T10:00:00"), { newUid: "t", tailPatch: { rrule: "FREQ=WEEKLY;BYDAY=TU" }, exceptions: "keep" });
  assert.equal((c.tailText.match(/EXDATE/g) || []).length, 2);
});
