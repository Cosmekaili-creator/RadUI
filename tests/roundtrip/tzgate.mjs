// SPDX-License-Identifier: AGPL-3.0-or-later
// Reference for the time-zone gate (S13-lite, RUN3 D-R3-6, addendum M6): an independent, brute-force Intl
// implementation of "wall clock -> instant" with the RFC 5545 3.3.5 rules (a time in a gap uses the offset before
// the gap, an ambiguous time its first occurrence), and the wall times of the matrix. No tests in here.

const HOUR = 3600000;
const MIN = 60000;
const DAY = 86400000;

export const GATE_ZONES = Object.freeze([
  "Europe/Paris", "America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe", "America/Santiago", "Africa/Casablanca",
  "Pacific/Chatham", "America/Sao_Paulo", "Asia/Tehran", "Europe/London", "UTC",
]);

/** Zone name of the machine running the tests (the "browser-runner's zone"). */
export const runnerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Offset function (ms of the UTC offset in effect at instant ms) of an IANA zone, from Intl alone. */
export function intlOffset(timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  return (ms) => {
    const v = {};
    for (const p of dtf.formatToParts(new Date(ms))) v[p.type] = +p.value;
    return Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second) - Math.floor(ms / 1000) * 1000;
  };
}

/** The reference instant of wall clock `wallMs` (the wall time read as if it were UTC) in the zone of `off`. */
export function refInstant(off, wallMs) {
  const seen = [];
  for (let t = wallMs - 30 * HOUR; t <= wallMs + 30 * HOUR; t += 15 * MIN) seen.push({ t, o: off(t) });
  const offsets = [...new Set(seen.map((s) => s.o))];
  const valid = offsets.filter((o) => off(wallMs - o) === o);
  if (valid.length) return wallMs - Math.max(...valid);
  // a gap: the offset in effect just before the jump
  let before = seen[0].o;
  for (const s of seen) if (s.t + s.o < wallMs) before = s.o;
  return wallMs - before;
}

/** Transitions {instant, from, to} of a zone in [fromYear, toYear], found by scanning and bisecting. */
export function transitions(off, fromYear, toYear) {
  const out = [];
  let t = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear + 1, 0, 1);
  let prev = off(t);
  while (t < end) {
    const n = t + 6 * HOUR;
    const o = off(n);
    if (o !== prev) {
      let lo = t;
      let hi = n;
      while (hi - lo > 1000) {
        const mid = Math.floor((lo + hi) / 2000) * 1000;
        if (off(mid) === prev) lo = mid;
        else hi = mid;
      }
      out.push({ instant: hi, from: prev, to: o });
      prev = o;
    }
    t = n;
  }
  return out;
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 19);

/**
 * The wall times of the matrix of one zone: around every transition of 2024-2040 (quarter hours, from two hours
 * before to two hours after, in the old wall clock, so gaps and overlaps are both covered) and 40 generic times
 * spread over the same years. Returns [{iso, wallMs, why}].
 */
export function matrixWalls(off, { fromYear = 2024, toYear = 2040 } = {}) {
  const out = [];
  for (const tr of transitions(off, fromYear, toYear)) {
    const w = tr.instant + tr.from;
    for (let k = -8; k <= 8; k++) out.push({ wallMs: w + k * 15 * MIN, why: `transition ${iso(tr.instant)}Z ${tr.from / MIN}->${tr.to / MIN} min, ${k * 15} min` });
    const w2 = tr.instant + tr.to;
    for (let k = -4; k <= 4; k++) out.push({ wallMs: w2 + k * 15 * MIN, why: `transition ${iso(tr.instant)}Z in the new wall clock, ${k * 15} min` });
  }
  const span = Date.UTC(toYear + 1, 0, 1) - Date.UTC(fromYear, 0, 1);
  for (let i = 0; i < 40; i++) out.push({ wallMs: Date.UTC(fromYear, 0, 1) + Math.floor((i + 0.37) * (span / 40)) - (Math.floor((i + 0.37) * (span / 40)) % MIN) + (i % 7) * HOUR, why: `generic ${i}` });
  const seen = new Set();
  return out.filter((c) => (seen.has(c.wallMs) ? false : seen.add(c.wallMs))).map((c) => ({ ...c, iso: iso(c.wallMs) }));
}

/** 40 wall times of one zone for the per-event gate: around the transitions of five years, then generic ones. */
export function eventWalls(off) {
  const all = matrixWalls(off);
  const trs = transitions(off, 2024, 2040).filter((t) => [2024, 2026, 2029, 2034, 2040].includes(new Date(t.instant).getUTCFullYear()));
  const picked = [];
  for (const tr of trs) for (const k of [-2, 0, 2]) picked.push(tr.instant + tr.from + k * 15 * MIN, tr.instant + tr.to + k * 15 * MIN);
  const generic = all.filter((c) => c.why.startsWith("generic")).map((c) => c.wallMs);
  const out = [...new Set(picked)].slice(0, 40);
  for (const g of generic) if (out.length < 40) out.push(g);
  return out.map((ms) => new Date(ms).toISOString().slice(0, 19));
}

export { DAY, HOUR, MIN };
