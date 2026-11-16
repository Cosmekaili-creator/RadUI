// SPDX-License-Identifier: AGPL-3.0-or-later
// VTIMEZONE generator from Intl alone (RUN3 WP B5, plan D-R3-6 / addendum M6, RUN1 spike S13). Pure: no DOM, no
// network. The VTIMEZONE Radicale generates on PUT is wrong for several zones (docs/roundtrip.md, "Time-zone gate"),
// so every NEW TZID RadUI writes carries a VTIMEZONE of its own, built here from the browser's tz data.
//
// How a zone is described:
//   1. The offset transitions of the zone are FOUND with Intl.DateTimeFormat over a window of years
//      [fromYear, toYear] (a transition = two instants one second apart with different UTC offsets).
//   2. Transitions of the same kind (same offset change, month, wall-clock time) are grouped. A group becomes a
//      yearly RRULE (FREQ=YEARLY;BYMONTH=m;BYDAY=-1SU | nXX | XX;BYMONTHDAY=d..d+6 | BYMONTHDAY=d) only when a
//      single rule reproduces EVERY transition of a run of at least 4 consecutive years, and, for a rule that
//      reaches the end of the window (so it is open-ended), only when it also still matches Intl for 20+ more
//      years (probed instant by instant). Otherwise the transitions are written as explicit RDATE lists.
//   3. The model is expanded again and compared with the transitions found in step 1 (same instants, same
//      offsets); a mismatch falls back to RDATE lists for everything. The result is therefore exact for the window.
//
// Limits (documented in docs/calendar.md): an RDATE list ends with the window, after which the last offset stays
// in force (`info.openEnded === false`, `info.coveredThrough`); this concerns zones whose clock changes follow no
// yearly rule (Africa/Casablanca around Ramadan) or whose rule Intl itself changes inside the probe range. A zone
// with a rule that is open-ended is exact for the window and extrapolated by the rule beyond it.
//
// No X- properties are written. Existing VTIMEZONEs are never touched (`ensureVtimezones` only adds missing ones).

import { Component, parse } from "../model/contentlines.js";
import { foldLine } from "../model/writer.js";
import { intlAccepts, vtimezoneMap } from "../model/icalview.js";

const HOUR = 3600000;
const DAY = 86400000;
const SCAN_STEP = 8 * HOUR;
const MIN_RULE_RUN = 4;
const PROBE_YEARS = 20; // an open-ended rule must still match Intl this many years after the window
const MIN_SPAN_YEARS = 30; // ... and the window plus the probe covers at least this many years
const MIN_YEAR = 1900;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const pad = (n, w = 2) => String(n).padStart(w, "0");

// ---------------------------------------------------------------------------
// Intl access

const zoneCache = new Map();

function zoneOf(tzid) {
  let z = zoneCache.get(tzid);
  if (z) return z;
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tzid, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const off = (ms) => {
    const v = {};
    for (const p of dtf.formatToParts(new Date(ms))) v[p.type] = +p.value;
    return Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second) - Math.floor(ms / 1000) * 1000;
  };
  z = { tzid, off, years: new Map(), names: new Map() };
  zoneCache.set(tzid, z);
  return z;
}

/** The transitions {instant, from, to} whose instant lies in the UTC year `y`. Cached per zone and year. */
function transitionsOfYear(z, y) {
  if (z.years.has(y)) return z.years.get(y);
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  const out = [];
  let lo = start - 1000;
  let po = z.off(lo);
  while (lo < end - 1000) {
    const hi = Math.min(lo + SCAN_STEP, end - 1000);
    const o = z.off(hi);
    if (o !== po) {
      let a = lo;
      let b = hi;
      while (b - a > 1000) {
        const mid = a + Math.floor((b - a) / 2000) * 1000;
        if (z.off(mid) === po) a = mid;
        else b = mid;
      }
      // a transition inside the step can be followed by another one (rare); look for it from b on
      out.push({ instant: b, from: po, to: z.off(b) });
      po = z.off(b);
      lo = b;
      continue;
    }
    lo = hi;
  }
  const kept = out.filter((t) => t.instant >= start && t.instant < end);
  z.years.set(y, kept);
  return kept;
}

function transitionsBetween(z, y0, y1) {
  const out = [];
  for (let y = y0; y <= y1; y++) out.push(...transitionsOfYear(z, y));
  return out;
}

