// SPDX-License-Identifier: AGPL-3.0-or-later
// Read view: time zones (decision D7) and recurrence expansion.
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../../../src/js/model/contentlines.js";
import { classifyTzid, createZones, expandEvents, intlAccepts, vtimezoneMap } from "../../../src/js/model/icalview.js";
import { openItem } from "../../../src/js/model/item.js";
import { D, fixture } from "./helpers.mjs";

const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";
const root = (name) => parse(fixture(name))[0];

// ------------------------------------------------------------------ D7

test("D7 (a): a TZID with an embedded VTIMEZONE is classified 'embedded'", () => {
  const item = openItem(fixture("event-tzid-embedded.ics"), "event");
  assert.deepEqual(item.tz, { "America/New_York": "embedded" });
  const c = openItem(fixture("event-tzid-custom-embedded.ics"), "event");
  assert.deepEqual(c.tz, { "Example Standard Time": "embedded" }, "a non-IANA name is fine when it is embedded");
  assert.equal(c.readOnly, false);
});

test("D7 (b): no VTIMEZONE but Intl accepts the name: instants from Intl, TZID kept, nothing added", () => {
  const src = fixture("event-tzid-iana-novtimezone.ics");
  const item = openItem(src, "event");
  assert.deepEqual(item.tz, { "Europe/Paris": "intl", "America/New_York": "intl" });
  assert.equal(item.readOnly, false);
  const { occurrences } = item.expand({});
  assert.equal(occurrences.length, 1);
  const o = occurrences[0];
  assert.equal(o.start.tzClass, "intl");
  assert.equal(iso(o.start.instant), "2026-06-15T06:00:00Z"); // 08:00 CEST
  assert.equal(iso(o.end.instant), "2026-06-15T14:00:00Z"); // 10:00 EDT
  assert.equal(o.end.tzid, "America/New_York");
  assert.equal(o.end.iso, "2026-06-15T10:00:00");
  // editing another field does not add a VTIMEZONE nor rewrite the TZIDs
  item.update({ summary: "x" });
  const out = item.save({ now: D("2026-11-12T10:00:00Z") }).text;
  assert.doesNotMatch(out, /VTIMEZONE/);
  assert.ok(out.includes("DTSTART;TZID=Europe/Paris:20260615T080000"));
  assert.ok(out.includes("DTEND;TZID=America/New_York:20260615T100000"));
});

test("D7 (c): neither: read-only with a warning, never treated as floating", () => {
  for (const [name, tzid] of [["event-tzid-quoted-unknown.ics", "UTC+02:00"], ["event-tzid-windows-name.ics", "Example Mountain Time"]]) {
    const item = openItem(fixture(name), "event");
    assert.equal(item.ok, true);
    assert.equal(item.readOnly, true);
    assert.equal(item.tz[tzid], "unknown");
    const w = item.warnings.find((x) => x.code === "unknown-tzid");
    assert.equal(w.tzid, tzid);
    const o = item.expand({}).occurrences[0];
    assert.equal(o.start.kind, "zoned", "still a zoned value");
    assert.equal(o.start.instant, null, "no instant is invented");
    assert.equal(o.start.tzClass, "unknown");
    assert.equal(o.start.iso, "2026-03-10T09:00:00", "drawn at its wall-clock time");
    assert.notEqual(o.start.kind, "floating");
  }
});

test("D7: a VTIMEZONE of the same name wins over Intl, and offset-style names are never Intl zones", () => {
  const map = vtimezoneMap(root("event-tzid-embedded.ics"));
  assert.equal(classifyTzid("America/New_York", map), "embedded");
  assert.equal(classifyTzid("America/New_York", new Map()), "intl");
  assert.equal(classifyTzid("+02:00", new Map()), "unknown");
  assert.equal(intlAccepts("UTC+02:00"), false);
  assert.equal(intlAccepts("Pacific Standard Time"), false);
  assert.equal(intlAccepts("Asia/Tokyo"), true);
  assert.equal(intlAccepts(""), false);
});

test("D7: floating times and all-day values are handled as they are", () => {
  const f = openItem(fixture("event-floating.ics"), "event");
  const o = f.expand({}).occurrences[0];
  assert.equal(o.start.kind, "floating");
  assert.equal(o.start.instant, null);
  assert.equal(o.start.iso, "2026-04-02T09:00:00");
  assert.deepEqual(f.tz, {});
  const a = openItem(fixture("event-allday-multiday.ics"), "event").expand({}).occurrences[0];
  assert.equal(a.allDay, true);
  assert.equal(a.start.iso, "2026-04-03");
  assert.equal(a.end.iso, "2026-04-07");
  const s = openItem(fixture("event-allday-single.ics"), "event").expand({}).occurrences[0];
  assert.equal(s.end.iso, "2026-04-02", "a one-day event without DTEND ends the next day");
});

