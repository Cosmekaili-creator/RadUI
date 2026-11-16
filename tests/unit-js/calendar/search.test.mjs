// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_LIMIT, occurrenceText, searchOccurrences } from "../../../src/js/calendar/search.js";
import { openItem } from "../../../src/js/model/item.js";
import { birthdayOccurrences } from "../../../src/js/calendar/birthdays.js";

const make = (uid, summary, location = "", description = "") =>
  openItem(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260318T090000Z\r\nDTEND:20260318T100000Z\r\nSUMMARY:${summary}\r\n${location ? `LOCATION:${location}\r\n` : ""}${description ? `DESCRIPTION:${description}\r\n` : ""}END:VEVENT\r\nEND:VCALENDAR\r\n`, "event").expand({}).occurrences[0];

test("every word must be found in summary, location or description; accents and case do not matter", () => {
  const occs = [make("a", "Réunion équipe", "Salle Étoile"), make("b", "Dentist", "", "Bring the X-ray"), make("c", "Lunch", "Café du Port")];
  const ids = (q) => searchOccurrences(occs, q).matches.map((o) => o.component.prop("UID").value);
  assert.deepEqual(ids("reunion"), ["a"]);
  assert.deepEqual(ids("ETOILE equipe"), ["a"]);
  assert.deepEqual(ids("xray"), []);
  assert.deepEqual(ids("x-ray"), ["b"]);
  assert.deepEqual(ids("cafe port"), ["c"]);
  assert.deepEqual(ids("zzz"), []);
  assert.deepEqual(ids("  "), []);
  assert.equal(searchOccurrences(occs, "").active, false);
  assert.equal(searchOccurrences(occs, "lunch").active, true);
});

test("the result is limited but the total is reported; virtual birthdays are searched by title", () => {
  const many = Array.from({ length: SEARCH_LIMIT + 5 }, (_, i) => make(`u${i}`, `Meeting ${i}`));
  const r = searchOccurrences(many, "meeting");
  assert.equal(r.total, SEARCH_LIMIT + 5);
  assert.equal(r.matches.length, SEARCH_LIMIT);
  assert.equal(searchOccurrences(many, "meeting", { limit: 3 }).matches.length, 3);
  const b = birthdayOccurrences([{ uid: "u", key: "k", ab: "/a/", fn: "Marie Dupont", bday: { year: 1990, month: 3, day: 18 } }], { from: "2026-03-01", to: "2026-04-01" });
  assert.equal(searchOccurrences(b, "dupont").matches.length, 1);
  assert.equal(occurrenceText(b[0]).summary, "Marie Dupont");
});