/** Abbreviation of the zone at an instant, when Intl has a real one (CET, EST, LHDT ...), else tzdata style (+1030). */
function nameAt(z, instant, offset) {
  const key = `${Math.floor(instant / DAY)}`;
  if (z.names.has(key)) return z.names.get(key);
  let name = null;
  for (const loc of ["en-US", "en-GB", "en-AU", "en-NZ", "en-ZA", "en-CA", "en-IN"]) {
    try {
      const parts = new Intl.DateTimeFormat(loc, { timeZone: z.tzid, timeZoneName: "short" }).formatToParts(new Date(instant));
      const n = (parts.find((p) => p.type === "timeZoneName") || {}).value || "";
      if (/^[A-Z]{2,6}$/.test(n)) {
        name = n;
        break;
      }
    } catch {
      /* try the next locale */
    }
  }
  if (!name) {
    const s = Math.abs(offset) / 1000;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    name = `${offset < 0 ? "-" : "+"}${pad(h)}${m ? pad(m) : ""}`;
  }
  z.names.set(key, name);
  return name;
}

// ---------------------------------------------------------------------------
// Dates

const offsetText = (ms) => {
  const s = Math.abs(Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${ms < 0 ? "-" : "+"}${pad(h)}${pad(m)}${sec ? pad(sec) : ""}`;
};

const wallText = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

const utcText = (ms) => `${wallText(ms)}Z`;
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

/** The description of a transition in its own wall clock (the clock before the change). */
function describe(t) {
  const wall = t.instant + t.from;
  const d = new Date(wall);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return { ...t, wall, year, month, day: d.getUTCDate(), wd: d.getUTCDay(), dim: dim(year, month), tod: wall - Date.UTC(year, month - 1, d.getUTCDate()) };
}

// ---------------------------------------------------------------------------
// Rule candidates

// L: last `w` of the month; A: the first `w` on or after day d (covers "2nd Sunday" with d = 8); F: day d of the month.
const allCandidates = () => {
  const out = [];
  for (let w = 0; w < 7; w++) out.push({ type: "L", w });
  for (let w = 0; w < 7; w++) for (let d = 1; d <= 25; d++) out.push({ type: "A", w, d });
  for (let d = 1; d <= 31; d++) out.push({ type: "F", d });
  return out;
};

const satisfies = (c, t) => {
  if (c.type === "L") return t.wd === c.w && t.day + 7 > t.dim;
  if (c.type === "A") return t.wd === c.w && t.day >= c.d && t.day <= c.d + 6;
  return t.day === c.d;
};

/** The day of month a candidate predicts in (year, month), or 0 when it does not occur. */
function predictedDay(c, year, month) {
  const n = dim(year, month);
  if (c.type === "F") return c.d <= n ? c.d : 0;
  if (c.type === "L") {
    for (let d = n; d > n - 7; d--) if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === c.w) return d;
    return 0;
  }
  for (let d = c.d; d <= c.d + 6; d++) if (d <= n && new Date(Date.UTC(year, month - 1, d)).getUTCDay() === c.w) return d;
  return 0;
}

// the preferred candidate of a feasible set: last-weekday, nth weekday, weekday on or after d, fixed day
const rank = (c) => (c.type === "L" ? 0 : c.type === "A" && (c.d - 1) % 7 === 0 ? 1 : c.type === "A" ? 2 : 3);
const pickCandidate = (set) => [...set].sort((a, b) => rank(a) - rank(b) || (a.d || 0) - (b.d || 0) || (a.w || 0) - (b.w || 0))[0];

function ruleText(c, month) {
  const base = `FREQ=YEARLY;BYMONTH=${month}`;
  if (c.type === "L") return `${base};BYDAY=-1${WEEKDAYS[c.w]}`;
  if (c.type === "A") {
    if ((c.d - 1) % 7 === 0) return `${base};BYDAY=${(c.d - 1) / 7 + 1}${WEEKDAYS[c.w]}`;
    return `${base};BYDAY=${WEEKDAYS[c.w]};BYMONTHDAY=${Array.from({ length: 7 }, (_, i) => c.d + i).join(",")}`;
  }
  return `${base};BYMONTHDAY=${c.d}`;
}

// ---------------------------------------------------------------------------
// The model

/**
 * Observances of a zone from its transitions `all` (described, sorted) in [y0, y1].
 * open: allow open-ended rules (checked by probing); returns {obs, ok} where ok is false when a rule that reaches
 * the end of the window failed the probe (the caller then widens the window and calls again with open = false).
 */
function buildObservances(z, all, y0, y1, { open, rules = true }) {
  const label = (i) => {
    const t = all[i];
    if (t.to <= t.from) return "STANDARD";
    const next = all[i + 1];
    const prev = all[i - 1];
    if (next && next.to === t.from && next.instant - t.instant < 400 * DAY) return "DAYLIGHT";
    if (prev && prev.from === t.to && prev.to === t.from && t.instant - prev.instant < 400 * DAY) return "DAYLIGHT";
    return "STANDARD";
  };
  const groups = new Map();
  all.forEach((t, i) => {
    t.label = label(i);
    const key = `${t.label}|${t.from}|${t.to}|${t.month}|${t.tod}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });

  const obs = [];
  const leftovers = [];
  let ok = true;
  const candidates = allCandidates();
  for (const list of groups.values()) {
    // runs of consecutive years on which one rule fits
    let i = 0;
    while (i < list.length) {
      let set = candidates.filter((c) => satisfies(c, list[i]));
      let j = i + 1;
      while (j < list.length && list[j].year === list[j - 1].year + 1) {
        const next = set.filter((c) => satisfies(c, list[j]));
        if (!next.length) break;
        set = next;
        j++;
      }
      const run = list.slice(i, j);
      i = j;
      if (!rules || run.length < MIN_RULE_RUN) {
        leftovers.push(...run);
        continue;
      }
      const first = run[0];
      const last = run[run.length - 1];
      const reachesEnd = last.year >= y1 && j >= list.length;
      let cand = null;
      let openEnded = false;
      if (reachesEnd && open) {
        // the rule must keep matching Intl after the window (probe instant by instant)
        const upto = Math.max(y1 + PROBE_YEARS, y0 + MIN_SPAN_YEARS);
        const alive = set.filter((c) => {
          for (let y = y1 + 1; y <= upto; y++) {
            const d = predictedDay(c, y, first.month);
            if (!d) return false;
            const wall = Date.UTC(y, first.month - 1, d) + first.tod;
            const at = wall - first.from;
            if (z.off(at - 1000) !== first.from || z.off(at) !== first.to) return false;
          }
          return true;
        });
        if (alive.length) {
          cand = pickCandidate(alive);
          openEnded = true;
        } else ok = false;
      } else cand = pickCandidate(set);
      if (!cand) {
        leftovers.push(...run);
        continue;
      }
      obs.push({
        label: first.label,
        from: first.from,
        to: first.to,
        dtstart: first.wall,
        instant: first.instant,
        name: nameAt(z, first.instant, first.to),
        rule: { cand, month: first.month, tod: first.tod, year0: first.year, year1: openEnded ? null : last.year, until: openEnded ? null : last.instant },
        rdates: [],
      });
    }
  }
  // explicit onsets: one observance per kind of offset change
  const byKind = new Map();
  for (const t of leftovers.sort((a, b) => a.instant - b.instant)) {
    const key = `${t.label}|${t.from}|${t.to}`;
    if (!byKind.has(key)) byKind.set(key, []);
    byKind.get(key).push(t);
  }
  for (const list of byKind.values()) {
    const first = list[0];
    obs.push({ label: first.label, from: first.from, to: first.to, dtstart: first.wall, instant: first.instant, name: nameAt(z, first.instant, first.to), rule: null, rdates: list.slice(1).map((t) => t.wall) });
  }
  obs.sort((a, b) => a.instant - b.instant);
  return { obs, ok };
}

