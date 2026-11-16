// SPDX-License-Identifier: AGPL-3.0-or-later
// VEVENT: the properties RadUI owns (SPECS 4.1) and the recurrence helpers.
// Everything else on an event (ATTENDEE, ORGANIZER, X-*, ATTACH, GEO, unknown
// parameters, VALARMs that are not relative DISPLAY alarms ...) is never
// touched. All functions operate on the content-line tree (contentlines.js).

import { newUuid } from "../uuid.js";
import {
  Component,
  ValueError,
  formatDuration,
  formatRRule,
  getText,
  getTextList,
  parseDuration,
  parseRRule,
  parseTime,
  unescapeText,
  formatTime,
  formatUtcStamp,
  specFromWallMs,
  specWallMs,
} from "./contentlines.js";
import {
  FieldError,
  addProp,
  encodeValue,
  newProp,
  removeProp,
  setSingle,
  setText,
  setTextList,
  setTimeProp,
  timeProp,
  touch,
  makeParam,
  setParam,
} from "./writer.js";
import { countBefore, createZones, eventModel, expandEvents, occurrenceEnd, specFromInfo, timeInfo } from "./icalview.js";

export const OWNED_PROPS = Object.freeze([
  "SUMMARY",
  "DESCRIPTION",
  "LOCATION",
  "URL",
  "CATEGORIES",
  "STATUS",
  "TRANSP",
  "DTSTART",
  "DTEND",
  "DURATION",
  "RRULE",
  "EXDATE",
  "RDATE",
]);
export const STATUSES = Object.freeze(["CONFIRMED", "TENTATIVE", "CANCELLED"]);
export const TRANSPARENCIES = Object.freeze(["OPAQUE", "TRANSPARENT"]);
export const DEFAULT_PRODID = "-//RadUI//Calendar//EN";

/**
 * A FieldError with a machine-readable `code` (the store maps it to an unmappable row, the
 * form to a field message). Codes: 'start-mismatch', 'allday-toggle-with-exceptions',
 * 'unknown-zone', 'no-master'.
 */
