// SPDX-License-Identifier: AGPL-3.0-or-later
// VTODO: the properties RadUI owns (SPECS 4.2). Everything else is preserved.

import {
  Component,
  ValueError,
  formatRRule,
  getText,
  getTextList,
  parseRRule,
  parseTime,
  unescapeText,
} from "./contentlines.js";
import { FieldError, encodeValue, newProp, setSingle, setText, setTimeProp, touch } from "./writer.js";
import { setCategories } from "./event.js";
import { newUuid } from "../uuid.js";

export const OWNED_PROPS = Object.freeze([
  "SUMMARY",
  "DESCRIPTION",
  "DUE",
  "DTSTART",
  "PRIORITY",
  "STATUS",
  "PERCENT-COMPLETE",
  "COMPLETED",
  "CATEGORIES",
  "RRULE",
]);
export const STATUSES = Object.freeze(["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"]);
export const DEFAULT_PRODID = "-//RadUI//Tasks//EN";

export function todoOf(root) {
  return root.comp("VTODO");
}

function setInt(comp, name, value, min, max) {
  if (value === null || value === undefined || value === "") return setSingle(comp, name, null);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new FieldError(`${name} must be an integer from ${min} to ${max}`);
  const cur = comp.prop(name);
  if (cur && parseInt(cur.value, 10) === n && /^\s*\d+\s*$/.test(cur.value)) return false;
  return setSingle(comp, name, String(n));
}

function readInt(comp, name) {
  const p = comp.prop(name);
  if (!p) return null;
  const n = parseInt(p.value, 10);
  return Number.isFinite(n) ? n : null;
}

export function readTodo(comp) {
  const t = (n) => {
    const p = comp.prop(n);
    return p ? parseTime(p.value, p.params) : null;
  };
  const rr = comp.prop("RRULE");
  const st = comp.prop("STATUS");
  return {
    summary: getText(comp, "SUMMARY") || "",
    description: getText(comp, "DESCRIPTION") || "",
    due: t("DUE"),
    start: t("DTSTART"),
    priority: readInt(comp, "PRIORITY"),
    status: st ? st.value.trim().toUpperCase() : null,
    percent: readInt(comp, "PERCENT-COMPLETE"),
    completed: t("COMPLETED"),
    categories: getTextList(comp, "CATEGORIES"),
    rrule: rr ? rr.value.trim() : null,
  };
}

/** Apply a patch (keys of readTodo, absent keys untouched). Returns true when anything changed. */
export function applyTodoPatch(comp, patch) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  let changed = false;
  if (has("summary")) changed = setText(comp, "SUMMARY", patch.summary, unescapeText) || changed;
  if (has("description")) changed = setText(comp, "DESCRIPTION", patch.description, unescapeText) || changed;
  if (has("due")) changed = setTimeProp(comp, "DUE", patch.due) || changed;
  if (has("start")) changed = setTimeProp(comp, "DTSTART", patch.start) || changed;
  if (has("priority")) changed = setInt(comp, "PRIORITY", patch.priority, 0, 9) || changed;
  if (has("percent")) changed = setInt(comp, "PERCENT-COMPLETE", patch.percent, 0, 100) || changed;
  if (has("status")) {
    const v = patch.status ? String(patch.status).toUpperCase() : null;
    if (v !== null && !STATUSES.includes(v)) throw new FieldError(`STATUS must be one of ${STATUSES.join(", ")}`);
    const cur = comp.prop("STATUS");
    if (!(cur && v && cur.value.trim().toUpperCase() === v)) changed = setSingle(comp, "STATUS", v) || changed;
  }
  if (has("completed")) {
    if (patch.completed && patch.completed.kind !== "utc") throw new FieldError("COMPLETED must be a UTC time");
    changed = setTimeProp(comp, "COMPLETED", patch.completed) || changed;
  }
  if (has("categories")) changed = setCategories(comp, patch.categories) || changed;
  if (has("rrule")) {
    if (!patch.rrule) changed = setSingle(comp, "RRULE", null) || changed;
    else {
      let norm;
      try {
        norm = formatRRule(parseRRule(String(patch.rrule).trim()));
      } catch (e) {
        if (e instanceof ValueError) throw new FieldError(e.message);
        throw e;
      }
      const cur = comp.prop("RRULE");
      if (!(cur && cur.value.trim() === norm)) changed = setSingle(comp, "RRULE", norm) || changed;
    }
  }
  return changed;
}

const utcSpec = (now) => ({ kind: "utc", iso: new Date(now).toISOString().slice(0, 19) });

/** One-tap complete: STATUS, COMPLETED (UTC now), PERCENT-COMPLETE 100. */
export function completeTask(comp, now = new Date()) {
  return applyTodoPatch(comp, { status: "COMPLETED", completed: utcSpec(now), percent: 100 });
}

/** Re-open: NEEDS-ACTION, no COMPLETED, no PERCENT-COMPLETE. */
export function reopenTask(comp) {
  return applyTodoPatch(comp, { status: "NEEDS-ACTION", completed: null, percent: null });
}

export function createTodo(fields, { uid, prodid = DEFAULT_PRODID } = {}) {
  const id = uid || newUuid();
  const cal = new Component("VCALENDAR");
  cal.items.push(newProp("VERSION", "2.0"));
  cal.items.push(newProp("PRODID", encodeValue("PRODID", prodid)));
  const td = new Component("VTODO");
  td.items.push(newProp("UID", encodeValue("UID", id)));
  td.touched = true;
  cal.items.push(td);
  applyTodoPatch(td, { ...fields });
  touch(td);
  return cal;
}
