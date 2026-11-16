// SPDX-License-Identifier: AGPL-3.0-or-later
// Where occurrences go on the grid (RUN3 WP B1). No DOM. An "entry" is anything with
// {start, end, allDay} where start and end are icalview TimeInfos (what Item.expand returns, plus
// whatever the store adds); the original object is returned as `occ` so views can key their nodes.
//
// Everything is drawn in the display zone `tz`:
//  - an instant is converted to the wall clock of that zone (DST days keep 1440 grid minutes: the grid
//    is a wall clock, a spring-forward day simply has no entry between the skipped hours);
//  - all-day and floating values are NOT shifted (their wall clock is used as it is);
//  - an unknown zone is drawn at its own wall clock and flagged `unknownZone` (never treated as floating);
//  - a timed entry that crosses midnight is split at midnight of the display zone.
//
//   displayTimes(entry, tz)                       {allDay, startWall, endWall, unknownZone}
//   layoutDay(entries, dayIso, tz, opts)          {allDay[], timed[{occ,startMin,endMin,lane,lanes,contStart,contEnd}]}
//   layoutAllDayRow(entries, days, tz)            {items[{occ,col,span,row,contStart,contEnd}], rows}
//   monthCells(range, entries, tz, opts)          [{date, inMonth, today, chips[], more, total}]
//   nowMarker(days, now, tz)                      {date, dayIndex, minutes, fraction} | null

import { DAY_MS, dateMs, inMonth, todayIn } from "./grid.js";
import { displayZone } from "./tzprefs.js";

const MIN_MS = 60000;

/** {allDay, startWall, endWall, unknownZone, floating}: walls are ms as if UTC (the display zone's clock). */
export function displayTimes(entry, tz) {
  const s = entry.start;
  const e = entry.end || entry.start;
  const allDay = entry.allDay !== undefined ? !!entry.allDay : s.kind === "date";
  if (allDay) {
    let endWall = e.wallMs;
    if (!(endWall > s.wallMs)) endWall = s.wallMs + DAY_MS;
    return { allDay: true, startWall: s.wallMs, endWall, unknownZone: false, floating: false };
  }
  const z = displayZone(tz);
  const conv = (info) => (info.instant !== null && z ? z.wallFromInstant(info.instant) : info.wallMs);
  const startWall = conv(s);
  let endWall = conv(e);
  if (endWall < startWall) endWall = startWall;
  return {
    allDay: false,
    startWall,
    endWall,
    unknownZone: s.tzClass === "unknown" || e.tzClass === "unknown",
    floating: s.kind === "floating",
  };
}

/** The part of a timed entry on one day: minutes since 00:00 and whether it continues across midnight. */
function segmentOn(times, dayStart) {
  const dayEnd = dayStart + DAY_MS;
  const { startWall, endWall } = times;
  const zeroLength = endWall === startWall;
  if (!(startWall < dayEnd && (endWall > dayStart || (zeroLength && startWall >= dayStart)))) return null;
  return {
    startMin: (Math.max(startWall, dayStart) - dayStart) / MIN_MS,
    endMin: (Math.min(endWall, dayEnd) - dayStart) / MIN_MS,
    contStart: startWall < dayStart,
    contEnd: endWall > dayEnd,
  };
}

const coversDay = (times, dayStart) => times.startWall <= dayStart && times.endWall > dayStart;
const byStart = (a, b) => a.startWall - b.startWall || b.endWall - a.endWall || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const keyOf = (occ) => `${occ.href || ""}|${occ.uid || ""}|${occ.start ? occ.start.iso : ""}`;

/**
 * One day: all-day entries covering it, and the timed segments packed in lanes. Overlapping segments
 * (transitively) form a cluster; a cluster's `lanes` is the number of columns it needs, so five
 * events that overlap each other get lanes 0..4 of 5. A segment shorter than `minMinutes` occupies
 * that much space for the packing only.
 */
