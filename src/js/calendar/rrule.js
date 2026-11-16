// SPDX-License-Identifier: AGPL-3.0-or-later
// The recurrence builder's model (RUN3 D-R3-7). No DOM.
//
//   parseRule(text, startSpec, {zones})  -> {custom:false, state} | {custom:true, raw, reason}
//   buildRule(state, startSpec, {zones}) -> RRULE text
//   canonicalRule(text) / sameRule(a, b) -> comparison on the part map
//   defaultState(startSpec, freq) / withFreq(state, freq, startSpec)
//
// A rule is editable only when build(parse(rule)) equals the rule as a sorted part map (the
// comparison ignores part order, upper/lower case, the order of BYDAY and INTERVAL=1, which is the
// default). Everything else (BYSETPOS, BYHOUR, several BYMONTH, RSCALE, ordinal BYDAY in a weekly
// rule ...) is `custom`: shown and kept as it is, never re-emitted unless the user replaces it.
// UNTIL follows the DTSTART value type (RFC 5545 3.3.10); an UNTIL that the builder did not touch is
// re-emitted from its original text, so an untouched rule never changes.

import { ValueError, parseRRule } from "../model/contentlines.js";
import { SeriesError, untilDateOf, untilFor } from "../model/event.js";
import { FieldError } from "../model/writer.js";
import { dateMs, daysInMonth, weekdayOf } from "./grid.js";

