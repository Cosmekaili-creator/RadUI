// SPDX-License-Identifier: AGPL-3.0-or-later
// RFC 5545 / RFC 6350 content-line layer: tokenizer, component tree and the
// pure value codecs (TEXT escaping, date/time, duration, RRULE). Used for both
// iCalendar and vCard. No dependencies, no DOM; runs unchanged in Node and in a
// browser.
//
// The tree keeps, for every property, the ORIGINAL physical text (folded, in
// LF-normalised form) next to the parsed name/group/params/value, so that an
// untouched property can be re-emitted exactly as it was read (writer.js).

export class ParseError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.name = "ParseError";
    this.line = line || null;
  }
}

/** Value-level problem (bad date, bad duration ...). */
export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValueError";
  }
}

const MAX_DEPTH = 8;

/** CRLF, lone CR and lone LF all become LF. A leading BOM is dropped. */
export function normalizeNewlines(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n?/g, "\n");
}

/** LF text to CRLF text (input must already be LF-normalised). */
export function toCRLF(lfText) {
  return lfText.replace(/\n/g, "\r\n");
}

// ---------------------------------------------------------------------------
// Tree

/** A content line. `raw` is the unfolded line, `folded` the original physical lines joined with LF. */
export class Property {
  constructor({ group = null, name, params = [], value = "", raw = null, folded = null }) {
    this.group = group;
    this.name = name;
    this.params = params;
    this.value = value;
    this.raw = raw;
    this.folded = folded;
    // A property read from text is clean; a property built in memory is dirty
    // and is serialised by the writer. Editing sets dirty = true.
    this.dirty = raw === null;
  }
  get key() {
    return this.name.toUpperCase();
  }
  get groupKey() {
    return this.group ? this.group.toUpperCase() : null;
  }
  /** First parameter with this name (case-insensitive) or null. */
  param(name) {
    const k = name.toUpperCase();
    return this.params.find((p) => p.name.toUpperCase() === k) || null;
  }
  /** All values of a parameter name (repeats merged), as plain strings. */
  paramValues(name) {
    const k = name.toUpperCase();
    const out = [];
    for (const p of this.params) {
      if (p.name.toUpperCase() === k) for (const v of p.values) out.push(v.text);
    }
    return out;
  }
  clone() {
    const c = new Property({
      group: this.group,
      name: this.name,
      params: this.params.map((p) => ({ ...p, values: p.values.map((v) => ({ ...v })) })),
      value: this.value,
      raw: this.raw,
      folded: this.folded,
    });
    c.dirty = this.dirty;
    return c;
  }
}

