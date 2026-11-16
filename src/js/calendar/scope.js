// SPDX-License-Identifier: AGPL-3.0-or-later
// Editing and deleting recurring events (RUN3 D-R3-5 / D-R3-7, addendum M1 M2 M3 M4 m1 m6). PURE: it reads an
// opened Item (never mutates it, it simulates on a fresh copy of item.raw) and returns DATA the store replays.
//
//   availableScopes(item, occ, 'edit' | 'delete')    ['this', 'following', 'all'] or less ([] = no question)
//   planEdit(item, {scope, occ, base, patch, exceptions})  -> plan
//   planDelete(item, {scope, occ})                          -> plan
//   applyOpsToItem(item, ops, {now})                        runs store/calops.js (the ONE implementation of the op vocabulary)
//   occParamOf(occ) / findOccurrence(item, param)           the `occ=` URL parameter
//
// A plan is one of
//   {ok:true, action:'noop'}
//   {ok:true, action:'ops', ops}                              store.applyOps({ops})
//   {ok:true, action:'split', rid, tailFields, tailExceptions}   store.splitWrite(...)
//   {ok:true, action:'delete'}                                the whole item (deleteItem with the shown ETag)
//   {ok:false, code, message?}                                refused; codes: read-only, not-event, occurrence-required,
//        occurrence-not-found, following-first, rrule-needs-series, allday-toggle-with-exceptions, unknown-zone,
//        start-mismatch, invalid, read-only-scope
//   {ok:false, needs:'exceptions', exceptions[], orphans[], defaultChoice}   the dialog-rule-exceptions decision:
//        call again with exceptions: 'keep' | 'remove' | 'remove-orphans'. defaultChoice is 'keep' ONLY when
//        nothing would be orphaned (addendum M3).
//
// Ops (data, not closures; rid / fromStart / toStart are TimeSpecs {kind, iso, tzid?}):
//   {type:'patch', fields}  {type:'override', rid, fields}  {type:'deleteOccurrence', rid}
//   {type:'removeExdate', rid}  {type:'removeOverride', rid}  {type:'truncate', rid}
//   {type:'shiftExceptions', fromStart, toStart}  {type:'complete'}  {type:'reopen'}

import { FieldError } from "../model/writer.js";
import * as eventLib from "../model/event.js";
import { SeriesError } from "../model/event.js";
import { applyOpsToItem as applyOps } from "../store/calops.js";
import { eventModel, expandEvents, sortMs, specFromInfo, timeInfo } from "../model/icalview.js";
import { openItem } from "../model/item.js";
import { specWallMs } from "../model/contentlines.js";
import { DAY_MS, addDays } from "./grid.js";
import { sameRule } from "./rrule.js";
import { ridSpecOf } from "./formmodel.js";

const idOf = (info) => (info.instant !== null ? `i${info.instant}` : `w${info.wallMs}${info.tzid || ""}`);
const sameSpec = (a, b) => a.kind === b.kind && a.iso === b.iso && (a.tzid || null) === (b.tzid || null);
const refuse = (code, message) => ({ ok: false, code, message: message || code });

/** Does the master repeat (RRULE or RDATE)? */
export function isRecurring(item) {
  const m = item.main;
  return !!m && (!!m.prop("RRULE") || !!m.prop("RDATE"));
}

function isFirstOccurrence(item, occ) {
  const zones = item.zones;
  const first = item.eventModel().start;
  return idOf(timeInfo(ridSpecOf(occ), zones)) === idOf(first);
}

/** Which scopes the dialog offers. [] means the event does not repeat (no question) or cannot be rewritten. */
export function availableScopes(item, occ, action = "edit") {
  if (item.kind !== "event" || !isRecurring(item)) return [];
  if (item.readOnly) return action === "delete" ? ["all"] : [];
  if (!occ) return ["all"];
  return isFirstOccurrence(item, occ) ? ["this", "all"] : ["this", "following", "all"];
}

// ---------------------------------------------------------------------------
// Ops

/**
 * Apply ops, in order, to an opened Item (the caller opens a FRESH item from the server text on every attempt).
 * Throws FieldError / SeriesError / ReadOnlyError when an op cannot be applied (the store lists it as unmappable).
 * Returns the item. The implementation is the store's (store/calops.js `applyOpsToItem`, which the write path
 * replays on a 412): this module only supplies the event model and returns the item for the planners.
 */
export function applyOpsToItem(item, ops, { now } = {}) {
  applyOps(item, ops, { lib: eventLib, ...(now ? { now } : {}) });
  return item;
}