export const WEEKDAYS = Object.freeze(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
export const FREQS = Object.freeze(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
export { untilFor, untilDateOf };

const DAY_RE = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const weekdayCode = (iso) => WEEKDAYS[weekdayOf(iso) - 1];

/** Part map of a rule as a canonical text: sorted keys, BYDAY sorted by weekday, INTERVAL=1 dropped. */
export function canonicalRule(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  let pairs;
  try {
    pairs = parseRRule(text.trim());
  } catch (e) {
    if (e instanceof ValueError) return text.trim().toUpperCase();
    throw e;
  }
  const out = [];
  for (const [k, v0] of pairs) {
    let v = v0.trim();
    if (k === "INTERVAL" && /^0*1$/.test(v)) continue;
    if (k === "BYDAY") {
      v = v
        .toUpperCase()
        .split(",")
        .map((s) => s.trim())
        .sort((a, b) => WEEKDAYS.indexOf(a.slice(-2)) - WEEKDAYS.indexOf(b.slice(-2)) || a.localeCompare(b))
        .join(",");
    } else if (k === "FREQ" || k === "WKST") v = v.toUpperCase();
    out.push(`${k}=${v}`);
  }
  return out.sort().join(";");
}

export const sameRule = (a, b) => canonicalRule(a) === canonicalRule(b);

/** A fresh builder state for a start (the day the series starts on drives the implicit parts). */
export function defaultState(startSpec, freq = "WEEKLY") {
  return withFreq({ freq: "DAILY", interval: 1, byday: [], monthly: "dom", bymonthday: null, nth: null, bymonth: null, end: { type: "never" }, wkst: null }, freq, startSpec);
}

/** "the nth weekday of the month" of a date: {n: 1..5, weekday:'TU', last: bool (it is also the last one)}. */
export function nthOf(iso) {
  const d = +iso.slice(8, 10);
  const n = Math.ceil(d / 7);
  const dim = daysInMonth(+iso.slice(0, 4), +iso.slice(5, 7));
  return { n, weekday: weekdayCode(iso), last: d + 7 > dim };
}

/** Switch the frequency, filling the parts the new one needs from the start date. */
export function withFreq(state, freq, startSpec) {
  const iso = startSpec && startSpec.iso ? startSpec.iso.slice(0, 10) : null;
  const next = { ...state, freq, byday: [], bymonthday: null, nth: null, bymonth: null, monthly: "dom" };
  if (!iso) return next;
  if (freq === "WEEKLY") next.byday = [weekdayCode(iso)];
  if (freq === "MONTHLY") {
    next.bymonthday = +iso.slice(8, 10);
    next.nth = { n: nthOf(iso).n, weekday: weekdayCode(iso) };
  }
  if (freq === "YEARLY") {
    next.bymonth = +iso.slice(5, 7);
    next.bymonthday = +iso.slice(8, 10);
    next.nth = { n: nthOf(iso).n, weekday: weekdayCode(iso) };
  }
  return next;
}

const custom = (raw, reason) => ({ custom: true, raw, reason });
const int = (s) => (/^\d{1,4}$/.test(s) ? +s : NaN);

/**
 * Parse an RRULE into builder state, or report it as custom. `startSpec` (TimeSpec of DTSTART) types
 * and reads UNTIL; `zones` (icalview createZones) resolves a zoned start.
 */
export function parseRule(text, startSpec, { zones } = {}) {
  const raw = String(text || "").trim();
  let pairs;
  try {
    pairs = parseRRule(raw);
  } catch (e) {
    if (e instanceof ValueError) return custom(raw, "unparsable");
    throw e;
  }
  const map = new Map();
  for (const [k, v] of pairs) {
    if (map.has(k)) return custom(raw, "duplicate-part");
    map.set(k, v.trim());
  }
  const allowed = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST", "BYDAY", "BYMONTHDAY", "BYMONTH"]);
  for (const k of map.keys()) if (!allowed.has(k)) return custom(raw, `part-${k.toLowerCase()}`);
  const freq = map.get("FREQ").toUpperCase();
  if (!FREQS.includes(freq)) return custom(raw, "frequency");
  const state = { freq, interval: 1, byday: [], monthly: "dom", bymonthday: null, nth: null, bymonth: null, end: { type: "never" }, wkst: null };
  if (map.has("INTERVAL")) {
    const n = int(map.get("INTERVAL"));
    if (!(n >= 1 && n <= 999)) return custom(raw, "interval");
    state.interval = n;
  }
  if (map.has("WKST")) {
    const w = map.get("WKST").toUpperCase();
    if (!WEEKDAYS.includes(w)) return custom(raw, "wkst");
    state.wkst = w;
  }
  if (map.has("COUNT") && map.has("UNTIL")) return custom(raw, "count-and-until");
  if (map.has("COUNT")) {
    const n = int(map.get("COUNT"));
    if (!(n >= 1)) return custom(raw, "count");
    state.end = { type: "count", count: n };
  }
  if (map.has("UNTIL")) {
    try {
      const rawUntil = map.get("UNTIL");
      const date = untilDateOf(rawUntil, startSpec, { zones });
      state.end = { type: "until", date, raw: rawUntil, rawDate: date };
    } catch (e) {
      if (e instanceof ValueError || e instanceof SeriesError) return custom(raw, "until");
      throw e;
    }
  }
  const byday = map.has("BYDAY") ? map.get("BYDAY").toUpperCase().split(",") : [];
  const dayParts = byday.map((s) => DAY_RE.exec(s.trim()));
  if (dayParts.some((m) => !m)) return custom(raw, "byday");
  const monthday = map.has("BYMONTHDAY") ? int(map.get("BYMONTHDAY")) : null;
  if (monthday !== null && !(monthday >= 1 && monthday <= 31)) return custom(raw, "bymonthday");
  const month = map.has("BYMONTH") ? int(map.get("BYMONTH")) : null;
  if (month !== null && !(month >= 1 && month <= 12)) return custom(raw, "bymonth");
  const ordinal = (m) => (m[1] === undefined ? null : parseInt(m[1], 10));
  const goodNth = (n) => n !== null && (n === -1 || (n >= 1 && n <= 5));

  if (freq === "DAILY") {
    if (byday.length || monthday !== null || month !== null) return custom(raw, "daily-parts");
  } else if (freq === "WEEKLY") {
    if (monthday !== null || month !== null || dayParts.some((m) => ordinal(m) !== null)) return custom(raw, "weekly-parts");
    const codes = dayParts.map((m) => m[2]);
    if (new Set(codes).size !== codes.length) return custom(raw, "byday");
    state.byday = WEEKDAYS.filter((d) => codes.includes(d));
  } else if (freq === "MONTHLY") {
    if (month !== null || (monthday !== null && byday.length) || byday.length > 1) return custom(raw, "monthly-parts");
    if (byday.length) {
      const n = ordinal(dayParts[0]);
      if (!goodNth(n)) return custom(raw, "byday");
      state.monthly = "nth";
      state.nth = { n, weekday: dayParts[0][2] };
    } else state.bymonthday = monthday;
  } else {
    if (byday.length > 1 || (monthday !== null && byday.length) || (month === null && (monthday !== null || byday.length))) {
      return custom(raw, "yearly-parts");
    }
    state.bymonth = month;
    if (byday.length) {
      const n = ordinal(dayParts[0]);
      if (!goodNth(n)) return custom(raw, "byday");
      state.monthly = "nth";
      state.nth = { n, weekday: dayParts[0][2] };
    } else state.bymonthday = monthday;
  }
  let rebuilt;
  try {
    rebuilt = buildRule(state, startSpec, { zones });
  } catch (e) {
    if (e instanceof FieldError || e instanceof ValueError) return custom(raw, "not-buildable");
    throw e;
  }
  if (canonicalRule(rebuilt) !== canonicalRule(raw)) return custom(raw, "not-exact");
  return { custom: false, state };
}

/** Validate a builder state; returns [] or a list of {field, code}. */
export function validateState(state, startSpec) {
  const errs = [];
  if (!FREQS.includes(state.freq)) errs.push({ field: "freq", code: "freq" });
  if (!Number.isInteger(state.interval) || state.interval < 1 || state.interval > 999) errs.push({ field: "interval", code: "interval" });
  if (state.freq === "WEEKLY" && (state.byday || []).some((d) => !WEEKDAYS.includes(d))) errs.push({ field: "byday", code: "byday" });
  if (state.end && state.end.type === "count" && !(Number.isInteger(state.end.count) && state.end.count >= 1 && state.end.count <= 9999)) {
    errs.push({ field: "end", code: "count" });
  }
  if (state.end && state.end.type === "until") {
    if (!DATE_RE.test(state.end.date || "")) errs.push({ field: "end", code: "until-invalid" });
    else {
      try {
        dateMs(state.end.date);
        if (startSpec && startSpec.iso && state.end.date < startSpec.iso.slice(0, 10)) errs.push({ field: "end", code: "until-before-start" });
      } catch {
        errs.push({ field: "end", code: "until-invalid" });
      }
    }
  }
  return errs;
}

/** Build the RRULE text of a builder state. Throws FieldError for an invalid state. */
export function buildRule(state, startSpec, { zones } = {}) {
  const errs = validateState(state, null);
  if (errs.length) throw new FieldError(`invalid recurrence: ${errs[0].code}`);
  const parts = [["FREQ", state.freq]];
  if (state.interval > 1) parts.push(["INTERVAL", String(state.interval)]);
  if (state.freq === "YEARLY" && state.bymonth) parts.push(["BYMONTH", String(state.bymonth)]);
  const nth = state.nth && state.monthly === "nth" ? `${state.nth.n}${state.nth.weekday}` : null;
  if (state.freq === "MONTHLY" || state.freq === "YEARLY") {
    if (nth && (state.freq === "MONTHLY" || state.bymonth)) parts.push(["BYDAY", nth]);
    else if (state.bymonthday && (state.freq === "MONTHLY" || state.bymonth)) parts.push(["BYMONTHDAY", String(state.bymonthday)]);
  }
  if (state.freq === "WEEKLY" && state.byday && state.byday.length) {
    parts.push(["BYDAY", WEEKDAYS.filter((d) => state.byday.includes(d)).join(",")]);
  }
  if (state.end && state.end.type === "count") parts.push(["COUNT", String(state.end.count)]);
  if (state.end && state.end.type === "until") {
    const untouched = state.end.raw && state.end.date === state.end.rawDate;
    parts.push(["UNTIL", untouched ? state.end.raw : untilFor(startSpec, state.end.date, { zones })]);
  }
  if (state.wkst) parts.push(["WKST", state.wkst]);
  return parts.map(([k, v]) => `${k}=${v}`).join(";");
}

/** Switch a monthly or yearly state between "day of month" and "nth weekday" using the start date. */
export function withMonthlyMode(state, mode, startSpec) {
  const iso = startSpec && startSpec.iso ? startSpec.iso.slice(0, 10) : null;
  const next = { ...state, monthly: mode === "nth" ? "nth" : "dom" };
  if (iso) {
    if (mode === "nth" && !next.nth) next.nth = { n: nthOf(iso).n, weekday: weekdayCode(iso) };
    if (mode !== "nth" && !next.bymonthday) next.bymonthday = +iso.slice(8, 10);
  }
  return next;
}
