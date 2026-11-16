// SPDX-License-Identifier: AGPL-3.0-or-later
// calendar/tz.js: the Intl-based VTIMEZONE generator (RUN3 WP B5) and its wiring into the write path.
// Goldens: tests/golden/vtimezone/<zone with / as _>.vtz (window 2025-2036). RADUI_UPDATE_GOLDEN=1 rewrites them.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureVtimezones, expandObservances, generateVtimezone, tzidSpans, vtimezoneComponent } from "../../../src/js/calendar/tz.js";
import { createZones } from "../../../src/js/model/icalview.js";
import { parse } from "../../../src/js/model/contentlines.js";
import { createItem, openItem } from "../../../src/js/model/item.js";
import { GATE_ZONES, intlOffset, matrixWalls, refInstant } from "../../roundtrip/tzgate.mjs";
import { fixture, logical, octets } from "../model/helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(here, "../../golden/vtimezone");
const WINDOW = { fromYear: 2025, toYear: 2036 };
const NOW = new Date("2026-11-12T10:00:00Z");
const GOLDEN_ZONES = ["Europe/Paris", "America/New_York", "Australia/Lord_Howe", "Pacific/Chatham", "America/Santiago", "Africa/Casablanca", "UTC", "Asia/Kathmandu"];
const noNames = (t) => t.split("\n").filter((l) => !l.startsWith("TZNAME:")).join("\n");

// ------------------------------------------------------------------ goldens

for (const zone of GOLDEN_ZONES) {
  test(`golden VTIMEZONE: ${zone}`, () => {
    const g = generateVtimezone(zone, WINDOW);
    const file = path.join(GOLDEN, `${zone.replace(/\//g, "_")}.vtz`);
    if (process.env.RADUI_UPDATE_GOLDEN === "1") {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(file, g.text + "\n");
    }
    assert.ok(existsSync(file), `missing golden ${file}`);
    const want = readFileSync(file, "utf8").replace(/\n$/, "");
    // TZNAME is the abbreviation the runtime's ICU knows (CET or GMT+1 ...): checked apart so a newer ICU does not break the goldens
    assert.equal(noNames(g.text), noNames(want));
    assert.equal(g.text.split("\n").filter((l) => l.startsWith("TZNAME:")).length, want.split("\n").filter((l) => l.startsWith("TZNAME:")).length);
    assert.doesNotMatch(g.text, /(^|\n)X-/, "no X- properties");
    for (const l of g.text.split("\n")) assert.ok(octets(l) <= 75, `line over 75 octets: ${l}`);
  });
}

test("golden shapes: the rules the zones really follow", () => {
  const rule = (z) => generateVtimezone(z, WINDOW).text.split("\n").filter((l) => l.startsWith("RRULE:")).join(" | ");
  assert.equal(rule("Europe/Paris"), "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU | RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU");
  assert.equal(rule("America/New_York"), "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU | RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU");
  assert.equal(rule("Australia/Lord_Howe"), "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU | RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU");
  assert.equal(rule("Pacific/Chatham"), "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU | RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=-1SU");
  assert.equal(rule("America/Santiago"), "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=SU;BYMONTHDAY=2,3,4,5,6,7,8 | RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=SU;BYMONTHDAY=2,3,4,5,6,7,8");
  assert.equal(rule("UTC"), "");
  assert.equal(rule("Africa/Casablanca"), "", "Ramadan changes follow no yearly rule: explicit RDATEs");
  const lh = generateVtimezone("Australia/Lord_Howe", WINDOW).text;
  assert.match(lh, /TZOFFSETFROM:\+1100\nTZOFFSETTO:\+1030/);
  assert.match(lh, /TZOFFSETFROM:\+1030\nTZOFFSETTO:\+1100/);
  const ch = generateVtimezone("Pacific/Chatham", WINDOW).text;
  assert.match(ch, /DTSTART:20250406T034500\nTZOFFSETFROM:\+1345\nTZOFFSETTO:\+1245/, "the onset is written in the clock before the change (the bug Radicale has)");
  assert.match(ch, /DTSTART:20250928T024500\nTZOFFSETFROM:\+1245\nTZOFFSETTO:\+1345/);
});

test("info: form, coverage and the limits are reported", () => {
  const info = (z) => generateVtimezone(z, WINDOW).info;
  assert.deepEqual([info("Europe/Paris").form, info("Europe/Paris").openEnded], ["rules", true]);
  assert.deepEqual([info("UTC").form, info("UTC").openEnded], ["constant", true]);
  const c = info("Africa/Casablanca");
  assert.deepEqual([c.form, c.openEnded, c.coveredThrough], ["rdates", false, 2036]);
  assert.throws(() => generateVtimezone("Not/AZone"), RangeError);
  assert.throws(() => generateVtimezone("UTC+02:00"), RangeError);
});

