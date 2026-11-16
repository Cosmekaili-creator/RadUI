// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { bdayOfCardDate, birthdayOccurrences, isDuplicate, normName, yearlyAllDayKeys } from "../../../src/js/calendar/birthdays.js";
import { parseCardDate } from "../../../src/js/model/vcard.js";
import { parse } from "../../../src/js/model/contentlines.js";
import { openItem } from "../../../src/js/model/item.js";
import { layoutDay } from "../../../src/js/calendar/layout.js";

const C = (fn, bday, extra = {}) => ({ uid: `u-${fn}`, key: `k-${fn}`, ab: "/a/book/", fn, bday, ...extra });
const dates = (occs) => occs.map((o) => `${o.date}:${o.title}:${o.age}`);

test("yearly all-day occurrences in a window; age only when the year is known", () => {
  const occs = birthdayOccurrences([C("Marie Dupont", { year: 1990, month: 3, day: 14 }), C("Zoë Martin", { year: null, month: 3, day: 20 }), C("No Date", null)], { from: "2026-03-01", to: "2026-04-01" });
  assert.deepEqual(dates(occs), ["2026-03-14:Marie Dupont:36", "2026-03-20:Zoë Martin:null"]);
  assert.equal(occs[0].virtual, true);
  assert.equal(occs[0].readOnly, true);
  assert.equal(occs[0].allDay, true);
  assert.equal(occs[0].uid, "u-Marie Dupont");
  assert.equal(occs[0].end.iso, "2026-03-15", "an all-day end is exclusive");
});

test("a window across a year boundary and several years; the day of birth itself is not a birthday", () => {
  const occs = birthdayOccurrences([C("A", { year: 2026, month: 1, day: 2 }), C("B", { year: 1980, month: 12, day: 31 })], { from: "2025-12-25", to: "2027-01-10" });
  assert.deepEqual(dates(occs), ["2025-12-31:B:45", "2026-12-31:B:46", "2027-01-02:A:1"]);
  const early = birthdayOccurrences([C("A", { year: 2026, month: 1, day: 2 })], { from: "2025-01-01", to: "2025-12-31" });
  assert.equal(early.length, 0, "not before the birth year");
});

test("leap rule: 29 February falls on 28 February in a year that is not a leap year", () => {
  const c = C("Leap", { year: 2000, month: 2, day: 29 });
  const y = (year) => birthdayOccurrences([c], { from: `${year}-01-01`, to: `${year + 1}-01-01` }).map((o) => o.date);
  assert.deepEqual(y(2026), ["2026-02-28"]);
  assert.deepEqual(y(2027), ["2027-02-28"]);
  assert.deepEqual(y(2028), ["2028-02-29"]);
  assert.deepEqual(y(2100), ["2100-02-28"], "2100 is not a leap year");
});

test("the occurrences are drawn by the layout modules like any all-day event, in every display zone", () => {
  const occs = birthdayOccurrences([C("Marie", { year: 1990, month: 3, day: 14 })], { from: "2026-03-01", to: "2026-04-01" });
  for (const tz of ["UTC", "Asia/Kathmandu", "America/New_York"]) {
    assert.equal(layoutDay(occs, "2026-03-14", tz).allDay.length, 1, tz);
    assert.equal(layoutDay(occs, "2026-03-15", tz).allDay.length, 0, tz);
  }
});

test("bdayOfCardDate maps vcard.js dates; text dates are not birthdays", () => {
  const p = (value) => parseCardDate(parse(`BEGIN:VCARD\nVERSION:4.0\nBDAY:${value}\nEND:VCARD\n`)[0].prop("BDAY"));
  assert.deepEqual(bdayOfCardDate(p("1990-04-01")), { year: 1990, month: 4, day: 1 });
  assert.deepEqual(bdayOfCardDate(p("--0401")), { year: null, month: 4, day: 1 });
  assert.deepEqual(bdayOfCardDate(p("--04-01")), { year: null, month: 4, day: 1 });
  assert.equal(bdayOfCardDate(p("someday")), null);
  assert.equal(bdayOfCardDate(null), null);
  assert.equal(bdayOfCardDate({ year: 1990, month: 13, day: 1 }), null);
});

test("duplicate filter: normalised name + month/day against yearly all-day events only", () => {
  const ev = (uid, summary, rr, date = "20260314") =>
    openItem(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;VALUE=DATE:${date}\r\n${rr ? `RRULE:${rr}\r\n` : ""}SUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`, "event");
  const keys = yearlyAllDayKeys([
    ev("e1", "Anniversaire de Marie Dupont", "FREQ=YEARLY"),
    ev("e2", "Zoë Martin", "FREQ=YEARLY", "20260320"),
    ev("e3", "Léa Roux", "FREQ=WEEKLY"),
    ev("e4", "Paul Quillfeather", null),
    { summary: "Plain Object", month: 5, day: 5 },
  ]);
  assert.deepEqual(keys.map((k) => k.name), ["anniversaire de marie dupont", "zoe martin", "plain object"]);
  const marie = C("Marie Dupont", { year: 1990, month: 3, day: 14 });
  assert.equal(isDuplicate(marie, keys), true);
  assert.equal(isDuplicate(C("Marie Dupont", { year: 1990, month: 3, day: 15 }), keys), false, "another day");
  assert.equal(isDuplicate(C("Zoe Martin", { year: null, month: 3, day: 20 }), keys), true, "accents and case do not matter");
  assert.equal(isDuplicate(C("Léa Roux", { year: null, month: 3, day: 14 }), keys), false, "a weekly event is not a birthday");
  assert.equal(isDuplicate(C("Paul Quillfeather", { year: null, month: 3, day: 14 }), keys), false, "a one-off event is not a yearly one");
  assert.equal(isDuplicate(C("Mar", { year: 1990, month: 3, day: 14 }), keys), false, "whole words only");
  const all = birthdayOccurrences([marie, C("Zoe Martin", { year: null, month: 3, day: 20 }), C("Other", { year: null, month: 3, day: 21 })], { from: "2026-03-01", to: "2026-04-01", hideKeys: keys });
  assert.deepEqual(all.map((o) => o.title), ["Other"]);
  assert.equal(normName("  D’Arc,  Jeanne!! "), "d arc jeanne");
});
