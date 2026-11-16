// SPDX-License-Identifier: AGPL-3.0-or-later
// READ-ONLY view of an iCalendar item. ical.js (vendored, MPL-2.0) is used here
// for recurrence-rule iteration, DURATION parsing and time arithmetic; it is
// never used to write anything (decision D6) and never sees vCard data.
//
// Time zones (decision D7):
//  - a TZID with an embedded VTIMEZONE is interpreted from that VTIMEZONE: its
//    STANDARD/DAYLIGHT onsets are generated with ical.js' RecurIterator and
//    resolved with the rules of RFC 5545 section 3.3.5 (a wall-clock time in a
//    gap uses the offset before the gap, an ambiguous one the first
//    occurrence). ICAL.Timezone itself is not used for the conversion because
//    it resolves gaps and overlaps the other way round;
//  - a TZID without VTIMEZONE that Intl accepts is converted with Intl;
//  - any other TZID has no instant (instant === null, tzClass 'unknown') and is
//    never treated as floating.
// Recurrences are expanded on wall-clock time (as the RFC defines them) and
// then converted to instants.

import ICAL from "../../vendor/ical.js/2.2.1/ical.min.js";
import {
  ValueError,
  parseDuration,
  parseTime,
  specFromWallMs,
  specWallMs,
  unescapeText,
} from "./contentlines.js";

const HOUR = 3600000;
const DAY = 86400000;

// ---------------------------------------------------------------------------
// Zones

/** Build {offsetAtInstant, instantFromWall, wallFromInstant} from an offset function (ms to ms). */
function makeZone(offsetAtInstant, extra) {
  return {
    ...extra,
    offsetAtInstant,
    instantFromWall(wallMs) {
      const o1 = offsetAtInstant(wallMs - 36 * HOUR); // offset before any nearby change
      const o2 = offsetAtInstant(wallMs + 36 * HOUR); // offset after it
      const cands = o1 === o2 ? [o1] : [o1, o2];
      const valid = cands.filter((o) => offsetAtInstant(wallMs - o) === o);
      if (!valid.length) return wallMs - o1; // gap: offset before the gap
      return wallMs - Math.max(...valid); // overlap: first occurrence
    },
    wallFromInstant(ms) {
      return ms + offsetAtInstant(ms);
    },
  };
}

/** True when the runtime's Intl knows this zone name (offset-style names are refused for determinism). */
export function intlAccepts(tzid) {
  if (!tzid || /^[+-]\d/.test(tzid)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

function intlZone(tzid) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const offsetAtInstant = (ms) => {
    const v = {};
    for (const p of dtf.formatToParts(new Date(ms))) v[p.type] = +p.value;
    const wall = Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second);
    return wall - Math.floor(ms / 1000) * 1000;
  };
  return makeZone(offsetAtInstant, { tzClass: "intl", tzid });
}

function parseOffset(text) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((text || "").trim());
  if (!m) throw new ValueError(`invalid UTC offset ${text}`);
  const s = (+m[2] * 3600 + +m[3] * 60 + +(m[4] || 0)) * 1000;
  return m[1] === "-" ? -s : s;
}

const wallOfIcal = (t) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
const icalTime = (ms, isDate = false) => {
  const d = new Date(ms);
  return ICAL.Time.fromData({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: isDate ? 0 : d.getUTCHours(),
    minute: isDate ? 0 : d.getUTCMinutes(),
    second: isDate ? 0 : d.getUTCSeconds(),
    isDate,
  });
};

