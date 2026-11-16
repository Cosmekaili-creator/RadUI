// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { buildRule, canonicalRule, defaultState, nthOf, parseRule, sameRule, validateState, withFreq, withMonthlyMode } from "../../../src/js/calendar/rrule.js";
import { parse } from "../../../src/js/model/contentlines.js";
import { createZones } from "../../../src/js/model/icalview.js";
import { fixtures } from "../model/helpers.mjs";

const PARIS = { kind: "zoned", iso: "2026-03-23T10:00:00", tzid: "Europe/Paris" };
const ALLDAY = { kind: "date", iso: "2026-03-23" };
const ok = (text, start = PARIS) => {
  const r = parseRule(text, start);
  assert.equal(r.custom, false, `${text}: ${r.reason}`);
  return r.state;
};

test("canonicalRule: part order, case, BYDAY order and INTERVAL=1 do not matter", () => {
  assert.equal(canonicalRule("FREQ=WEEKLY;BYDAY=TH,MO;INTERVAL=1"), canonicalRule("byday=MO,TH;freq=weekly"));
  assert.ok(sameRule("FREQ=DAILY;COUNT=3", "COUNT=3;FREQ=DAILY"));
  assert.ok(!sameRule("FREQ=DAILY;COUNT=3", "FREQ=DAILY;COUNT=4"));
  assert.ok(!sameRule("FREQ=DAILY;INTERVAL=2", "FREQ=DAILY"));
  assert.equal(canonicalRule(""), "");
});

test("the four frequencies parse into builder state and build back exactly", () => {
  const cases = [
    "FREQ=DAILY",
    "FREQ=DAILY;INTERVAL=3;COUNT=10",
    "FREQ=WEEKLY;BYDAY=MO,TH",
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=8",
    "FREQ=WEEKLY",
    "FREQ=MONTHLY;BYMONTHDAY=15",
    "FREQ=MONTHLY",
    "FREQ=MONTHLY;BYDAY=2TU",
    "FREQ=MONTHLY;BYDAY=-1FR;INTERVAL=2",
    "FREQ=YEARLY",
    "FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=4",
    "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
    "FREQ=WEEKLY;BYDAY=MO;WKST=SU",
  ];
  for (const r of cases) {
    const st = ok(r);
    assert.ok(sameRule(buildRule(st, PARIS), r), `${r} -> ${buildRule(st, PARIS)}`);
  }
});