export class SeriesError extends FieldError {
  constructor(code, message) {
    super(message || code);
    this.name = "SeriesError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Structure helpers

export function masterOf(root) {
  return root.comps("VEVENT").find((c) => !c.prop("RECURRENCE-ID")) || null;
}

export function overridesOf(root) {
  return root.comps("VEVENT").filter((c) => c.prop("RECURRENCE-ID"));
}

const upper = (s) => (s === null || s === undefined ? s : String(s).toUpperCase());

function setEnum(comp, name, value, allowed) {
  if (value === null || value === undefined || value === "") return setSingle(comp, name, null);
  const v = upper(value);
  if (!allowed.includes(v)) throw new FieldError(`${name} must be one of ${allowed.join(", ")}`);
  const cur = comp.prop(name);
  if (cur && cur.value.trim().toUpperCase() === v) return false;
  return setSingle(comp, name, v);
}

/** CATEGORIES: one line holding the list; no-op when unchanged. */
export function setCategories(comp, list) {
  return setTextList(comp, "CATEGORIES", list);
}

// ---------------------------------------------------------------------------
// Alarms: only relative DISPLAY alarms are modelled

const ALARM_PROPS = new Set(["ACTION", "TRIGGER", "DESCRIPTION"]);

/** {seconds, related} when the VALARM is a plain relative DISPLAY alarm, else null. */
export function modelledAlarm(valarm) {
  const action = valarm.prop("ACTION");
  const trigger = valarm.prop("TRIGGER");
  if (!action || !trigger || action.value.trim().toUpperCase() !== "DISPLAY") return null;
  if (valarm.components.length) return null;
  if (valarm.properties.some((p) => !ALARM_PROPS.has(p.key) || p.group)) return null;
  if (valarm.props("TRIGGER").length !== 1 || valarm.props("ACTION").length !== 1) return null;
  const valueParam = trigger.paramValues("VALUE");
  if (valueParam.length && valueParam[0].toUpperCase() !== "DURATION") return null;
  const rel = trigger.paramValues("RELATED");
  const related = rel.length && rel[0].toUpperCase() === "END" ? "END" : "START";
  try {
    return { seconds: parseDuration(trigger.value), related };
  } catch (e) {
    if (e instanceof ValueError) return null;
    throw e;
  }
}

export function readAlarms(comp) {
  const alarms = [];
  let foreign = 0;
  for (const v of comp.comps("VALARM")) {
    const m = modelledAlarm(v);
    if (m) alarms.push({ ...m, component: v });
    else foreign++;
  }
  return { alarms, foreign };
}

/**
 * Make the modelled alarms equal `wanted` ([{seconds, related?}], negative
 * seconds = before). Unmodelled alarms are never touched.
 */
export function setAlarms(comp, wanted) {
  const key = (a) => `${a.seconds}|${a.related || "START"}`;
  const want = new Map();
  for (const a of wanted || []) {
    if (!Number.isFinite(a.seconds)) throw new FieldError("alarm offset must be a number of seconds");
    want.set(key(a), { seconds: a.seconds, related: a.related === "END" ? "END" : "START" });
  }
  let changed = false;
  const have = new Set();
  for (const v of comp.comps("VALARM")) {
    const m = modelledAlarm(v);
    if (!m) continue;
    const k = key(m);
    if (want.has(k) && !have.has(k)) have.add(k);
    else {
      comp.remove(v);
      changed = true;
    }
  }
  for (const [k, a] of want) {
    if (have.has(k)) continue;
    const v = new Component("VALARM");
    v.items.push(newProp("ACTION", "DISPLAY"));
    v.items.push(
      newProp("TRIGGER", formatDuration(a.seconds), { params: a.related === "END" ? [makeParam("RELATED", ["END"])] : [] }),
    );
    v.items.push(newProp("DESCRIPTION", "Reminder"));
    comp.append(v);
    changed = true;
  }
  if (changed) touch(comp);
  return changed;
}

// ---------------------------------------------------------------------------
// Read

/** Plain object of every owned field of a VEVENT. Throws ValueError on bad dates. */
export function readEvent(comp) {
  const ds = comp.prop("DTSTART");
  const de = comp.prop("DTEND");
  const du = comp.prop("DURATION");
  const url = comp.prop("URL");
  const rr = comp.prop("RRULE");
  const { alarms, foreign } = readAlarms(comp);
  const start = ds ? parseTime(ds.value, ds.params) : null;
  return {
    summary: getText(comp, "SUMMARY") || "",
    description: getText(comp, "DESCRIPTION") || "",
    location: getText(comp, "LOCATION") || "",
    url: url ? url.value.trim() : "",
    categories: getTextList(comp, "CATEGORIES"),
    status: upper((comp.prop("STATUS") || { value: "" }).value.trim()) || null,
    transp: upper((comp.prop("TRANSP") || { value: "" }).value.trim()) || null,
    start,
    end: de ? parseTime(de.value, de.params) : null,
    duration: du ? parseDuration(du.value) : null,
    allDay: !!start && start.kind === "date",
    rrule: rr ? rr.value.trim() : null,
    exdates: comp.props("EXDATE").flatMap((p) => p.value.split(",").filter(Boolean).map((v) => parseTime(v, p.params))),
    rdates: comp.props("RDATE").flatMap((p) => p.value.split(",").filter(Boolean).map((v) => parseTime(v.split("/")[0], p.params))),
    alarms: alarms.map((a) => ({ seconds: a.seconds, related: a.related })),
    foreignAlarms: foreign,
  };
}

// ---------------------------------------------------------------------------
// Write

/** Seconds between two TimeSpecs (exact for instants, nominal for dates/floating). */
export function durationBetween(startSpec, endSpec, zones) {
  const a = timeInfo(startSpec, zones);
  const b = timeInfo(endSpec, zones);
  if (a.kind === "date" && b.kind === "date") return (b.wallMs - a.wallMs) / 1000;
  if (a.kind === "date" || b.kind === "date") throw new FieldError("start and end must both be all-day or both timed");
  if (a.instant !== null && b.instant !== null) return (b.instant - a.instant) / 1000;
  if (a.kind === "floating" && b.kind === "floating") return (b.wallMs - a.wallMs) / 1000;
  if (a.tzid && a.tzid === b.tzid) return (b.wallMs - a.wallMs) / 1000;
  throw new FieldError("cannot compute a duration between these values (unknown time zone)");
}

/** Set DURATION from seconds; no-op when the current one is equal. */
function setDuration(comp, seconds) {
  const cur = comp.prop("DURATION");
  if (cur) {
    try {
      if (parseDuration(cur.value) === seconds) return false;
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
    }
  }
  return setSingle(comp, "DURATION", formatDuration(seconds));
}

function setRRule(comp, value) {
  if (value === null || value === undefined || value === "") return setSingle(comp, "RRULE", null);
  const text = String(value).trim();
  let norm;
  try {
    norm = formatRRule(parseRRule(text));
  } catch (e) {
    if (e instanceof ValueError) throw new FieldError(e.message);
    throw e;
  }
  const cur = comp.prop("RRULE");
  if (cur && cur.value.trim() === norm) return false;
  return setSingle(comp, "RRULE", norm);
}

/**
 * Apply a patch of owned fields to a VEVENT. Only the keys present in the patch
 * are looked at; a value equal to the current one changes nothing.
 * Keys: summary, description, location, url, categories, status, transp, start,
 * end (null removes DTEND/DURATION unless a duration is given too), duration
 * (seconds), rrule, alarms. Sending back what readEvent returned is safe: an
 * event that uses DURATION has end null and a duration, which sets DURATION again.
 * Returns true when anything changed.
 */
export function applyEventPatch(comp, patch, { zones } = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  let changed = false;
  const dec = unescapeText;
  if (has("summary")) changed = setText(comp, "SUMMARY", patch.summary, dec) || changed;
  if (has("description")) changed = setText(comp, "DESCRIPTION", patch.description, dec) || changed;
  if (has("location")) changed = setText(comp, "LOCATION", patch.location, dec) || changed;
  if (has("url")) {
    const u = patch.url ? String(patch.url).trim() : null;
    const cur = comp.prop("URL");
    if (!(cur && u && cur.value.trim() === u)) changed = setSingle(comp, "URL", u || null) || changed;
  }
  if (has("categories")) changed = setCategories(comp, patch.categories) || changed;
  if (has("status")) changed = setEnum(comp, "STATUS", patch.status, STATUSES) || changed;
  if (has("transp")) changed = setEnum(comp, "TRANSP", patch.transp, TRANSPARENCIES) || changed;
  if (has("start")) {
    if (!patch.start) throw new FieldError("an event needs a start");
    changed = setTimeProp(comp, "DTSTART", patch.start) || changed;
  }
  if (has("end") || has("duration")) {
    const endV = has("end") ? patch.end : null;
    const durV = has("duration") ? patch.duration : null;
    if (endV) {
      const usesDuration = !!comp.prop("DURATION") && !comp.prop("DTEND");
      if (usesDuration) {
        const startP = comp.prop("DTSTART");
        if (!startP) throw new FieldError("cannot edit the end of an event without a start");
        const startSpec = parseTime(startP.value, startP.params);
        changed = setDuration(comp, durationBetween(startSpec, endV, zones || createZones(rootOf(comp)))) || changed;
      } else {
        changed = setTimeProp(comp, "DTEND", endV) || changed;
      }
    } else if (durV !== null && durV !== undefined) {
      changed = setSingle(comp, "DTEND", null) || changed;
      changed = setDuration(comp, durV) || changed;
    } else {
      // end: null (and no duration) removes both
      changed = setSingle(comp, "DTEND", null) || changed;
      changed = setSingle(comp, "DURATION", null) || changed;
    }
  }
  if (has("rrule")) changed = setRRule(comp, patch.rrule) || changed;
  if (has("alarms")) changed = setAlarms(comp, patch.alarms) || changed;
  return changed;
}

// A VEVENT does not know its parent; the zones for a duration rewrite normally
// come from the caller. This fallback only supports TZIDs Intl knows.
function rootOf(comp) {
  const r = new Component("VCALENDAR");
  r.items.push(comp);
  return r;
}

// ---------------------------------------------------------------------------
// Recurrence helpers

function checkSameKind(spec, master, zones) {
  const first = eventModel(master, zones).start;
  if (spec.kind !== first.kind) {
    throw new FieldError(`occurrence time must be of the same kind as the series start (${first.kind})`);
  }
}

const idOf = (info) => (info.instant !== null ? `i${info.instant}` : `w${info.wallMs}${info.tzid || ""}`);

/** Does an EXDATE already hide this occurrence? */
function isExcluded(master, info, zones) {
  for (const p of master.props("EXDATE")) {
    for (const v of p.value.split(",").filter(Boolean)) {
      const x = timeInfo(parseTime(v, p.params), zones);
      if (idOf(x) === idOf(info)) return true;
    }
  }
  return false;
}

/**
 * Is `ridSpec` an occurrence (or an override) of the series as it stands now? The store asks this before it replays an
 * override, a deleted occurrence or a truncation on a version that may have changed in the meantime: an occurrence
 * that was deleted or that the rule no longer produces must not be brought back by an edit made on an older version.
 */
export function isOccurrence(root, ridSpec, { zones } = {}) {
  zones = zones || createZones(root);
  const master = masterOf(root);
  if (!master || !(master.prop("RRULE") || master.prop("RDATE"))) return false;
  const info = timeInfo(ridSpec, zones);
  const key = idOf(info);
  if (exceptionsOf(root, { zones }).some((e) => e.type === "override" && e.key === key)) return true;
  const at = info.instant !== null ? info.instant : info.wallMs;
  const { occurrences } = expandEvents(root, { from: at - 2 * 86400000, to: at + 2 * 86400000, limit: 5000, zones });
  return occurrences.some((o) => o.source !== "override" && idOf(o.recurrenceId || o.start) === key);
}

/** Hide one occurrence of the series (adds an EXDATE). Returns true when a line was added. */
export function addExdate(root, spec, { zones } = {}) {
  zones = zones || createZones(root);
  const master = masterOf(root);
  if (!master) throw new FieldError("no master event");
  checkSameKind(spec, master, zones);
  if (isExcluded(master, timeInfo(spec, zones), zones)) return false;
  addProp(master, timeProp("EXDATE", spec));
  return true;
}

/** Undo addExdate for one value. Returns true when something was removed. */
export function removeExdate(root, spec, { zones } = {}) {
  zones = zones || createZones(root);
  const master = masterOf(root);
  if (!master) return false;
  const target = idOf(timeInfo(spec, zones));
  let changed = false;
  for (const p of master.props("EXDATE")) {
    const parts = p.value.split(",").filter(Boolean);
    const keep = parts.filter((v) => idOf(timeInfo(parseTime(v, p.params), zones)) !== target);
    if (keep.length === parts.length) continue;
    changed = true;
    if (!keep.length) master.remove(p);
    else {
      p.value = keep.join(",");
      p.dirty = true;
    }
  }
  if (changed) touch(master);
  return changed;
}

/** Add an extra occurrence (RDATE). */
export function addRdate(root, spec, { zones } = {}) {
  zones = zones || createZones(root);
  const master = masterOf(root);
  if (!master) throw new FieldError("no master event");
  checkSameKind(spec, master, zones);
  const key = idOf(timeInfo(spec, zones));
  for (const p of master.props("RDATE")) {
    for (const v of p.value.split(",").filter(Boolean)) {
      if (idOf(timeInfo(parseTime(v.split("/")[0], p.params), zones)) === key) return false;
    }
  }
  addProp(master, timeProp("RDATE", spec));
  return true;
}

function findOverride(root, ridSpec, zones) {
  const key = idOf(timeInfo(ridSpec, zones));
  return overridesOf(root).find((o) => {
    const p = o.prop("RECURRENCE-ID");
    return idOf(timeInfo(parseTime(p.value, p.params), zones)) === key;
  });
}

/**
 * Create or edit the override of one occurrence. The override VEVENT stays in
 * the SAME resource. A new override starts as a copy of the master without
 * RRULE/RDATE/EXDATE, with RECURRENCE-ID and DTSTART (and DTEND) set to the
 * occurrence; `patch` (applyEventPatch keys) is then applied.
 * Returns the override component.
 */
export function upsertOverride(root, ridSpec, patch = {}, { zones } = {}) {
  zones = zones || createZones(root);
  const master = masterOf(root);
  if (!master) throw new FieldError("no master event");
  checkSameKind(ridSpec, master, zones);
  let ov = findOverride(root, ridSpec, zones);
  if (!ov) {
    const model = eventModel(master, zones);
    const startInfo = timeInfo(ridSpec, zones);
    ov = new Component("VEVENT");
    const skip = new Set(["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "SEQUENCE"]);
    for (const n of master.items) {
      if (n instanceof Component) {
        ov.items.push(n.clone());
        continue;
      }
      if (skip.has(n.key)) continue;
      if (n.key === "DTSTART") {
        ov.items.push(timeProp("DTSTART", ridSpec));
        ov.items.push(timeProp("RECURRENCE-ID", ridSpec));
      } else if (n.key === "DTEND") {
        ov.items.push(timeProp("DTEND", specFromInfo(occurrenceEnd(startInfo, model, zones))));
      } else ov.items.push(n.clone());
    }
    if (!ov.prop("RECURRENCE-ID")) ov.items.push(timeProp("RECURRENCE-ID", ridSpec));
    root.append(ov);
    touch(ov);
  }
  if (applyEventPatch(ov, patch, { zones })) touch(ov);
  return ov;
}

/** Remove the override of one occurrence (the occurrence returns to the series). */
export function removeOverride(root, ridSpec, { zones } = {}) {
  zones = zones || createZones(root);
  const ov = findOverride(root, ridSpec, zones);
  if (!ov) return false;
  root.remove(ov);
  const m = masterOf(root);
  if (m) touch(m);
  return true;
}

/** Delete one occurrence: EXDATE on the master and no override left for it. */
export function deleteOccurrence(root, ridSpec, { zones } = {}) {
  zones = zones || createZones(root);
  const a = removeOverride(root, ridSpec, { zones });
  const b = addExdate(root, ridSpec, { zones });
  return a || b;
}

function untilText(splitInfo, zones) {
  if (splitInfo.kind === "date") {
    const d = new Date(splitInfo.wallMs - 86400000);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  }
  if (splitInfo.instant !== null) return formatUtcStamp(splitInfo.instant - 1000);
  if (splitInfo.kind === "floating") return formatTime({ kind: "floating", iso: new Date(splitInfo.wallMs - 1000).toISOString().slice(0, 19) }).value;
  throw new FieldError("cannot split a series whose time zone is unknown");
}

function filterTimeProps(comp, name, zones, keepFn) {
  const moved = [];
  for (const p of comp.props(name)) {
    const parts = p.value.split(",").filter(Boolean);
    const keep = [];
    for (const v of parts) {
      const info = timeInfo(parseTime(v.split("/")[0], p.params), zones);
      if (keepFn(info)) keep.push(v);
      else moved.push({ prop: p, value: v });
    }
    if (keep.length === parts.length) continue;
    if (!keep.length) comp.remove(p);
    else {
      p.value = keep.join(",");
      p.dirty = true;
    }
  }
  return moved;
}

/**
 * "This and following": end the series before `splitSpec` and create the tail
 * as a NEW item. Mutates `root` (the head: RRULE gets an UNTIL, later
 * EXDATE/RDATE and overrides move out) and returns {tail}: the root of a new
 * VCALENDAR with `newUid` that starts at `splitSpec` and continues the rule.
 * options: {newUid, prodid, zones, tailPatch, exceptions, discardTail}. UID and PRODID are set
 * on the tail only (it is a new item: PRODID defaults to DEFAULT_PRODID); the head
 * keeps both.
 * `tailPatch` follows the same rules as an edit of a whole series (RUN3 D-R3-7, addendum M1/M2):
 * when it moves the start, the exceptions of the tail (EXDATE, RECURRENCE-ID, a date-time UNTIL)
 * move by the same wall-clock delta first (shiftExceptions); an all-day <-> timed change with
 * exceptions present throws SeriesError('allday-toggle-with-exceptions'). `exceptions` says what
 * to do with the tail's exceptions: 'keep' (default), 'remove' (all, before the patch) or
 * 'remove-orphans' (those that are no longer occurrences after the patch).
 * `discardTail` is for truncateSeries: only the head matters, so the tail is not checked.
 */
export function splitSeries(root, splitSpec, { newUid, prodid, zones, tailPatch, exceptions = "keep", discardTail = false } = {}) {
  zones = zones || createZones(root);
  const master = masterOf(root);
  if (!master) throw new FieldError("no master event");
  const rr = master.prop("RRULE");
  if (!rr) throw new FieldError("not a recurring event");
  checkSameKind(splitSpec, master, zones);
  const model = eventModel(master, zones);
  const splitInfo = timeInfo(splitSpec, zones);
  if (splitInfo.wallMs <= model.start.wallMs) throw new FieldError("splitting at the first occurrence is an edit of the whole series");
  const uid = newUid || newUuid();

  const pairs = parseRRule(rr.value);
  const countPair = pairs.find(([k]) => k === "COUNT");
  const origCount = countPair ? parseInt(countPair[1], 10) : null;
  const before = countBefore(root, splitInfo, zones);
  if (before < 1) throw new FieldError("nothing before the split point");

  // Tail first: a copy of the untouched master.
  const tailMaster = master.clone();
  tailMaster.touched = true;
  const tailRoot = new Component("VCALENDAR");
  for (const p of root.properties) {
    if (p.key === "PRODID") tailRoot.items.push(newProp("PRODID", encodeValue("PRODID", prodid || DEFAULT_PRODID)));
    else tailRoot.items.push(p.clone());
  }
  for (const v of root.comps("VTIMEZONE")) tailRoot.items.push(v.clone());

  // Head.
  const headPairs = pairs.filter(([k]) => k !== "COUNT" && k !== "UNTIL");
  headPairs.push(["UNTIL", untilText(splitInfo, zones)]);
  setSingle(master, "RRULE", formatRRule(headPairs));
  filterTimeProps(master, "EXDATE", zones, (i) => sortKey(i) < sortKey(splitInfo));
  filterTimeProps(master, "RDATE", zones, (i) => sortKey(i) < sortKey(splitInfo));
  const movedOverrides = [];
  for (const ov of overridesOf(root)) {
    const p = ov.prop("RECURRENCE-ID");
    const i = timeInfo(parseTime(p.value, p.params), zones);
    if (sortKey(i) >= sortKey(splitInfo)) {
      root.remove(ov);
      movedOverrides.push(ov);
    }
  }
  touch(master);

  // Tail master.
  setSingle(tailMaster, "UID", encodeValue("UID", uid));
  setSingle(tailMaster, "SEQUENCE", null);
  setSingle(tailMaster, "CREATED", null);
  setTimeProp(tailMaster, "DTSTART", splitSpec);
  if (tailMaster.prop("DTEND")) {
    setTimeProp(tailMaster, "DTEND", specFromInfo(occurrenceEnd(splitInfo, model, zones)));
  }
  if (origCount !== null) {
    const left = origCount - before;
    if (left < 1 && !discardTail) throw new FieldError("no occurrence left for the tail");
    setSingle(tailMaster, "RRULE", formatRRule(pairs.map(([k, v]) => (k === "COUNT" ? [k, String(left)] : [k, v]))));
  }
  filterTimeProps(tailMaster, "EXDATE", zones, (i) => sortKey(i) >= sortKey(splitInfo));
  filterTimeProps(tailMaster, "RDATE", zones, (i) => sortKey(i) >= sortKey(splitInfo));
  tailRoot.items.push(tailMaster);
  for (const ov of movedOverrides) {
    const c = ov.clone();
    setSingle(c, "UID", encodeValue("UID", uid));
    c.touched = true;
    tailRoot.items.push(c);
  }
  if (tailPatch && !discardTail) applyTailPatch(tailRoot, tailMaster, splitSpec, tailPatch, { zones, exceptions });
  else if (exceptions === "remove" && !discardTail) removeExceptions(tailRoot, exceptionsOf(tailRoot, { zones: createZones(tailRoot) }), { zones: createZones(tailRoot) });
  return { tail: tailRoot, tailUid: uid };
}

function applyTailPatch(tailRoot, tailMaster, splitSpec, tailPatch, { zones, exceptions }) {
  const tz = createZones(tailRoot);
  if (exceptions === "remove") removeExceptions(tailRoot, exceptionsOf(tailRoot, { zones: tz }), { zones: tz });
  if (tailPatch.start && !sameSpec(tailPatch.start, splitSpec)) shiftExceptions(tailRoot, splitSpec, tailPatch.start, { zones: tz });
  applyEventPatch(tailMaster, tailPatch, { zones: createZones(tailRoot) });
  if (exceptions === "remove-orphans") {
    const z = createZones(tailRoot);
    removeExceptions(tailRoot, orphanedExceptions(tailRoot, { zones: z }), { zones: z });
  }
}

const sortKey = (info) => (info.instant !== null ? info.instant : info.wallMs);

const DAY_MS = 86400000;
const sameSpec = (a, b) => a.kind === b.kind && a.iso === b.iso && (a.tzid || null) === (b.tzid || null);
const addDaysIso = (iso, n) => specFromWallMs(specWallMs({ iso: iso.slice(0, 10) }) + n * DAY_MS, "date").iso;

// ---------------------------------------------------------------------------
// UNTIL typing (RFC 5545 3.3.10): the value type follows DTSTART.

const compactDate = (iso) => iso.slice(0, 10).replace(/-/g, "");

/**
 * The UNTIL value for "ends on `dateIso`" (inclusive, YYYY-MM-DD) of a series that starts at
 * `startSpec`: a DATE for an all-day start, the end of that day (23:59:59) as a UTC date-time for
 * a UTC or zoned start, a local date-time for a floating start. `zones` (optional) resolves the
 * start's time zone; an unknown zone throws SeriesError('unknown-zone').
 */
export function untilFor(startSpec, dateIso, { zones } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso || "")) throw new FieldError("UNTIL needs a date (YYYY-MM-DD)");
  const day = compactDate(dateIso);
  if (startSpec.kind === "date") return day;
  if (startSpec.kind === "floating") return `${day}T235959`;
  if (startSpec.kind === "utc") return `${day}T235959Z`;
  const z = (zones || createZones(new Component("VCALENDAR"))).get(startSpec.tzid);
  if (!z) throw new SeriesError("unknown-zone", `unknown time zone ${startSpec.tzid}`);
  const wall = specWallMs({ iso: `${dateIso}T23:59:59` });
  return formatUtcStamp(z.instantFromWall(wall));
}

/** The day (YYYY-MM-DD, in the series' own zone) an UNTIL value ends on; the reverse of untilFor. */
export function untilDateOf(untilText, startSpec, { zones } = {}) {
  const x = parseTime(untilText, []);
  if (x.kind === "date" || x.kind === "floating") return x.iso.slice(0, 10);
  if (startSpec.kind === "zoned") {
    const z = (zones || createZones(new Component("VCALENDAR"))).get(startSpec.tzid);
    if (!z) throw new SeriesError("unknown-zone", `unknown time zone ${startSpec.tzid}`);
    return specFromWallMs(z.wallFromInstant(specWallMs(x)), "floating").iso.slice(0, 10);
  }
  return x.iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Exceptions (EXDATE and overrides): list, orphans, removal, shift

/** [{type:'exdate'|'override', spec, key, prop?, component?}] of a series (RDATE is not an exception). */
export function exceptionsOf(root, { zones } = {}) {
  zones = zones || createZones(root);
  const master = masterOf(root);
  const out = [];
  if (!master) return out;
  for (const p of master.props("EXDATE")) {
    for (const v of p.value.split(",").filter(Boolean)) {
      const spec = parseTime(v, p.params);
      out.push({ type: "exdate", spec, key: idOf(timeInfo(spec, zones)), prop: p });
    }
  }
  for (const ov of overridesOf(root)) {
    const p = ov.prop("RECURRENCE-ID");
    const spec = parseTime(p.value, p.params);
    out.push({ type: "override", spec, key: idOf(timeInfo(spec, zones)), component: ov });
  }
  return out;
}

/**
 * The exceptions whose value is no longer an occurrence of the rule (the series as it stands, RDATE
 * included, EXDATE and overrides ignored): after a rule or start change they would silently stop
 * meaning anything (RUN3 addendum M3). Same shape as exceptionsOf.
 */
export function orphanedExceptions(root, { zones } = {}) {
  const exs = exceptionsOf(root, { zones: zones || createZones(root) });
  if (!exs.length || !masterOf(root)) return [];
  const scratch = root.clone();
  const m = masterOf(scratch);
  for (const p of m.props("EXDATE")) m.remove(p);
  for (const ov of overridesOf(scratch)) scratch.remove(ov);
  const z = createZones(scratch);
  const infos = exs.map((e) => timeInfo(e.spec, z));
  const lo = Math.min(...infos.map(sortKey)) - 2 * DAY_MS;
  const hi = Math.max(...infos.map(sortKey)) + 2 * DAY_MS;
  const { occurrences } = expandEvents(scratch, { from: lo, to: hi, limit: 5000, zones: z });
  const keys = new Set();
  const days = new Set();
  for (const o of occurrences) {
    keys.add(idOf(o.start));
    days.add(Math.floor(o.start.wallMs / DAY_MS));
  }
  const timed = timeInfo(parseTime(masterOf(scratch).prop("DTSTART").value, masterOf(scratch).prop("DTSTART").params), z).kind !== "date";
  return exs.filter((e, i) => {
    if (infos[i].kind === "date" && timed) return !days.has(Math.floor(infos[i].wallMs / DAY_MS));
    return !keys.has(e.key);
  });
}

/** Remove the listed exceptions (from exceptionsOf / orphanedExceptions). Returns how many were removed. */
export function removeExceptions(root, list, { zones } = {}) {
  zones = zones || createZones(root);
  let n = 0;
  for (const e of list) {
    if (e.type === "override" ? removeOverride(root, e.spec, { zones }) : removeExdate(root, e.spec, { zones })) n++;
  }
  return n;
}

function makeShifter(fromSpec, toSpec, zones) {
  const deltaWall = specWallMs(toSpec) - specWallMs(fromSpec);
  const deltaDays = Math.round((specWallMs({ iso: toSpec.iso.slice(0, 10) }) - specWallMs({ iso: fromSpec.iso.slice(0, 10) })) / DAY_MS);
  const need = (tzid) => {
    const z = zones.get(tzid);
    if (!z) throw new SeriesError("unknown-zone", `unknown time zone ${tzid}`);
    return z;
  };
  return {
    deltaWall,
    deltaDays,
    /** The shifted value of one EXDATE / RECURRENCE-ID / UNTIL value, in the form it was written in. */
    spec(x) {
      if (x.kind === "date") return { kind: "date", iso: addDaysIso(x.iso, deltaDays) };
      const sameForm = x.kind === fromSpec.kind && (x.tzid || null) === (fromSpec.tzid || null);
      if (sameForm) return specFromWallMs(specWallMs(x) + deltaWall, toSpec.kind, toSpec.tzid);
      if (fromSpec.kind !== "utc" && fromSpec.kind !== "zoned") return specFromWallMs(specWallMs(x) + deltaWall, x.kind, x.tzid);
      // written in UTC or in another zone than the master: go through the instant, in the master's zone
      const info = timeInfo(x, zones);
      if (info.instant === null) throw new SeriesError("unknown-zone", `unknown time zone ${x.tzid}`);
      const fromWall = fromSpec.kind === "utc" ? info.instant : need(fromSpec.tzid).wallFromInstant(info.instant);
      const wall = fromWall + deltaWall;
      if (toSpec.kind !== "utc" && toSpec.kind !== "zoned") return specFromWallMs(specWallMs(x) + deltaWall, x.kind, x.tzid);
      const instant = toSpec.kind === "utc" ? wall : need(toSpec.tzid).instantFromWall(wall);
      if (x.kind === "utc") return specFromWallMs(instant, "utc");
      return specFromWallMs(need(x.tzid).wallFromInstant(instant), "zoned", x.tzid);
    },
  };
}

function propFromSpecs(name, specs) {
  const f = formatTime(specs[0]);
  const params = [];
  if (f.valueDate) params.push(makeParam("VALUE", ["DATE"]));
  if (f.tzid) params.push(makeParam("TZID", [f.tzid]));
  return newProp(name, specs.map((s) => formatTime(s).value).join(","), { params });
}

function shiftExdateProp(master, p, shifter) {
  const specs = p.value.split(",").filter(Boolean).map((v) => parseTime(v, p.params));
  const next = specs.map((s) => shifter.spec(s));
  if (next.every((s, i) => sameSpec(s, specs[i]))) return false;
  const groups = new Map();
  for (const s of next) {
    const k = `${s.kind}|${s.tzid || ""}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  let first = true;
  let anchor = p;
  for (const list of groups.values()) {
    if (first) {
      const f = formatTime(list[0]);
      p.value = list.map((s) => formatTime(s).value).join(",");
      setParam(p, "VALUE", f.valueDate ? ["DATE"] : null);
      setParam(p, "TZID", f.tzid ? [f.tzid] : null);
      p.dirty = true;
      first = false;
    } else {
      anchor = master.insertAfter(anchor, propFromSpecs("EXDATE", list));
    }
  }
  return true;
}

function shiftUntil(master, fromSpec, toSpec, shifter, zones) {
  const rr = master.prop("RRULE");
  if (!rr) return false;
  const pairs = parseRRule(rr.value);
  const i = pairs.findIndex(([k]) => k === "UNTIL");
  if (i < 0) return false;
  const x = parseTime(pairs[i][1], []);
  let text;
  if ((fromSpec.kind === "date") !== (toSpec.kind === "date")) {
    text = untilFor(toSpec, untilDateOf(pairs[i][1], fromSpec, { zones }), { zones });
  } else {
    let s = shifter.spec(x);
    if (s.kind === "zoned") {
      const z = zones.get(s.tzid);
      if (!z) throw new SeriesError("unknown-zone", `unknown time zone ${s.tzid}`);
      s = specFromWallMs(z.instantFromWall(specWallMs(s)), "utc");
    }
    text = formatTime(s).value;
  }
  if (text === pairs[i][1]) return false;
  pairs[i][1] = text;
  setSingle(master, "RRULE", formatRRule(pairs));
  return true;
}

/**
 * The start of the series moves from `fromSpec` to `toSpec` (call it BEFORE applying the new start
 * with applyEventPatch): every EXDATE value and every override's RECURRENCE-ID moves by the same
 * wall-clock delta in the master's zone, a date-time UNTIL by the same delta (addendum M2: the
 * occurrence count stays), a DATE UNTIL by the difference in calendar days. Values written in UTC or
 * in another TZID than the master's are converted through the instant, shifted in the master's zone
 * and written back in their own form (addendum m6). An override whose DTSTART still equals its
 * RECURRENCE-ID follows the series; an override the user moved keeps its own DTSTART/DTEND. RDATE
 * is left alone. Throws SeriesError('start-mismatch') when the master's DTSTART is not `fromSpec`
 * (addendum M4) and SeriesError('allday-toggle-with-exceptions') for an all-day <-> timed change
 * while EXDATEs or overrides exist. Returns true when anything changed.
 */
export function shiftExceptions(root, fromSpec, toSpec, { zones } = {}) {
  zones = zones || createZones(root);
  const master = masterOf(root);
  if (!master) throw new SeriesError("no-master", "no master event");
  const ds = master.prop("DTSTART");
  if (!ds) throw new SeriesError("no-master", "the master has no start");
  if (!sameSpec(parseTime(ds.value, ds.params), fromSpec)) {
    throw new SeriesError("start-mismatch", "the start of the series is not the one these changes were made against");
  }
  if (sameSpec(fromSpec, toSpec)) return false;
  const toggles = (fromSpec.kind === "date") !== (toSpec.kind === "date");
  const exs = exceptionsOf(root, { zones });
  if (toggles && exs.length) {
    throw new SeriesError("allday-toggle-with-exceptions", "an all-day series with exceptions cannot become a timed one (or the reverse)");
  }
  const shifter = makeShifter(fromSpec, toSpec, zones);
  let changed = shiftUntil(master, fromSpec, toSpec, shifter, zones);
  for (const p of master.props("EXDATE")) changed = shiftExdateProp(master, p, shifter) || changed;
  for (const ov of overridesOf(root)) {
    const rp = ov.prop("RECURRENCE-ID");
    const rid = parseTime(rp.value, rp.params);
    const ridKey = idOf(timeInfo(rid, zones));
    const own = ov.prop("DTSTART");
    const follows = !!own && idOf(timeInfo(parseTime(own.value, own.params), zones)) === ridKey;
    const newRid = shifter.spec(rid);
    if (!sameSpec(newRid, rid)) {
      if (follows) {
        for (const n of ["DTSTART", "DTEND"]) {
          const p = ov.prop(n);
          if (p) setTimeProp(ov, n, shifter.spec(parseTime(p.value, p.params)));
        }
      }
      setTimeProp(ov, "RECURRENCE-ID", newRid);
      touch(ov);
      changed = true;
    }
  }
  if (changed) touch(master);
  return changed;
}

/**
 * "Delete this and all following": the series ends before the occurrence `ridSpec` (COUNT becomes
 * UNTIL, EXDATE/RDATE and overrides from that point on are removed with it). A wrapper over
 * splitSeries whose tail is discarded. Throws FieldError at the first occurrence (that is a
 * delete of the whole item).
 */
export function truncateSeries(root, ridSpec, { zones } = {}) {
  splitSeries(root, ridSpec, { zones, discardTail: true });
  return true;
}

// ---------------------------------------------------------------------------
// New events

/**
 * Build a new VCALENDAR with one VEVENT. `fields` are applyEventPatch keys.
 * UID and PRODID are set here and only here.
 */
export function createEvent(fields, { uid, prodid = DEFAULT_PRODID } = {}) {
  const id = uid || newUuid();
  if (!fields || !fields.start) throw new FieldError("a new event needs a start");
  const cal = new Component("VCALENDAR");
  cal.items.push(newProp("VERSION", "2.0"));
  cal.items.push(newProp("PRODID", encodeValue("PRODID", prodid)));
  const ev = new Component("VEVENT");
  ev.items.push(newProp("UID", encodeValue("UID", id)));
  cal.items.push(ev);
  ev.touched = true;
  applyEventPatch(ev, { ...fields }, {});
  return cal;
}

export { expandEvents };