/** The onsets {instant, from, to} a list of observances produces up to UTC year `maxYear` (verification, tests). */
export function expandObservances(obs, maxYear) {
  const out = [];
  for (const o of obs) {
    out.push({ instant: o.dtstart - o.from, from: o.from, to: o.to });
    for (const w of o.rdates) out.push({ instant: w - o.from, from: o.from, to: o.to });
    if (o.rule) {
      const last = o.rule.year1 === null ? maxYear : Math.min(o.rule.year1, maxYear);
      for (let y = o.rule.year0 + 1; y <= last; y++) {
        const d = predictedDay(o.rule.cand, y, o.rule.month);
        if (d) out.push({ instant: Date.UTC(y, o.rule.month - 1, d) + o.rule.tod - o.from, from: o.from, to: o.to });
      }
    }
  }
  return out.sort((a, b) => a.instant - b.instant);
}

const sameOnsets = (a, b) => a.length === b.length && a.every((t, i) => t.instant === b[i].instant && t.from === b[i].from && t.to === b[i].to);

// ---------------------------------------------------------------------------
// Text

function observanceLines(o) {
  const lines = [`BEGIN:${o.label}`, `DTSTART:${wallText(o.dtstart)}`, `TZOFFSETFROM:${offsetText(o.from)}`, `TZOFFSETTO:${offsetText(o.to)}`];
  if (o.name) lines.push(`TZNAME:${o.name}`);
  if (o.rule) {
    lines.push(`RRULE:${ruleText(o.rule.cand, o.rule.month)}${o.rule.until === null ? "" : `;UNTIL=${utcText(o.rule.until)}`}`);
  }
  // one RDATE line per onset: Radicale (vobject) keeps only the first value of a comma-separated RDATE in a VTIMEZONE
  for (const w of o.rdates) lines.push(`RDATE:${wallText(w)}`);
  lines.push(`END:${o.label}`);
  return lines;
}

