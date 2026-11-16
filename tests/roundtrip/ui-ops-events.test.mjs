// SPDX-License-Identifier: AGPL-3.0-or-later
// Event operations against a throwaway Radicale (tests/roundtrip/run.sh starts one): everything the calendar screens
// will do, driven through the same modules (calendar/formmodel.js, calendar/scope.js, store/writes.js with its
// verification), PUT to and read back from a REAL server. Node only, no browser.
//
//   (1) GATE S13-lite (RUN3 D-R3-6, addendum M6; informative since WP B5, see below): for each zone of the list and the runner's zone, events PUT with a
//       bare TZID (Radicale adds the VTIMEZONE), then GET, open, and the instant the app derives from the SERVED
//       VTIMEZONE (the embedded path of icalview.js) must equal an independent Intl reference; the same for a
//       2024-2040 matrix of wall times (gaps, overlaps, quarter hours around every transition) against that zone,
//       and for two 10-year weekly series (Sunday 02:30 and 00:30) compared occurrence by occurrence;
//   (2) form no-op: an untouched event form gives `{}`, a `noop` plan and NO request, for the whole event corpus;
//   (3) every single-field form edit through store/writes.js `applyOps`: PUT -> GET -> a semantic diff limited to
//       the edited property, the write verification passes, the served text re-opens as a stable form;
//   (4) every scope operation on a series with exceptions (this / all / following, delete this / following,
//       restore, split with a changed tail, `shiftExceptions` across DST incl. UTC-written EXDATEs, a date-time
//       UNTIL, the all-day refusal, the rule-change question), checked as the exact lines that changed and as the
//       expanded occurrences before and after.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fromItem, toPatch, withAllDay } from "../../src/js/calendar/formmodel.js";
import { planDelete, planEdit } from "../../src/js/calendar/scope.js";
import { openItem } from "../../src/js/model/item.js";
import { FIXTURES, SKIP, loadFixtures } from "./lib.mjs";
import { calOf, countingEnv, delta, entriesOf, makeWrites, newCalendar, putServed, touched } from "./evlib.mjs";
import { GATE_ZONES, HOUR, MIN, intlOffset, matrixWalls, refInstant, runnerZone, transitions } from "./tzgate.mjs";

const env = SKIP ? null : countingEnv();
const writes = SKIP ? null : makeWrites(env);
const it = (name, fn) => test(name, { skip: SKIP }, fn);
const fx = (name) => readFileSync(path.join(FIXTURES, "ics", name), "utf8");
const clone = (v) => JSON.parse(JSON.stringify(v));
const PARIS = "Europe/Paris";
const zoned = (iso, tzid = PARIS) => ({ kind: "zoned", iso, tzid });
const compact = (iso) => iso.replace(/[-:]/g, "").slice(0, 15);
const crlf = (lines) => lines.join("\r\n") + "\r\n";

// ---------------------------------------------------------------------------
// (1) the gate

const gateZones = [...new Set([...GATE_ZONES, runnerZone()])];

/** 40 wall times of one zone: around the transitions of five years, then generic ones. */
function eventWalls(off) {
  const all = matrixWalls(off);
  const trs = transitions(off, 2024, 2040).filter((t) => [2024, 2026, 2029, 2034, 2040].includes(new Date(t.instant).getUTCFullYear()));
  const picked = [];
  for (const tr of trs) for (const k of [-2, 0, 2]) picked.push(tr.instant + tr.from + k * 15 * MIN, tr.instant + tr.to + k * 15 * MIN);
  const generic = all.filter((c) => c.why.startsWith("generic")).map((c) => c.wallMs);
  const out = [...new Set(picked)].slice(0, 40);
  for (const g of generic) if (out.length < 40) out.push(g);
  return out.map((ms) => new Date(ms).toISOString().slice(0, 19));
}