/** Onsets {instant, to, from} of a VTIMEZONE up to `maxYear`, sorted. */
function vtimezoneTransitions(vtz, maxYear) {
  const out = [];
  for (const sub of vtz.components) {
    const k = sub.key;
    if (k !== "STANDARD" && k !== "DAYLIGHT") continue;
    const ds = sub.prop("DTSTART");
    const fromP = sub.prop("TZOFFSETFROM");
    const toP = sub.prop("TZOFFSETTO");
    if (!ds || !fromP || !toP) continue;
    const from = parseOffset(fromP.value);
    const to = parseOffset(toP.value);
    const startWall = specWallMs(parseTime(ds.value, []));
    const add = (wall) => out.push({ instant: wall - from, to, from });
    const rr = sub.prop("RRULE");
    if (!rr) add(startWall);
    else {
      const recur = ICAL.Recur.fromString(rr.value);
      let untilInstant = Infinity;
      if (recur.until) {
        const w = wallOfIcal(recur.until);
        untilInstant = recur.until.zone && recur.until.zone.tzid === "UTC" ? w : w - from;
        recur.until = null;
      }
      const it = recur.iterator(icalTime(startWall));
      for (let n = 0; n < 1000; n++) {
        const t = it.next();
        if (!t || t.year > maxYear) break;
        const wall = wallOfIcal(t);
        if (wall - from > untilInstant) break;
        add(wall);
      }
    }
    for (const r of sub.props("RDATE")) {
      for (const part of r.value.split(",")) {
        try {
          add(specWallMs(parseTime(part.split("/")[0], [])));
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
        }
      }
    }
  }
  out.sort((a, b) => a.instant - b.instant);
  return out;
}

function embeddedZone(vtz, tzid) {
  let upto = 0;
  let trans = [];
  const ensure = (year) => {
    if (year > upto) {
      upto = Math.max(year + 2, 2040);
      trans = vtimezoneTransitions(vtz, upto);
    }
  };
  const offsetAtInstant = (ms) => {
    ensure(new Date(ms).getUTCFullYear());
    if (!trans.length) return 0;
    let lo = -1;
    for (let i = 0; i < trans.length; i++) {
      if (trans[i].instant <= ms) lo = i;
      else break;
    }
    return lo < 0 ? trans[0].from : trans[lo].to;
  };
  return makeZone(offsetAtInstant, { tzClass: "embedded", tzid });
}

/** Map of TZID to VTIMEZONE component for a parsed VCALENDAR. */
export function vtimezoneMap(root) {
  const map = new Map();
  for (const v of root.comps("VTIMEZONE")) {
    const t = v.prop("TZID");
    if (t) map.set(unescapeText(t.value).trim(), v);
  }
  return map;
}

const usable = new WeakMap();

/** A VTIMEZONE is usable when its onsets can be computed (a broken one counts as absent). */
function vtimezoneUsable(vtz) {
  if (!usable.has(vtz)) {
    let ok = false;
    try {
      ok = vtimezoneTransitions(vtz, new Date().getUTCFullYear() + 2).length > 0;
    } catch {
      ok = false;
    }
    usable.set(vtz, ok);
  }
  return usable.get(vtz);
}

/** Classify one TZID: 'embedded' | 'intl' | 'unknown' (decision D7). */
export function classifyTzid(tzid, vtzMap) {
  if (vtzMap && vtzMap.has(tzid) && vtimezoneUsable(vtzMap.get(tzid))) return "embedded";
  return intlAccepts(tzid) ? "intl" : "unknown";
}

/** Zone lookup for one item. get(tzid) is null for an unknown TZID. */
export function createZones(root) {
  const vtz = vtimezoneMap(root);
  const cache = new Map();
  return {
    vtz,
    classify: (tzid) => classifyTzid(tzid, vtz),
    get(tzid) {
      if (cache.has(tzid)) return cache.get(tzid);
      const c = classifyTzid(tzid, vtz);
      let z = null;
      if (c === "embedded") z = embeddedZone(vtz.get(tzid), tzid);
      else if (c === "intl") z = intlZone(tzid);
      cache.set(tzid, z);
      return z;
    },
  };
}

// ---------------------------------------------------------------------------
// Time values

/**
 * TimeInfo of a TimeSpec: {kind, tzid, iso, wallMs, instant, tzClass}.
 * instant is null for dates, floating times and unknown zones.
 */
export function timeInfo(spec, zones) {
  const wallMs = specWallMs(spec);
  const base = { kind: spec.kind, iso: spec.iso, wallMs, instant: null, tzid: spec.tzid || null, tzClass: null };
  if (spec.kind === "utc") return { ...base, instant: wallMs, tzClass: "utc" };
  if (spec.kind === "zoned") {
    const z = zones.get(spec.tzid);
    if (!z) return { ...base, tzClass: "unknown" };
    return { ...base, instant: z.instantFromWall(wallMs), tzClass: z.tzClass };
  }
  return base;
}