/**
 * Generate the VTIMEZONE of an IANA zone.
 * @param {string} tzid a name Intl accepts (anything else throws RangeError)
 * @param {{fromYear?: number, toYear?: number}} [window] years the events use: transitions are searched from
 *   `fromYear` to `toYear` (default: this year -1 to +10). Times before `fromYear` get the offset in force on 1 January of it.
 * @returns {{tzid, lines, text, observances, info}} `text` has LF line ends and no final line end (the lines are
 *   folded at 75 octets); info = {form: 'constant'|'rules'|'rdates'|'mixed', openEnded, coveredThrough, fromYear, transitions}.
 */
export function generateVtimezone(tzid, { fromYear, toYear } = {}) {
  if (!intlAccepts(tzid)) throw new RangeError(`unknown time zone ${tzid}`);
  const now = new Date().getUTCFullYear();
  let y0 = Math.max(MIN_YEAR, Math.floor(fromYear === undefined ? now - 1 : fromYear));
  let y1 = Math.max(y0 + 10, Math.floor(toYear === undefined ? y0 + 11 : toYear));
  const z = zoneOf(tzid);
  const baseline = z.off(Date.UTC(y0, 0, 1) - 1000);

  const attempt = (y1x, opts) => {
    const all = transitionsBetween(z, y0, y1x).map(describe);
    const built = buildObservances(z, all, y0, y1x, opts);
    return { all, ...built };
  };
  let end = y1;
  let res = attempt(end, { open: true });
  if (!res.ok) {
    // an open-ended rule stopped matching Intl after the window: widen the window and write what follows explicitly
    end = Math.max(y1 + PROBE_YEARS, y0 + MIN_SPAN_YEARS);
    res = attempt(end, { open: false });
  }
  const check = (r) => sameOnsets(expandObservances(r.obs, end), r.all.map((t) => ({ instant: t.instant, from: t.from, to: t.to })));
  if (!check(res)) res = attempt(end, { open: false, rules: false }); // a rule that does not reproduce Intl is never written
  const openEnded = res.obs.some((o) => o.rule && o.rule.year1 === null);

  // the clock in force before the first change is a daylight clock when that change goes back to standard time
  const f0 = res.all[0];
  const baseLabel = f0 && f0.label === "STANDARD" && f0.from > f0.to && res.all[1] && res.all[1].to === f0.from ? "DAYLIGHT" : "STANDARD";
  const base = { label: baseLabel, from: baseline, to: baseline, dtstart: Date.UTC(y0, 0, 1), instant: Date.UTC(y0, 0, 1) - baseline, name: nameAt(z, Date.UTC(y0, 0, 1), baseline), rule: null, rdates: [] };
  const observances = [base, ...res.obs];
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  for (const o of observances) lines.push(...observanceLines(o));
  lines.push("END:VTIMEZONE");
  const hasRules = res.obs.some((o) => o.rule);
  const hasLists = res.obs.some((o) => !o.rule);
  const info = {
    form: !res.obs.length ? "constant" : hasRules && hasLists ? "mixed" : hasRules ? "rules" : "rdates",
    openEnded: openEnded || !res.obs.length, // a constant offset never changes
    coveredThrough: end,
    fromYear: y0,
    transitions: res.all.length,
  };
  const folded = lines.map(foldLine);
  return { tzid, lines, text: folded.join("\n"), observances, info };
}

