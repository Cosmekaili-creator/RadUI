// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests of the allowlist comparison (no server needed).
import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWLIST, compareServer, flatDiff, tally } from "./compare.mjs";
import { BS } from "./lib.mjs";

const cal = (lines, head = "PRODID:-//Example//EN\n") => `BEGIN:VCALENDAR\nVERSION:2.0\n${head}BEGIN:VEVENT\nUID:u@example.org\nDTSTAMP:20260101T000000Z\nDTSTART:20260101T090000Z\n${lines}\nEND:VEVENT\nEND:VCALENDAR\n`;

test("order, parameter case, quoting and folding are not differences", () => {
  const a = cal('SUMMARY:One\nATTENDEE;CN="Bob";PARTSTAT=ACCEPTED:mailto:bob@example.org');
  const b = cal('attendee;partstat=ACCEPTED;cn=Bob:mailto:bob@example.org\nsummary:One');
  assert.equal(compareServer(a, b).equal, true);
  assert.deepEqual(flatDiff("BEGIN:VCARD\nVERSION:3.0\nTEL;TYPE=HOME,VOICE:1\nEND:VCARD", "BEGIN:VCARD\nVERSION:3.0\nTEL;type=voice;type=home:1\nEND:VCARD"), { onlyA: [], onlyB: [] });
});

test("an ordinary change is unexplained", () => {
  const r = compareServer(cal("SUMMARY:One"), cal("SUMMARY:Two"));
  assert.equal(r.equal, false);
  assert.equal(r.unexplained.length, 2);
});

test("text-reescaped: an unescaped semicolon served escaped", () => {
  const r = compareServer(cal("X-A:one;two"), cal(`X-A:one${BS};two`));
  assert.equal(r.equal, true);
  assert.deepEqual(tally(r.explained), { "text-reescaped": 1 });
});

test("text-cut-at-unescaped-comma is explained and marked lossy; an escaped comma is not cut", () => {
  const r = compareServer(cal("SUMMARY:a, b"), cal("SUMMARY:a"));
  assert.equal(r.equal, true);
  assert.equal(r.explained[0].lossy, true);
  assert.equal(compareServer(cal(`SUMMARY:a${BS}, b`), cal("SUMMARY:a")).equal, false, "dropping text after an ESCAPED comma is a failure");
  assert.equal(compareServer(cal("SUMMARY:a, b"), cal("SUMMARY:x")).equal, false);
});

test("photo-data-uri-payload-dropped", () => {
  const a = "BEGIN:VCARD\nVERSION:4.0\nUID:x\nPHOTO:data:image/png;base64,AAAA\nEND:VCARD";
  const b = `BEGIN:VCARD\nVERSION:4.0\nUID:x\nPHOTO:data:image/png${BS};base64\nEND:VCARD`;
  const r = compareServer(a, b);
  assert.equal(r.equal, true);
  assert.deepEqual(tally(r.explained), { "photo-data-uri-payload-dropped": 1 });
});

test("vtimezone-generated only for a used, undefined, known zone", () => {
  const tz = "BEGIN:VTIMEZONE\nTZID:Europe/Paris\nBEGIN:STANDARD\nDTSTART:19701025T030000\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0100\nEND:STANDARD\nEND:VTIMEZONE\n";
  const a = cal("DTEND;TZID=Europe/Paris:20260101T100000");
  const b = a.replace("BEGIN:VEVENT", tz + "BEGIN:VEVENT");
  assert.deepEqual(tally(compareServer(a, b).explained), { "vtimezone-generated": 1 });
  assert.equal(compareServer(cal("SUMMARY:x"), cal("SUMMARY:x").replace("BEGIN:VEVENT", tz + "BEGIN:VEVENT")).equal, false, "an unused zone is not explained");
  const bogus = tz.replace(/Europe\/Paris/, "Nowhere/Land");
  assert.equal(compareServer(a.replace(/Europe\/Paris/, "Nowhere/Land"), a.replace(/Europe\/Paris/, "Nowhere/Land").replace("BEGIN:VEVENT", bogus + "BEGIN:VEVENT")).equal, false, "an unknown zone is not explained");
  const altered = a.replace("BEGIN:VEVENT", tz + "BEGIN:VEVENT");
  assert.equal(compareServer(altered, altered.replace("+0100", "+0200")).equal, false, "an existing VTIMEZONE must not change");
});

test("prodid-added and dtstamp-added", () => {
  const a = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:u\nDTSTART:20260101T090000Z\nEND:VEVENT\nEND:VCALENDAR\n";
  const b = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//PYVOBJECT//NONSGML Version 0.9.9//EN\nBEGIN:VEVENT\nUID:u\nDTSTART:20260101T090000Z\nDTSTAMP:20261112T161914Z\nEND:VEVENT\nEND:VCALENDAR\n";
  assert.deepEqual(tally(compareServer(a, b).explained), { "prodid-added": 1, "dtstamp-added": 1 });
  assert.equal(compareServer(cal("SUMMARY:x"), cal("SUMMARY:x").replace("DTSTAMP:20260101T000000Z", "DTSTAMP:20270101T000000Z")).equal, false, "a changed DTSTAMP is not explained");
});

test("zero-duration-dropped needs a DTEND", () => {
  const a = cal("DTEND:20260101T100000Z\nDURATION:PT0S");
  assert.deepEqual(tally(compareServer(a, cal("DTEND:20260101T100000Z")).explained), { "zero-duration-dropped": 1 });
  assert.equal(compareServer(cal("DURATION:PT0S"), cal("SUMMARY:x")).equal, false);
  assert.equal(compareServer(cal("DTEND:20260101T100000Z\nDURATION:PT1H"), cal("DTEND:20260101T100000Z")).equal, false);
});

test("exdate-retyped", () => {
  const a = cal("EXDATE;VALUE=DATE:20260108");
  const b = cal("EXDATE:20260108T090000Z");
  assert.deepEqual(tally(compareServer(a, b).explained), { "exdate-retyped": 1 });
  assert.equal(compareServer(a, cal("EXDATE:20260109T090000Z")).equal, false);
});

test("default-value-param-dropped", () => {
  const a = cal("BEGIN:VALARM\nACTION:DISPLAY\nTRIGGER;VALUE=DURATION:-PT10M\nEND:VALARM");
  const b = cal("BEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT10M\nEND:VALARM");
  assert.deepEqual(tally(compareServer(a, b).explained), { "default-value-param-dropped": 1 });
  assert.equal(compareServer(a, cal("BEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT15M\nEND:VALARM")).equal, false);
});

test("every allowlist rule names evidence and a fixture that exists", async () => {
  const { loadFixtures } = await import("./lib.mjs");
  const names = new Set(loadFixtures().map((f) => f.name));
  for (const r of ALLOWLIST) assert.ok(r.what && names.has(r.evidence), r.code);
});
