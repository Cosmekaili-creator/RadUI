// SPDX-License-Identifier: AGPL-3.0-or-later
// The event form model: the ONLY place where form values become a model patch (RUN3 risk #2/#3).
// No DOM. It works on an Item and an optional occurrence.
//
//   fromItem(item, occ?)             what the form shows (flat strings and arrays)
//   toPatch(base, values, {zones})   the patch for the model: ONLY keys whose value differs from what
//                                    the form showed; {} = nothing to save
//   validate(base, values, {isNew, zones})   [{field, testId, code}]
//   valuesToSpecs(values)            {start, end} TimeSpecs (an all-day end is the exclusive DTEND)
//   whenInfo(values, {zones, displayTz})     instants, duration, DST gap / overlap notes for the preview
//   newEventValues({date, time, tz, ...})    values of a blank form
//   toNewFields(values)              the fields of a NEW event (createItem('event', fields))
//
// Rules: every comparison is made against the DISPLAYED baseline, never against the raw event, so an
// untouched field never rewrites the event; the zone of an existing event is the zone of its own TZID
// (never the display zone) and is rewritten only when the picker changed; the all-day end is shown
// inclusive and written exclusive (DTEND).

import { readEvent } from "../model/event.js";
import { ValueError } from "../model/contentlines.js";
import { occurrenceEnd, specFromInfo, timeInfo } from "../model/icalview.js";
import { addDays, dateMs, isValidDate } from "./grid.js";
import { buildRule, parseRule, sameRule, validateState } from "./rrule.js";
import { displayZone, zoneWallStatus } from "./tzprefs.js";

export const MAX_ALARMS = 3;
export const LIMITS = Object.freeze({ text: 1000, description: 20000, url: 2000 });
export const ALARM_PRESETS = Object.freeze([
  Object.freeze({ id: "none", seconds: null }),
  Object.freeze({ id: "start", seconds: 0 }),
  Object.freeze({ id: "5m", seconds: -300 }),
  Object.freeze({ id: "10m", seconds: -600 }),
  Object.freeze({ id: "15m", seconds: -900 }),
  Object.freeze({ id: "30m", seconds: -1800 }),
  Object.freeze({ id: "1h", seconds: -3600 }),
  Object.freeze({ id: "1d", seconds: -86400 }),
]);
export const STATUS_OPTIONS = Object.freeze(["", "CONFIRMED", "TENTATIVE", "CANCELLED"]);
export const TRANSP_OPTIONS = Object.freeze(["", "OPAQUE", "TRANSPARENT"]);

/** The select id of a relative alarm ('custom' when it is not one of the presets, e.g. 45 minutes or END-related). */
export function alarmPresetId(alarm) {
  if (alarm.related && alarm.related !== "START") return "custom";
  const p = ALARM_PRESETS.find((x) => x.seconds === alarm.seconds);
  return p ? p.id : "custom";
}

/** The alarm of a preset id ({seconds, related}), or null for 'none'/'custom'. */
export function alarmOfPreset(id) {
  const p = ALARM_PRESETS.find((x) => x.id === id);
  return p && p.seconds !== null ? { seconds: p.seconds, related: "START" } : null;
}

const norm = (s) => String(s === undefined || s === null ? "" : s).replace(/\r\n?/g, "\n");
const alarmKey = (a) => `${a.seconds}|${a.related === "END" ? "END" : "START"}`;
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function hhmm(iso) {
  const t = iso.slice(11, 19);
  return t.endsWith(":00") ? t.slice(0, 5) : t;
}

function partsOfSpec(spec, which, allDay) {
  const out = {};
  const date = spec.iso.slice(0, 10);
  if (allDay) {
    out[`${which}Date`] = date;
    out[`${which}Time`] = "";
    out[`${which}Tz`] = "";
    out[`${which}Kind`] = "date";
    return out;
  }
  out[`${which}Date`] = date;
  out[`${which}Time`] = hhmm(spec.iso);
  out[`${which}Tz`] = spec.kind === "utc" ? "UTC" : spec.tzid || "";
  out[`${which}Kind`] = spec.kind;
  return out;
}

/**
 * The form values of an event. `occ` (an occurrence from item.expand) is the occurrence being edited:
 * its own start, end and text (an override's own text) are shown; without it the master is shown.
 */
