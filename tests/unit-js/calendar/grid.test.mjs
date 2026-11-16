// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { addDays, addMonths, diffDays, instantWindow, isValidDate, periodRange, rangeHas, shiftDate, startOfWeek, todayIn, weekdayOf } from "../../../src/js/calendar/grid.js";

test("date arithmetic never depends on the local zone", () => {
  assert.equal(addDays("2026-03-28", 2), "2026-03-30");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-01-15", -1), "2025-12-15");
  assert.equal(diffDays("2026-03-01", "2026-04-01"), 31);
  assert.equal(weekdayOf("2026-11-16"), 1);
  assert.equal(weekdayOf("2026-11-22"), 7);
  assert.equal(isValidDate("2026-02-29"), false);
  assert.equal(isValidDate("2028-02-29"), true);
  assert.equal(isValidDate("26-02-01"), false);
  assert.throws(() => addDays("2026-13-01", 1), RangeError);
});

test("startOfWeek honours the first weekday preference", () => {
  assert.equal(startOfWeek("2026-11-18", 1), "2026-11-16");
  assert.equal(startOfWeek("2026-11-18", 7), "2026-11-15");
  assert.equal(startOfWeek("2026-11-15", 7), "2026-11-15");
  assert.equal(startOfWeek("2026-11-15", 1), "2026-11-09");
  assert.equal(startOfWeek("2026-11-18", 6), "2026-11-14");
});

test("month range: full weeks, 4 to 6 rows", () => {
  const nov = periodRange("month", "2026-11-18", { firstWeekday: 1 });
  assert.equal(nov.start, "2026-10-26");
  assert.equal(nov.dayCount, 42, "1 Nov 2026 is a Sunday: six rows when weeks start on Monday");
  assert.equal(nov.end, "2026-12-07");
  assert.equal(nov.month, "2026-11");
  const feb = periodRange("month", "2027-02-10", { firstWeekday: 1 });
  assert.equal(feb.dayCount, 28, "February 2027 starts on a Monday: four rows");
  const aug = periodRange("month", "2026-08-05", { firstWeekday: 1 });
  assert.equal(aug.dayCount, 42, "August 2026 needs six rows");
  const sun = periodRange("month", "2026-11-18", { firstWeekday: 7 });
  assert.equal(sun.start, "2026-11-01");
  assert.equal(sun.dayCount, 35);
});

test("week range: 7 days from the first weekday; the phone range is 3 days starting at the date", () => {
  const w = periodRange("week", "2026-11-18", { firstWeekday: 1 });
  assert.deepEqual([w.start, w.end, w.dayCount], ["2026-11-16", "2026-11-23", 7]);
  const p = periodRange("week", "2026-11-18", { phone: true });
  assert.deepEqual(p.days, ["2026-11-18", "2026-11-19", "2026-11-20"]);
  assert.equal(p.end, "2026-11-21");
  const d = periodRange("day", "2026-11-18");
  assert.deepEqual(d.days, ["2026-11-18"]);
  const a = periodRange("agenda", "2026-11-18");
  assert.equal(a.dayCount, 30);
  assert.equal(a.days[29], "2026-12-17");
  assert.equal(rangeHas(a, "2026-12-17"), true);
  assert.equal(rangeHas(a, "2026-12-18"), false);
  assert.throws(() => periodRange("year", "2026-11-18"), RangeError);
});

test("today / prev / next per view", () => {
  assert.equal(shiftDate("month", "2026-01-31", 1), "2026-02-28");
  assert.equal(shiftDate("month", "2026-03-31", -1), "2026-02-28");
  assert.equal(shiftDate("week", "2026-11-18", 1), "2026-11-25");
  assert.equal(shiftDate("week", "2026-11-18", -1, { phone: true }), "2026-11-15");
  assert.equal(shiftDate("day", "2026-11-18", 1), "2026-11-19");
  assert.equal(shiftDate("agenda", "2026-11-18", 1), "2026-12-18");
});

test("todayIn is the date in the display zone, not in UTC", () => {
  const instant = Date.UTC(2026, 10, 16, 23, 30);
  assert.equal(todayIn("UTC", instant), "2026-11-16");
  assert.equal(todayIn("Asia/Kathmandu", instant), "2026-11-17");
  assert.equal(todayIn("America/New_York", instant), "2026-11-16");
  assert.equal(todayIn("Nowhere/Land", instant), "2026-11-16", "an unknown zone falls back to UTC");
});

test("instantWindow converts the range in the display zone and pads by a day", () => {
  const r = periodRange("day", "2026-03-29");
  const w = instantWindow(r, "Europe/Paris", { pad: 0 });
  assert.equal(new Date(w.from).toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(new Date(w.to).toISOString(), "2026-03-29T22:00:00.000Z", "the DST day is 23 hours long");
  const padded = instantWindow(r, "UTC");
  assert.equal(padded.to - padded.from, 3 * 86400000);
});