const eventText = (uid, tz, startIso, endIso, rrule = "") =>
  crlf(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example Corp//Calendar 1.0//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;TZID=${tz}:${compact(startIso)}`, `DTEND;TZID=${tz}:${compact(endIso)}`, ...(rrule ? [`RRULE:${rrule}`] : []), "SUMMARY:Gate event", "END:VEVENT", "END:VCALENDAR"]);

for (const zone of gateZones) {
  it(`GATE S13-lite, ${zone}${zone === runnerZone() ? " (runner zone)" : ""}: the app's instants from the served VTIMEZONE equal Intl`, async (t) => {
    const off = intlOffset(zone);
    const col = await newCalendar(env, "tz");
    const failures = [];
    const note = (kind, msg) => failures.push(`${kind}: ${msg}`);
    const stamp = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";
    let firstServed = null;
    let classes = new Set();

    // (a) one event per wall time, as the app would store it and read it back
    const walls = eventWalls(off);
    for (const [i, iso] of walls.entries()) {
      const wall = Date.parse(iso + "Z");
      const href = `${col}e${i}.ics`;
      await env.client.putItem(href, eventText(`gate-${i}@example.org`, zone, iso, new Date(wall + HOUR).toISOString()), { create: true });
      const served = await env.client.getItem(href);
      if (!firstServed) firstServed = served.text;
      const item = openItem(served.text, "event");
      if (!item.ok || item.readOnly) {
        note("event", `${iso} not editable (${item.reason || item.readOnlyReason})`);
        continue;
      }
      const start = item.eventModel().start;
      classes.add(start.tzClass);
      const want = refInstant(off, wall);
      if (start.instant !== want) note("event", `${iso} wall: app ${stamp(start.instant)} vs Intl ${stamp(want)}`);
    }
    const first = openItem(firstServed, "event");
    const zn = first.zones.get(zone);
    assert.ok(zn, "the zone resolves");
    const klass = zn.tzClass;
    if (zone === "UTC") assert.ok(klass === "embedded" || klass === "intl", klass);
    else if (klass !== "embedded") note("class", `${klass} instead of embedded (the server added no usable VTIMEZONE)`);

    // (b) the 2024-2040 matrix against the zone of the first served item
    const matrix = matrixWalls(off);
    let matrixBad = 0;
    for (const c of matrix) {
      const want = refInstant(off, c.wallMs);
      const got = zn.instantFromWall(c.wallMs);
      if (got !== want) {
        matrixBad++;
        if (matrixBad <= 3) note("matrix", `${c.iso} (${c.why}): app ${stamp(got)} vs Intl ${stamp(want)}`);
      }
    }
    if (matrixBad > 3) note("matrix", `... ${matrixBad} of ${matrix.length} wall times differ in all`);

    // (c) two 10-year weekly series, occurrence by occurrence
    let seriesCases = 0;
    for (const [label, time] of [["Sunday 02:30", "T023000"], ["Sunday 00:30", "T003000"]]) {
      const iso = `2026-01-04T${time.slice(1, 3)}:${time.slice(3, 5)}:00`;
      const href = `${col}series-${time}.ics`;
      await env.client.putItem(href, eventText(`gate-series-${time}@example.org`, zone, iso, new Date(Date.parse(iso + "Z") + HOUR).toISOString(), "FREQ=WEEKLY;COUNT=520"), { create: true });
      const served = await env.client.getItem(href);
      const item = openItem(served.text, "event");
      if (!item.ok || item.readOnly) {
        note("series", `${label} not editable`);
        continue;
      }
      const { occurrences, truncated } = item.expand({ limit: 2000 });
      if (truncated || occurrences.length !== 520) note("series", `${label}: ${occurrences.length} occurrences instead of 520`);
      let bad = 0;
      occurrences.forEach((o, n) => {
        seriesCases++;
        const wall = Date.parse(iso + "Z") + n * 7 * 86400000;
        if (o.start.wallMs !== wall) {
          bad++;
          if (bad <= 3) note("series", `${label} #${n}: wall ${stamp(o.start.wallMs)} instead of ${stamp(wall)}`);
        } else if (o.start.instant !== refInstant(off, wall)) {
          bad++;
          if (bad <= 3) note("series", `${label} #${n} ${stamp(wall)}: app ${stamp(o.start.instant)} vs Intl ${stamp(refInstant(off, wall))}`);
        }
      });
      if (bad > 3) note("series", `${label}: ${bad} of ${occurrences.length} occurrences differ in all`);
    }
    t.diagnostic(`${zone}: class ${[...classes].join(",")}, ${walls.length} events, ${matrix.length} matrix walls, ${seriesCases} series occurrences, ${failures.length} problems`);
    // WP B5: RadUI no longer relies on the VTIMEZONE the server generates (events carry their own, see
    // tzgate-own.test.mjs). What the server generates depends on the process: Radicale keeps ONE tzinfo per TZID for its
    // whole life (the first one it sees, from a pytz zone or from ANY client's VTIMEZONE), so this reference gate is
    // informative; RADUI_TZGATE_SERVER_STRICT=1 makes it fail again.
    if (process.env.RADUI_TZGATE_SERVER_STRICT === "1") assert.deepEqual(failures, [], `${zone} does not match Intl`);
    else for (const f of failures.slice(0, 2)) t.diagnostic(`server-generated VTIMEZONE differs from Intl (not relied on): ${f}`);
  });
}

// ---------------------------------------------------------------------------
// (2) the form no-op over the event corpus

const eventFixtures = loadFixtures().filter((f) => f.name.startsWith("ics/") && f.meta.kind === "event");
const editable = eventFixtures.filter((f) => {
  const p = openItem(f.text, "event");
  return p.ok && !p.readOnly;
});

for (const f of editable) {
  it(`event form no-op sends nothing: ${f.name}`, async () => {
    const col = await newCalendar(env, "n");
    const { served } = await putServed(env, col, f.text);
    const item = openItem(served.text, "event");
    assert.ok(item.ok && !item.readOnly, "the served text opens editable");
    const { occurrences } = item.expand({ limit: 4 });
    const targets = [null, ...occurrences.slice(0, 3)];
    const mark = env.mark();
    for (const occ of targets) {
      const base = fromItem(item, occ);
      assert.deepEqual(toPatch(base, clone(base), { zones: item.zones }), {}, `patch for ${occ ? occ.start.iso : "master"}`);
      const typed = clone(base);
      typed.description = String(typed.description).replace(/\r\n?/g, "\n"); // as typed into a textarea
      assert.deepEqual(toPatch(base, typed, { zones: item.zones }), {}, "textarea-normalised values change nothing");
      for (const scope of ["all", "this", "following"]) {
        const plan = planEdit(item, { scope, occ, base, patch: {} });
        assert.equal(plan.ok && plan.action, "noop", `${scope} plan`);
      }
    }
    const plain = openItem(served.text, "event");
    assert.equal(plain.update({}), false);
    assert.equal(plain.save().changed, false, "save without a change is a no-op");
    assert.deepEqual(env.since(mark, "PUT"), [], "no PUT");
  });
}

// ---------------------------------------------------------------------------
// (3) every single-field form edit through applyOps

const bumpDate = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
const FORM_EDITS = [
  { field: "summary", props: ["SUMMARY"], apply: (v) => void (v.summary = "Edited, title; with \\ backslash") },
  { field: "location", props: ["LOCATION"], apply: (v) => void (v.location = "Edited, room; 4") },
  { field: "description", props: ["DESCRIPTION"], apply: (v) => void (v.description = "Line one\nLine two, with; separators") },
  { field: "url", props: ["URL"], apply: (v) => void (v.url = "https://example.org/edited?a=1&b=2") },
  { field: "categories", props: ["CATEGORIES"], apply: (v) => void (v.categories = [...v.categories, "Edited, one", "two"]) },
  { field: "status", props: ["STATUS"], apply: (v) => void (v.status = v.status === "TENTATIVE" ? "CONFIRMED" : "TENTATIVE") },
  { field: "transp", props: ["TRANSP"], apply: (v) => void (v.transp = v.transp === "TRANSPARENT" ? "OPAQUE" : "TRANSPARENT") },
  { field: "end", props: ["DTEND", "DURATION"], apply: (v) => void (v.endDate = bumpDate(v.endDate, 1)) },
  {
    field: "move",
    props: ["DTSTART", "DTEND", "DURATION"],
    single: true,
    apply: (v) => {
      v.startDate = bumpDate(v.startDate, 1);
      v.endDate = bumpDate(v.endDate, 1);
    },
  },
  { field: "alarm", props: ["ACTION", "TRIGGER", "DESCRIPTION"], alarm: true, apply: (v) => void (v.alarms = [...v.alarms, { seconds: -74040, related: "START" }]) },
];

const skippedEdits = [];
for (const f of editable) {
  it(`one form edit at a time through applyOps, PUT -> GET: ${f.name}`, async (t) => {
    const col = await newCalendar(env, "e");
    const { href, served: first } = await putServed(env, col, f.text);
    const probe = openItem(first.text, "event");
    const series = Boolean(probe.fields().rrule) || probe.overrides.length > 0 || probe.fields().rdates.length > 0;
    const failures = [];
    let ran = 0;
    for (const edit of FORM_EDITS) {
      if (edit.single && series) continue;
      const cur = await env.client.getItem(href);
      if (cur.text !== first.text) await env.client.putItem(href, first.text, { etag: cur.etag });
      const served = await env.client.getItem(href);
      const item = openItem(served.text, "event");
      const base = fromItem(item, null);
      if (edit.alarm && base.alarms.length >= 3) continue;
      const values = clone(base);
      edit.apply(values);
      const patch = toPatch(base, values, { zones: item.zones });
      if (!Object.keys(patch).length) {
        skippedEdits.push(`${f.name}:${edit.field}:empty patch`);
        continue;
      }
      let plan = planEdit(item, { scope: "all", occ: null, base, patch });
      if (plan.needs) plan = planEdit(item, { scope: "all", occ: null, base, patch, exceptions: "keep" });
      if (!plan.ok) {
        failures.push(`${edit.field}: plan refused (${plan.code})`);
        continue;
      }
      const r = await writes.applyOps({ collection: calOf(col), href, base: { text: served.text, etag: served.etag }, ops: plan.ops });
      if (!r.ok || r.status !== "saved") {
        failures.push(`${edit.field}: ${r.status} ${r.message}`);
        continue;
      }
      ran++;
      const back = await env.client.getItem(href);
      const names = touched(served.text, back.text);
      for (const n of names) if (!edit.props.includes(n)) failures.push(`${edit.field}: outside the edit: ${n}`);
      if (!names.length) failures.push(`${edit.field}: no difference`);
      if (r.verified !== true) failures.push(`${edit.field}: verification ${r.verified} ${(r.mismatched || []).join(",")}`);
      const again = openItem(back.text, "event");
      if (!again.ok || again.readOnly) failures.push(`${edit.field}: the served text opens read-only`);
      else {
        const b2 = fromItem(again, null);
        if (Object.keys(toPatch(b2, clone(b2), { zones: again.zones })).length) failures.push(`${edit.field}: form not stable`);
      }
    }
    assert.ok(ran > 0, "at least one edit ran");
    assert.deepEqual(failures, []);
    t.diagnostic(`${ran} edits ran`);
  });
}

it("summary of form edits skipped on purpose", (t) => {
  t.diagnostic(`${skippedEdits.length} skipped: ${skippedEdits.slice(0, 8).join(" | ") || "none"}`);
});

// ---------------------------------------------------------------------------
// (4) scope operations on a series with exceptions

const SERIES = fx("event-series-overrides-exdates.ics");
const SERIES_WALLS = ["2026-03-16T09:30:00", "2026-03-23T14:00:00", "2026-04-06T09:30:00", "2026-04-13T09:30:00", "2026-04-27T09:30:00", "2026-05-04T09:30:00", "2026-05-11T09:30:00", "2026-05-18T09:30:00", "2026-05-25T09:30:00", "2026-06-01T09:30:00"];

async function scene(text = SERIES) {
  const col = await newCalendar(env, "s");
  const { href, served } = await putServed(env, col, text, "series");
  return { col, href, served, coll: calOf(col) };
}
const occurrencesOf = (text) => {
  const item = openItem(text, "event");
  assert.ok(item.ok, item.reason);
  return item.expand({ limit: 5000 }).occurrences;
};
const sig = (o) => `${o.start.iso}${o.end ? ">" + o.end.iso : ""} ${o.source} ${o.component.prop("SUMMARY") ? o.component.prop("SUMMARY").value : ""}`;
const starts = (text) => occurrencesOf(text).map((o) => o.start.iso);
const occAt = (item, iso) => {
  const o = item.expand({ limit: 5000 }).occurrences.find((x) => x.start.iso === iso);
  assert.ok(o, `occurrence ${iso} exists`);
  return o;
};
const lines = (text) => text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter(Boolean);
const rruleOf = (text) => {
  const all = lines(text);
  const l = all.slice(all.indexOf("BEGIN:VEVENT")).find((x) => x.startsWith("RRULE:")); // not the VTIMEZONE's rules
  return l ? Object.fromEntries(l.slice(6).split(";").map((p) => p.split("="))) : null;
};

/** form patch for `occ` (or the master) from a change of the form values */
function formPatch(item, occ, change) {
  const base = fromItem(item, occ);
  const values = clone(base);
  change(values, base);
  return { base, values, patch: toPatch(base, values, { zones: item.zones }) };
}
const ok = (r) => {
  assert.equal(r.ok, true, `${r.status} ${r.message}`);
  assert.equal(r.verified, true, `verified ${r.verified} ${(r.mismatched || []).join(",")}`);
};

it("the fixture is what the tests below assume: 10 occurrences, two overrides, two EXDATEs", async () => {
  const s = await scene();
  assert.deepEqual(starts(s.served.text), SERIES_WALLS);
  const item = openItem(s.served.text, "event");
  assert.equal(item.overrides.length, 2);
  assert.equal(item.exceptions().length, 4);
});

it("scope this: an override is created; nothing is removed; the master is untouched", async () => {
  const s = await scene();
  const item = openItem(s.served.text, "event");
  const occ = occAt(item, "2026-04-13T09:30:00");
  const { base, patch } = formPatch(item, occ, (v) => void (v.summary = "Only this one"));
  const plan = planEdit(item, { scope: "this", occ, base, patch });
  assert.equal(plan.ok, true);
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: s.served, ops: plan.ops }));
  const back = await env.client.getItem(s.href);
  const d = delta(s.served.text, back.text);
  assert.deepEqual(d.removed, []);
  assert.ok(d.added.length >= 4 && d.added.every((l) => l.startsWith("VEVENT[20260413T093000] |")), d.added.join("\n"));
  assert.ok(d.added.includes("VEVENT[20260413T093000] | SUMMARY:Only this one"));
  assert.deepEqual(starts(back.text), SERIES_WALLS);
  assert.equal(occurrencesOf(back.text).find((o) => o.start.iso === "2026-04-13T09:30:00").source, "override");
  // a moved occurrence
  const item2 = openItem(back.text, "event");
  const occ2 = occAt(item2, "2026-04-27T09:30:00");
  const mv = formPatch(item2, occ2, (v) => {
    v.startTime = "16:00";
    v.endTime = "17:00";
  });
  const plan2 = planEdit(item2, { scope: "this", occ: occ2, base: mv.base, patch: mv.patch });
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: back, ops: plan2.ops }));
  const back2 = await env.client.getItem(s.href);
  assert.ok(starts(back2.text).includes("2026-04-27T16:00:00"));
  assert.ok(!starts(back2.text).includes("2026-04-27T09:30:00"));
  assert.ok(delta(back.text, back2.text).added.includes("VEVENT[20260427T093000] | DTSTART;TZID=Europe/Paris:20260427T160000"));
});

