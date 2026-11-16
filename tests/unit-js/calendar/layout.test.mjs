// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { displayTimes, layoutAllDayRow, layoutDay, monthCells, nowMarker } from "../../../src/js/calendar/layout.js";
import { periodRange } from "../../../src/js/calendar/grid.js";
import { openItem } from "../../../src/js/model/item.js";

const ics = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\n${body}END:VCALENDAR\r\n`;
const ev = (uid, lines) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;
const occs = (...bodies) => bodies.flatMap((b) => openItem(ics(b), "event").expand({}).occurrences.map((o) => ({ ...o, uid: b.match(/UID:(\S+)/)[1] })));
const utc = (uid, s, e) => ev(uid, [`DTSTART:${s}`, `DTEND:${e}`, `SUMMARY:${uid}`]);

test("five overlapping events get five lanes; a later event starts a new cluster", () => {
  const entries = occs(
    utc("a", "20260318T090000Z", "20260318T110000Z"),
    utc("b", "20260318T093000Z", "20260318T103000Z"),
    utc("c", "20260318T100000Z", "20260318T120000Z"),
    utc("d", "20260318T101500Z", "20260318T104500Z"),
    utc("e", "20260318T103000Z", "20260318T113000Z"),
    utc("f", "20260318T140000Z", "20260318T150000Z"),
  );
  const day = layoutDay(entries, "2026-03-18", "UTC");
  const by = Object.fromEntries(day.timed.map((t) => [t.occ.uid, t]));
  assert.equal(by.a.lane, 0);
  assert.deepEqual([by.a.lanes, by.b.lanes, by.c.lanes, by.d.lanes, by.e.lanes], [4, 4, 4, 4, 4], "a..e share a cluster");
  assert.equal(new Set([by.a, by.b, by.c, by.d].map((t) => t.lane)).size, 4);
  assert.ok(by.e.lane >= 0 && by.e.lane < 4);
  assert.deepEqual([by.f.lane, by.f.lanes], [0, 1], "f is alone");
  for (const x of day.timed) for (const y of day.timed) {
    if (x === y || x.lane !== y.lane) continue;
    assert.ok(x.endMin <= y.startMin || y.endMin <= x.startMin, `${x.occ.uid} and ${y.occ.uid} share lane ${x.lane}`);
  }
  assert.equal(by.a.startMin, 540);
  assert.equal(by.a.endMin, 660);
});

test("exactly five events that all overlap use lanes 0..4 of 5", () => {
  const entries = occs(...["a", "b", "c", "d", "e"].map((u, i) => utc(u, `20260318T09${i}000Z`, "20260318T120000Z")));
  const day = layoutDay(entries, "2026-03-18", "UTC");
  assert.deepEqual(day.timed.map((t) => t.lane).sort(), [0, 1, 2, 3, 4]);
  assert.ok(day.timed.every((t) => t.lanes === 5));
});

test("a timed event is drawn in the display zone and split at midnight there", () => {
  const entries = occs(utc("night", "20260318T213000Z", "20260319T033000Z")); // 21:30Z -> 03:30Z
  const paris = "Europe/Paris"; // UTC+1 on 18 Mar: 22:30 -> 04:30 local
  const d1 = layoutDay(entries, "2026-03-18", paris);
  const d2 = layoutDay(entries, "2026-03-19", paris);
  assert.equal(d1.timed.length, 1);
  assert.deepEqual([d1.timed[0].startMin, d1.timed[0].endMin, d1.timed[0].contStart, d1.timed[0].contEnd], [1350, 1440, false, true]);
  assert.deepEqual([d2.timed[0].startMin, d2.timed[0].endMin, d2.timed[0].contStart, d2.timed[0].contEnd], [0, 270, true, false]);
  assert.equal(layoutDay(entries, "2026-03-20", paris).timed.length, 0);
  // in UTC it is the same event on different days
  assert.equal(layoutDay(entries, "2026-03-18", "UTC").timed[0].startMin, 21 * 60 + 30);
});

test("an event that ends exactly at midnight does not appear on the next day", () => {
  const entries = occs(utc("x", "20260318T220000Z", "20260318T230000Z"));
  assert.equal(layoutDay(entries, "2026-03-19", "UTC").timed.length, 0);
  assert.equal(layoutDay(entries, "2026-03-18", "UTC").timed[0].endMin, 1380);
  const entries2 = occs(utc("y", "20260318T230000Z", "20260319T000000Z"));
  assert.equal(layoutDay(entries2, "2026-03-19", "UTC").timed.length, 0);
});

test("all-day and floating events are not shifted by the display zone", () => {
  const entries = occs(
    ev("ad", ["DTSTART;VALUE=DATE:20260318", "DTEND;VALUE=DATE:20260320", "SUMMARY:ad"]),
    ev("fl", ["DTSTART:20260318T090000", "DTEND:20260318T100000", "SUMMARY:fl"]),
  );
  for (const tz of ["UTC", "Asia/Kathmandu", "America/New_York", "Australia/Lord_Howe"]) {
    const d = layoutDay(entries, "2026-03-18", tz);
    assert.equal(d.allDay.length, 1, tz);
    assert.equal(d.timed[0].startMin, 540, `floating stays at 09:00 in ${tz}`);
    assert.equal(layoutDay(entries, "2026-03-19", tz).allDay.length, 1);
    assert.equal(layoutDay(entries, "2026-03-20", tz).allDay.length, 0, "DTEND is exclusive");
  }
});

test("an unknown time zone is drawn at its own wall clock and flagged", () => {
  const entries = occs(ev("u", ["DTSTART;TZID=Mars/Olympus_Mons:20260318T090000", "DTEND;TZID=Mars/Olympus_Mons:20260318T100000", "SUMMARY:u"]));
  const d = layoutDay(entries, "2026-03-18", "Asia/Kathmandu");
  assert.equal(d.timed[0].startMin, 540);
  assert.equal(d.timed[0].unknownZone, true);
  assert.equal(displayTimes(entries[0], "UTC").unknownZone, true);
});

test("a zero-length event is placed and takes minMinutes of room in the packing", () => {
  const entries = occs(
    ev("z", ["DTSTART:20260318T100000Z", "SUMMARY:z"]),
    ev("w", ["DTSTART:20260318T101000Z", "DTEND:20260318T104000Z", "SUMMARY:w"]),
  );
  const d = layoutDay(entries, "2026-03-18", "UTC");
  assert.equal(d.timed.length, 2);
  assert.notEqual(d.timed[0].lane, d.timed[1].lane);
});

test("all-day strip: spans, continuation flags and row stacking", () => {
  const entries = occs(
    ev("long", ["DTSTART;VALUE=DATE:20260316", "DTEND;VALUE=DATE:20260322", "SUMMARY:long"]),
    ev("mid", ["DTSTART;VALUE=DATE:20260318", "DTEND;VALUE=DATE:20260320", "SUMMARY:mid"]),
    ev("late", ["DTSTART;VALUE=DATE:20260319", "DTEND;VALUE=DATE:20260321", "SUMMARY:late"]),
    ev("before", ["DTSTART;VALUE=DATE:20260310", "DTEND;VALUE=DATE:20260318", "SUMMARY:before"]),
    ev("out", ["DTSTART;VALUE=DATE:20260401", "SUMMARY:out"]),
  );
  const days = periodRange("week", "2026-03-18").days; // 16..22
  const { items, rows } = layoutAllDayRow(entries, days, "UTC");
  const by = Object.fromEntries(items.map((i) => [i.occ.uid, i]));
  assert.equal(items.length, 4);
  assert.deepEqual([by.long.col, by.long.span, by.long.row], [0, 6, 0]);
  assert.deepEqual([by.before.col, by.before.span, by.before.contStart], [0, 2, true]);
  assert.deepEqual([by.mid.col, by.mid.span], [2, 2]);
  assert.equal(by.late.contEnd, false);
  assert.ok(rows >= 3);
  for (const a of items) for (const b of items) {
    if (a === b || a.row !== b.row) continue;
    assert.ok(a.col + a.span <= b.col || b.col + b.span <= a.col, "no overlap in a row");
  }
});

test("month cells: a chip on each day of a multi-day event, all-day first, +n more", () => {
  const entries = occs(
    ev("multi", ["DTSTART;VALUE=DATE:20260317", "DTEND;VALUE=DATE:20260320", "SUMMARY:multi"]),
    utc("t1", "20260318T080000Z", "20260318T090000Z"),
    utc("t2", "20260318T100000Z", "20260318T110000Z"),
    utc("t3", "20260318T120000Z", "20260318T130000Z"),
    utc("t4", "20260318T140000Z", "20260318T150000Z"),
  );
  const range = periodRange("month", "2026-03-18");
  const cells = monthCells(range, entries, "UTC", { maxChips: 3, now: Date.UTC(2026, 2, 18, 12) });
  const cell = (d) => cells.find((c) => c.date === d);
  assert.equal(cell("2026-03-17").chips.length, 1);
  assert.equal(cell("2026-03-17").chips[0].contEnd, true);
  assert.equal(cell("2026-03-19").chips[0].contStart, true);
  assert.equal(cell("2026-03-20").chips.length, 0);
  const c18 = cell("2026-03-18");
  assert.equal(c18.total, 5);
  assert.equal(c18.more, 2);
  assert.equal(c18.chips[0].allDay, true);
  assert.deepEqual(c18.chips.slice(1).map((c) => c.occ.uid), ["t1", "t2"]);
  assert.equal(c18.today, true);
  assert.equal(cell("2026-02-28").inMonth, false);
  assert.equal(cells.length, range.dayCount);
});

test("now marker: only when today is displayed, position in the display zone", () => {
  const days = periodRange("week", "2026-11-18").days;
  const now = Date.UTC(2026, 10, 18, 22, 15);
  const k = nowMarker(days, now, "Asia/Kathmandu"); // UTC+5:45 -> 04:00 on the 19th
  assert.equal(k.date, "2026-11-19");
  assert.equal(k.dayIndex, 3);
  assert.equal(k.minutes, 240);
  assert.equal(k.fraction, 240 / 1440);
  assert.equal(nowMarker(days, Date.UTC(2026, 11, 1), "UTC"), null);
});