test("anything the builder cannot reproduce is custom and is never re-emitted", () => {
  const customs = [
    ["FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "part-bysetpos"],
    ["FREQ=YEARLY;BYMONTH=3,6,9,12;BYDAY=SU;BYSETPOS=-1;COUNT=8", "part-bysetpos"],
    ["FREQ=DAILY;BYHOUR=9,17", "part-byhour"],
    ["FREQ=YEARLY;BYMONTH=3,6", "bymonth"],
    ["FREQ=WEEKLY;BYDAY=2MO", "weekly-parts"],
    ["FREQ=MONTHLY;BYDAY=MO", "byday"],
    ["FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=3", "monthly-parts"],
    ["FREQ=HOURLY;COUNT=3", "frequency"],
    ["FREQ=DAILY;COUNT=3;UNTIL=20261231", "count-and-until"],
    ["FREQ=DAILY;RSCALE=HEBREW", "part-rscale"],
    ["FREQ=DAILY;INTERVAL=0", "interval"],
    ["FREQ=MONTHLY;BYMONTHDAY=-1", "bymonthday"],
    ["FREQ=DAILY;X-FOO=1", "part-x-foo"],
    ["FREQ=DAILY;COUNT=2;COUNT=3", "duplicate-part"],
    ["INTERVAL=2", "unparsable"],
  ];
  for (const [r, reason] of customs) {
    const res = parseRule(r, PARIS);
    assert.equal(res.custom, true, r);
    assert.equal(res.reason, reason, r);
    assert.equal(res.raw, r);
  }
});

test("UNTIL follows the DTSTART value type and an untouched UNTIL is re-emitted as it was", () => {
  const st = ok("FREQ=DAILY;UNTIL=20261231T225959Z");
  assert.equal(st.end.type, "until");
  assert.equal(st.end.date, "2026-12-31");
  assert.equal(buildRule(st, PARIS), "FREQ=DAILY;UNTIL=20261231T225959Z");
  // an UNTIL that is the START of the last occurrence (what many clients write) is kept
  const odd = ok("FREQ=DAILY;UNTIL=20260403T080000Z");
  assert.equal(buildRule(odd, PARIS), "FREQ=DAILY;UNTIL=20260403T080000Z");
  // a changed date is typed from scratch
  const changed = { ...odd, end: { ...odd.end, date: "2026-05-01" } };
  assert.equal(buildRule(changed, PARIS), "FREQ=DAILY;UNTIL=20260501T215959Z");
  assert.equal(buildRule(changed, ALLDAY), "FREQ=DAILY;UNTIL=20260501");
  assert.equal(buildRule(changed, { kind: "utc", iso: "2026-03-23T10:00:00" }), "FREQ=DAILY;UNTIL=20260501T235959Z");
  assert.equal(buildRule(changed, { kind: "floating", iso: "2026-03-23T10:00:00" }), "FREQ=DAILY;UNTIL=20260501T235959");
  // an all-day series with a sloppy date-time UNTIL is still editable
  const sloppy = ok("FREQ=WEEKLY;UNTIL=20260501T000000Z", ALLDAY);
  assert.equal(sloppy.end.date, "2026-05-01");
});

test("validateState / buildRule refuse nonsense", () => {
  const st = defaultState(PARIS, "WEEKLY");
  assert.deepEqual(validateState(st, PARIS), []);
  assert.throws(() => buildRule({ ...st, interval: 0 }, PARIS), /interval/);
  assert.throws(() => buildRule({ ...st, end: { type: "count", count: 0 } }, PARIS), /count/);
  assert.throws(() => buildRule({ ...st, end: { type: "until", date: "2026-02-30" } }, PARIS), /until/);
  assert.equal(validateState({ ...st, end: { type: "until", date: "2026-03-01" } }, PARIS)[0].code, "until-before-start");
});

test("defaultState / withFreq fill the parts from the start date", () => {
  const w = defaultState(PARIS, "WEEKLY");
  assert.equal(buildRule(w, PARIS), "FREQ=WEEKLY;BYDAY=MO");
  const m = withFreq(w, "MONTHLY", PARIS);
  assert.equal(buildRule(m, PARIS), "FREQ=MONTHLY;BYMONTHDAY=23");
  assert.equal(buildRule(withMonthlyMode(m, "nth", PARIS), PARIS), "FREQ=MONTHLY;BYDAY=4MO");
  const y = withFreq(w, "YEARLY", PARIS);
  assert.equal(buildRule(y, PARIS), "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=23");
  assert.equal(buildRule(withMonthlyMode(y, "nth", PARIS), PARIS), "FREQ=YEARLY;BYMONTH=3;BYDAY=4MO");
  assert.equal(buildRule(withFreq(w, "DAILY", PARIS), PARIS), "FREQ=DAILY");
  assert.deepEqual(nthOf("2026-03-31"), { n: 5, weekday: "TU", last: true });
  assert.deepEqual(nthOf("2026-03-02"), { n: 1, weekday: "MO", last: false });
});

test("every RRULE of the fixture corpus either round-trips exactly or is custom", () => {
  let seen = 0;
  let editable = 0;
  let custom = 0;
  for (const f of fixtures().filter((x) => x.name.startsWith("ics/"))) {
    let roots;
    try {
      roots = parse(f.text);
    } catch {
      continue;
    }
    const walk = (c, out) => {
      for (const n of c.components) {
        if (n.key === "VEVENT" || n.key === "VTODO") out.push(n);
        else if (n.key !== "VTIMEZONE") walk(n, out);
      }
      return out;
    };
    const zones = createZones(roots[0]);
    for (const comp of walk(roots[0], [])) {
      const rr = comp.prop("RRULE");
      const ds = comp.prop("DTSTART");
      if (!rr || !ds) continue;
      const tz = ds.paramValues("TZID")[0];
      const value = ds.value.trim();
      const spec = /^\d{8}$/.test(value)
        ? { kind: "date", iso: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` }
        : { kind: value.endsWith("Z") ? "utc" : tz ? "zoned" : "floating", iso: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`, ...(tz ? { tzid: tz } : {}) };
      const res = parseRule(rr.value, spec, { zones });
      seen++;
      if (res.custom) {
        custom++;
        assert.equal(res.raw, rr.value.trim());
      } else {
        editable++;
        assert.ok(sameRule(buildRule(res.state, spec, { zones }), rr.value), `${f.name}: ${rr.value}`);
      }
    }
  }
  assert.ok(seen >= 15, `corpus has RRULEs (${seen})`);
  assert.ok(editable > 0 && custom > 0, `editable ${editable}, custom ${custom}`);
});