it("scope all: a title change patches the master only; overrides keep their own text", async () => {
  const s = await scene();
  const item = openItem(s.served.text, "event");
  const { base, patch } = formPatch(item, null, (v) => void (v.summary = "Renamed review"));
  const plan = planEdit(item, { scope: "all", occ: null, base, patch });
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: s.served, ops: plan.ops }));
  const back = await env.client.getItem(s.href);
  assert.deepEqual(delta(s.served.text, back.text), { removed: ["VEVENT[] | SUMMARY:Weekly review"], added: ["VEVENT[] | SUMMARY:Renamed review"] });
  const text = occurrencesOf(back.text).map((o) => o.component.prop("SUMMARY").value);
  assert.equal(text.filter((x) => x === "Renamed review").length, 8, "the 8 occurrences that follow the master");
  assert.ok(text.includes("Weekly review (moved)") && text.includes("Weekly review (special topic)"));
});

it("delete this (EXDATE) and restore it (removeExdate)", async () => {
  const s = await scene();
  const item = openItem(s.served.text, "event");
  const occ = occAt(item, "2026-04-13T09:30:00");
  const plan = planDelete(item, { scope: "this", occ });
  assert.equal(plan.ok, true);
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: s.served, ops: plan.ops }));
  const back = await env.client.getItem(s.href);
  const d = delta(s.served.text, back.text);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added, ["VEVENT[] | EXDATE;TZID=Europe/Paris:20260413T093000"]);
  assert.deepEqual(starts(back.text), SERIES_WALLS.filter((w) => w !== "2026-04-13T09:30:00"));
  // the restore of an EXDATE that was in the fixture
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: back, ops: [{ type: "removeExdate", rid: zoned("2026-04-13T09:30:00") }] }));
  const back2 = await env.client.getItem(s.href);
  assert.deepEqual(starts(back2.text), SERIES_WALLS);
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: back2, ops: [{ type: "removeExdate", rid: zoned("2026-03-30T09:30:00") }] }));
  const back3 = await env.client.getItem(s.href);
  assert.deepEqual(delta(back2.text, back3.text).added, []);
  assert.ok(starts(back3.text).includes("2026-03-30T09:30:00"));
});