export function layoutDay(entries, dayIso, tz, { minMinutes = 30 } = {}) {
  const dayStart = dateMs(dayIso);
  const allDay = [];
  const segs = [];
  for (const occ of entries) {
    const times = displayTimes(occ, tz);
    if (times.allDay) {
      if (coversDay(times, dayStart)) allDay.push({ occ, times, key: keyOf(occ), startWall: times.startWall, endWall: times.endWall });
      continue;
    }
    const seg = segmentOn(times, dayStart);
    if (seg) segs.push({ occ, times, ...seg, key: keyOf(occ), startWall: times.startWall, endWall: times.endWall });
  }
  allDay.sort(byStart);
  segs.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  let cluster = [];
  let clusterEnd = -1;
  let laneEnds = [];
  const close = () => {
    for (const s of cluster) s.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const s of segs) {
    const eff = Math.max(s.endMin, s.startMin + minMinutes);
    if (cluster.length && s.startMin >= clusterEnd) {
      close();
      clusterEnd = -1;
    }
    let lane = laneEnds.findIndex((end) => end <= s.startMin);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = eff;
    s.lane = lane;
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, eff);
  }
  close();
  return {
    day: dayIso,
    allDay: allDay.map((x) => ({ occ: x.occ })),
    timed: segs.map((s) => ({
      occ: s.occ,
      startMin: s.startMin,
      endMin: s.endMin,
      lane: s.lane,
      lanes: s.lanes,
      contStart: s.contStart,
      contEnd: s.contEnd,
      unknownZone: s.times.unknownZone,
    })),
  };
}

/**
 * The all-day strip over several days (week / day view): every all-day entry that touches `days`
 * becomes {occ, col (first visible column), span (columns), row, contStart, contEnd}; rows are stacked
 * greedily so overlapping items never share a row.
 */
export function layoutAllDayRow(entries, days, tz) {
  if (!days.length) return { items: [], rows: 0 };
  const first = dateMs(days[0]);
  const end = dateMs(days[days.length - 1]) + DAY_MS;
  const items = [];
  for (const occ of entries) {
    const times = displayTimes(occ, tz);
    if (!times.allDay || !(times.startWall < end && times.endWall > first)) continue;
    const col = Math.max(0, Math.round((times.startWall - first) / DAY_MS));
    const lastCol = Math.min(days.length, Math.round((times.endWall - first) / DAY_MS));
    items.push({
      occ,
      col,
      span: Math.max(1, lastCol - col),
      row: 0,
      contStart: times.startWall < first,
      contEnd: times.endWall > end,
      startWall: times.startWall,
      endWall: times.endWall,
      key: keyOf(occ),
    });
  }
  items.sort((a, b) => a.col - b.col || b.span - a.span || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const rowEnds = [];
  for (const it of items) {
    let r = rowEnds.findIndex((e) => e <= it.col);
    if (r < 0) r = rowEnds.length;
    rowEnds[r] = it.col + it.span;
    it.row = r;
  }
  return { items: items.map(({ occ, col, span, row, contStart, contEnd }) => ({ occ, col, span, row, contStart, contEnd })), rows: rowEnds.length };
}

/**
 * Month cells: one per day of the range, each with its chips (Q-R3-9: an event that spans several days
 * gets a chip on EACH day, no spanning bars). All-day chips first, then timed ones by start; at most
 * `maxChips` are listed and `more` counts the rest.
 */
export function monthCells(range, entries, tz, { maxChips = 3, now = Date.now() } = {}) {
  const today = todayIn(tz, now);
  const prepared = entries.map((occ) => ({ occ, times: displayTimes(occ, tz), key: keyOf(occ) }));
  return range.days.map((date) => {
    const dayStart = dateMs(date);
    const chips = [];
    for (const p of prepared) {
      if (p.times.allDay) {
        if (coversDay(p.times, dayStart)) {
          chips.push({ occ: p.occ, allDay: true, startMin: 0, endMin: 1440, contStart: p.times.startWall < dayStart, contEnd: p.times.endWall > dayStart + DAY_MS, sort: p.times.startWall, key: p.key });
        }
        continue;
      }
      const seg = segmentOn(p.times, dayStart);
      if (seg) chips.push({ occ: p.occ, allDay: false, ...seg, sort: p.times.startWall, key: p.key });
    }
    chips.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.sort - b.sort || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const total = chips.length;
    return {
      date,
      inMonth: inMonth(range, date),
      today: date === today,
      total,
      more: Math.max(0, total - maxChips),
      chips: chips.slice(0, maxChips).map(({ sort, key, ...c }) => c),
    };
  });
}

/** Position of "now" in the displayed days; null when today is not among them. */
export function nowMarker(days, now, tz) {
  const z = displayZone(tz);
  const wall = z ? z.wallFromInstant(now) : now;
  const dayIso = todayIn(tz, now);
  const dayIndex = days.indexOf(dayIso);
  if (dayIndex < 0) return null;
  const minutes = (wall - dateMs(dayIso)) / MIN_MS;
  return { date: dayIso, dayIndex, minutes, fraction: minutes / 1440 };
}