// ------------------------------------------------------------------ zone arithmetic

test("embedded VTIMEZONE and Intl agree on every non-ambiguous hour of 2026 (Paris, New York)", () => {
  for (const [file, tzid] of [["event-recur-weekly-dst.ics", "Europe/Paris"], ["event-tzid-embedded.ics", "America/New_York"]]) {
    const zones = createZones(root(file));
    const emb = zones.get(tzid);
    assert.equal(emb.tzClass, "embedded");
    const intl = createZones(parse("BEGIN:VCALENDAR\nEND:VCALENDAR\n")[0]).get(tzid);
    assert.equal(intl.tzClass, "intl");
    let n = 0;
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3600000 * 5 + 1800000) {
      assert.equal(emb.offsetAtInstant(t), intl.offsetAtInstant(t), `${tzid} ${iso(t)}`);
      n++;
    }
    assert.ok(n > 1500);
  }
});

test("wall-clock resolution follows RFC 5545: a gap uses the offset before it, an overlap the first occurrence", () => {
  const embedded = createZones(root("event-dst-spring-gap.ics")).get("Europe/Paris");
  const intl = createZones(parse("BEGIN:VCALENDAR\nEND:VCALENDAR\n")[0]).get("Europe/Paris");
  for (const z of [embedded, intl]) {
    assert.equal(iso(z.instantFromWall(Date.UTC(2026, 2, 29, 2, 30))), "2026-03-29T01:30:00Z", "gap 02:30 -> +01:00");
    assert.equal(iso(z.instantFromWall(Date.UTC(2026, 2, 29, 1, 59))), "2026-03-29T00:59:00Z");
    assert.equal(iso(z.instantFromWall(Date.UTC(2026, 2, 29, 3, 0))), "2026-03-29T01:00:00Z");
    assert.equal(iso(z.instantFromWall(Date.UTC(2026, 9, 25, 2, 30))), "2026-10-25T00:30:00Z", "overlap 02:30 -> first (+02:00)");
    assert.equal(iso(z.instantFromWall(Date.UTC(2026, 9, 25, 3, 30))), "2026-10-25T02:30:00Z");
    assert.equal(iso(z.instantFromWall(Date.UTC(2026, 9, 25, 1, 30))), "2026-10-24T23:30:00Z");
  }
});

test("DST edge fixtures: instants of the gap and overlap events", () => {
  const gap = openItem(fixture("event-dst-spring-gap.ics"), "event").expand({}).occurrences[0];
  assert.equal(iso(gap.start.instant), "2026-03-29T01:30:00Z");
  assert.equal(iso(gap.end.instant), "2026-03-29T01:30:00Z", "03:30 CEST = 01:30Z");
  assert.equal(gap.end.instant - gap.start.instant, 0);
  const ov = openItem(fixture("event-dst-autumn-overlap.ics"), "event").expand({}).occurrences[0];
  assert.equal(iso(ov.start.instant), "2026-10-25T00:30:00Z");
  assert.equal(iso(ov.end.instant), "2026-10-25T02:30:00Z");
});

test("New York spring change inside one event: one real hour", () => {
  const item = openItem(fixture("event-tzid-embedded.ics"), "event");
  const m = item.eventModel();
  assert.equal(m.durationSec, 3600);
  const o = item.expand({}).occurrences[0];
  assert.equal(iso(o.start.instant), "2026-03-08T06:30:00Z");
  assert.equal(iso(o.end.instant), "2026-03-08T07:30:00Z");
  assert.equal(o.end.iso, "2026-03-08T03:30:00");
});

test("a custom (non-IANA) embedded zone resolves from its own rules", () => {
  const o = openItem(fixture("event-tzid-custom-embedded.ics"), "event").expand({}).occurrences[0];
  assert.equal(iso(o.start.instant), "2026-07-01T13:00:00Z"); // -0400 in July
  assert.equal(o.start.tzClass, "embedded");
});

// ------------------------------------------------------------------ expansion

const occ = (name, opts = {}) => openItem(fixture(name), "event").expand(opts).occurrences;
const starts = (list) => list.map((o) => (o.start.instant !== null ? iso(o.start.instant) : o.start.iso));

test("weekly series across the DST change keeps the wall clock", () => {
  assert.deepEqual(starts(occ("event-recur-weekly-dst.ics")), [
    "2026-03-22T09:00:00Z",
    "2026-03-29T08:00:00Z",
    "2026-04-05T08:00:00Z",
    "2026-04-12T08:00:00Z",
  ]);
});