test("the model expands to exactly the transitions Intl has", () => {
  for (const zone of [...GATE_ZONES, "America/Los_Angeles", "Europe/Dublin", "Asia/Tehran", "Pacific/Apia", "Africa/Cairo"]) {
    const g = generateVtimezone(zone, { fromYear: 2020, toYear: 2035 });
    const off = intlOffset(zone);
    const got = expandObservances(g.observances, 2035).filter((o) => o.instant > Date.UTC(2020, 0, 1) && o.instant < Date.UTC(2036, 0, 1));
    const insideWindow = got.filter((o) => o.from !== o.to);
    // every Intl offset change of 2020-2035 is an onset, with the right offsets
    for (const o of insideWindow) {
      assert.equal(off(o.instant - 1000), o.from, `${zone} ${new Date(o.instant).toISOString()} from`);
      assert.equal(off(o.instant), o.to, `${zone} ${new Date(o.instant).toISOString()} to`);
    }
    let prev = off(Date.UTC(2020, 0, 1) - 1000);
    let n = 0;
    for (let t = Date.UTC(2020, 0, 1); t < Date.UTC(2036, 0, 1); t += 6 * 3600000) {
      const o = off(t);
      if (o !== prev) n++;
      prev = o;
    }
    assert.equal(insideWindow.length, n, `${zone}: number of transitions`);
  }
});

// ------------------------------------------------------------------ read back with the app's own reader

test("read with the app's embedded-zone code path: the same instants as Intl (gap and overlap days included)", () => {
  for (const zone of [...GATE_ZONES, "Asia/Kathmandu"]) {
    const { component, info } = vtimezoneComponent(zone, { fromYear: 2023, toYear: 2040 });
    const root = parse("BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n")[0];
    root.items.push(component);
    const zones = createZones(root);
    const z = zones.get(zone);
    assert.equal(z.tzClass, "embedded", `${zone} is read from its VTIMEZONE`);
    const off = intlOffset(zone);
    let bad = 0;
    const first = [];
    for (const c of matrixWalls(off)) {
      const want = refInstant(off, c.wallMs);
      if (z.instantFromWall(c.wallMs) !== want) {
        bad++;
        if (first.length < 3) first.push(`${c.iso} (${c.why})`);
      }
    }
    assert.equal(bad, 0, `${zone} (${info.form}): ${bad} wall times differ, e.g. ${first.join("; ")}`);
  }
});

test("a 40-year window and a far-away event (1998) are exact too", () => {
  for (const [zone, years] of [["Europe/Paris", [1998, 2038]], ["America/New_York", [2004, 2034]], ["America/Sao_Paulo", [2015, 2035]]]) {
    const { component } = vtimezoneComponent(zone, { fromYear: years[0], toYear: years[1] });
    const root = parse("BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n")[0];
    root.items.push(component);
    const z = createZones(root).get(zone);
    const off = intlOffset(zone);
    for (let y = years[0] + 1; y <= years[1]; y++) {
      for (const [mo, d] of [[1, 15], [3, 28], [4, 3], [7, 1], [9, 30], [10, 28], [11, 4], [12, 20]]) {
        const wall = Date.UTC(y, mo - 1, d, 2, 30);
        assert.equal(z.instantFromWall(wall), refInstant(off, wall), `${zone} ${y}-${mo}-${d}`);
      }
    }
  }
});

// ------------------------------------------------------------------ the write path

const ev = (tz, extra = {}) => ({ summary: "Meeting", start: { kind: "zoned", iso: "2026-11-18T14:00:00", tzid: tz }, end: { kind: "zoned", iso: "2026-11-18T15:00:00", tzid: tz }, ...extra });

test("a new event with a TZID gets our VTIMEZONE (CRLF, folded, no X- properties) before the VEVENT", () => {
  const item = createItem("event", ev("Australia/Lord_Howe"), { uid: "new-1@example.org" });
  const out = item.save({ now: NOW });
  assert.equal(out.changed, true);
  const t = out.text;
  assert.ok(t.includes("\r\nBEGIN:VTIMEZONE\r\nTZID:Australia/Lord_Howe\r\n"));
  assert.ok(t.indexOf("BEGIN:VTIMEZONE") < t.indexOf("BEGIN:VEVENT"));
  assert.ok(!/[^\r]\n/.test(t), "CRLF only");
  assert.ok(!/\r\nX-/.test(t));
  assert.deepEqual(item.tzAdded.map((x) => x.tzid), ["Australia/Lord_Howe"]);
  const back = openItem(t, "event");
  assert.equal(back.ok && !back.readOnly, true);
  assert.equal(back.tz["Australia/Lord_Howe"], "embedded");
  const s = back.eventModel().start;
  assert.equal(s.tzClass, "embedded");
  assert.equal(new Date(s.instant).toISOString(), "2026-11-18T03:00:00.000Z"); // +11:00
});