const fresh = (item) => {
  const r = openItem(item.raw, item.kind);
  if (!r.ok) throw new SeriesError("invalid", "the event cannot be reopened");
  return r;
};

function failOf(e) {
  if (e instanceof SeriesError) return refuse(e.code, e.message);
  if (e instanceof FieldError) return refuse("invalid", e.message);
  if (e && e.name === "ReadOnlyError") return refuse("read-only", e.message);
  throw e;
}

const describe = (e) => ({ type: e.type, spec: e.spec, key: e.key });

// ---------------------------------------------------------------------------
// Edit

/**
 * The patch of the form (relative to the occurrence being edited, `base` = what the form showed) as a patch of
 * the MASTER: dates move by the calendar-day offset between the occurrence and the master, the time of day,
 * the zone and the all-day flag are the user's.
 */
function toMasterPatch(item, base, patch) {
  const out = { ...patch };
  if (!base || (!patch.start && !patch.end)) return out;
  const master = specFromInfo(item.eventModel().start);
  const offsetDays = Math.round((specWallMs({ iso: `${base.startDate}` }) - specWallMs({ iso: master.iso.slice(0, 10) })) / DAY_MS);
  if (offsetDays === 0) return out;
  const move = (spec) => {
    const date = addDays(spec.iso.slice(0, 10), -offsetDays);
    return { ...spec, iso: spec.kind === "date" ? date : `${date}${spec.iso.slice(10)}` };
  };
  if (patch.start) out.start = move(patch.start);
  if (patch.end) out.end = move(patch.end);
  return out;
}

const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function exceptionDecision(before, after, ruleChanged, startChanged, choice) {
  const ex = after.exceptions();
  const orphans = after.orphanedExceptions();
  const stale = before.orphanedExceptions().length;
  const ask = (ruleChanged && ex.length > 0) || (startChanged && orphans.length > stale);
  if (!ask) return { ask: false, ex, orphans };
  const defaultChoice = orphans.length > stale ? null : "keep";
  if (choice === undefined) return { ask: true, ex, orphans, defaultChoice };
  return { ask: false, ex, orphans, choice };
}

/**
 * Plan a save of an event. `scope` is 'this' | 'following' | 'all' (ignored for an event that does not repeat),
 * `occ` the occurrence being edited, `base` the values the form showed (formmodel.fromItem), `patch` the form's
 * patch (formmodel.toPatch), `exceptions` the answer of dialog-rule-exceptions.
 */
export function planEdit(item, { scope = "all", occ = null, base = null, patch = {}, exceptions } = {}) {
  if (item.kind !== "event") return refuse("not-event");
  if (item.readOnly) return refuse("read-only", item.readOnlyReason || "read-only");
  if (!patch || !Object.keys(patch).length) return { ok: true, action: "noop" };
  try {
    if (!isRecurring(item)) return { ok: true, action: "ops", ops: [{ type: "patch", fields: { ...patch } }] };
    if (scope === "this") return planThis(item, occ, patch);
    if (scope === "following") return planFollowing(item, occ, patch, exceptions);
    return planAll(item, occ, base, patch, exceptions);
  } catch (e) {
    return failOf(e);
  }
}

function planThis(item, occ, patch) {
  if (!occ) return refuse("occurrence-required");
  if (hasKey(patch, "rrule")) return refuse("rrule-needs-series", "the rule belongs to the whole series");
  const rid = ridSpecOf(occ);
  const ops = [{ type: "override", rid, fields: { ...patch } }];
  applyOpsToItem(fresh(item), ops);
  return { ok: true, action: "ops", ops };
}

function planAll(item, occ, base, patch, choice) {
  const mp = occ ? toMasterPatch(item, base, patch) : { ...patch };
  const ops = [];
  const master = specFromInfo(item.eventModel().start);
  const startChanged = !!mp.start && !sameSpec(mp.start, master);
  const ruleChanged = hasKey(mp, "rrule") && !sameRule(mp.rrule || "", item.fields().rrule || "");
  if (startChanged) {
    if ((mp.start.kind === "date") !== (master.kind === "date") && item.exceptions().length) {
      return refuse("allday-toggle-with-exceptions", "an all-day series with exceptions cannot become a timed one (or the reverse)");
    }
    ops.push({ type: "shiftExceptions", fromStart: master, toStart: mp.start });
  }
  ops.push({ type: "patch", fields: mp });
  const after = applyOpsToItem(fresh(item), ops);
  if (!startChanged && !ruleChanged) return { ok: true, action: "ops", ops };
  const d = exceptionDecision(item, after, ruleChanged, startChanged, choice);
  if (d.ask) return { ok: false, needs: "exceptions", exceptions: d.ex.map(describe), orphans: d.orphans.map(describe), defaultChoice: d.defaultChoice };
  const drop = d.choice === "remove" ? d.ex : d.choice === "remove-orphans" ? d.orphans : [];
  for (const e of drop) ops.push(e.type === "override" ? { type: "removeOverride", rid: e.spec } : { type: "removeExdate", rid: e.spec });
  return { ok: true, action: "ops", ops };
}

