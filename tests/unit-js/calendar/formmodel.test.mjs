// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { ALARM_PRESETS, alarmOfPreset, alarmPresetId, fromItem, newEventValues, ridSpecOf, toNewFields, toPatch, validate, valuesToSpecs, whenInfo, withAllDay, withZone } from "../../../src/js/calendar/formmodel.js";
import { createItem, openItem } from "../../../src/js/model/item.js";
import { parseTime } from "../../../src/js/model/contentlines.js";
import { D, fixture, fixtures } from "../model/helpers.mjs";

const NOW = D("2026-11-12T10:00:00Z");
const open = (name) => {
  const it = openItem(fixture(name), "event");
  assert.equal(it.ok, true, name);
  return it;
};
const clone = (v) => JSON.parse(JSON.stringify(v));

test("no-op over every .ics event fixture: untouched values give an empty patch, no error, and the specs round-trip", () => {
  let n = 0;
  for (const f of fixtures().filter((x) => x.name.startsWith("ics/event-"))) {
    const item = openItem(f.text, "event");
    if (!item.ok || item.readOnly) continue;
    const base = fromItem(item);
    const values = clone(base);
    assert.deepEqual(toPatch(base, values, { zones: item.zones }), {}, f.name);
    assert.deepEqual(validate(base, values, { zones: item.zones }), [], f.name);
    const { start, end } = valuesToSpecs(values);
    const ds = item.main.prop("DTSTART");
    assert.deepEqual(start, parseTime(ds.value, ds.params), `${f.name}: start`);
    const de = item.main.prop("DTEND");
    if (de) assert.deepEqual(end, parseTime(de.value, de.params), `${f.name}: end`);
    // opening the same item for each occurrence of a series is also a no-op
    for (const occ of item.expand({ limit: 3 }).occurrences) {
      const b2 = fromItem(item, occ);
      assert.deepEqual(toPatch(b2, clone(b2), { zones: item.zones }), {}, `${f.name} occurrence`);
    }
    // and an update with the empty patch never changes the item
    item.update(toPatch(base, values));
    assert.deepEqual(item.save({ now: NOW }), { changed: false }, f.name);
    n++;
  }
  assert.ok(n >= 30, `corpus events checked: ${n}`);
});

test("only the changed keys are in the patch, and the event's own TZID survives", () => {
  const item = open("event-tzid-embedded.ics");
  const base = fromItem(item);
  assert.ok(base.startTz);
  const v = clone(base);
  v.summary = "Renamed";
  assert.deepEqual(toPatch(base, v), { summary: "Renamed" });
  const w = clone(base);
  w.endTime = "23:45";
  const p = toPatch(base, w);
  assert.deepEqual(Object.keys(p), ["end"]);
  assert.equal(p.end.tzid, base.endTz);
  const z = withZone(clone(base), "start", "Asia/Kathmandu");
  const pz = toPatch(base, z);
  assert.deepEqual(Object.keys(pz), ["start"]);
  assert.equal(pz.start.tzid, "Asia/Kathmandu");
  assert.equal(pz.start.iso.slice(0, 19), `${base.startDate}T${base.startTime.length === 5 ? base.startTime + ":00" : base.startTime}`, "the wall time is kept; only the zone changed");
});

test("text, categories, status, transp, url, alarms", () => {
  const item = open("event-alarms.ics");
  const base = fromItem(item);
  const v = clone(base);
  v.description = "line 1\r\nline 2";
  v.location = "Room 4";
  v.categories = [" a ", "", "b"];
  v.status = "TENTATIVE";
  v.transp = "TRANSPARENT";
  v.url = " https://example.org/x ";
  v.alarms = [{ seconds: -600, related: "START" }];
  const p = toPatch(base, v);
  assert.equal(p.description, "line 1\nline 2");
  assert.equal(p.location, "Room 4");
  assert.deepEqual(p.categories, ["a", "b"]);
  assert.equal(p.status, "TENTATIVE");
  assert.equal(p.transp, "TRANSPARENT");
  assert.equal(p.url, "https://example.org/x");
  assert.deepEqual(p.alarms, [{ seconds: -600, related: "START" }]);
  item.update(p);
  assert.equal(item.save({ now: NOW }).changed, true);
  const cleared = clone(base);
  cleared.status = "";
  assert.equal(toPatch({ ...base, status: "CONFIRMED" }, cleared).status, null, "an emptied select removes the property");
});

test("alarm presets: ids, custom values and the foreign count", () => {
  assert.equal(ALARM_PRESETS.length, 8);
  assert.equal(alarmPresetId({ seconds: -900, related: "START" }), "15m");
  assert.equal(alarmPresetId({ seconds: -2700, related: "START" }), "custom");
  assert.equal(alarmPresetId({ seconds: -900, related: "END" }), "custom");
  assert.deepEqual(alarmOfPreset("1d"), { seconds: -86400, related: "START" });
  assert.equal(alarmOfPreset("none"), null);
  assert.equal(alarmOfPreset("custom"), null);
  const item = open("event-alarms.ics");
  const base = fromItem(item);
  assert.equal(typeof base.foreignAlarms, "number");
});