export function fromItem(item, occ = null) {
  const zones = item.zones;
  const model = item.eventModel();
  const comp = occ && occ.component ? occ.component : item.main;
  const f = readEvent(comp);
  const masterFields = item.fields();
  const startInfo = occ ? occ.start : model.start;
  const endInfo = occ ? occ.end : occurrenceEnd(model.start, model, zones);
  const startSpec = specFromInfo(startInfo);
  const endSpec = specFromInfo(endInfo);
  const allDay = startSpec.kind === "date";
  const values = {
    summary: f.summary,
    location: f.location,
    description: norm(f.description),
    url: f.url,
    categories: f.categories.slice(),
    status: f.status || "",
    transp: f.transp || "",
    allDay,
    ...partsOfSpec(startSpec, "start", allDay),
    ...partsOfSpec(endSpec, "end", allDay),
    alarms: f.alarms.map((a) => ({ seconds: a.seconds, related: a.related })),
    foreignAlarms: f.foreignAlarms,
  };
  if (allDay) {
    const last = endSpec.kind === "date" ? addDays(endSpec.iso.slice(0, 10), -1) : endSpec.iso.slice(0, 10);
    values.endDate = last < values.startDate ? values.startDate : last;
  }
  const masterStart = specFromInfo(model.start);
  const rr = masterFields.rrule;
  let rule = { mode: "none" };
  if (rr) {
    const parsed = parseRule(rr, masterStart, { zones });
    rule = parsed.custom ? { mode: "custom", raw: parsed.raw, reason: parsed.reason } : { mode: "builder", state: parsed.state };
  }
  values.rule = rule;
  values.ruleText = rr || null;
  values.recurring = !!rr || masterFields.rdates.length > 0;
  return values;
}

/** A blank form. `tz` is the display zone for a new event (new events are never floating). */
export function newEventValues({ date, time = "09:00", durationMinutes = 60, tz = "UTC", allDay = false } = {}) {
  const startMs = dateMs(date) + (+time.slice(0, 2) * 60 + +time.slice(3, 5)) * 60000;
  const end = new Date(startMs + durationMinutes * 60000).toISOString();
  return {
    summary: "",
    location: "",
    description: "",
    url: "",
    categories: [],
    status: "",
    transp: "",
    allDay,
    startDate: date,
    startTime: allDay ? "" : time,
    startTz: allDay ? "" : tz,
    startKind: allDay ? "date" : tz === "UTC" ? "utc" : "zoned",
    endDate: allDay ? date : end.slice(0, 10),
    endTime: allDay ? "" : end.slice(11, 16),
    endTz: allDay ? "" : tz,
    endKind: allDay ? "date" : tz === "UTC" ? "utc" : "zoned",
    alarms: [],
    foreignAlarms: 0,
    rule: { mode: "none" },
    ruleText: null,
    recurring: false,
  };
}

/** Change the zone picker of `which` ('start' | 'end'): the kind follows ('UTC' is written as Z). */
export function withZone(values, which, tz) {
  return { ...values, [`${which}Tz`]: tz, [`${which}Kind`]: tz === "UTC" ? "utc" : tz ? "zoned" : "floating" };
}