it("delete this and following (truncate) with COUNT: the rule becomes UNTIL, later EXDATEs and overrides go", async () => {
  const s = await scene();
  const item = openItem(s.served.text, "event");
  const occ = occAt(item, "2026-04-27T09:30:00");
  const plan = planDelete(item, { scope: "following", occ });
  assert.deepEqual(plan.ops, [{ type: "truncate", rid: zoned("2026-04-27T09:30:00") }]);
  const mark = env.mark();
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: s.served, ops: plan.ops }));
  assert.equal(env.since(mark, "PUT").length, 1, "one PUT");
  const back = await env.client.getItem(s.href);
  const rr = rruleOf(back.text);
  assert.equal(rr.COUNT, undefined);
  assert.ok(rr.UNTIL, "UNTIL instead of COUNT");
  assert.deepEqual(starts(back.text), ["2026-03-16T09:30:00", "2026-03-23T14:00:00", "2026-04-06T09:30:00", "2026-04-13T09:30:00"]);
  // truncating at an override removes the later EXDATEs and the later override
  const t2 = await scene();
  const item2 = openItem(t2.served.text, "event");
  const plan2 = planDelete(item2, { scope: "following", occ: occAt(item2, "2026-03-23T14:00:00") });
  ok(await writes.applyOps({ collection: t2.coll, href: t2.href, base: t2.served, ops: plan2.ops }));
  const back2 = await env.client.getItem(t2.href);
  assert.deepEqual(starts(back2.text), ["2026-03-16T09:30:00"]);
  const open2 = openItem(back2.text, "event");
  assert.equal(open2.overrides.length, 0);
  assert.equal(open2.exceptions().length, 0);
  // a plain COUNT series
  const col = await newCalendar(env, "c");
  const { href, served } = await putServed(env, col, fx("event-rrule-count-weekly.ics"));
  const it3 = openItem(served.text, "event");
  const fifth = it3.expand({ limit: 50 }).occurrences[4];
  const p3 = planDelete(it3, { scope: "following", occ: fifth });
  ok(await writes.applyOps({ collection: calOf(col), href, base: served, ops: p3.ops }));
  const b3 = await env.client.getItem(href);
  assert.equal(occurrencesOf(b3.text).length, 4);
  assert.equal(rruleOf(b3.text).COUNT, undefined);
});

