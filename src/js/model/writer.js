// SPDX-License-Identifier: AGPL-3.0-or-later
// Writer: our own serializer plus the primitives that mutate the content-line
// tree. ical.js is never used here (decision D6).
//
// Rules implemented here:
//  - untouched properties are re-emitted with their original physical text, so
//    an item with no edit is byte-exact against the LF-normalised input
//    (re-emitted with CRLF);
//  - touched properties are serialised by formatProperty(): TEXT values are
//    escaped through the per-property value-type registry, the original name
//    case, group prefix and parameter form of an edited property are kept
//    (new properties are upper-case);
//  - lines fold at 75 octets (continuation lines are at most 75 octets
//    including the leading space), never inside a UTF-8 sequence;
//  - output is CRLF with a final CRLF.

import {
  Component,
  Property,
  ValueError,
  escapeText,
  getTextList,
  formatTime,
  formatUtcStamp,
  parseTime,
  toCRLF,
} from "./contentlines.js";

export class FieldError extends Error {
  constructor(message) {
    super(message);
    this.name = "FieldError";
  }
}

// ---------------------------------------------------------------------------
// Value-type registry

/**
 * Value type per property name (upper-case). Unlisted names are treated as
 * TEXT, the safe default (escaped).
 */
export const VALUE_TYPES = Object.freeze({
  SUMMARY: "text",
  DESCRIPTION: "text",
  LOCATION: "text",
  COMMENT: "text",
  CONTACT: "text",
  TZNAME: "text",
  UID: "text",
  STATUS: "text",
  TRANSP: "text",
  CLASS: "text",
  ACTION: "text",
  FN: "text",
  NOTE: "text",
  TITLE: "text",
  ROLE: "text",
  KIND: "text",
  GENDER: "text",
  "X-ABLABEL": "text",
  CATEGORIES: "text-list",
  NICKNAME: "text-list",
  RESOURCES: "text-list",
  N: "structured",
  ADR: "structured",
  ORG: "structured",
  URL: "uri",
  MEMBER: "uri",
  "X-ADDRESSBOOKSERVER-MEMBER": "uri",
  "X-ADDRESSBOOKSERVER-KIND": "text",
  TEL: "raw",
  EMAIL: "text",
  PHOTO: "binary",
  PRIORITY: "integer",
  "PERCENT-COMPLETE": "integer",
  SEQUENCE: "integer",
  DTSTART: "time",
  DTEND: "time",
  DUE: "time",
  COMPLETED: "time",
  DTSTAMP: "time",
  CREATED: "time",
  "LAST-MODIFIED": "time",
  "RECURRENCE-ID": "time",
  EXDATE: "time",
  RDATE: "time",
  DURATION: "duration",
  TRIGGER: "duration",
  RRULE: "recur",
  BDAY: "raw",
  ANNIVERSARY: "raw",
  REV: "raw",
  VERSION: "raw",
  PRODID: "text",
});

export function valueTypeOf(name) {
  return VALUE_TYPES[name.toUpperCase()] || "text";
}

const noBreak = (s, what) => {
  if (/[\r\n]/.test(s)) throw new FieldError(`${what} may not contain a line break`);
  return s;
};

/**
 * Encode a typed JS value for property `name` into the serialised value text.
 *  text         string
 *  text-list    string[] (or a string)
 *  structured   (string | string[] | null)[]   components joined by ";", lists by ","
 *  uri / raw / integer / duration / recur / binary   string or number, no line break
 *  time         TimeSpec
 */
export function encodeValue(name, typed) {
  const type = valueTypeOf(name);
  switch (type) {
    case "text":
      return escapeText(String(typed));
    case "text-list":
      return (Array.isArray(typed) ? typed : [typed]).map((s) => escapeText(String(s))).join(",");
    case "structured":
      return typed
        .map((c) =>
          c === null || c === undefined
            ? ""
            : Array.isArray(c)
              ? c.map((s) => escapeText(String(s))).join(",")
              : escapeText(String(c)),
        )
        .join(";");
    case "time":
      return formatTime(typed).value;
    default:
      return noBreak(String(typed), name);
  }
}