test("window: a recurring event gets rules that last, a one-off a short window", () => {
  const one = createItem("event", ev("America/New_York"), { uid: "w1@example.org" }).save({ now: NOW }).text;
  assert.match(one, /DTSTART:20250101T000000/, "from the year before the event");
  const series = createItem("event", ev("America/New_York", { rrule: "FREQ=WEEKLY;COUNT=520" }), { uid: "w2@example.org" }).save({ now: NOW }).text;
  assert.match(series, /RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU/, "an open-ended rule");
  const spans = tzidSpans(parse(series)[0]);
  assert.equal(spans.get("America/New_York").min, 2026);
  assert.ok(spans.get("America/New_York").max >= 2036);
});

test("a zone with explicit RDATEs reports its limit", () => {
  const item = createItem("event", ev("Africa/Casablanca"), { uid: "c1@example.org" });
  const out = item.save({ now: NOW });
  assert.match(out.text, /RDATE:/);
  assert.deepEqual(item.tzAdded.map((x) => [x.tzid, x.form, x.openEnded, x.coveredThrough]), [["Africa/Casablanca", "rdates", false, 2036]]);
});

test("an existing VTIMEZONE is never modified; untouched TZIDs get nothing; a no-op save is byte-identical", () => {
  const src = fixture("event-tzid-embedded.ics"); // America/New_York with its own VTIMEZONE
  const item = openItem(src, "event");
  assert.equal(item.save().changed, false, "no-op save: no request");
  item.update({ summary: "x" });
  const out = item.save({ now: NOW });
  const vtz = (t) => t.match(/BEGIN:VTIMEZONE[\s\S]*END:VTIMEZONE/)[0].replace(/\r\n/g, "\n");
  assert.equal(vtz(out.text), vtz(src.replace(/\r\n/g, "\n")), "the foreign VTIMEZONE is byte-identical");
  assert.deepEqual(item.tzAdded, []);
  // a foreign (even wrong) VTIMEZONE stays when the user changes the end zone to ANOTHER zone: only the new zone gets one
  const wrong = src.replace("TZOFFSETTO:-0500", "TZOFFSETTO:-0600");
  const two = openItem(wrong, "event");
  two.update({ end: { kind: "zoned", iso: "2026-03-08T12:30:00", tzid: "Europe/Paris" } });
  const o2 = two.save({ now: NOW });
  assert.ok(o2.text.includes("TZOFFSETTO:-0600"), "the wrong foreign VTIMEZONE is left alone");
  assert.deepEqual(two.tzAdded.map((x) => x.tzid), ["Europe/Paris"]);
  assert.equal((o2.text.match(/BEGIN:VTIMEZONE/g) || []).length, 2);
});

test("an item without a VTIMEZONE keeps none when its zones do not change (fidelity), gets one for a new zone", () => {
  const src = fixture("event-tzid-iana-novtimezone.ics"); // Europe/Paris + America/New_York, no VTIMEZONE
  const a = openItem(src, "event");
  a.update({ summary: "renamed" });
  assert.doesNotMatch(a.save({ now: NOW }).text, /VTIMEZONE/);
  const b = openItem(src, "event");
  b.update({ end: { kind: "zoned", iso: "2026-06-15T10:00:00", tzid: "Asia/Tokyo" } });
  const o = b.save({ now: NOW });
  assert.deepEqual(b.tzAdded.map((x) => x.tzid), ["Asia/Tokyo"]);
  assert.match(o.text, /TZID:Asia\/Tokyo\r\nBEGIN:STANDARD/);
  assert.doesNotMatch(o.text, /TZID:Europe\/Paris\r\nBEGIN/);
});

test("the tail of a split gets a VTIMEZONE for a zone the user changed", () => {
  const src = fixture("event-series-overrides-exdates.ics");
  const item = openItem(src, "event");
  const rid = { kind: "zoned", iso: "2026-04-20T10:00:00", tzid: "Europe/Paris" };
  const fields = item.fields();
  const { tailText, tzAdded } = item.splitSeries(rid, { newUid: "tail-tz", now: NOW, tailPatch: { start: { kind: "zoned", iso: "2026-04-20T10:00:00", tzid: "Asia/Tokyo" }, end: { kind: "zoned", iso: "2026-04-20T11:00:00", tzid: "Asia/Tokyo" } } });
  assert.ok(fields);
  assert.deepEqual(tzAdded.map((x) => x.tzid), ["Asia/Tokyo"]);
  assert.match(tailText, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Paris/, "the cloned one stays");
  assert.match(tailText, /BEGIN:VTIMEZONE\r\nTZID:Asia\/Tokyo/);
  const tail = openItem(tailText, "event");
  assert.equal(tail.tz["Asia/Tokyo"], "embedded");
});

test("ensureVtimezones: unknown TZIDs and floating times are left alone; idempotent", () => {
  const root = parse(fixture("event-tzid-quoted-unknown.ics"))[0];
  assert.deepEqual(ensureVtimezones(root), []);
  const r2 = parse(createItem("event", ev("Europe/Paris"), { uid: "i@example.org" }).save({ now: NOW }).text)[0];
  assert.deepEqual(ensureVtimezones(r2), [], "already there");
});
