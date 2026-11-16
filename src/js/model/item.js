// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry point of the data model: openItem() classifies an item as served by
// Radicale and returns either an editable item or a read-only verdict.
//
//   const r = openItem(text, 'event' | 'task' | 'contact');
//   r.ok === false  -> { ok:false, readOnly:true, reason, message, raw }
//   r.ok === true   -> editable item (r.readOnly is true when it must not be
//                      rewritten, e.g. an unknown TZID: see D7 (c))
//   r.update(patch) ... r.save() -> {changed:false} | {changed:true, text}
//
// text is the item text exactly as served (any line ending). save() returns a
// CRLF body with a final CRLF and refuses (FidelityError) anything that would
// alter a line RadUI does not own.

import { ParseError, ValueError, parse } from "./contentlines.js";
import {
  DEFAULT_PRODID as EVENT_PRODID,
  addExdate,
  applyEventPatch,
  createEvent,
  deleteOccurrence,
  expandEvents,
  masterOf,
  overridesOf,
  readEvent,
  removeExdate,
  removeOverride,
  splitSeries,
  upsertOverride,
  addRdate,
  shiftExceptions,
  truncateSeries,
  exceptionsOf,
  orphanedExceptions,
} from "./event.js";
import { DEFAULT_PRODID as TODO_PRODID, applyTodoPatch, completeTask, createTodo, readTodo, reopenTask, todoOf } from "./todo.js";
import { DEFAULT_PRODID as CARD_PRODID, applyCardPatch, cardOf, createCard, createGroup, isGroupCard, readCard } from "./vcard.js";
import { classifyTzid, createZones, eventModel, vtimezoneMap } from "./icalview.js";
import { checkFidelity, checkNewItem } from "./fidelity.js";
import { ensureVtimezones } from "../calendar/tz.js";
import { FieldError, emit, encodeValue, newProp, serialize, setValue } from "./writer.js";

export class ReadOnlyError extends Error {
  constructor(reason) {
    super(`item is read-only (${reason})`);
    this.name = "ReadOnlyError";
    this.reason = reason;
  }
}

const KIND_OF_COMPONENT = { VEVENT: "event", VTODO: "task", VCARD: "contact" };

function collectTzids(comp, out) {
  for (const p of comp.properties) for (const v of p.paramValues("TZID")) out.add(v);
  for (const c of comp.components) if (c.key !== "VTIMEZONE") collectTzids(c, out);
}

export class Item {
  constructor({ kind, root, raw, baseline, isNew = false, tz = {}, warnings = [] }) {
    this.ok = true;
    this.kind = kind;
    this.root = root;
    this.raw = raw;
    this.baseline = baseline;
    this.isNew = isNew;
    this.tz = tz;
    this.warnings = warnings;
    this.readOnly = warnings.some((w) => w.readOnly);
    this.readOnlyReason = this.readOnly ? warnings.find((w) => w.readOnly).code : null;
    // TZIDs the item referenced when it was read: a save never adds a VTIMEZONE for one of them (fidelity), only for new ones
    this.knownTzids = new Set();
    if (!isNew) collectTzids(root, this.knownTzids);
    /** VTIMEZONEs the last save()/splitSeries() added: [{tzid, form, openEnded, coveredThrough}] (see calendar/tz.js). */
    this.tzAdded = [];
  }

  /** `prepare` hook of the writer: add a generated VTIMEZONE for every TZID that is new to the item and has none. */
  _vtimezones(skip) {
    if (this.kind === "contact") return undefined;
    return (copy) => {
      this.tzAdded = ensureVtimezones(copy, { skip });
    };
  }

  /** Master VEVENT, the VTODO or the VCARD. */
  get main() {
    if (this.kind === "event") return masterOf(this.root);
    if (this.kind === "task") return todoOf(this.root);
    return cardOf(this.root);
  }
  get overrides() {
    return this.kind === "event" ? overridesOf(this.root) : [];
  }
  get uid() {
    const m = this.main;
    const p = m && m.prop("UID");
    return p ? p.value.trim() : null;
  }
  /** Zone lookup built from the item's current VTIMEZONEs. */
  get zones() {
    return createZones(this.root);
  }