/** Back to a TimeSpec ({kind, iso, tzid}). */
export function specFromInfo(info) {
  return info.kind === "zoned" ? { kind: info.kind, iso: info.iso, tzid: info.tzid } : { kind: info.kind, iso: info.iso };
}

/** The number to order/compare an info by (instant, else wall clock). */
export const sortMs = (info) => (info.instant !== null ? info.instant : info.wallMs);

function readSpec(prop) {
  return parseTime(prop.value, prop.params);
}

/** Split a possibly multi-valued RDATE/EXDATE property into TimeSpecs (PERIODs use their start). */
function specsOf(prop) {
  return prop.value
    .split(",")
    .filter(Boolean)
    .map((v) => parseTime(v.split("/")[0], prop.params));
}

// ---------------------------------------------------------------------------
// Events

function infoKey(info) {
  return info.instant !== null ? `i${info.instant}` : `w${info.wallMs}${info.tzid || ""}`;
}

/** Duration/end model of one VEVENT: start info, nominal duration in seconds, end zone. */
export function eventModel(comp, zones) {
  const ds = comp.prop("DTSTART");
  if (!ds) throw new ValueError("VEVENT without DTSTART");
  const startSpec = readSpec(ds);
  const start = timeInfo(startSpec, zones);
  const de = comp.prop("DTEND") || comp.prop("DUE");
  const du = comp.prop("DURATION");
  let durationSec = start.kind === "date" ? 86400 : 0;
  let endKind = start.kind;
  let endTzid = start.tzid;
  if (de) {
    const endSpec = readSpec(de);
    const end = timeInfo(endSpec, zones);
    endKind = end.kind;
    endTzid = end.tzid;
    if (start.kind === "date" && end.kind === "date") durationSec = (end.wallMs - start.wallMs) / 1000;
    else if (start.instant !== null && end.instant !== null) durationSec = (end.instant - start.instant) / 1000;
    else durationSec = (end.wallMs - start.wallMs) / 1000;
  } else if (du) {
    durationSec = parseDuration(du.value);
  }
  return { start, durationSec, endKind, endTzid };
}

/** End TimeInfo of an occurrence that starts at `start` (a TimeInfo), given the master's eventModel. */
export function occurrenceEnd(start, model, zones) {
  return endFor(start, model, zones);
}

function endFor(start, model, zones) {
  const dur = model.durationSec * 1000;
  if (start.kind === "date") return timeInfo(specFromWallMs(start.wallMs + dur, "date"), zones);
  if (start.instant !== null) {
    const instant = start.instant + dur;
    if (model.endKind === "zoned" && model.endTzid) {
      const z = zones.get(model.endTzid);
      if (z) {
        return timeInfo(specFromWallMs(z.wallFromInstant(instant), "zoned", model.endTzid), zones);
      }
    }
    return timeInfo(specFromWallMs(instant, "utc"), zones);
  }
  return timeInfo(specFromWallMs(start.wallMs + dur, start.kind, start.tzid), zones);
}

function ridInfo(comp, zones) {
  const p = comp.prop("RECURRENCE-ID");
  return p ? timeInfo(readSpec(p), zones) : null;
}

const occurrence = (start, end, source, component, recurrenceId) => ({
  start,
  end,
  allDay: start.kind === "date",
  source,
  component,
  recurrenceId,
});

/**
 * Expand the VEVENTs of a VCALENDAR component tree into occurrences.
 * options: {from, to (ms instants), limit, zones}. Floating and all-day values
 * are compared by their wall clock as if it were UTC, so callers pad the window
 * by a day on both sides. With neither `to` nor an end of the rule the
 * expansion stops at `limit` (default 2000).
 * Returns {occurrences: [...sorted], truncated}.
 */