test("EXDATE and a RECURRENCE-ID override with a changed time", () => {
  const list = occ("event-recur-exdate-override-moved.ics");
  assert.deepEqual(starts(list), [
    "2026-03-02T08:30:00Z",
    "2026-03-09T08:30:00Z",
    "2026-03-23T08:30:00Z", // 16 March is excluded
    "2026-03-30T12:00:00Z", // override: 14:00 CEST instead of 09:30
    "2026-04-06T07:30:00Z",
    "2026-04-13T07:30:00Z",
    "2026-04-20T07:30:00Z",
  ]);
  const moved = list.find((o) => o.source === "override");
  assert.equal(moved.recurrenceId.iso, "2026-03-30T09:30:00");
  assert.equal(moved.component.prop("SUMMARY").value, "Weekly sync (moved)");
  assert.equal(iso(moved.end.instant), "2026-03-30T13:00:00Z");
  assert.equal(list[0].source, "series");
});

test("RDATE adds occurrences", () => {
  const list = occ("event-rdate.ics");
  assert.deepEqual(starts(list), ["2026-06-01T08:00:00Z", "2026-06-02T08:00:00Z", "2026-06-03T08:00:00Z", "2026-06-20T08:00:00Z", "2026-06-25T08:00:00Z"]);
  assert.equal(list[3].source, "rdate");
});

test("BYSETPOS: last working day of the month", () => {
  assert.deepEqual(starts(occ("event-bysetpos.ics")), ["2026-01-30T17:00:00Z", "2026-02-27T17:00:00Z", "2026-03-31T17:00:00Z", "2026-04-30T17:00:00Z"]);
});

test("UNTIL in UTC is compared as an instant (zone without VTIMEZONE)", () => {
  const list = occ("event-recur-until-utc.ics");
  assert.equal(list.length, 5);
  assert.equal(iso(list[4].start.instant), "2026-04-03T08:00:00Z");
});

test("all-day weekly series with a date EXDATE", () => {
  const list = occ("event-recur-allday.ics");
  assert.deepEqual(starts(list), ["2026-03-01", "2026-03-15", "2026-03-22", "2026-03-29"]);
  assert.ok(list.every((o) => o.allDay));
  assert.equal(list[0].end.iso, "2026-03-02");
});

test("a cancelled override is returned with its component", () => {
  const list = occ("event-cancelled-override.ics");
  assert.equal(list.length, 4);
  assert.equal(list[1].source, "override");
  assert.equal(list[1].component.prop("STATUS").value, "CANCELLED");
});

test("time window and limit", () => {
  const all = occ("event-recur-exdate-override-moved.ics");
  const win = occ("event-recur-exdate-override-moved.ics", { from: Date.UTC(2026, 2, 28), to: Date.UTC(2026, 3, 8) });
  assert.deepEqual(starts(win), ["2026-03-30T12:00:00Z", "2026-04-06T07:30:00Z"]);
  assert.ok(all.length > win.length);
  const lim = openItem(fixture("event-recur-exdate-override-moved.ics"), "event").expand({ limit: 2 });
  assert.equal(lim.occurrences.length, 2);
  assert.equal(lim.truncated, true);
});

test("an endless rule is cut by the window or the limit", () => {
  const src = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//X//EN\r\nBEGIN:VEVENT\r\nUID:e@example.org\r\nDTSTART:20260101T080000Z\r\nDTEND:20260101T090000Z\r\nRRULE:FREQ=DAILY\r\nSUMMARY:s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const item = openItem(src, "event");
  const w = item.expand({ from: Date.UTC(2026, 5, 1), to: Date.UTC(2026, 5, 4) });
  assert.equal(w.occurrences.length, 3);
  const lim = item.expand({ limit: 5 });
  assert.equal(lim.occurrences.length, 5);
  assert.equal(lim.truncated, true);
});

test("a weekly series in a zone keeps 09:00 local across the New York change", () => {
  const src = fixture("event-tzid-embedded.ics").replace("DTSTART;TZID=America/New_York:20260308T013000", "DTSTART;TZID=America/New_York:20260301T090000").replace("DTEND;TZID=America/New_York:20260308T033000", "DTEND;TZID=America/New_York:20260301T100000").replace("SUMMARY:", "RRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:");
  const list = openItem(src, "event").expand({}).occurrences;
  assert.deepEqual(starts(list), ["2026-03-01T14:00:00Z", "2026-03-08T13:00:00Z", "2026-03-15T13:00:00Z"]);
});

test("the expansion also works for events whose zone is unknown (no instants)", () => {
  const src = fixture("event-tzid-windows-name.ics").replace("SUMMARY:", "RRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:");
  const list = openItem(src, "event").expand({}).occurrences;
  assert.deepEqual(starts(list), ["2026-03-10T09:00:00", "2026-03-11T09:00:00", "2026-03-12T09:00:00"]);
  assert.ok(list.every((o) => o.start.instant === null && o.start.kind === "zoned"));
});