  /** Plain object of the owned fields of the master (event/task/contact). */
  fields() {
    if (this.kind === "event") return readEvent(this.main);
    if (this.kind === "task") return readTodo(this.main);
    return readCard(this.main);
  }

  /** Owned fields of the override VEVENTs, keyed by RECURRENCE-ID value. */
  overrideFields() {
    return this.overrides.map((o) => ({ recurrenceId: o.prop("RECURRENCE-ID").value.trim(), ...readEvent(o) }));
  }

  _writable() {
    if (this.readOnly) throw new ReadOnlyError(this.readOnlyReason);
  }

  /**
   * Apply a patch of owned fields (see applyEventPatch / applyTodoPatch /
   * applyCardPatch). For events, `recurrenceId` (a TimeSpec) edits or creates
   * the override of that occurrence instead of the master.
   */
  update(patch, { recurrenceId, strict = false } = {}) {
    this._writable();
    if (this.kind === "event") {
      if (recurrenceId) {
        upsertOverride(this.root, recurrenceId, patch, { zones: this.zones });
        return true;
      }
      return applyEventPatch(this.main, patch, { zones: this.zones });
    }
    if (this.kind === "task") return applyTodoPatch(this.main, patch);
    return applyCardPatch(this.main, patch, { strict });
  }

  /**
   * A NEW item holding the current in-memory state of this one (apply the patch first),
   * with `uid` on every UID line (a recurring event's overrides included). It is a new
   * resource: save() runs the new-item guard and the managed properties (REV, CREATED ...)
   * are written; a PRODID is added when the source has none. Group cards are refused:
   * a copy would duplicate the group. Pass the result's text to PUT with If-None-Match.
   */
  asCopy({ uid } = {}) {
    this._writable();
    if (typeof uid !== "string" || !uid.trim()) throw new FieldError("a copy needs a new UID");
    if (this.kind === "contact" && isGroupCard(this)) throw new FieldError("a group card cannot be copied");
    const root = this.root.clone();
    const holders = root.key === "VCARD" ? [root] : root.components.filter((c) => c.key === "VEVENT" || c.key === "VTODO");
    for (const c of holders) {
      const lines = c.props("UID");
      if (lines.length) {
        setValue(lines[0], encodeValue("UID", uid));
        for (const extra of lines.slice(1)) c.remove(extra);
      } else c.appendProperty(newProp("UID", encodeValue("UID", uid)));
      c.touched = true;
    }
    if (!root.prop("PRODID")) {
      const prodid = this.kind === "contact" ? CARD_PRODID : this.kind === "task" ? TODO_PRODID : EVENT_PRODID;
      root.appendProperty(newProp("PRODID", encodeValue("PRODID", prodid)));
    }
    root.touched = true;
    return new Item({ kind: this.kind, root, raw: null, baseline: undefined, isNew: true, tz: this.tz, warnings: this.warnings });
  }

  completeTask(now) {
    this._writable();
    return completeTask(this.main, now);
  }
  reopenTask() {
    this._writable();
    return reopenTask(this.main);
  }

  addExdate(spec) {
    this._writable();
    return addExdate(this.root, spec, { zones: this.zones });
  }
  removeExdate(spec) {
    this._writable();
    return removeExdate(this.root, spec, { zones: this.zones });
  }
  addRdate(spec) {
    this._writable();
    return addRdate(this.root, spec, { zones: this.zones });
  }
  upsertOverride(ridSpec, patch) {
    this._writable();
    return upsertOverride(this.root, ridSpec, patch, { zones: this.zones });
  }
  removeOverride(ridSpec) {
    this._writable();
    return removeOverride(this.root, ridSpec, { zones: this.zones });
  }
  deleteOccurrence(ridSpec) {
    this._writable();
    return deleteOccurrence(this.root, ridSpec, { zones: this.zones });
  }

