// SPDX-License-Identifier: AGPL-3.0-or-later
// The fidelity guard: accepts what the operation owns, rejects tampering.
import test from "node:test";
import assert from "node:assert/strict";
import { FidelityError, checkFidelity, checkNewItem } from "../../../src/js/model/fidelity.js";
import { openItem } from "../../../src/js/model/item.js";
import { crlf, fixture } from "./helpers.mjs";

const ev = crlf(fixture("event-recur-exdate-override-moved.ics"));
const vc = crlf(fixture("vcard30-groups.vcf"));
const att = crlf(fixture("event-attendees.ics"));
const alarms = crlf(fixture("event-alarms.ics"));
const reject = (before, after, re, opts) => assert.throws(() => checkFidelity(before, after, opts), (e) => e instanceof FidelityError && re.test(e.message), `expected rejection ${re}`);
const sub = (text, a, b) => {
  assert.ok(text.includes(a), `missing ${a}`);
  return text.replace(a, b);
};

test("identical text passes", () => {
  assert.equal(checkFidelity(ev, ev), true);
  assert.equal(checkFidelity(vc, vc), true);
});

test("owned changes pass (summary, location, dates, rrule) and so do line-ending and folding differences", () => {
  const after = sub(sub(ev, "SUMMARY:Weekly sync\r\n", "SUMMARY:Renamed\r\nLOCATION:Room 4\r\n"), "RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=MO", "RRULE:FREQ=WEEKLY;COUNT=9;BYDAY=MO");
  assert.equal(checkFidelity(ev, after), true);
  assert.equal(checkFidelity(ev, after.replace(/\r\n/g, "\n")), true);
  assert.equal(checkFidelity(ev, sub(ev, "SUMMARY:Weekly sync", "SUMMARY:Weekly\r\n  sync")), true, "a refolded value that unfolds to a changed summary is an owned change");
  assert.equal(checkFidelity(att, sub(att, "SUMMARY:Review", "SUMMARY:Rev\r\n iew")), true, "same value, different folding");
});

test("writer-managed properties may change", () => {
  const after = sub(ev, "DTSTAMP:20260101T000000Z", "DTSTAMP:20261112T100000Z").replace("SEQUENCE:1", "SEQUENCE:2");
  assert.equal(checkFidelity(ev, after), true);
  assert.equal(checkFidelity(vc, sub(vc, "REV:2026-01-01T00:00:00Z", "REV:2026-11-12T10:00:00Z")), true);
});

test("an override VEVENT may be added or removed; a VTIMEZONE may be added or removed", () => {
  const withOverride = sub(ev, "END:VCALENDAR", "BEGIN:VEVENT\r\nUID:override-moved@example.org\r\nRECURRENCE-ID;TZID=Europe/Paris:20260406T093000\r\nDTSTART;TZID=Europe/Paris:20260406T100000\r\nEND:VEVENT\r\nEND:VCALENDAR");
  assert.equal(checkFidelity(ev, withOverride), true);
  assert.equal(checkFidelity(withOverride, ev), true);
  const noOverride = ev.replace(/BEGIN:VEVENT\r\nUID:override-moved@example.org\r\nDTSTAMP:\d+T\d+Z\r\nRECURRENCE-ID[\s\S]*?END:VEVENT\r\n/, "");
  assert.notEqual(noOverride, ev);
  assert.equal(checkFidelity(ev, noOverride), true);
  // An unreferenced VTIMEZONE may be added or removed (the referencing TZIDs are dropped here to isolate that rule).
  const floating = ev.replace(/;TZID=Europe\/Paris/g, "");
  const noTz = floating.replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r\n/, "");
  assert.notEqual(noTz, floating);
  assert.equal(checkFidelity(floating, noTz), true, "dropping an unreferenced VTIMEZONE is fine");
  assert.equal(checkFidelity(noTz, floating), true, "adding a VTIMEZONE is fine");
  // An unreferenced VTIMEZONE that stays in the original but is dropped by the edit.
  const floatingEdit = floating.replace("SUMMARY:Weekly sync", "SUMMARY:Renamed");
  assert.equal(checkFidelity(floating, floatingEdit.replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r\n/, "")), true);
});