/** The VTIMEZONE as a parsed component (clean lines, ready to insert in a calendar tree). */
export function vtimezoneComponent(tzid, window) {
  const g = generateVtimezone(tzid, window);
  const [comp] = parse(g.text + "\n");
  return { component: comp, info: g.info, tzid };
}

// ---------------------------------------------------------------------------
// Wiring into a calendar item

const TIME_PROPS = new Set(["DTSTART", "DTEND", "DUE", "RECURRENCE-ID", "EXDATE", "RDATE", "COMPLETED"]);

/** Last year a recurrence rule can reach (a rough upper bound; unbounded rules count `unbounded` years). */
function ruleEndYear(rr, startYear, unbounded = 30) {
  const parts = Object.fromEntries(rr.value.split(";").map((p) => p.split("=")));
  if (parts.UNTIL && /^\d{4}/.test(parts.UNTIL)) return +parts.UNTIL.slice(0, 4);
  if (parts.COUNT) {
    const n = Math.max(1, +parts.COUNT) * Math.max(1, +parts.INTERVAL || 1);
    const per = { SECONDLY: 1e9, MINUTELY: 1e7, HOURLY: 1e5, DAILY: 365, WEEKLY: 52, MONTHLY: 12, YEARLY: 1 }[parts.FREQ] || 1;
    return startYear + Math.ceil(n / per) + 1;
  }
  return startYear + unbounded;
}

/** Map of TZID to {min, max}: the years the item's time properties with that TZID cover (series included). */
export function tzidSpans(root) {
  const spans = new Map();
  const visit = (comp) => {
    const here = new Map();
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of comp.properties) {
      const ids = p.paramValues("TZID");
      if (!ids.length || !TIME_PROPS.has(p.key)) {
        for (const id of ids) if (!here.has(id)) here.set(id, true);
        continue;
      }
      for (const part of p.value.split(",")) {
        const y = /^\d{4}/.test(part.trim()) ? +part.trim().slice(0, 4) : NaN;
        if (Number.isFinite(y)) {
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
      for (const id of ids) here.set(id, true);
    }
    const rr = comp.prop("RRULE");
    if (rr && Number.isFinite(lo)) hi = Math.max(hi, ruleEndYear(rr, lo));
    for (const id of here.keys()) {
      const cur = spans.get(id);
      const a = Number.isFinite(lo) ? lo : new Date().getUTCFullYear();
      const b = Number.isFinite(hi) ? hi : a;
      spans.set(id, cur ? { min: Math.min(cur.min, a), max: Math.max(cur.max, b) } : { min: a, max: b });
    }
    for (const c of comp.components) if (c.key !== "VTIMEZONE") visit(c);
  };
  visit(root);
  return spans;
}

/**
 * Add a generated VTIMEZONE for every TZID the item references that has none (an existing VTIMEZONE is never
 * modified, replaced or removed, even when it disagrees with Intl). `skip` is a Set of TZIDs to leave alone
 * (the ones the item already referenced when it was read: an edit that does not change a zone never adds one).
 * A TZID Intl does not accept is left alone (the item is then read-only anyway). Mutates `root` (callers pass the
 * clone they are about to serialise).
 * @returns {Array<{tzid, form, openEnded, coveredThrough}>} what was added
 */
export function ensureVtimezones(root, { skip = new Set() } = {}) {
  const have = vtimezoneMap(root);
  const added = [];
  for (const [tzid, span] of tzidSpans(root)) {
    if (have.has(tzid) || skip.has(tzid) || !intlAccepts(tzid)) continue;
    const { component, info } = vtimezoneComponent(tzid, { fromYear: span.min - 1, toYear: span.max + 10 });
    let at = -1;
    for (let i = 0; i < root.items.length; i++) {
      const n = root.items[i];
      if (n instanceof Component && n.key === "VTIMEZONE") at = i;
    }
    if (at < 0) {
      at = root.items.findIndex((n) => n instanceof Component);
      at = at < 0 ? root.items.length : at - 1;
    }
    root.items.splice(at + 1, 0, component);
    added.push({ tzid, form: info.form, openEnded: info.openEnded, coveredThrough: info.coveredThrough });
  }
  return added;
}