  /**
   * The start of the series moves from `fromSpec` to `toSpec`: EXDATEs, override RECURRENCE-IDs and
   * a date-time UNTIL move by the same wall-clock delta (see event.js shiftExceptions). Call it
   * before update({start}). Throws SeriesError (start-mismatch, allday-toggle-with-exceptions).
   */
  shiftExceptions(fromSpec, toSpec) {
    this._writable();
    return shiftExceptions(this.root, fromSpec, toSpec, { zones: this.zones });
  }
  /** "Delete this and following": the series ends before `ridSpec` (one save, no new item). */
  truncateSeries(ridSpec) {
    this._writable();
    return truncateSeries(this.root, ridSpec, { zones: this.zones });
  }
  /** [{type:'exdate'|'override', spec, key}] of the series. */
  exceptions() {
    return exceptionsOf(this.root, { zones: this.zones });
  }
  /** Exceptions that are no longer occurrences of the rule (see event.js orphanedExceptions). */
  orphanedExceptions() {
    return orphanedExceptions(this.root, { zones: this.zones });
  }

  /**
   * "This and following". Mutates this item (the head) and returns
   * {tailText, tailUid}: the CRLF body of a NEW resource (to be PUT with
   * If-None-Match) that continues the series. Save the head with save().
   * `tailPatch` and `exceptions` ('keep' | 'remove' | 'remove-orphans') are described at event.js splitSeries.
   */
  splitSeries(splitSpec, { newUid, prodid, now, tailPatch, exceptions } = {}) {
    this._writable();
    const { tail, tailUid } = splitSeries(this.root, splitSpec, { newUid, prodid, zones: this.zones, tailPatch, exceptions });
    const out = serialize(tail, { isNew: true, now, prepare: this._vtimezones(new Set()) });
    checkNewItem(out.text);
    return { tailText: out.text, tailUid, tzAdded: this.tzAdded };
  }

  /** Occurrences of the item's events (see expandEvents). */
  expand(options = {}) {
    if (this.kind !== "event") throw new FieldError("only events expand");
    return expandEvents(this.root, { ...options, zones: this.zones });
  }

  /** Time model of the master (start info, duration) for display code. */
  eventModel() {
    return eventModel(this.main, this.zones);
  }

  /**
   * Text to PUT. {changed:false} when no owned property changed (send no
   * request); otherwise {changed:true, text}. Throws ReadOnlyError for a
   * read-only item and FidelityError when the guard refuses the result.
   * `now` (Date) is injectable for tests.
   */
  save({ now } = {}) {
    this._writable();
    if (this.isNew) {
      const out = serialize(this.root, { isNew: true, now, prepare: this._vtimezones(new Set()) });
      checkNewItem(out.text);
      return out;
    }
    const out = serialize(this.root, { baseline: this.baseline, now, prepare: this._vtimezones(this.knownTzids) });
    if (!out.changed) return out;
    checkFidelity(this.baseline, out.text, { allowOverrides: this.kind === "event" });
    return out;
  }
}

function fail(raw, reason, message) {
  return { ok: false, readOnly: true, reason, message, raw };
}

/**
 * Open item text served by Radicale. `kind` is 'event' | 'task' | 'contact';
 * when omitted it is inferred from the content.
 */
export function openItem(rawText, kind) {
  if (typeof rawText !== "string" || !rawText.trim()) return fail(rawText, "empty", "empty item");
  let roots;
  try {
    roots = parse(rawText);
  } catch (e) {
    if (e instanceof ParseError) return fail(rawText, "parse-error", e.message);
    throw e;
  }
  if (!roots.length) return fail(rawText, "empty", "no component");
  const root = roots[0];
  const isCard = root.key === "VCARD";
  if (roots.length > 1) {
    return isCard
      ? fail(rawText, "multiple-vcards", "the resource holds several vCards")
      : fail(rawText, "multiple-calendars", "the resource holds several top-level components");
  }
  if (!isCard && root.key !== "VCALENDAR") return fail(rawText, "unsupported-component", `unsupported top-level component ${root.name}`);

  const baseline = emit(root);
  try {
    if (isCard) return openCard(rawText, root, kind, baseline);
    return openCalendar(rawText, root, kind, baseline);
  } catch (e) {
    if (e instanceof ValueError) return fail(rawText, "invalid-value", e.message);
    throw e;
  }
}