/** Toggle all-day; going back to timed needs a zone and a time (new events are never floating). */
export function withAllDay(values, allDay, { tz = "UTC", time = "09:00", durationMinutes = 60 } = {}) {
  if (!!allDay === !!values.allDay) return values;
  if (allDay) {
    return { ...values, allDay: true, startTime: "", endTime: "", startTz: "", endTz: "", startKind: "date", endKind: "date" };
  }
  const base = newEventValues({ date: values.startDate, time, durationMinutes, tz });
  return {
    ...values,
    allDay: false,
    startTime: base.startTime,
    startTz: tz,
    startKind: base.startKind,
    endDate: base.endDate > values.endDate ? base.endDate : values.endDate,
    endTime: base.endTime,
    endTz: tz,
    endKind: base.endKind,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function specOf(v, which) {
  const date = v[`${which}Date`];
  if (v.allDay) return { kind: "date", iso: which === "end" ? addDays(date, 1) : date };
  const time = norm(v[`${which}Time`]);
  const iso = `${date}T${time.length === 5 ? `${time}:00` : time}`;
  const tz = v[`${which}Tz`];
  if (!tz) return { kind: "floating", iso };
  if (tz === "UTC" && v[`${which}Kind`] === "utc") return { kind: "utc", iso };
  return { kind: "zoned", iso, tzid: tz };
}

/** {start, end} TimeSpecs of the values (the all-day end is the exclusive DTEND). Throws ValueError on a bad date or time. */
export function valuesToSpecs(values) {
  for (const w of ["start", "end"]) {
    if (!isValidDate(values[`${w}Date`])) throw new ValueError(`invalid ${w} date`);
    if (!values.allDay && !TIME_RE.test(norm(values[`${w}Time`]))) throw new ValueError(`invalid ${w} time`);
  }
  return { start: specOf(values, "start"), end: specOf(values, "end") };
}

const sameSpec = (a, b) => a.kind === b.kind && a.iso === b.iso && (a.tzid || null) === (b.tzid || null);

function timeGroupChanged(base, values, which) {
  return ["Date", "Time", "Tz", "Kind"].some((k) => (base[`${which}${k}`] || "") !== (values[`${which}${k}`] || "")) || !!base.allDay !== !!values.allDay;
}

/** The RRULE text of the values' rule (null for none). `startSpec` types an UNTIL. */
export function ruleTextOf(values, startSpec, { zones } = {}) {
  const r = values.rule;
  if (!r || r.mode === "none") return null;
  if (r.mode === "custom") return r.raw;
  return buildRule(r.state, startSpec, { zones });
}

/**
 * The model patch for `values` against `base` (what fromItem showed). Keys: summary, description,
 * location, url, categories, status, transp, start, end, rrule, alarms (the keys of applyEventPatch).
 * A time group that is untouched is not in the patch, so the TZID and the form of the stored value
 * survive; changing the all-day flag writes start and end.
 */
export function toPatch(base, values, { zones } = {}) {
  const patch = {};
  for (const k of ["summary", "location", "description"]) if (norm(values[k]) !== norm(base[k])) patch[k] = norm(values[k]);
  if ((values.url || "").trim() !== (base.url || "").trim()) patch.url = (values.url || "").trim();
  const cats = (values.categories || []).map((c) => String(c).trim()).filter(Boolean);
  if (!sameList(cats, base.categories || [])) patch.categories = cats;
  if ((values.status || "") !== (base.status || "")) patch.status = values.status || null;
  if ((values.transp || "") !== (base.transp || "")) patch.transp = values.transp || null;
  const toggled = !!base.allDay !== !!values.allDay;
  const startChanged = toggled || timeGroupChanged(base, values, "start");
  const endChanged = toggled || timeGroupChanged(base, values, "end");
  if (startChanged || endChanged) {
    const specs = valuesToSpecs(values);
    if (startChanged) patch.start = specs.start;
    if (endChanged) patch.end = specs.end;
  }
  const startSpec = patch.start || valuesToSpecs(values).start;
  const text = ruleTextOf(values, startSpec, { zones });
  if (text === null ? base.ruleText !== null : base.ruleText === null || !sameRule(text, base.ruleText)) patch.rrule = text;
  const have = (base.alarms || []).map(alarmKey).sort();
  const want = (values.alarms || []).map(alarmKey).sort();
  if (!sameList(have, want)) patch.alarms = (values.alarms || []).map((a) => ({ seconds: a.seconds, related: a.related === "END" ? "END" : "START" }));
  return patch;
}

/** The fields of a NEW event (createItem('event', fields, ...)). */
export function toNewFields(values, { zones } = {}) {
  const { start, end } = valuesToSpecs(values);
  const fields = {
    summary: norm(values.summary).trim(),
    start,
    end,
  };
  for (const k of ["location", "description"]) if (norm(values[k])) fields[k] = norm(values[k]);
  if ((values.url || "").trim()) fields.url = values.url.trim();
  const cats = (values.categories || []).map((c) => String(c).trim()).filter(Boolean);
  if (cats.length) fields.categories = cats;
  if (values.status) fields.status = values.status;
  if (values.transp) fields.transp = values.transp;
  const text = ruleTextOf(values, start, { zones });
  if (text) fields.rrule = text;
  if ((values.alarms || []).length) fields.alarms = values.alarms.map((a) => ({ seconds: a.seconds, related: a.related === "END" ? "END" : "START" }));
  return fields;
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\S/;
const UNSAFE_SCHEME_RE = /^\s*(?:javascript|data|vbscript):/i;

function zonesOrIntl(zones) {
  return zones || { get: (tz) => displayZone(tz) };
}

/**
 * Structured field errors. Like the contact form, only values that changed (or are new) are judged, so an
 * old event with an odd value can still be saved after an unrelated edit. [{field, testId, code}]
 */
export function validate(base, values, { isNew = false, zones } = {}) {
  const errs = [];
  const add = (field, testId, code) => errs.push({ field, testId, code });
  const changed = (k) => isNew || norm(values[k]) !== norm((base || {})[k]);
  const b = base || {};
  if (changed("summary") && !norm(values.summary).trim()) add("summary", "field-title", "summary-required");
  if (norm(values.summary).length > LIMITS.text) add("summary", "field-title", "too-long");
  if (changed("location") && norm(values.location).length > LIMITS.text) add("location", "field-location", "too-long");
  if (changed("description") && norm(values.description).length > LIMITS.description) add("description", "field-description", "too-long");
  const url = (values.url || "").trim();
  if (url && url !== (b.url || "").trim()) {
    if (!SCHEME_RE.test(url)) add("url", "field-url", "url-scheme");
    else if (UNSAFE_SCHEME_RE.test(url)) add("url", "field-url", "url-unsafe");
    else if (url.length > LIMITS.url) add("url", "field-url", "too-long");
  }
  const touched = (w) => isNew || timeGroupChanged(b, values, w);
  let datesOk = true;
  for (const w of ["start", "end"]) {
    if (!touched(w)) continue;
    if (!isValidDate(values[`${w}Date`])) {
      add(w, `field-${w}-date`, values[`${w}Date`] ? "date-invalid" : "date-required");
      datesOk = false;
    }
    if (!values.allDay && !TIME_RE.test(norm(values[`${w}Time`]))) {
      add(w, `field-${w}-time`, norm(values[`${w}Time`]) ? "time-invalid" : "time-required");
      datesOk = false;
    }
    if (!values.allDay && values[`${w}Tz`] && values[`${w}Tz`] !== (b[`${w}Tz`] || "") && !zonesOrIntl(zones).get(values[`${w}Tz`])) {
      add(w, `field-tz-${w}`, "tz-unknown");
      datesOk = false;
    }
  }
  if (datesOk && (touched("start") || touched("end"))) {
    try {
      const { start, end } = valuesToSpecs(values);
      const z = zonesOrIntl(zones);
      const s = timeInfo(start, z);
      const e = timeInfo(end, z);
      const before = s.instant !== null && e.instant !== null ? e.instant < s.instant : e.wallMs < s.wallMs;
      const nonSense = values.allDay ? e.wallMs <= s.wallMs : before;
      if (nonSense) add("end", values.allDay ? "field-end-date" : "field-end-time", "end-before-start");
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
    }
  }
  const alarmsChanged = isNew || !sameList((b.alarms || []).map(alarmKey).sort(), (values.alarms || []).map(alarmKey).sort());
  if (alarmsChanged) {
    if ((values.alarms || []).length > MAX_ALARMS) add("alarms", "btn-add-alarm", "alarms-max");
    if ((values.alarms || []).some((a) => !Number.isFinite(a.seconds))) add("alarms", "btn-add-alarm", "alarm-invalid");
  }
  if (values.rule && values.rule.mode === "builder") {
    const ruleChanged = isNew || !b.ruleText || !sameRule(ruleTextOf(values, datesOk ? valuesToSpecs(values).start : null, { zones }) || "", b.ruleText);
    if (ruleChanged) {
      for (const e of validateState(values.rule.state, datesOk ? valuesToSpecs(values).start : null)) add("rule", "recurrence-builder", e.code);
    }
  }
  return errs;
}

function statusOf(zones, spec) {
  if (spec.kind !== "zoned") return { status: "ok" };
  return zoneWallStatus(zonesOrIntl(zones).get(spec.tzid), spec.iso);
}

/**
 * What the "event-when-preview" line needs: the instants, the duration, the wall clock of start and end in the
 * display zone and the DST notes. {start, end, startGap?, endGap?, startOverlap?, endOverlap?, durationSec,
 * display: {start, end} ISO wall clocks in `displayTz`} or null while the values are incomplete.
 */
export function whenInfo(values, { zones, displayTz } = {}) {
  let specs;
  try {
    specs = valuesToSpecs(values);
  } catch (e) {
    if (e instanceof ValueError) return null;
    throw e;
  }
  const z = zonesOrIntl(zones);
  const si = timeInfo(specs.start, z);
  const ei = timeInfo(specs.end, z);
  const out = { start: specs.start, end: specs.end, allDay: !!values.allDay, startInstant: si.instant, endInstant: ei.instant, durationSec: null, display: null };
  if (values.allDay) out.durationSec = (ei.wallMs - si.wallMs) / 1000;
  else if (si.instant !== null && ei.instant !== null) out.durationSec = (ei.instant - si.instant) / 1000;
  else out.durationSec = (ei.wallMs - si.wallMs) / 1000;
  for (const [name, spec] of [["start", specs.start], ["end", specs.end]]) {
    const st = statusOf(zones, spec);
    if (st.status === "gap") out[`${name}Gap`] = { wall: spec.iso, resolved: st.resolvedIso, tzid: spec.tzid };
    if (st.status === "overlap") out[`${name}Overlap`] = { wall: spec.iso, tzid: spec.tzid };
  }
  const dz = displayTz ? displayZone(displayTz) : null;
  if (dz && !values.allDay && si.instant !== null && ei.instant !== null) {
    const iso = (ms) => new Date(dz.wallFromInstant(ms)).toISOString().slice(0, 19);
    out.display = { start: iso(si.instant), end: iso(ei.instant) };
  }
  return out;
}

/** The TimeSpec an `occ=` URL parameter / op stores for an occurrence (RECURRENCE-ID when it has one). */
export function ridSpecOf(occ) {
  return specFromInfo(occ.recurrenceId || occ.start);
}