const keyOf = (o) => `${o.start.instant}|${o.end.instant}|${o.component.prop("SUMMARY").value}`;

it("scope following: the original is cut, the tail is a new resource, together they are the series", async () => {
  const s = await scene();
  const before = occurrencesOf(s.served.text).map(keyOf).sort();
  const mark = env.mark();
  const r = await writes.splitWrite({ collection: s.coll, href: s.href, base: s.served, rid: zoned("2026-04-13T09:30:00"), tailFields: {} });
  ok(r);
  assert.equal(env.since(mark, "PUT").length, 2, "the tail, then the original");
  const all = await entriesOf(env, s.col);
  assert.equal(all.length, 2);
  const head = all.find((e) => e.href === s.href);
  const tail = all.find((e) => e.href !== s.href);
  assert.equal(tail.href, r.tailHref);
  assert.notEqual(openItem(tail.text, "event").uid, openItem(head.text, "event").uid, "the tail has its own UID");
  assert.deepEqual(starts(head.text), ["2026-03-16T09:30:00", "2026-03-23T14:00:00", "2026-04-06T09:30:00"]);
  assert.deepEqual(starts(tail.text), ["2026-04-13T09:30:00", "2026-04-27T09:30:00", "2026-05-04T09:30:00", "2026-05-11T09:30:00", "2026-05-18T09:30:00", "2026-05-25T09:30:00", "2026-06-01T09:30:00"]);
  assert.deepEqual([...occurrencesOf(head.text), ...occurrencesOf(tail.text)].map(keyOf).sort(), before, "head and tail are the original series");
  // the head keeps its exceptions, the tail takes the later ones
  assert.deepEqual(openItem(head.text, "event").exceptions().map((e) => `${e.type}:${e.spec.iso}`).sort(), ["exdate:2026-03-30T09:30:00", "override:2026-03-23T09:30:00", "override:2026-04-06T09:30:00"]);
  assert.deepEqual(openItem(tail.text, "event").exceptions().map((e) => `${e.type}:${e.spec.iso}`), ["exdate:2026-04-20T09:30:00"]);
  assert.equal(rruleOf(head.text).COUNT, undefined);
  assert.equal(rruleOf(tail.text).COUNT, "8", "the tail carries the remaining count");
  // the semantic diff of the original: only the rule and the later EXDATE changed
  assert.deepEqual(touched(s.served.text, head.text), ["EXDATE", "RRULE"]);
  // a changed title on the tail only
  const col2 = await newCalendar(env, "s");
  const s2 = await putServed(env, col2, SERIES, "series");
  const r2 = await writes.splitWrite({ collection: calOf(col2), href: s2.href, base: s2.served, rid: zoned("2026-04-13T09:30:00"), tailFields: { summary: "Tail title" } });
  ok(r2);
  const all2 = await entriesOf(env, col2);
  const tail2 = all2.find((e) => e.href !== s2.href);
  assert.deepEqual([...new Set(occurrencesOf(tail2.text).filter((o) => o.source === "series").map((o) => o.component.prop("SUMMARY").value))], ["Tail title"]);
  assert.equal(occurrencesOf(all2.find((e) => e.href === s2.href).text).find((o) => o.source === "series").component.prop("SUMMARY").value, "Weekly review");
});