test("an edit that drops a still-referenced VTIMEZONE is refused (also with a lower-case tzid parameter and a quoted value)", () => {
  const noTz = ev.replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r\n/, "");
  assert.notEqual(noTz, ev);
  reject(ev, noTz, /VTIMEZONE Europe\/Paris was removed/);
  reject(ev, noTz.replace(/;TZID=Europe\/Paris/g, ";tzid=Europe/Paris"), /VTIMEZONE Europe\/Paris was removed/);
  reject(ev, noTz.replace(/;TZID=Europe\/Paris/g, ';TZID="Europe/Paris"'), /VTIMEZONE Europe\/Paris was removed/);
  // referenced by a single EXDATE parameter only: still a reference
  const tz = "BEGIN:VTIMEZONE\r\nTZID:Etc/Example\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0100\r\nDTSTART:19700101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n";
  const mini = (zone, exdate) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//EN\r\n${zone}BEGIN:VEVENT\r\nUID:mini@example.org\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260302T093000\r\nRRULE:FREQ=DAILY;COUNT=3\r\n${exdate}SUMMARY:Mini\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const withRef = mini(tz, "EXDATE;TZID=Etc/Example:20260303T093000\r\n");
  reject(withRef, mini("", "EXDATE;TZID=Etc/Example:20260303T093000\r\n"), /VTIMEZONE Etc\/Example was removed/);
  assert.equal(checkFidelity(withRef, mini("", "")), true, "the reference went away with the VTIMEZONE");
  // an item that keeps its VTIMEZONE and the TZIDs passes
  assert.equal(checkFidelity(ev, ev), true);
});

test("allowOverrides:false refuses adding or removing an override", () => {
  const noOverride = ev.replace(/BEGIN:VEVENT\r\nUID:override-moved@example.org\r\nDTSTAMP:\d+T\d+Z\r\nRECURRENCE-ID[\s\S]*?END:VEVENT\r\n/, "");
  reject(ev, noOverride, /override/, { allowOverrides: false });
});