test("all-day: the end is shown inclusive and written exclusive; toggling writes start and end", () => {
  const item = open("event-allday-multiday.ics");
  const base = fromItem(item);
  assert.equal(base.allDay, true);
  const de = item.main.prop("DTEND").value;
  const exclusive = `${de.slice(0, 4)}-${de.slice(4, 6)}-${de.slice(6, 8)}`;
  const last = new Date(Date.parse(`${exclusive}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  assert.equal(base.endDate, last);
  const v = clone(base);
  v.endDate = exclusive; // one more day
  assert.equal(toPatch(base, v).end.iso, new Date(Date.parse(`${exclusive}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
  const timed = withAllDay(clone(base), false, { tz: "Europe/Paris", time: "09:00", durationMinutes: 90 });
  const p = toPatch(base, timed);
  assert.equal(p.start.kind, "zoned");
  assert.equal(p.start.tzid, "Europe/Paris");
  assert.ok(p.end);
  const back = withAllDay(timed, true);
  assert.equal(back.startKind, "date");
  assert.equal(toPatch(fromItem(open("event-tzid-embedded.ics")), withAllDay(clone(fromItem(open("event-tzid-embedded.ics"))), true)).start.kind, "date");
});

test("an event that uses DURATION and an event without end can be shown and are not rewritten", () => {
  for (const f of ["event-duration.ics", "event-allday-duration.ics", "event-quirk-zero-duration.ics"]) {
    const item = open(f);
    const base = fromItem(item);
    assert.deepEqual(toPatch(base, clone(base)), {}, f);
    assert.ok(base.endDate >= base.startDate, f);
  }
});

test("an occurrence of a series shows its own start; an override shows its own text", () => {
  const item = open("event-recur-exdate-override-moved.ics");
  const occs = item.expand({}).occurrences;
  const over = occs.find((o) => o.source === "override");
  assert.ok(over);
  const f = fromItem(item, over);
  assert.equal(f.summary, over.component.prop("SUMMARY").value);
  const plain = occs.find((o) => o.source === "series");
  const g = fromItem(item, plain);
  assert.equal(g.startDate, plain.start.iso.slice(0, 10));
  assert.equal(ridSpecOf(over).iso, over.recurrenceId.iso);
  assert.equal(ridSpecOf(plain).iso, plain.start.iso);
});

test("recurrence in the form: builder, custom (kept) and none", () => {
  const weekly = open("event-rrule-count-weekly.ics");
  const base = fromItem(weekly);
  assert.equal(base.rule.mode, "builder");
  assert.equal(base.recurring, true);
  const v = clone(base);
  v.rule.state.interval = 2;
  const p = toPatch(base, v);
  assert.match(p.rrule, /INTERVAL=2/);
  const none = clone(base);
  none.rule = { mode: "none" };
  assert.equal(toPatch(base, none).rrule, null);
  const custom = openItem(fixture("event-bysetpos.ics"), "event");
  const cb = fromItem(custom);
  assert.equal(cb.rule.mode, "custom");
  assert.deepEqual(toPatch(cb, clone(cb)), {}, "an untouched custom rule is never re-emitted");
  const single = fromItem(open("event-allday-single.ics"));
  assert.equal(single.rule.mode, "none");
  assert.equal(single.recurring, false);
});

test("validation: only touched values are judged; title, dates, times, order, zones, URL, alarms", () => {
  const item = open("event-tzid-embedded.ics");
  const base = fromItem(item);
  const codes = (v, extra) => validate(base, v, { zones: item.zones, ...extra }).map((e) => `${e.field}:${e.code}`);
  const v = clone(base);
  v.summary = "  ";
  assert.deepEqual(codes(v), ["summary:summary-required"]);
  const t = clone(base);
  t.startTime = "25:00";
  assert.deepEqual(codes(t), ["start:time-invalid"]);
  const d = clone(base);
  d.endDate = "2026-02-30";
  assert.deepEqual(codes(d), ["end:date-invalid"]);
  const e = clone(base);
  e.endDate = e.startDate;
  e.endTime = "00:00";
  e.startTime = "10:00";
  assert.deepEqual(codes(e), ["end:end-before-start"]);
  const z = withZone(clone(base), "start", "Nowhere/Land");
  assert.deepEqual(codes(z), ["start:tz-unknown"]);
  const u = clone(base);
  u.url = "example.org/x";
  assert.deepEqual(codes(u), ["url:url-scheme"]);
  u.url = "javascript:alert(1)";
  assert.deepEqual(codes(u), ["url:url-unsafe"]);
  u.url = "https://example.org/x";
  assert.deepEqual(codes(u), []);
  const a = clone(base);
  a.alarms = [-60, -120, -180, -240].map((s) => ({ seconds: s, related: "START" }));
  assert.deepEqual(codes(a), ["alarms:alarms-max"]);
  // a new event needs a title and a start
  const nv = newEventValues({ date: "2026-11-20", tz: "Europe/Paris" });
  assert.deepEqual(validate(null, nv, { isNew: true }).map((x) => x.code), ["summary-required"]);
  nv.summary = "Lunch";
  assert.deepEqual(validate(null, nv, { isNew: true }), []);
  // an old event with no title can still be saved after an unrelated edit
  const untitled = { ...base, summary: "" };
  assert.deepEqual(validate(untitled, { ...clone(untitled), location: "Here" }, { zones: item.zones }), []);
});

test("all-day end before start is refused; an end equal to the start is allowed for timed events", () => {
  const item = open("event-allday-single.ics");
  const base = fromItem(item);
  const v = clone(base);
  v.endDate = "2000-01-01";
  assert.deepEqual(validate(base, v).map((x) => x.code), ["end-before-start"]);
  const t = newEventValues({ date: "2026-11-20", tz: "Europe/Paris", time: "10:00" });
  t.summary = "x";
  t.endTime = "10:00";
  t.endDate = t.startDate;
  assert.deepEqual(validate(null, t, { isNew: true }), []);
});

test("end >= start is judged in absolute time across zones", () => {
  const v = newEventValues({ date: "2026-11-20", tz: "Europe/Paris", time: "10:00" });
  v.summary = "Flight";
  v.endDate = "2026-11-20";
  v.endTime = "08:00";
  v.endTz = "America/New_York"; // 08:00 in New York is after 10:00 in Paris
  v.endKind = "zoned";
  assert.deepEqual(validate(null, v, { isNew: true }), []);
  v.endTz = "Asia/Kathmandu"; // 08:00 Kathmandu = 03:15 Paris: before the start
  assert.deepEqual(validate(null, v, { isNew: true }).map((x) => x.code), ["end-before-start"]);
});

test("whenInfo: duration, display zone clock, DST gap and overlap notes", () => {
  const v = newEventValues({ date: "2026-03-29", tz: "Europe/Paris", time: "02:30" });
  const w = whenInfo(v, { displayTz: "Asia/Kathmandu" });
  assert.equal(w.startGap.resolved, "2026-03-29T03:30:00");
  assert.equal(w.startGap.tzid, "Europe/Paris");
  assert.equal(typeof w.durationSec, "number");
  const normal = whenInfo(newEventValues({ date: "2026-07-01", tz: "Europe/Paris", time: "14:00", durationMinutes: 90 }), { displayTz: "America/New_York" });
  assert.equal(normal.durationSec, 5400);
  assert.equal(normal.display.start, "2026-07-01T08:00:00");
  assert.equal(normal.startGap, undefined);
  const fall = whenInfo(newEventValues({ date: "2026-10-25", tz: "Europe/Paris", time: "02:30" }), {});
  assert.ok(fall.startOverlap);
  const bad = { ...v, startTime: "xx" };
  assert.equal(whenInfo(bad, {}), null);
  const allDay = whenInfo(newEventValues({ date: "2026-07-01", allDay: true }), {});
  assert.equal(allDay.durationSec, 86400);
});

test("a new event: fields for createItem, never floating, a rule and alarms included", () => {
  const v = newEventValues({ date: "2026-11-20", time: "14:00", tz: "Europe/Paris" });
  v.summary = "Review";
  v.location = "Room 4";
  v.categories = ["work"];
  v.alarms = [{ seconds: -900, related: "START" }];
  v.rule = { mode: "builder", state: { freq: "WEEKLY", interval: 1, byday: ["FR"], monthly: "dom", bymonthday: null, nth: null, bymonth: null, end: { type: "count", count: 4 }, wkst: null } };
  const fields = toNewFields(v);
  assert.equal(fields.start.kind, "zoned");
  assert.equal(fields.start.tzid, "Europe/Paris");
  assert.equal(fields.end.iso, "2026-11-20T15:00:00");
  assert.equal(fields.rrule, "FREQ=WEEKLY;BYDAY=FR;COUNT=4");
  const item = createItem("event", fields, { uid: "new-1" });
  const out = item.save({ now: NOW }).text;
  assert.match(out, /DTSTART;TZID=Europe\/Paris:20261120T140000/);
  assert.match(out, /RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=4/);
  assert.match(out, /TRIGGER:-PT15M/);
  const utc = newEventValues({ date: "2026-11-20", tz: "UTC" });
  assert.equal(valuesToSpecs(utc).start.kind, "utc");
  assert.equal(valuesToSpecs(withZone(utc, "start", "Europe/Paris")).start.kind, "zoned");
});