it("scope following with a moved start (addendum M1): the tail's EXDATE and override follow, an untouched head does not", async () => {
  const s = await scene();
  // an override on 27 April, then the split of 13 April with the tail one hour later
  const item = openItem(s.served.text, "event");
  const occ = occAt(item, "2026-04-27T09:30:00");
  const f = formPatch(item, occ, (v) => void (v.summary = "Special topic"));
  const p1 = planEdit(item, { scope: "this", occ, base: f.base, patch: f.patch });
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: s.served, ops: p1.ops }));
  const base1 = await env.client.getItem(s.href);
  const before = occurrencesOf(base1.text);
  const it2 = openItem(base1.text, "event");
  const occ2 = occAt(it2, "2026-04-13T09:30:00");
  const f2 = formPatch(it2, occ2, (v) => {
    v.startTime = "10:30";
    v.endTime = "11:30";
  });
  const plan = planEdit(it2, { scope: "following", occ: occ2, base: f2.base, patch: f2.patch });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.action, "split");
  const r = await writes.splitWrite({ collection: s.coll, href: s.href, base: base1, rid: plan.rid, tailFields: plan.tailFields, exceptions: plan.tailExceptions });
  ok(r);
  const all = await entriesOf(env, s.col);
  const head = all.find((e) => e.href === s.href);
  const tail = all.find((e) => e.href !== s.href);
  assert.deepEqual(starts(tail.text), ["2026-04-13T10:30:00", "2026-04-27T10:30:00", "2026-05-04T10:30:00", "2026-05-11T10:30:00", "2026-05-18T10:30:00", "2026-05-25T10:30:00", "2026-06-01T10:30:00"]);
  const ts = occurrencesOf(tail.text);
  assert.equal(ts.find((o) => o.start.iso === "2026-04-27T10:30:00").source, "override");
  assert.equal(ts.find((o) => o.start.iso === "2026-04-27T10:30:00").component.prop("SUMMARY").value, "Special topic");
  assert.ok(!starts(tail.text).some((x) => x.startsWith("2026-04-20")), "the deleted 20 April stays deleted, one hour later");
  assert.ok(lines(tail.text).includes("EXDATE;TZID=Europe/Paris:20260420T103000"));
  assert.deepEqual(starts(head.text), before.map((o) => o.start.iso).filter((x) => x < "2026-04-13"));
  // instants: every tail occurrence is exactly one hour later than in the original
  const orig = new Map(before.map((o) => [o.start.iso.slice(0, 10), o.start.instant]));
  for (const o of ts) assert.equal(o.start.instant, orig.get(o.start.iso.slice(0, 10)) + HOUR, o.start.iso);
});