test("relative DISPLAY alarms may be added and removed; other alarms may not", () => {
  const added = sub(alarms, "END:VEVENT", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-P1D\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT");
  assert.equal(checkFidelity(alarms, added), true);
  const removed = sub(alarms, "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\n", "");
  assert.equal(checkFidelity(alarms, removed), true);
  reject(alarms, sub(alarms, "BEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER:-PT30M\r\nATTACH;FMTTYPE=audio/basic:https://example.org/sounds/ding\r\nEND:VALARM\r\n", ""), /VALARM/);
  reject(alarms, sub(alarms, "TRIGGER:-PT30M", "TRIGGER:-PT31M"), /VALARM/);
  reject(alarms, sub(alarms, "REPEAT:2", "REPEAT:3"), /VALARM/);
  reject(alarms, sub(alarms, "TRIGGER;VALUE=DATE-TIME:20260501T080000Z", "TRIGGER;VALUE=DATE-TIME:20260501T080100Z"), /VALARM/);
});

test("a changed UID is refused", () => {
  reject(ev, ev.replaceAll("override-moved@example.org", "other@example.org"), /UID/);
  reject(vc, sub(vc, "UID:urn:uuid:11111111-2222-3333-4444-555555555502", "UID:urn:uuid:11111111-2222-3333-4444-555555555599"), /UID/);
});

test("a changed or dropped VERSION is refused", () => {
  reject(vc, sub(vc, "VERSION:3.0", "VERSION:4.0"), /VERSION/);
  reject(ev, sub(ev, "VERSION:2.0", "VERSION:2.1"), /VERSION/);
  reject(vc, sub(vc, "VERSION:3.0\r\n", ""), /VERSION/);
});

test("a changed PRODID is refused", () => {
  reject(ev, sub(ev, "PRODID:-//Example Corp//Calendar 1.0//EN", "PRODID:-//RadUI//Calendar//EN"), /PRODID/);
});

test("a dropped untouched line is refused", () => {
  reject(att, sub(att, "ATTENDEE;PARTSTAT=DECLINED:mailto:dave@example.org\r\n", ""), /dropped or changed untouched line "ATTENDEE/);
  const vendor = crlf(fixture("vcard40-vendor.vcf"));
  reject(vendor, sub(vendor, "IMPP;X-SERVICE-TYPE=Example:example:judy\r\n", ""), /dropped or changed untouched line "IMPP/);
  reject(vc, sub(vc, "PRODID:-//Example Contacts//Contacts 1.0//EN\r\n", ""), /PRODID/);
});

test("a changed untouched line is refused (attendee, X- property, unknown parameter)", () => {
  reject(att, sub(att, "PARTSTAT=ACCEPTED", "PARTSTAT=DECLINED"), /untouched/);
  reject(crlf(fixture("event-xprops.ics")), sub(crlf(fixture("event-xprops.ics")), "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "X-MICROSOFT-CDO-BUSYSTATUS:FREE"), /untouched/);
  reject(att, sub(att, "X-NUM-GUESTS=2", "x-num-guests=2"), /untouched/);
});

test("an unexpected new line is refused", () => {
  reject(att, sub(att, "SUMMARY:Review\r\n", "SUMMARY:Review\r\nX-NEW:1\r\n"), /unexpected new line/);
  reject(vc, sub(vc, "REV:", "X-ADDED:1\r\nREV:"), /unexpected new line/);
});

test("reordered untouched lines are refused", () => {
  const a = sub(att, "ATTENDEE;PARTSTAT=DECLINED:mailto:dave@example.org\r\n", "");
  const after = sub(a, "ORGANIZER;", "ATTENDEE;PARTSTAT=DECLINED:mailto:dave@example.org\r\nORGANIZER;");
  reject(att, after, /reordered/);
});

test("a changed set of components is refused", () => {
  reject(att, sub(att, "END:VCALENDAR", "BEGIN:VTODO\r\nUID:x\r\nEND:VTODO\r\nEND:VCALENDAR"), /set of components/);
  reject(att, sub(att, "BEGIN:VEVENT", "BEGIN:VJOURNAL").replace("END:VEVENT", "END:VJOURNAL"), /set of components/);
  reject(ev, ev.replace(/BEGIN:VEVENT\r\nUID:override-moved@example.org\r\nDTSTAMP:\d+T\d+Z\r\nDTSTART[\s\S]*?END:VEVENT\r\n/, ""), /master|components/);
  reject(vc, vc.replace("BEGIN:VCARD", "BEGIN:VCALENDAR").replace("END:VCARD", "END:VCALENDAR"), /top-level/);
});

test("an existing VTIMEZONE that is kept must not be rewritten", () => {
  reject(ev, sub(ev, "TZOFFSETTO:+0200", "TZOFFSETTO:+0300"), /VTIMEZONE/);
});

test("text that does not parse is refused", () => {
  reject(ev, ev.replace("END:VCALENDAR", ""), /does not parse/);
  reject(ev, "", /exactly one/);
  reject(ev, ev + ev, /exactly one/);
});

test("owned properties of an Apple group travel together: label changes pass, a foreign property sharing a group does not", () => {
  const after = sub(vc, "item1.TEL;type=pref;type=VOICE:+1 555 0101\r\nitem1.X-ABLabel:main line", "item9.TEL;type=pref;type=VOICE:+1 555 0101\r\nitem9.X-ABLabel:renamed");
  assert.equal(checkFidelity(vc, after), true);
  const vendor = crlf(fixture("vcard40-vendor.vcf"));
  reject(vendor, sub(vendor, "item1.X-ABRELATEDNAMES:Another", "item1.X-ABRELATEDNAMES:Changed"), /untouched/);
  reject(vendor, sub(vendor, "item1.X-ABLabel:_$!<Friend>!$_", "item1.X-ABLabel:other"), /untouched/);
});

test("checkNewItem: needs VERSION, PRODID, one UID, and content", () => {
  assert.equal(checkNewItem(ev.replace(/BEGIN:VEVENT\r\nUID:override[\s\S]*?(?=END:VCALENDAR)/, "BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n").replace(/BEGIN:VEVENT\r\nUID:x[\s\S]*?(?=END:VCALENDAR)/, "BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n")), true);
  assert.throws(() => checkNewItem("BEGIN:VCALENDAR\r\nPRODID:-//X//EN\r\nBEGIN:VEVENT\r\nUID:a\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"), /VERSION/);
  assert.throws(() => checkNewItem("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"), /PRODID/);
  assert.throws(() => checkNewItem("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//X//EN\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"), /UID/);
  assert.throws(() => checkNewItem("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//X//EN\r\nEND:VCALENDAR\r\n"), /no event/);
});

test("item.save() runs the guard: a tampered tree is refused", () => {
  const item = openItem(fixture("event-attendees.ics"), "event");
  item.update({ summary: "ok" });
  const att0 = item.main.props("ATTENDEE")[0];
  att0.value = "mailto:evil@example.org";
  att0.dirty = true;
  assert.throws(() => item.save(), FidelityError);
  const c = openItem(fixture("vcard30-basic.vcf"), "contact");
  c.update({ fn: "x" });
  const v = c.main.prop("VERSION");
  v.value = "4.0";
  v.dirty = true;
  assert.throws(() => c.save(), FidelityError);
});

test("item.save() refuses an owned-looking change to UID", () => {
  const item = openItem(fixture("event-utc-basic.ics"), "event");
  const u = item.main.prop("UID");
  u.value = "changed@example.org";
  u.dirty = true;
  item.main.touched = true;
  assert.throws(() => item.save(), /UID/);
});
