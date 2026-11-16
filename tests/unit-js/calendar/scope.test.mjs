// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { applyOpsToItem, availableScopes, findOccurrence, occParamOf, planDelete, planEdit } from "../../../src/js/calendar/scope.js";
import { fromItem, toPatch, ridSpecOf, withZone } from "../../../src/js/calendar/formmodel.js";
import { openItem } from "../../../src/js/model/item.js";
import { D, fixture } from "../model/helpers.mjs";

const NOW = D("2026-11-12T10:00:00Z");
const PARIS = "Europe/Paris";
const ics = (lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//x//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
const vevent = (lines) => ["BEGIN:VEVENT", "UID:u1", "DTSTAMP:20260101T000000Z", ...lines, "END:VEVENT"];
const open = (text) => {
  const it = openItem(text, "event");
  assert.equal(it.ok, true, it.message);
  return it;
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const starts = (item) => item.expand({}).occurrences.map((o) => (o.start.instant !== null ? new Date(o.start.instant).toISOString().slice(0, 19) + "Z" : o.start.iso));
const props = (text, name) => text.split("\r\n").filter((l) => l.startsWith(name));

// Mondays 16 Mar .. 20 Apr 2026, Paris, with an EXDATE and a moved override
const SERIES = ics([
  ...vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6", "EXDATE;TZID=Europe/Paris:20260323T100000", "SUMMARY:Standup"]),
  ...vevent(["RECURRENCE-ID;TZID=Europe/Paris:20260406T100000", "DTSTART;TZID=Europe/Paris:20260407T150000", "DTEND;TZID=Europe/Paris:20260407T160000", "SUMMARY:Standup (moved)"]),
]);
const plainSeries = (rr = "FREQ=WEEKLY;COUNT=6") => ics(vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", `RRULE:${rr}`, "SUMMARY:S"]));

const occAt = (item, iso) => item.expand({}).occurrences.find((o) => o.start.iso === iso || (o.recurrenceId && o.recurrenceId.iso === iso));
const edit = (item, occ, change) => {
  const base = fromItem(item, occ);
  const values = clone(base);
  change(values);
  return { base, patch: toPatch(base, values, { zones: item.zones }) };
};
const runOps = (text, ops) => {
  const item = open(text);
  applyOpsToItem(item, ops);
  const r = item.save({ now: NOW });
  return r.changed ? r.text : text;
};

test("availableScopes: none for a single event, no 'following' for the first occurrence, only 'all' for a delete of a read-only item", () => {
  const single = open(fixture("event-allday-single.ics"));
  assert.deepEqual(availableScopes(single, single.expand({}).occurrences[0], "edit"), []);
  const item = open(SERIES);
  const first = occAt(item, "2026-03-16T10:00:00");
  const later = occAt(item, "2026-03-30T10:00:00");
  assert.deepEqual(availableScopes(item, first), ["this", "all"]);
  assert.deepEqual(availableScopes(item, later), ["this", "following", "all"]);
  assert.deepEqual(availableScopes(item, null), ["all"]);
  const ro = open(fixture("event-tzid-quoted-unknown.ics"));
  assert.equal(ro.readOnly, true);
  assert.deepEqual(availableScopes(ro, ro.expand({}).occurrences[0], "edit"), []);
});

test("m1: deleting this/following on an unknown-zone series is a rewrite; only the whole delete is offered", () => {
  const ro = open(fixture("event-tzid-quoted-unknown.ics"));
  const occ = ro.expand({}).occurrences[0];
  assert.deepEqual(planDelete(ro, { scope: "all", occ }), { ok: true, action: "delete" });
  if (availableScopes(ro, occ, "delete").length) {
    assert.deepEqual(availableScopes(ro, occ, "delete"), ["all"]);
    assert.equal(planDelete(ro, { scope: "this", occ }).code, "read-only-scope");
    assert.equal(planDelete(ro, { scope: "following", occ }).code, "read-only-scope");
  }
  assert.equal(planEdit(ro, { scope: "all", patch: { summary: "x" } }).code, "read-only");
});

test("scope this: one override op, replayed to the right text; rrule is refused", () => {
  const item = open(SERIES);
  const occ = occAt(item, "2026-03-30T10:00:00");
  const { patch } = edit(item, occ, (v) => (v.summary = "Special"));
  const plan = planEdit(item, { scope: "this", occ, patch });
  assert.equal(plan.action, "ops");
  assert.deepEqual(plan.ops, [{ type: "override", rid: { kind: "zoned", iso: "2026-03-30T10:00:00", tzid: PARIS }, fields: { summary: "Special" } }]);
  const out = runOps(SERIES, JSON.parse(JSON.stringify(plan.ops)));
  assert.match(out, /RECURRENCE-ID;TZID=Europe\/Paris:20260330T100000/);
  assert.equal(planEdit(item, { scope: "this", occ, patch: { rrule: "FREQ=DAILY" } }).code, "rrule-needs-series");
  assert.equal(planEdit(item, { scope: "this", patch }).code, "occurrence-required");
  assert.deepEqual(planEdit(item, { scope: "this", occ, patch: {} }), { ok: true, action: "noop" });
});

test("scope all: a changed start shifts exceptions first (shiftExceptions, then patch) and nothing is orphaned (M3 not asked)", () => {
  const item = open(SERIES);
  const occ = occAt(item, "2026-03-16T10:00:00");
  const { base, patch } = edit(item, occ, (v) => {
    v.startTime = "11:30";
    v.endTime = "12:30";
  });
  const plan = planEdit(item, { scope: "all", occ, base, patch });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.ops.map((o) => o.type), ["shiftExceptions", "patch"]);
  assert.deepEqual(plan.ops[0].fromStart, { kind: "zoned", iso: "2026-03-16T10:00:00", tzid: PARIS });
  assert.deepEqual(plan.ops[0].toStart, { kind: "zoned", iso: "2026-03-16T11:30:00", tzid: PARIS });
  const out = runOps(SERIES, plan.ops);
  const again = open(out);
  assert.equal(again.orphanedExceptions().length, 0);
  assert.ok(out.includes("EXDATE;TZID=Europe/Paris:20260323T113000"));
  assert.ok(out.includes("RECURRENCE-ID;TZID=Europe/Paris:20260406T113000"));
  assert.ok(out.includes("DTSTART;TZID=Europe/Paris:20260407T150000"), "the moved override stays where the user put it");
});

test("scope all from a later occurrence: the form's dates are translated to the master", () => {
  const item = open(plainSeries());
  const occ = occAt(item, "2026-04-06T10:00:00");
  const { base, patch } = edit(item, occ, (v) => {
    v.startTime = "09:00";
    v.endTime = "10:00";
  });
  assert.equal(patch.start.iso, "2026-04-06T09:00:00");
  const plan = planEdit(item, { scope: "all", occ, base, patch });
  assert.equal(plan.ok, true);
  const patchOp = plan.ops.find((o) => o.type === "patch");
  assert.equal(patchOp.fields.start.iso, "2026-03-16T09:00:00", "the master moves, not the 6 April date");
  assert.equal(patchOp.fields.end.iso, "2026-03-16T10:00:00");
  assert.deepEqual(starts(open(runOps(plainSeries(), plan.ops)))[0], "2026-03-16T08:00:00Z");
});

test("M2 through the planner: a series bounded by a UTC UNTIL keeps its occurrence count when the start moves by an hour", () => {
  const text = plainSeries("FREQ=WEEKLY;UNTIL=20260420T080000Z");
  const item = open(text);
  const n = starts(item).length;
  const occ = occAt(item, "2026-03-16T10:00:00");
  const { base, patch } = edit(item, occ, (v) => {
    v.startTime = "11:00";
    v.endTime = "12:00";
  });
  const out = runOps(text, planEdit(item, { scope: "all", occ, base, patch }).ops);
  assert.equal(starts(open(out)).length, n);
  assert.ok(out.includes("UNTIL=20260420T090000Z"));
});

test("scope all: all-day <-> timed with exceptions is refused (field-level code), without exceptions it works", () => {
  const item = open(SERIES);
  const occ = occAt(item, "2026-03-16T10:00:00");
  const { base, patch } = edit(item, occ, (v) => {
    v.allDay = true;
    v.startTime = "";
    v.endTime = "";
    v.startTz = "";
    v.endTz = "";
    v.startKind = "date";
    v.endKind = "date";
  });
  const plan = planEdit(item, { scope: "all", occ, base, patch });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "allday-toggle-with-exceptions");
  const plain = open(plainSeries());
  const o2 = occAt(plain, "2026-03-16T10:00:00");
  const e2 = edit(plain, o2, (v) => {
    v.allDay = true;
    v.startTime = "";
    v.endTime = "";
    v.startTz = "";
    v.endTz = "";
    v.startKind = "date";
    v.endKind = "date";
  });
  const p2 = planEdit(plain, { scope: "all", occ: o2, base: e2.base, patch: e2.patch });
  assert.equal(p2.ok, true);
  assert.match(runOps(plainSeries(), p2.ops), /DTSTART;VALUE=DATE:20260316/);
});

test("M3: a rule change that orphans exceptions asks, lists them, and has no default; keep / remove / remove-orphans", () => {
  const item = open(SERIES);
  const occ = occAt(item, "2026-03-16T10:00:00");
  const { base, patch } = edit(item, occ, (v) => (v.rule.state.byday = ["TU"]));
  assert.equal(patch.rrule, "FREQ=WEEKLY;BYDAY=TU;COUNT=6");
  const ask = planEdit(item, { scope: "all", occ, base, patch });
  assert.equal(ask.ok, false);
  assert.equal(ask.needs, "exceptions");
  assert.equal(ask.exceptions.length, 2);
  assert.equal(ask.orphans.length, 2, "both exceptions are Mondays");
  assert.equal(ask.defaultChoice, null, "no default to Keep when something would be orphaned");
  const keep = planEdit(item, { scope: "all", occ, base, patch, exceptions: "keep" });
  assert.deepEqual(keep.ops.map((o) => o.type), ["patch"]);
  const rem = planEdit(item, { scope: "all", occ, base, patch, exceptions: "remove" });
  assert.deepEqual(rem.ops.map((o) => o.type), ["patch", "removeExdate", "removeOverride"]);
  const out = runOps(SERIES, rem.ops);
  assert.ok(!out.includes("EXDATE") && !out.includes("RECURRENCE-ID"));
  assert.equal(open(out).exceptions().length, 0);
  const orph = planEdit(item, { scope: "all", occ, base, patch, exceptions: "remove-orphans" });
  assert.equal(orph.ops.length, 3);
});

test("M3: a rule change that keeps every exception valid still asks, with Keep as the default", () => {
  const item = open(SERIES);
  const occ = occAt(item, "2026-03-16T10:00:00");
  const { base, patch } = edit(item, occ, (v) => (v.rule.state.end = { type: "count", count: 10 }));
  const ask = planEdit(item, { scope: "all", occ, base, patch });
  assert.equal(ask.needs, "exceptions");
  assert.equal(ask.orphans.length, 0);
  assert.equal(ask.defaultChoice, "keep");
  // no exceptions at all: no question
  const bare = open(plainSeries());
  const o2 = occAt(bare, "2026-03-16T10:00:00");
  const e2 = edit(bare, o2, (v) => (v.rule.state.end = { type: "count", count: 10 }));
  assert.equal(planEdit(bare, { scope: "all", occ: o2, base: e2.base, patch: e2.patch }).ok, true);
});

test("M3: moving DTSTART to a weekday that is not in BYDAY lists the exceptions it orphans", () => {
  const text = ics(vevent(["DTSTART;TZID=Europe/Paris:20260316T100000", "DTEND;TZID=Europe/Paris:20260316T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8", "EXDATE;TZID=Europe/Paris:20260323T100000", "SUMMARY:S"]));
  const item = open(text);
  const occ = occAt(item, "2026-03-16T10:00:00");
  const { base, patch } = edit(item, occ, (v) => (v.startDate = "2026-03-17"));
  assert.equal(patch.start.iso, "2026-03-17T10:00:00");
  const plan = planEdit(item, { scope: "all", occ, base, patch });
  assert.equal(plan.needs, "exceptions");
  assert.equal(plan.defaultChoice, null);
});

test("scope following: a split plan carrying the patch; hidden at the first occurrence; the tail rules (M1) apply", () => {
  const item = open(SERIES);
  const first = occAt(item, "2026-03-16T10:00:00");
  assert.equal(planEdit(item, { scope: "following", occ: first, patch: { summary: "x" } }).code, "following-first");
  const occ = occAt(item, "2026-03-30T10:00:00");
  const { patch } = edit(item, occ, (v) => (v.summary = "From now on"));
  const plan = planEdit(item, { scope: "following", occ, patch });
  assert.deepEqual(plan, { ok: true, action: "split", rid: { kind: "zoned", iso: "2026-03-30T10:00:00", tzid: PARIS }, tailFields: { summary: "From now on" }, tailExceptions: "keep" });
  // the tail starts one hour later: its exceptions (the moved 6 April override) move with it, nothing is asked
  const e2 = edit(item, occ, (v) => {
    v.startTime = "11:00";
    v.endTime = "12:00";
  });
  const p2 = planEdit(item, { scope: "following", occ, patch: e2.patch });
  assert.equal(p2.ok, true, JSON.stringify(p2));
  // the tail's rule change with exceptions asks (dialog-rule-exceptions)
  const e3 = edit(item, occ, (v) => (v.rule.state.byday = ["WE"]));
  const p3 = planEdit(item, { scope: "following", occ, patch: e3.patch });
  assert.equal(p3.needs, "exceptions");
  assert.equal(p3.exceptions.length, 1, "only the 6 April override belongs to the tail");
  assert.equal(p3.defaultChoice, null);
  const p4 = planEdit(item, { scope: "following", occ, patch: e3.patch, exceptions: "remove-orphans" });
  assert.equal(p4.action, "split");
  assert.equal(p4.tailExceptions, "remove-orphans");
  // all-day <-> timed refused on the tail while it has exceptions
  const e5 = edit(item, occ, (v) => {
    v.allDay = true;
    v.startTime = "";
    v.endTime = "";
    v.startTz = "";
    v.endTz = "";
    v.startKind = "date";
    v.endKind = "date";
  });
  assert.equal(planEdit(item, { scope: "following", occ, patch: e5.patch }).code, "allday-toggle-with-exceptions");
});

test("zone change on a series: wall time kept, exceptions follow the new zone (all)", () => {
  const item = open(SERIES);
  const occ = occAt(item, "2026-03-16T10:00:00");
  const base = fromItem(item, occ);
  const values = withZone(withZone(clone(base), "start", "America/New_York"), "end", "America/New_York");
  const patch = toPatch(base, values);
  const plan = planEdit(item, { scope: "all", occ, base, patch });
  assert.equal(plan.ok, true);
  const out = runOps(SERIES, plan.ops);
  assert.ok(out.includes("DTSTART;TZID=America/New_York:20260316T100000"));
  assert.ok(out.includes("EXDATE;TZID=America/New_York:20260323T100000"));
  assert.equal(open(out).orphanedExceptions().length, 0);
});

test("planDelete: this = deleteOccurrence, following = truncate, all = the item; first occurrence cannot truncate", () => {
  const item = open(SERIES);
  const occ = occAt(item, "2026-03-30T10:00:00");
  const rid = ridSpecOf(occ);
  assert.deepEqual(planDelete(item, { scope: "this", occ }), { ok: true, action: "ops", ops: [{ type: "deleteOccurrence", rid }] });
  assert.deepEqual(planDelete(item, { scope: "following", occ }), { ok: true, action: "ops", ops: [{ type: "truncate", rid }] });
  assert.deepEqual(planDelete(item, { scope: "all", occ }), { ok: true, action: "delete" });
  assert.equal(planDelete(item, { scope: "following", occ: occAt(item, "2026-03-16T10:00:00") }).code, "following-first");
  const out = runOps(SERIES, planDelete(item, { scope: "following", occ }).ops);
  assert.equal(starts(open(out)).length, 1, "16 Mar only (23 Mar excluded)");
  const single = open(fixture("event-allday-single.ics"));
  assert.deepEqual(planDelete(single, { scope: "this", occ: single.expand({}).occurrences[0] }), { ok: true, action: "delete" });
});

test("ops are data; a replay on a changed series throws for the missing occurrence and for a moved start (M4)", () => {
  const item = open(SERIES);
  const occ = occAt(item, "2026-03-30T10:00:00");
  const ops = planDelete(item, { scope: "this", occ }).ops;
  assert.deepEqual(JSON.parse(JSON.stringify(ops)), ops);
  // theirs: someone already deleted that occurrence
  const theirs = open(SERIES);
  applyOpsToItem(theirs, ops);
  const theirsText = theirs.save({ now: NOW }).text;
  assert.throws(() => applyOpsToItem(open(theirsText), ops), (e) => e.code === "occurrence-not-found");
  // theirs: the series start moved
  const moved = open(SERIES);
  moved.shiftExceptions({ kind: "zoned", iso: "2026-03-16T10:00:00", tzid: PARIS }, { kind: "zoned", iso: "2026-03-16T12:00:00", tzid: PARIS });
  moved.update({ start: { kind: "zoned", iso: "2026-03-16T12:00:00", tzid: PARIS }, end: { kind: "zoned", iso: "2026-03-16T13:00:00", tzid: PARIS } });
  const movedText = moved.save({ now: NOW }).text;
  const o2 = occAt(open(SERIES), "2026-03-16T10:00:00");
  const e2 = edit(open(SERIES), o2, (v) => {
    v.startTime = "11:00";
    v.endTime = "12:00";
  });
  const plan = planEdit(open(SERIES), { scope: "all", occ: o2, base: e2.base, patch: e2.patch });
  assert.throws(() => applyOpsToItem(open(movedText), plan.ops), (e) => e.code === "start-mismatch");
  // a replay of a plain patch on a changed series still works
  const sum = planEdit(open(SERIES), { scope: "all", occ: o2, base: e2.base, patch: { summary: "Only text" } });
  assert.equal(open(runOps(movedText, sum.ops)).fields().summary, "Only text");
  assert.throws(() => applyOpsToItem(open(SERIES), [{ type: "explode" }]), /unknown operation/);
});

test("a non-recurring event: any scope is a plain patch", () => {
  const item = open(fixture("event-allday-single.ics"));
  const plan = planEdit(item, { scope: "following", patch: { summary: "x" } });
  assert.deepEqual(plan, { ok: true, action: "ops", ops: [{ type: "patch", fields: { summary: "x" } }] });
});

test("occ parameter: round trip, validation, and a moved override is found by its RECURRENCE-ID", () => {
  const item = open(SERIES);
  for (const o of item.expand({}).occurrences) {
    const p = occParamOf(o);
    assert.ok(p.length <= 40);
    const back = findOccurrence(item, p);
    assert.ok(back, p);
    assert.equal(occParamOf(back), p);
  }
  const moved = item.expand({}).occurrences.find((o) => o.source === "override");
  assert.equal(occParamOf(moved), "2026-04-06T10:00:00");
  assert.equal(findOccurrence(item, "2026-04-06T10:00:00").start.iso, "2026-04-07T15:00:00");
  assert.equal(findOccurrence(item, "not a date"), null);
  assert.equal(findOccurrence(item, "2026-03-23T10:00:00"), null, "an excluded occurrence does not exist");
  assert.equal(findOccurrence(item, "x".repeat(41)), null);
  assert.equal(findOccurrence(item, undefined), null);
});

test("m1 (real case): a recurring series in an unknown zone offers only the whole delete and refuses this/following/edit", () => {
  const text = ics(vevent(["DTSTART;TZID=Mars/Olympus_Mons:20260316T100000", "DTEND;TZID=Mars/Olympus_Mons:20260316T110000", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:S"]));
  const ro = open(text);
  assert.equal(ro.readOnly, true);
  const occ = ro.expand({}).occurrences[1];
  assert.deepEqual(availableScopes(ro, occ, "delete"), ["all"]);
  assert.deepEqual(availableScopes(ro, occ, "edit"), []);
  assert.equal(planDelete(ro, { scope: "this", occ }).code, "read-only-scope");
  assert.equal(planDelete(ro, { scope: "following", occ }).code, "read-only-scope");
  assert.deepEqual(planDelete(ro, { scope: "all", occ }), { ok: true, action: "delete" });
  assert.equal(planEdit(ro, { scope: "this", occ, patch: { summary: "x" } }).code, "read-only");
});

test("m7: scope.js has no op implementation of its own: it runs store/calops.js (one vocabulary, one occurrence check)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../../src/js/calendar/scope.js", import.meta.url), "utf8");
  assert.match(src, /from "\.\.\/store\/calops\.js"/);
  assert.doesNotMatch(src, /function assertOccurrence/);
  assert.doesNotMatch(src, /case "deleteOccurrence"/);
});