it("scope all with a moved start across DST: EXDATEs and override ids follow by the same wall delta, in their own form (m6)", async () => {
  // one EXDATE written in UTC (09:30 CEST = 07:30Z on 20 April)
  const mixed = SERIES.replace("EXDATE;TZID=Europe/Paris:20260420T093000", "EXDATE:20260420T073000Z");
  assert.notEqual(mixed, SERIES);
  const s = await scene(mixed);
  const before = occurrencesOf(s.served.text);
  assert.equal(before.length, 10);
  const item = openItem(s.served.text, "event");
  const { base, patch } = formPatch(item, null, (v) => {
    v.startTime = "10:30";
    v.endTime = "11:30";
  });
  const plan = planEdit(item, { scope: "all", occ: null, base, patch });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.ops[0].type, "shiftExceptions");
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: s.served, ops: plan.ops }));
  const back = await env.client.getItem(s.href);
  const l = lines(back.text);
  assert.ok(l.includes("EXDATE;TZID=Europe/Paris:20260330T103000"), "TZID form shifted as wall clock");
  assert.ok(l.includes("EXDATE:20260420T083000Z"), "UTC form shifted through the instant and kept in UTC");
  assert.ok(l.includes("RECURRENCE-ID;TZID=Europe/Paris:20260323T103000"));
  assert.ok(l.includes("RECURRENCE-ID;TZID=Europe/Paris:20260406T103000"));
  const after = occurrencesOf(back.text);
  assert.equal(after.length, 10, "no occurrence appeared or vanished");
  const byDay = new Map(before.map((o) => [o.start.iso.slice(0, 10), o]));
  for (const o of after) {
    const was = byDay.get(o.start.iso.slice(0, 10));
    assert.ok(was, `${o.start.iso} existed before`);
    if (o.start.iso.startsWith("2026-03-23")) assert.equal(o.start.iso, "2026-03-23T14:00:00", "the override the user had moved keeps its own time");
    else assert.equal(o.start.iso.slice(11), "10:30:00", o.start.iso);
    if (o.source === "series" || (o.source === "override" && o.start.iso.slice(0, 10) !== "2026-03-23")) assert.equal(o.start.instant, was.start.instant + HOUR, `${o.start.iso} is exactly one hour later (DST included)`);
  }
});

it("scope all with a moved start and a date-time UNTIL (addendum M2): the occurrence count does not change", async () => {
  const untilText = SERIES.replace("RRULE:FREQ=WEEKLY;COUNT=12;BYDAY=MO", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601T073000Z");
  assert.notEqual(untilText, SERIES);
  const s = await scene(untilText);
  const n = occurrencesOf(s.served.text).length;
  assert.equal(n, 10);
  const item = openItem(s.served.text, "event");
  const { base, patch } = formPatch(item, null, (v) => {
    v.startTime = "10:30";
    v.endTime = "11:30";
  });
  const plan = planEdit(item, { scope: "all", occ: null, base, patch });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  ok(await writes.applyOps({ collection: s.coll, href: s.href, base: s.served, ops: plan.ops }));
  const back = await env.client.getItem(s.href);
  assert.equal(rruleOf(back.text).UNTIL, "20260601T083000Z", "UNTIL moved by the same hour");
  assert.equal(occurrencesOf(back.text).length, n);
  // the tail of a split with a moved start
  const col = await newCalendar(env, "u");
  const s2 = await putServed(env, col, untilText, "series");
  const total = occurrencesOf(s2.served.text);
  const r = await writes.splitWrite({ collection: calOf(col), href: s2.href, base: s2.served, rid: zoned("2026-04-13T09:30:00"), tailFields: { start: zoned("2026-04-13T10:30:00"), end: zoned("2026-04-13T11:30:00") } });
  ok(r);
  const all = await entriesOf(env, col);
  const tail = all.find((e) => e.href !== s2.href);
  const head = all.find((e) => e.href === s2.href);
  assert.equal(rruleOf(tail.text).UNTIL, "20260601T083000Z");
  assert.equal(occurrencesOf(head.text).length + occurrencesOf(tail.text).length, total.length);
});

it("the all-day <-> timed toggle with exceptions is refused, and no request is sent; a rule change asks about the exceptions (M3)", async () => {
  const s = await scene();
  const item = openItem(s.served.text, "event");
  const mark = env.mark();
  const toAllDay = formPatch(item, null, (v, base) => Object.assign(v, withAllDay(base, true)));
  const plan = planEdit(item, { scope: "all", occ: null, base: toAllDay.base, patch: toAllDay.patch });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "allday-toggle-with-exceptions");
  // a rule change that makes every exception an orphan: no default to Keep; "remove orphans" removes them
  const f = { base: fromItem(item, null), patch: { rrule: "FREQ=WEEKLY;COUNT=12;BYDAY=TU" } };
  const ask = planEdit(item, { scope: "all", occ: null, base: f.base, patch: f.patch });
  if (ask.needs) {
    assert.equal(ask.needs, "exceptions");
    assert.equal(ask.defaultChoice, null, "no default to Keep when something would no longer be shown");
    assert.ok(ask.orphans.length > 0);
    const go = planEdit(item, { scope: "all", occ: null, base: f.base, patch: f.patch, exceptions: "remove-orphans" });
    assert.equal(go.ok, true);
    ok(await writes.applyOps({ collection: s.coll, href: s.href, base: s.served, ops: go.ops }));
    const back = await env.client.getItem(s.href);
    const reopened = openItem(back.text, "event");
    assert.deepEqual(reopened.orphanedExceptions(), [], "nothing is left that the rule no longer produces");
  } else {
    assert.fail(`expected a question about the exceptions, got ${JSON.stringify(ask)}`);
  }
  assert.equal(env.since(mark, "PUT").length, 1, "only the confirmed write was sent");
});