export class Component {
  constructor(name, { beginRaw = null, endRaw = null } = {}) {
    this.name = name;
    this.beginRaw = beginRaw === null ? `BEGIN:${name}` : beginRaw;
    this.endRaw = endRaw === null ? `END:${name}` : endRaw;
    this.items = []; // Property | Component, in file order
    this.touched = false; // set by mutators; drives the writer-managed properties
  }
  get key() {
    return this.name.toUpperCase();
  }
  get properties() {
    return this.items.filter((n) => n instanceof Property);
  }
  get components() {
    return this.items.filter((n) => n instanceof Component);
  }
  props(name) {
    const out = this.properties;
    if (name === undefined) return out;
    const k = name.toUpperCase();
    return out.filter((p) => p.key === k);
  }
  prop(name) {
    const k = name.toUpperCase();
    for (const n of this.items) if (n instanceof Property && n.key === k) return n;
    return null;
  }
  comps(name) {
    const out = this.components;
    if (name === undefined) return out;
    const k = name.toUpperCase();
    return out.filter((c) => c.key === k);
  }
  comp(name) {
    return this.comps(name)[0] || null;
  }
  indexOf(node) {
    return this.items.indexOf(node);
  }
  append(node) {
    this.items.push(node);
    return node;
  }
  /** Insert after the last property (before any sub-component). */
  appendProperty(prop) {
    let at = -1;
    for (let i = 0; i < this.items.length; i++) if (this.items[i] instanceof Property) at = i;
    this.items.splice(at + 1, 0, prop);
    return prop;
  }
  insertAfter(ref, node) {
    const i = this.items.indexOf(ref);
    this.items.splice(i < 0 ? this.items.length : i + 1, 0, node);
    return node;
  }
  insertBefore(ref, node) {
    const i = this.items.indexOf(ref);
    this.items.splice(i < 0 ? this.items.length : i, 0, node);
    return node;
  }
  remove(node) {
    const i = this.items.indexOf(node);
    if (i >= 0) this.items.splice(i, 1);
    return i >= 0;
  }
  clone() {
    const c = new Component(this.name, { beginRaw: this.beginRaw, endRaw: this.endRaw });
    c.touched = this.touched;
    c.items = this.items.map((n) => n.clone());
    return c;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer

/**
 * Split LF text into logical lines. Returns [{raw, folded, line}] where `raw` is
 * the unfolded text, `folded` the physical lines joined by LF and `line` the
 * 1-based number of the first physical line. Blank lines are skipped.
 */
export function logicalLines(lfText) {
  const phys = lfText.split("\n");
  if (phys.length && phys[phys.length - 1] === "") phys.pop();
  const out = [];
  let cur = null;
  for (let i = 0; i < phys.length; i++) {
    const p = phys[i];
    if (p === "") continue;
    const c = p.charCodeAt(0);
    if (c === 0x20 || c === 0x09) {
      if (!cur) throw new ParseError("continuation line without a preceding line", i + 1);
      cur.raw += p.slice(1);
      cur.folded += "\n" + p;
    } else {
      cur = { raw: p, folded: p, line: i + 1 };
      out.push(cur);
    }
  }
  return out;
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Parse one unfolded content line into {group, name, params, value}.
 * Parameter values keep their raw (still caret-encoded) text; `quoted` records
 * the original quoting. A parameter without "=" (vCard 2.1 style) is `bare`.
 */
export function parseContentLine(raw, lineNo) {
  let i = 0;
  const n = raw.length;
  while (i < n && raw[i] !== ";" && raw[i] !== ":") i++;
  if (i >= n) throw new ParseError("content line without ':'", lineNo);
  let nameTok = raw.slice(0, i);
  let group = null;
  const dot = nameTok.indexOf(".");
  if (dot >= 0) {
    group = nameTok.slice(0, dot);
    nameTok = nameTok.slice(dot + 1);
    if (!NAME_RE.test(group)) throw new ParseError("bad group name", lineNo);
  }
  if (!NAME_RE.test(nameTok)) throw new ParseError("bad property name", lineNo);
  const params = [];
  while (raw[i] === ";") {
    i++;
    const start = i;
    while (i < n && raw[i] !== "=" && raw[i] !== ";" && raw[i] !== ":") i++;
    if (i >= n) throw new ParseError("content line without ':'", lineNo);
    const pname = raw.slice(start, i);
    if (!pname || !NAME_RE.test(pname)) throw new ParseError("bad parameter name", lineNo);
    if (raw[i] !== "=") {
      params.push({ name: pname, values: [], bare: true, raw: pname });
      continue;
    }
    i++; // '='
    const values = [];
    for (;;) {
      if (raw[i] === '"') {
        const end = raw.indexOf('"', i + 1);
        if (end < 0) throw new ParseError("unterminated quoted parameter value", lineNo);
        values.push({ text: raw.slice(i + 1, end), quoted: true });
        i = end + 1;
        if (i < n && raw[i] !== "," && raw[i] !== ";" && raw[i] !== ":") {
          throw new ParseError("text after a quoted parameter value", lineNo);
        }
      } else {
        const s = i;
        while (i < n && raw[i] !== "," && raw[i] !== ";" && raw[i] !== ":") i++;
        values.push({ text: raw.slice(s, i), quoted: false });
      }
      if (i >= n) throw new ParseError("content line without ':'", lineNo);
      if (raw[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    params.push({ name: pname, values, bare: false, raw: raw.slice(start, i) });
  }
  if (raw[i] !== ":") throw new ParseError("content line without ':'", lineNo);
  return { group, name: nameTok, params, value: raw.slice(i + 1) };
}

/**
 * Parse text (any line ending) into an array of top-level components.
 * Throws ParseError on structural problems.
 */
export function parse(text) {
  const lf = normalizeNewlines(text);
  const lines = logicalLines(lf);
  const roots = [];
  const stack = [];
  for (const ln of lines) {
    const p = parseContentLine(ln.raw, ln.line);
    const key = p.name.toUpperCase();
    if (!p.group && key === "BEGIN") {
      if (p.params.length) throw new ParseError("BEGIN with parameters", ln.line);
      if (stack.length >= MAX_DEPTH) throw new ParseError("components nested too deeply", ln.line);
      const c = new Component(p.value.trim() || "", { beginRaw: ln.folded });
      if (!c.name || !NAME_RE.test(c.name)) throw new ParseError("bad component name", ln.line);
      if (stack.length) stack[stack.length - 1].append(c);
      else roots.push(c);
      stack.push(c);
    } else if (!p.group && key === "END") {
      const top = stack.pop();
      if (!top) throw new ParseError("END without BEGIN", ln.line);
      if (top.name.toUpperCase() !== p.value.trim().toUpperCase()) {
        throw new ParseError(`END:${p.value} does not match BEGIN:${top.name}`, ln.line);
      }
      top.endRaw = ln.folded;
    } else {
      if (!stack.length) throw new ParseError("content outside any component", ln.line);
      stack[stack.length - 1].append(
        new Property({ group: p.group, name: p.name, params: p.params, value: p.value, raw: ln.raw, folded: ln.folded }),
      );
    }
  }
  if (stack.length) throw new ParseError(`unterminated component ${stack[stack.length - 1].name}`);
  return roots;
}

// ---------------------------------------------------------------------------
// TEXT codecs

/** Escape a TEXT value: backslash, semicolon, comma, newline. */
export function escapeText(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Reverse of escapeText; unknown escapes drop the backslash. */
export function unescapeText(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      const d = s[++i];
      out += d === "n" || d === "N" ? "\n" : d;
    } else out += c;
  }
  return out;
}

/** Split a raw value on an unescaped separator; segments stay raw (still escaped). */
export function splitUnescaped(s, sep) {
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      cur += c + s[++i];
    } else if (c === sep) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Date / time / duration codecs
//
// TimeSpec: { kind: 'date'|'floating'|'utc'|'zoned', iso, tzid? }
//   date     iso = 'YYYY-MM-DD'
//   others   iso = 'YYYY-MM-DDTHH:MM:SS' (wall clock; 'utc' means UTC)

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATETIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

const pad = (n, w = 2) => String(n).padStart(w, "0");

function checkDate(y, mo, d, raw) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || d < 1 || t.getUTCDate() !== d || t.getUTCMonth() !== mo - 1) {
    throw new ValueError(`invalid date ${raw}`);
  }
}

/** Parse an iCalendar DATE / DATE-TIME value with its parameters. */
export function parseTime(raw, params = []) {
  const v = raw.trim();
  const tz = params.find((p) => p.name.toUpperCase() === "TZID");
  const isDateParam = params.some(
    (p) => p.name.toUpperCase() === "VALUE" && p.values.some((x) => x.text.toUpperCase() === "DATE"),
  );
  let m = DATE_RE.exec(v);
  if (m && (isDateParam || !DATETIME_RE.test(v))) {
    checkDate(+m[1], +m[2], +m[3], v);
    return { kind: "date", iso: `${m[1]}-${m[2]}-${m[3]}` };
  }
  m = DATETIME_RE.exec(v);
  if (!m) throw new ValueError(`invalid date-time ${raw}`);
  checkDate(+m[1], +m[2], +m[3], v);
  if (+m[4] > 23 || +m[5] > 59 || +m[6] > 60) throw new ValueError(`invalid time ${raw}`);
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (m[7] === "Z") return { kind: "utc", iso };
  if (tz && tz.values.length) return { kind: "zoned", iso, tzid: tz.values[0].text };
  return { kind: "floating", iso };
}

/** Format a TimeSpec to {value, valueDate, tzid} (the property value and what the params need). */
export function formatTime(spec) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/.exec(spec.iso || "");
  if (!m) throw new ValueError(`invalid time spec ${JSON.stringify(spec)}`);
  checkDate(+m[1], +m[2], +m[3], spec.iso);
  if (spec.kind === "date") {
    return { value: `${m[1]}${m[2]}${m[3]}`, valueDate: true, tzid: null };
  }
  if (m[4] === undefined) throw new ValueError("date-time spec without a time");
  const value = `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}`;
  if (spec.kind === "utc") return { value: value + "Z", valueDate: false, tzid: null };
  if (spec.kind === "zoned") {
    if (!spec.tzid) throw new ValueError("zoned time without tzid");
    return { value, valueDate: false, tzid: spec.tzid };
  }
  if (spec.kind === "floating") return { value, valueDate: false, tzid: null };
  throw new ValueError(`unknown time kind ${spec.kind}`);
}

/** Wall-clock milliseconds (as if UTC) of a TimeSpec. */
export function specWallMs(spec) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/.exec(spec.iso);
  if (!m) throw new ValueError(`invalid time spec ${JSON.stringify(spec)}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/** Build a TimeSpec from wall-clock milliseconds (as if UTC). */
export function specFromWallMs(ms, kind, tzid) {
  const d = new Date(ms);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (kind === "date") return { kind, iso: date };
  const iso = `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return kind === "zoned" ? { kind, iso, tzid } : { kind, iso };
}

const DUR_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

/** Parse an RFC 5545 DURATION to signed seconds. */
export function parseDuration(raw) {
  const v = raw.trim();
  const m = DUR_RE.exec(v);
  if (!m || v.replace(/^[+-]/, "") === "P" || /T$/i.test(v)) throw new ValueError(`invalid duration ${raw}`);
  const s = (+m[2] || 0) * 604800 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0);
  return m[1] === "-" ? -s : s;
}

/** Format signed seconds as a compact DURATION (weeks only when exact). */
export function formatDuration(seconds) {
  const neg = seconds < 0;
  let s = Math.abs(Math.round(seconds));
  const sign = neg ? "-" : "";
  if (s === 0) return "PT0S";
  if (s % 604800 === 0) return `${sign}P${s / 604800}W`;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const mi = Math.floor(s / 60);
  s -= mi * 60;
  let out = `${sign}P`;
  if (d) out += `${d}D`;
  if (h || mi || s) {
    out += "T";
    if (h) out += `${h}H`;
    if (mi) out += `${mi}M`;
    if (s) out += `${s}S`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// RRULE codec: ordered [key, value] pairs so unknown parts survive.

export function parseRRule(raw) {
  const out = [];
  for (const part of raw.split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) throw new ValueError(`invalid RRULE part ${part}`);
    out.push([part.slice(0, eq).toUpperCase(), part.slice(eq + 1)]);
  }
  if (!out.some(([k]) => k === "FREQ")) throw new ValueError("RRULE without FREQ");
  return out;
}

export function formatRRule(pairs) {
  return pairs.map(([k, v]) => `${k}=${v}`).join(";");
}

/** Compact text of a UTC instant (ms) as YYYYMMDDTHHMMSSZ. */
export function formatUtcStamp(ms) {
  const d = new Date(ms);
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// ---------------------------------------------------------------------------
// Read helpers on the tree

/** Decoded TEXT value of the first property `name`, or null. */
export function getText(comp, name) {
  const p = comp.prop(name);
  return p ? unescapeText(p.value) : null;
}

/** Decoded TEXT list over every property `name` (comma lists and repeated lines flattened). */
export function getTextList(comp, name) {
  const out = [];
  for (const p of comp.props(name)) {
    for (const seg of splitUnescaped(p.value, ",")) {
      const t = unescapeText(seg).trim();
      if (t) out.push(t);
    }
  }
  return out;
}
