// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { changedNames, semdiff } from "../../lib/semdiff.js";
import { fixture, lf, logical } from "./helpers.mjs";

const A = fixture("event-attendees.ics");

test("identical texts and pure formatting differences are equal", () => {
  assert.equal(semdiff(A, A).equal, true);
  assert.equal(semdiff(A, lf(A)).equal, true, "line endings");
  assert.equal(semdiff(A, A.replace("SUMMARY:Review", "SUMMARY:Rev\r\n iew")).equal, true, "folding");
  assert.equal(semdiff(A, A + "\r\n\r\n").equal, true, "blank lines");
});

test("property order, parameter-name case and parameter order are ignored", () => {
  const L = logical(A);
  const shuffled = [...L.slice(0, 4), ...L.slice(4, -2).reverse(), ...L.slice(-2)].join("\r\n") + "\r\n";
  assert.equal(semdiff(A, shuffled).equal, true);
  assert.equal(semdiff(A, A.replace("PARTSTAT=ACCEPTED;RSVP=TRUE;X-NUM-GUESTS=2", "rsvp=TRUE;partstat=ACCEPTED;x-num-guests=2")).equal, true);
  assert.equal(semdiff(A, A.replace("ATTENDEE;PARTSTAT=DECLINED", "attendee;PARTSTAT=DECLINED")).equal, true, "property-name case");
});

test("quoting and merged/repeated TYPE parameters are ignored", () => {
  const v = fixture("vcard30-types.vcf");
  assert.equal(semdiff(v, v.replace("TEL;TYPE=HOME,VOICE", "TEL;TYPE=HOME;TYPE=VOICE")).equal, true);
  assert.equal(semdiff(v, v.replace("TEL;TYPE=HOME,VOICE", "TEL;TYPE=voice,home")).equal, true);
  assert.equal(semdiff(A, A.replace("ORGANIZER;CN=", "ORGANIZER;X-A=b;CN=")).equal, false);
});

test("a changed value is reported on both sides", () => {
  const d = semdiff(A, A.replace("SUMMARY:Review", "SUMMARY:Other"));
  assert.equal(d.equal, false);
  assert.deepEqual(d.diffs.map((x) => [x.side, x.line]), [["a", "SUMMARY:Review"], ["b", "SUMMARY:Other"]]);
  assert.deepEqual(changedNames(d), ["SUMMARY"]);
});

test("ignoreManaged hides DTSTAMP, SEQUENCE, LAST-MODIFIED and REV only", () => {
  const b = A.replace("DTSTAMP:20260101T000000Z", "DTSTAMP:20261112T000000Z").replace("END:VEVENT", "SEQUENCE:2\r\nLAST-MODIFIED:20261112T000000Z\r\nEND:VEVENT");
  assert.equal(semdiff(A, b).equal, false);
  assert.equal(semdiff(A, b, { ignoreManaged: true }).equal, true);
  assert.equal(semdiff(A, b.replace("SUMMARY:Review", "SUMMARY:X"), { ignoreManaged: true }).equal, false);
  const v = fixture("vcard30-basic.vcf");
  assert.equal(semdiff(v, v.replace("REV:2026-01-01T00:00:00Z", "REV:2027-01-01T00:00:00Z"), { ignoreManaged: true }).equal, true);
});

test("duplicate lines count: dropping one of two identical lines is a difference", () => {
  const d = fixture("event-existing-managed.ics");
  assert.equal(semdiff(d, d.replace("CATEGORIES:gamma", "CATEGORIES:alpha,beta")).equal, false);
});

test("sub-components are matched by identity: VEVENTs by UID+RECURRENCE-ID, VTIMEZONE by TZID", () => {
  const s = fixture("event-recur-exdate-override-moved.ics");
  const d = semdiff(s, s.replace("SUMMARY:Weekly sync (moved)", "SUMMARY:Changed"));
  assert.deepEqual(changedNames(d), ["SUMMARY"]);
  assert.ok(d.diffs.every((x) => x.path.endsWith("VEVENT")));
  const removed = s.replace(/BEGIN:VALARM[\s\S]*?END:VALARM\r\n/, "");
  const d2 = semdiff(s, removed);
  assert.equal(d2.equal, false);
  assert.ok(d2.diffs[0].line.startsWith("<component VALARM"));
  // swapping two VEVENTs is no difference
  const parts = s.split(/(?=BEGIN:VEVENT)/);
  const swapped = parts[0] + parts[2].replace("END:VCALENDAR\r\n", "") + parts[1].replace(/END:VCALENDAR\r\n$/, "") + "END:VCALENDAR\r\n";
  assert.equal(semdiff(s, swapped).equal, true);
});

test("semdiff accepts both iCalendar and vCard", () => {
  const v = fixture("vcard40-groups.vcf");
  assert.equal(semdiff(v, v.replace("GENDER:F", "GENDER:M")).diffs.length, 2);
});