function openCard(raw, root, kind, baseline) {
  if (kind && kind !== "contact") return fail(raw, "wrong-kind", `a vCard is not a ${kind}`);
  const v = root.prop("VERSION");
  const version = v ? v.value.trim() : "";
  if (version !== "3.0" && version !== "4.0") return fail(raw, "unsupported-version", `vCard version ${version || "(none)"} is not supported`);
  if (root.props("VERSION").length > 1 || root.props("UID").length > 1) return fail(raw, "duplicate-property", "VERSION or UID appears twice");
  const item = new Item({ kind: "contact", root, raw, baseline });
  readCard(root); // validates the values it reads
  return item;
}

function openCalendar(raw, root, kind, baseline) {
  const v = root.prop("VERSION");
  if (!v || v.value.trim() !== "2.0") return fail(raw, "unsupported-version", "VERSION must be 2.0");
  const names = new Set(root.components.map((c) => c.key));
  for (const bad of ["VJOURNAL", "VFREEBUSY"]) if (names.has(bad)) return fail(raw, "unsupported-component", `${bad} is not supported`);
  const hasEvent = names.has("VEVENT");
  const hasTodo = names.has("VTODO");
  if (hasEvent && hasTodo) return fail(raw, "mixed-components", "events and tasks in one resource");
  if (!hasEvent && !hasTodo) return fail(raw, "empty", "no event or task");
  const actual = hasEvent ? "event" : "task";
  if (kind && kind !== actual) return fail(raw, "wrong-kind", `the item holds a ${actual}, not a ${kind}`);
  const comps = root.comps(hasEvent ? "VEVENT" : "VTODO");
  const uids = new Set();
  for (const c of comps) {
    const u = c.prop("UID");
    if (!u || !u.value.trim()) return fail(raw, "no-uid", "a component has no UID");
    uids.add(u.value.trim());
  }
  if (uids.size > 1) return fail(raw, "multiple-uids", "the resource holds several UIDs");
  if (hasTodo && comps.length > 1) return fail(raw, "multiple-tasks", "several VTODO components in one resource");
  if (hasEvent && !masterOf(root)) return fail(raw, "no-master", "overrides without a master event");
  if (hasEvent && comps.filter((c) => !c.prop("RECURRENCE-ID")).length > 1) return fail(raw, "multiple-masters", "several master events");

  const warnings = [];
  const tz = {};
  const tzids = new Set();
  collectTzids(root, tzids);
  const vtz = vtimezoneMap(root);
  for (const t of tzids) {
    tz[t] = classifyTzid(t, vtz);
    if (tz[t] === "unknown") {
      warnings.push({
        code: "unknown-tzid",
        tzid: t,
        readOnly: true,
        message: `time zone "${t}" has no VTIMEZONE and is not known to this browser`,
      });
    }
  }
  const item = new Item({ kind: actual, root, raw, baseline, tz, warnings });
  // validate every value the readers will touch
  if (hasEvent) {
    const zones = createZones(root);
    for (const c of comps) {
      readEvent(c);
      eventModel(c, zones);
    }
  } else readTodo(comps[0]);
  return item;
}

/** New event / task / contact (kind 'event' | 'task' | 'contact'); options: {uid, prodid, version, form}. */
export function createItem(kind, fields, options = {}) {
  let root;
  if (kind === "event") root = createEvent(fields, options);
  else if (kind === "task") root = createTodo(fields, options);
  else if (kind === "contact") root = createCard(fields, options);
  else throw new FieldError(`unknown item kind ${kind}`);
  return new Item({ kind, root, raw: null, baseline: undefined, isNew: true });
}

/** New group card (see createGroup). */
export function createGroupItem(name, memberUids, options) {
  return new Item({ kind: "contact", root: createGroup(name, memberUids, options), raw: null, baseline: undefined, isNew: true });
}