it("a custom rule is kept as is by every other edit; a two-zone event keeps both TZIDs", async () => {
  const col = await newCalendar(env, "k");
  const a = await putServed(env, col, fx("event-custom-rrule.ics"), "custom");
  const item = openItem(a.served.text, "event");
  const base = fromItem(item, null);
  assert.equal(base.rule.mode, "custom");
  const f = formPatch(item, null, (v) => void (v.summary = "Renamed custom"));
  assert.equal("rrule" in f.patch, false, "an untouched custom rule is not in the patch");
  const plan = planEdit(item, { scope: "all", occ: null, base: f.base, patch: f.patch });
  ok(await writes.applyOps({ collection: calOf(col), href: a.href, base: a.served, ops: plan.ops }));
  const back = await env.client.getItem(a.href);
  assert.deepEqual(touched(a.served.text, back.text), ["SUMMARY"]);
  assert.deepEqual(rruleOf(back.text), rruleOf(a.served.text));

  const z = await putServed(env, col, fx("event-two-zones.ics"), "twozones");
  const zi = openItem(z.served.text, "event");
  assert.deepEqual(Object.fromEntries(Object.entries(zi.tz)), { "America/New_York": "embedded", "Asia/Tokyo": "embedded" }, "the server added the Tokyo VTIMEZONE");
  const g = formPatch(zi, null, (v) => {
    v.summary = "Renamed flight";
    v.endTime = "23:30";
  });
  const p2 = planEdit(zi, { scope: "all", occ: null, base: g.base, patch: g.patch });
  ok(await writes.applyOps({ collection: calOf(col), href: z.href, base: z.served, ops: p2.ops }));
  const b2 = await env.client.getItem(z.href);
  const l = lines(b2.text);
  assert.ok(l.includes("DTSTART;TZID=America/New_York:20260707T080000"), "start zone untouched");
  assert.ok(l.includes("DTEND;TZID=Asia/Tokyo:20260707T233000"), "end zone untouched");
  assert.deepEqual(touched(z.served.text, b2.text), ["DTEND", "SUMMARY"]);
});

// ---------------------------------------------------------------------------
// (5) tasks (RUN3 WP C1, its own block): the task form no-op, one-tap complete / reopen and a field edit, PUT -> GET

import { fromItem as taskFromItem, toPatch as taskToPatch } from "../../src/js/tasks/formmodel.js";

it("tasks: the task form model is a no-op over every todo fixture; complete and reopen change only STATUS, COMPLETED and PERCENT-COMPLETE; an edit only its property", async () => {
  const col = `/${env.user}/tasks${Date.now().toString(36)}/`;
  await env.client.mkcalendar(col, { components: ["VTODO"] });
  const names = ["todo-open", "todo-zoned", "todo-recurring", "todo-related-to-parent", "todo-related-to-child", "todo-due-completed"];
  const put = {};
  for (const n of names) {
    put[n] = await putServed(env, col, fx(`${n}.ics`), n);
    const it0 = openItem(put[n].served.text, "task");
    assert.ok(it0.ok && !it0.readOnly, `${n} opens`);
    const v = taskFromItem(it0);
    assert.deepEqual(taskToPatch(v, v), {}, `${n}: an untouched form gives an empty patch`);
  }
  // complete, then reopen
  const a = put["todo-open"];
  ok(await writes.applyOps({ collection: calOf(col), href: a.href, base: a.served, ops: [{ type: "complete" }] }));
  const done = await env.client.getItem(a.href);
  assert.deepEqual(touched(a.served.text, done.text), ["COMPLETED", "PERCENT-COMPLETE", "STATUS"]);
  assert.ok(lines(done.text).includes("STATUS:COMPLETED"));
  assert.ok(lines(done.text).includes("PERCENT-COMPLETE:100"));
  ok(await writes.applyOps({ collection: calOf(col), href: a.href, base: { text: done.text, etag: done.etag }, ops: [{ type: "reopen" }] }));
  const again = await env.client.getItem(a.href);
  assert.deepEqual(touched(done.text, again.text), ["COMPLETED", "PERCENT-COMPLETE", "STATUS"]);
  assert.deepEqual(touched(a.served.text, again.text), [], "reopen undoes complete");
  // one field of the form
  const z = put["todo-zoned"];
  const zi = openItem(z.served.text, "task");
  const base = taskFromItem(zi);
  const patch = taskToPatch(base, { ...base, priority: "1" });
  assert.deepEqual(patch, { priority: 1 });
  // saveItem(patch) on a calendar is one `patch` operation; sent as applyOps because the test collection object is not registered (saveItem hands on only its href)
  ok(await writes.applyOps({ collection: calOf(col), href: z.href, base: z.served, ops: [{ type: "patch", fields: patch }] }));
  const back = await env.client.getItem(z.href);
  assert.deepEqual(touched(z.served.text, back.text), ["PRIORITY"]);
  assert.ok(lines(back.text).includes("DUE;TZID=America/New_York:20260601T170000"), "the zone of the due time is untouched");
});