// ---------------------------------------------------------------------------
// Folding and line formatting

const UTF8_RANGES = [
  [0x7f, 1],
  [0x7ff, 2],
  [0xffff, 3],
];

function cpBytes(cp) {
  for (const [max, n] of UTF8_RANGES) if (cp <= max) return n;
  return 4;
}

/** Number of UTF-8 octets of a string. */
export function utf8Length(s) {
  let n = 0;
  for (const ch of s) n += cpBytes(ch.codePointAt(0));
  return n;
}

/**
 * Fold one logical line at 75 octets. Returns LF-joined physical lines; every
 * continuation line starts with one space and is at most 75 octets long
 * including it. Never splits a UTF-8 sequence (code points stay whole).
 */
export function foldLine(line) {
  if (line.length * 4 <= 75 || utf8Length(line) <= 75) return line;
  const parts = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = cpBytes(ch.codePointAt(0));
    if (bytes + b > limit) {
      parts.push(cur);
      cur = "";
      bytes = 0;
      limit = 74;
    }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join("\n ");
}

const needsQuote = (t) => /[:;,]/.test(t);

/** RFC 6868 caret encoding for a NEW parameter value. */
export function encodeParamText(t) {
  return t.replace(/\^/g, "^^").replace(/"/g, "^'").replace(/\r\n|\r|\n/g, "^n");
}

export function formatParams(params) {
  let out = "";
  for (const p of params) {
    if (p.bare) {
      out += `;${p.name}`;
      continue;
    }
    out += `;${p.name}=` + p.values.map((v) => (v.quoted || needsQuote(v.text) ? `"${v.text}"` : v.text)).join(",");
  }
  return out;
}

/** The unfolded text of a property built from its parts. */
export function formatProperty(prop) {
  return `${prop.group ? prop.group + "." : ""}${prop.name}${formatParams(prop.params)}:${prop.value}`;
}

// ---------------------------------------------------------------------------
// Emission

function walk(comp, out) {
  out.push(comp.beginRaw);
  for (const n of comp.items) {
    if (n instanceof Component) walk(n, out);
    else out.push(n.dirty ? foldLine(formatProperty(n)) : n.folded);
  }
  out.push(comp.endRaw);
}

/** Serialise a component tree to LF text with a final LF. */
export function emitLF(root) {
  const out = [];
  walk(root, out);
  return out.join("\n") + "\n";
}

/** Serialise a component tree to CRLF text with a final CRLF (the PUT body form). */
export function emit(root) {
  return toCRLF(emitLF(root));
}

// ---------------------------------------------------------------------------
// Mutation primitives (all of them mark the owning component as touched when
// something really changed; a no-op never marks anything)

export function touch(comp) {
  comp.touched = true;
}

/** A parameter object. Values are plain strings; they are caret-encoded and quoted on output when needed. */
export function makeParam(name, values) {
  return {
    name,
    values: values.map((t) => ({ text: encodeParamText(t), quoted: false })),
    bare: false,
    raw: null,
  };
}

/** Build a new (dirty) property with an upper-case name. `value` is the already encoded text. */
export function newProp(name, value, { params = [], group = null } = {}) {
  noBreak(value, name);
  return new Property({ group, name: name.toUpperCase(), params, value });
}

function paramsText(params) {
  return formatParams(params);
}

/**
 * Replace (values array) or remove (null) one parameter on a property, keeping
 * the parameter name case and quoting of an existing one. Returns true if
 * anything changed.
 */
export function setParam(prop, name, values) {
  const k = name.toUpperCase();
  const idx = prop.params.findIndex((p) => p.name.toUpperCase() === k);
  if (values === null) {
    if (idx < 0) return false;
    prop.params = prop.params.filter((p) => p.name.toUpperCase() !== k);
    prop.dirty = true;
    return true;
  }
  const encoded = values.map((t) => encodeParamText(t));
  if (idx >= 0) {
    const cur = prop.params.filter((p) => p.name.toUpperCase() === k);
    const same =
      cur.length === 1 &&
      cur[0].values.length === encoded.length &&
      cur[0].values.every((v, i) => v.text === encoded[i]);
    if (same) return false;
    const first = prop.params[idx];
    const quoted = first.values.length ? first.values[0].quoted : false;
    const np = { name: first.name, values: encoded.map((t) => ({ text: t, quoted })), bare: false, raw: null };
    const rest = prop.params.filter((p) => p.name.toUpperCase() !== k);
    rest.splice(idx, 0, np);
    prop.params = rest;
  } else {
    prop.params = [...prop.params, makeParam(name, values)];
  }
  prop.dirty = true;
  return true;
}

/** Change a property's value text (and optionally its params) in place; no-op when identical. */
export function setValue(prop, value, params) {
  noBreak(value, prop.name);
  let changed = false;
  if (prop.value !== value) {
    prop.value = value;
    changed = true;
  }
  if (params !== undefined && paramsText(params) !== paramsText(prop.params)) {
    prop.params = params;
    changed = true;
  }
  if (changed) prop.dirty = true;
  return changed;
}

/**
 * Set the single-valued property `name` of `comp` to the encoded `value`
 * (null removes it). The existing property keeps its name case, group and
 * parameters; a new one is upper-case. Returns true when something changed.
 */
export function setSingle(comp, name, value, { params } = {}) {
  const existing = comp.prop(name);
  if (value === null) {
    if (!existing) return false;
    comp.remove(existing);
    touch(comp);
    return true;
  }
  if (existing) {
    const changed = setValue(existing, value, params);
    if (changed) touch(comp);
    return changed;
  }
  comp.appendProperty(newProp(name, value, { params: params || [] }));
  touch(comp);
  return true;
}

/** TEXT property: no-op when the decoded value is unchanged (keeps foreign escaping forms). */
export function setText(comp, name, text, decode) {
  if (text === null || text === undefined || text === "") return setSingle(comp, name, null);
  const existing = comp.prop(name);
  if (existing && decode(existing.value) === String(text)) return false;
  return setSingle(comp, name, encodeValue(name, text));
}

/**
 * Comma-list TEXT property (CATEGORIES, NICKNAME): every line is replaced by one
 * line holding the list; a list equal to the current one changes nothing.
 */
export function setTextList(comp, name, list) {
  const wanted = (list || []).map((s) => String(s).trim()).filter(Boolean);
  const cur = getTextList(comp, name);
  if (wanted.length === cur.length && wanted.every((v, i) => v === cur[i])) return false;
  const lines = comp.props(name);
  if (!wanted.length) {
    for (const l of lines) comp.remove(l);
    touch(comp);
    return true;
  }
  const value = encodeValue(name, wanted);
  if (lines.length) {
    const [first, ...rest] = lines;
    first.value = value;
    first.dirty = true;
    for (const l of rest) comp.remove(l);
  } else comp.appendProperty(newProp(name, value));
  touch(comp);
  return true;
}

export function addProp(comp, prop) {
  comp.appendProperty(prop);
  touch(comp);
  return prop;
}

export function removeProp(comp, prop) {
  const ok = comp.remove(prop);
  if (ok) touch(comp);
  return ok;
}

function sameSpec(a, b) {
  return a.kind === b.kind && a.iso === b.iso && (a.tzid || null) === (b.tzid || null);
}

/** Set a DATE / DATE-TIME property from a TimeSpec (null removes). */
export function setTimeProp(comp, name, spec) {
  if (spec === null || spec === undefined) return setSingle(comp, name, null);
  const f = formatTime(spec);
  const existing = comp.prop(name);
  if (existing) {
    let same = false;
    try {
      same = sameSpec(parseTime(existing.value, existing.params), spec);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
    }
    if (same) return false;
    existing.value = f.value;
    setParam(existing, "VALUE", f.valueDate ? ["DATE"] : null);
    setParam(existing, "TZID", f.tzid ? [f.tzid] : null);
    existing.dirty = true;
    touch(comp);
    return true;
  }
  const params = [];
  if (f.valueDate) params.push(makeParam("VALUE", ["DATE"]));
  if (f.tzid) params.push(makeParam("TZID", [f.tzid]));
  comp.appendProperty(newProp(name, f.value, { params }));
  touch(comp);
  return true;
}

/** Build a new time property (EXDATE, RDATE ...) from a TimeSpec. */
export function timeProp(name, spec) {
  const f = formatTime(spec);
  const params = [];
  if (f.valueDate) params.push(makeParam("VALUE", ["DATE"]));
  if (f.tzid) params.push(makeParam("TZID", [f.tzid]));
  return newProp(name, f.value, { params });
}

// ---------------------------------------------------------------------------
// Writer-managed properties and the save entry point

/** Names the writer manages (used by the fidelity guard and by semdiff). */
export const MANAGED_PROPS = Object.freeze({
  VEVENT: Object.freeze(["DTSTAMP", "SEQUENCE", "LAST-MODIFIED"]),
  VTODO: Object.freeze(["DTSTAMP", "LAST-MODIFIED"]),
  VCARD: Object.freeze(["REV"]),
});

function setManaged(comp, name, value) {
  const existing = comp.prop(name);
  if (existing) setValue(existing, value);
  else comp.appendProperty(newProp(name, value));
}

function revValue(root, ms) {
  const stamp = formatUtcStamp(ms);
  const existing = root.prop("REV");
  const version = (root.prop("VERSION") || { value: "" }).value.trim();
  const basic = existing ? /^\d{8}T\d{6}Z$/.test(existing.value.trim()) : version === "4.0";
  if (basic) return stamp;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
}

/**
 * Apply the writer-managed properties to every touched VEVENT/VTODO/VCARD in
 * the tree (mutates `root`; callers pass a clone).
 */
export function applyManaged(root, { now = new Date(), isNew = false } = {}) {
  const ms = now instanceof Date ? now.getTime() : now;
  const stamp = formatUtcStamp(ms);
  const visit = (c) => {
    const k = c.key;
    if ((k === "VEVENT" || k === "VTODO") && (c.touched || isNew)) {
      setManaged(c, "DTSTAMP", stamp);
      setManaged(c, "LAST-MODIFIED", stamp);
      if (isNew && !c.prop("CREATED")) c.appendProperty(newProp("CREATED", stamp));
      if (k === "VEVENT") {
        const cur = c.prop("SEQUENCE");
        const n = cur ? parseInt(cur.value, 10) : NaN;
        setManaged(c, "SEQUENCE", String(isNew && !cur ? 0 : (Number.isFinite(n) ? n : 0) + 1));
      }
    } else if (k === "VCARD" && (c.touched || isNew)) {
      setManaged(c, "REV", revValue(c, ms));
    }
    for (const sub of c.components) visit(sub);
  };
  visit(root);
  return root;
}

/**
 * Serialise `root` for a PUT.
 *  - baseline: the CRLF text emitted for the freshly parsed item; when the tree
 *    emits identically no request is needed and {changed:false} is returned;
 *  - isNew: new item (CREATED, SEQUENCE 0 are added by applyManaged);
 *  - prepare(copy): called on the clone before the managed properties are applied (the calendar write path adds
 *    the VTIMEZONEs a new TZID needs there); it is not called when the tree is unchanged.
 * The tree itself is not modified (managed properties go onto a clone), so
 * save can be called again after further edits.
 */
export function serialize(root, { baseline, now = new Date(), isNew = false, prepare } = {}) {
  if (!isNew && baseline !== undefined && emit(root) === baseline) return { changed: false };
  const copy = root.clone();
  if (prepare) prepare(copy);
  applyManaged(copy, { now, isNew });
  return { changed: true, text: emit(copy) };
}