export function expandEvents(root, { from = -Infinity, to = Infinity, limit = 2000, zones } = {}) {
  zones = zones || createZones(root);
  const vevents = root.comps("VEVENT");
  const master = vevents.find((c) => !c.prop("RECURRENCE-ID")) || null;
  const overrides = vevents.filter((c) => c.prop("RECURRENCE-ID"));
  const out = [];
  let truncated = false;
  const inWindow = (o) => {
    const s = sortMs(o.start);
    const e = sortMs(o.end);
    return s < to && (e > from || s >= from);
  };

  const ovByKey = new Map();
  for (const ov of overrides) ovByKey.set(infoKey(ridInfo(ov, zones)), ov);
  const usedOverrides = new Set();

  const fromOverride = (ov) => {
    const m = eventModel(ov, zones);
    return occurrence(m.start, endFor(m.start, m, zones), "override", ov, ridInfo(ov, zones));
  };

  if (master) {
    const model = eventModel(master, zones);
    const first = model.start;
    const exKeys = new Set();
    const exDays = new Set();
    for (const p of master.props("EXDATE")) {
      for (const s of specsOf(p)) {
        const i = timeInfo(s, zones);
        if (i.kind === "date" && first.kind !== "date") exDays.add(Math.floor(i.wallMs / DAY));
        else exKeys.add(infoKey(i));
      }
    }
    const excluded = (info) => exKeys.has(infoKey(info)) || (exDays.size > 0 && exDays.has(Math.floor(info.wallMs / DAY)));

    const walls = [];
    const rr = master.prop("RRULE");
    if (rr) {
      const recur = ICAL.Recur.fromString(rr.value);
      let untilWall = Infinity;
      if (recur.until) {
        untilWall = wallOfIcal(recur.until);
        if (recur.until.isDate) untilWall += DAY - 1;
        recur.until = null;
      }
      const hasUtcUntil = untilWall !== Infinity && /UNTIL=\d{8}T\d{6}Z/i.test(rr.value);
      const it = recur.iterator(icalTime(first.wallMs, first.kind === "date"));
      for (let n = 0; n < 60000; n++) {
        const t = it.next();
        if (!t) break;
        const wall = wallOfIcal(t);
        const info = timeInfo(specFromWallMs(wall, first.kind, first.tzid), zones);
        if (hasUtcUntil && first.instant !== null ? info.instant > untilWall : wall > untilWall) break;
        if (sortMs(info) - DAY * 2 > to) break;
        walls.push(info);
        if (walls.length >= limit * 4) break;
      }
    } else {
      walls.push(first);
    }
    for (const p of master.props("RDATE")) {
      for (const s of specsOf(p)) {
        const i = timeInfo(s, zones);
        walls.push({ ...i, rdate: true });
      }
    }
    walls.sort((a, b) => sortMs(a) - sortMs(b));
    const seen = new Set();
    for (const info of walls) {
      const key = infoKey(info);
      if (seen.has(key)) continue;
      seen.add(key);
      const ov = ovByKey.get(key);
      if (ov) {
        usedOverrides.add(ov);
        const o = fromOverride(ov);
        if (inWindow(o)) out.push(o);
        continue;
      }
      if (excluded(info)) continue;
      const o = occurrence(info, endFor(info, model, zones), info.rdate ? "rdate" : rr ? "series" : "single", master, null);
      if (inWindow(o)) out.push(o);
    }
  }
  for (const ov of overrides) {
    if (usedOverrides.has(ov)) continue;
    const o = fromOverride(ov);
    if (inWindow(o)) out.push(o);
  }
  out.sort((a, b) => sortMs(a.start) - sortMs(b.start));
  if (out.length > limit) {
    out.length = limit;
    truncated = true;
  }
  return { occurrences: out, truncated };
}

/** Number of occurrences of the master series that start before `beforeInfo` (used when splitting a COUNT series). */
export function countBefore(root, beforeInfo, zones) {
  zones = zones || createZones(root);
  const master = root.comps("VEVENT").find((c) => !c.prop("RECURRENCE-ID"));
  const rr = master.prop("RRULE");
  const first = eventModel(master, zones).start;
  if (!rr) return 1;
  const recur = ICAL.Recur.fromString(rr.value);
  recur.until = null;
  const it = recur.iterator(icalTime(first.wallMs, first.kind === "date"));
  let n = 0;
  for (let i = 0; i < 60000; i++) {
    const t = it.next();
    if (!t) break;
    if (wallOfIcal(t) >= beforeInfo.wallMs) break;
    n++;
  }
  return n;
}