function planFollowing(item, occ, patch, choice) {
  if (!occ) return refuse("occurrence-required");
  if (isFirstOccurrence(item, occ)) return refuse("following-first", "this and following equals the whole series here");
  const rid = ridSpecOf(occ);
  const probe = (tailPatch, exceptions) => {
    const copy = fresh(item);
    const { tailText } = copy.splitSeries(rid, { newUid: "plan-probe", tailPatch, exceptions });
    const tail = openItem(tailText, "event");
    if (!tail.ok) throw new SeriesError("invalid", "the tail cannot be reopened");
    return tail;
  };
  const plain = probe(undefined, "keep");
  const tail = probe(patch, "keep");
  const ruleChanged = hasKey(patch, "rrule") && !sameRule(patch.rrule || "", plain.fields().rrule || "");
  const startChanged = !!patch.start && !sameSpec(patch.start, rid);
  const d = exceptionDecision(plain, tail, ruleChanged, startChanged, choice);
  if (d.ask) return { ok: false, needs: "exceptions", exceptions: d.ex.map(describe), orphans: d.orphans.map(describe), defaultChoice: d.defaultChoice };
  const tailExceptions = d.choice || "keep";
  if (tailExceptions !== "keep") probe(patch, tailExceptions);
  return { ok: true, action: "split", rid, tailFields: { ...patch }, tailExceptions };
}

// ---------------------------------------------------------------------------
// Delete

/** Plan a delete. 'this' = deleteOccurrence, 'following' = truncate (one PUT), 'all' (or a single event) = the item. */
export function planDelete(item, { scope = "all", occ = null } = {}) {
  if (item.kind !== "event") return refuse("not-event");
  if (!isRecurring(item) || scope === "all") return { ok: true, action: "delete" };
  if (item.readOnly) return refuse("read-only-scope", "an item that cannot be rewritten can only be deleted whole");
  if (!occ) return refuse("occurrence-required");
  if (scope === "following" && isFirstOccurrence(item, occ)) return refuse("following-first", "this and following equals the whole series here");
  const op = scope === "following" ? { type: "truncate", rid: ridSpecOf(occ) } : { type: "deleteOccurrence", rid: ridSpecOf(occ) };
  try {
    applyOpsToItem(fresh(item), [op]);
  } catch (e) {
    return failOf(e);
  }
  return { ok: true, action: "ops", ops: [op] };
}

// ---------------------------------------------------------------------------
// The `occ=` URL parameter

const PARAM_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z?)?$/;

/** The `occ` parameter of an occurrence: its RECURRENCE-ID (or start) as an ISO date, local date-time or UTC date-time. */
export function occParamOf(occ) {
  const s = ridSpecOf(occ);
  return s.kind === "utc" ? `${s.iso}Z` : s.iso;
}

/** The occurrence an `occ` parameter designates (validated, at most 40 characters), or null. */
export function findOccurrence(item, param) {
  if (typeof param !== "string" || param.length > 40 || !PARAM_RE.test(param)) return null;
  const zones = item.zones;
  const wall = specWallMs({ iso: param.slice(0, 19) });
  const seek = (from, to) =>
    expandEvents(item.root, { from, to, limit: 5000, zones }).occurrences.find((o) => occParamOf(o) === param) || null;
  const found = seek(wall - 3 * DAY_MS, wall + 3 * DAY_MS);
  if (found) return found;
  for (const ex of item.exceptions()) {
    if (ex.type !== "override") continue;
    const rid = ex.spec;
    if ((rid.kind === "utc" ? `${rid.iso}Z` : rid.iso) !== param) continue;
    // a moved override is not near its RECURRENCE-ID: look around where it now starts
    const at = sortMs(eventModel(ex.component, zones).start);
    const hit = seek(at - 3 * DAY_MS, at + 3 * DAY_MS);
    if (hit) return hit;
  }
  return null;
}
