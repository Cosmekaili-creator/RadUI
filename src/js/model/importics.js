// SPDX-License-Identifier: AGPL-3.0-or-later
// .ics import planning (RUN3 WP C2; RUN2 plan D-R2-16 `.ics` part and addendum B5). Pure functions: no DOM, no
// network, no timers. `importplan.js` re-exports `planIcsImport` and dispatches `resolveImport` here for a plan whose
// `kind` is 'calendar', so the store (importrun.js) runs both kinds the same way.
//
// Rules:
//  - the caller decodes the file as UTF-8 (a non-UTF-8 file is refused there); limits as for `.vcf`;
//  - a file may hold several VCALENDARs. Every top-level component is cut out at line level, so one broken
//    component is reported and skipped without hiding the others;
//  - VEVENT/VTODO are grouped by UID: the master and its overrides (RECURRENCE-ID) stay in ONE resource. A component
//    without a UID gets a generated UID (reported, the only invented line); the same UID + RECURRENCE-ID twice in
//    the file keeps the first;
//  - each resource is the source text written line for line (our own raw-lines writer: no ical.js serialisation, no
//    re-folding): the source VCALENDAR header (METHOD dropped and reported; VERSION / PRODID added only when the
//    source has none), exactly the VTIMEZONEs the resource references, then the components as they are;
//  - VJOURNAL, VFREEBUSY, other components and components the target calendar does not support are skipped and
//    reported per row; a resource the app cannot open (parse error, overrides without master, several UIDs,
//    mixed events and tasks, unsupported VERSION) is listed and never uploaded;
//  - a TZID that neither a VTIMEZONE nor Intl knows is NOT rewritten: the item is imported as it is with a warning
//    (note `unknown-tzid`; the app then shows it read-only);
//  - TEXT values with an unescaped comma (round-trip rule `text-cut-at-unescaped-comma`) are `lossy`: a REPLACE
//    of an existing item with such an item needs `confirmLossy` (same pattern as the contacts import);
//  - every operation is verified with checkSplit (every output line is a source line, except UID rewrites and the
//    wrapper lines the plan reported) and checkNewItem before it is handed out.

import { newUuid } from "../uuid.js";
import { logicalLines, normalizeNewlines, parse, splitUnescaped } from "./contentlines.js";
import { DEFAULT_PRODID } from "./event.js";
import { FidelityError, checkNewItem, checkSplit } from "./fidelity.js";
import { openItem } from "./item.js";
import { foldLine } from "./writer.js";

// Same numbers as importplan.js LIMITS (a unit test asserts they stay equal).
export const ICS_LIMITS = Object.freeze({ fileBytes: 10 * 1024 * 1024, items: 5000, itemBytes: 1024 * 1024, chunks: 20000 });
const NAME_RE = /^[A-Za-z0-9._@-]{1,100}$/;
const SUPPORTED = ["VEVENT", "VTODO"];
const POLICIES = ["skip", "replace", "keep-both"];
const LOSSY_TEXT = new Set(["SUMMARY", "DESCRIPTION", "LOCATION", "COMMENT"]);

const encoder = new TextEncoder();
const byteLength = (s) => encoder.encode(s).length;
const uuid = (random) => (random ? random() : newUuid());
const decodeSafe = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** `<uid>.ics` when the UID is a safe file name, else a fresh UUID (never a name in `taken`, compared case-insensitively). */
export function icsFileName(uid, random, taken = new Set()) {
  const free = (n) => !taken.has(n.toLowerCase());
  if (NAME_RE.test(uid) && !uid.startsWith(".") && free(`${uid}.ics`)) return `${uid}.ics`;
  for (;;) {
    const n = `${uuid(random)}.ics`;
    if (free(n)) return n;
  }
}

/** UID of the first UID line of a calendar item text (the known items of the target), or null. */
export function calendarUidOf(text) {
  const m = /^UID(?:;[^:\n]*)?:(.*)$/im.exec(normalizeNewlines(text).replace(/\n[ \t]/g, ""));
  const v = m ? m[1].trim() : "";
  return v || null;
}

// ---------------------------------------------------------------------------
// Splitting

const BOUNDARY = /^(BEGIN|END):\s*([A-Za-z0-9_-]+)\s*$/i;

/**
 * Cut a file into VCALENDARs and their top-level components at line level (nothing is parsed here).
 * Returns {error: null | 'unreadable', calendars: [{index, line, beginRaw, endRaw, header: [folded line], unterminated}],
 * blocks: [{name, text, line, cal, problem?}], stray: [{line}], overflow}. `text` is the component as in the file
 * (LF, original folding). A block with a `problem` ('unterminated') is not a usable component.
 */
export function splitIcs(fileText, { maxChunks = Infinity } = {}) {
  const lf = normalizeNewlines(fileText);
  let lines;
  try {
    lines = logicalLines(lf);
  } catch {
    return { error: "unreadable", calendars: [], blocks: [], stray: [], overflow: false };
  }
  const calendars = [];
  const blocks = [];
  const stray = [];
  let cal = null;
  let blk = null;
  let strayAt = null;
  let overflow = false;
  for (const ln of lines) {
    if (blocks.length + stray.length > maxChunks) {
      overflow = true;
      break;
    }
    const m = BOUNDARY.exec(ln.raw);
    const kind = m ? m[1].toUpperCase() : null;
    const name = m ? m[2].toUpperCase() : null;
    if (blk) {
      blk.lines.push(ln.folded);
      if (kind === "BEGIN") blk.depth++;
      else if (kind === "END") blk.depth--;
      if (blk.depth === 0) {
        blocks.push({ name: blk.name, text: blk.lines.join("\n") + "\n", line: blk.line, cal: cal.index });
        blk = null;
      }
      continue;
    }
    if (!cal) {
      if (kind === "BEGIN" && name === "VCALENDAR") {
        cal = { index: calendars.length, line: ln.line, beginRaw: ln.folded, endRaw: "END:VCALENDAR", header: [], unterminated: true };
        calendars.push(cal);
        strayAt = null;
      } else if (strayAt === null) {
        strayAt = ln.line;
        stray.push({ line: ln.line });
      }
      continue;
    }
    if (kind === "END" && name === "VCALENDAR") {
      cal.endRaw = ln.folded;
      cal.unterminated = false;
      cal = null;
    } else if (kind === "BEGIN") {
      blk = { name, lines: [ln.folded], line: ln.line, depth: 1 };
    } else cal.header.push(ln.folded);
  }
  if (blk) blocks.push({ name: blk.name, text: blk.lines.join("\n") + "\n", line: blk.line, cal: cal.index, problem: "unterminated" });
  return { error: null, calendars, blocks, stray, overflow };
}

// ---------------------------------------------------------------------------
// Helpers on parsed components

function referencedTzids(comp, out = new Set()) {
  for (const p of comp.properties) for (const v of p.paramValues("TZID")) out.add(v.trim());
  for (const c of comp.components) if (c.key !== "VTIMEZONE") referencedTzids(c, out);
  return out;
}

const ridKey = (comp) => {
  const p = comp.prop("RECURRENCE-ID");
  return p ? `${p.value.trim()}|${p.paramValues("TZID").join(",")}|${p.paramValues("VALUE").join(",")}` : "";
};

/**
 * Names of the TEXT properties Radicale would cut at an unescaped comma (docs/roundtrip.md, rule
 * text-cut-at-unescaped-comma): SUMMARY, DESCRIPTION, LOCATION, COMMENT and unknown X- properties of the events or
 * tasks (and their alarms). `root` is a parsed VCALENDAR.
 */
export function lossyCalendarProperties(root) {
  const out = new Set();
  const walk = (comp) => {
    for (const p of comp.properties) {
      const key = p.key;
      const valueTypes = p.paramValues("VALUE").map((v) => v.toUpperCase());
      if (valueTypes.length && !valueTypes.includes("TEXT")) continue;
      if ((LOSSY_TEXT.has(key) || key.startsWith("X-")) && splitUnescaped(p.value, ",").length > 1) out.add(key);
    }
    for (const c of comp.components) if (c.key !== "VTIMEZONE") walk(c);
  };
  for (const c of root.components) if (SUPPORTED.includes(c.key)) walk(c);
  return [...out];
}

const headerName = (line) => {
  const m = /^([A-Za-z0-9-]+)[;:]/.exec(line);
  return m ? m[1].toUpperCase() : "";
};
const headerValue = (line) => {
  const i = line.indexOf(":");
  return i < 0 ? "" : line.slice(i + 1).replace(/\n[ \t]/g, "").trim();
};

function withUid(text, uid) {
  const lines = text.split("\n");
  let at = 1;
  while (at < lines.length && /^[ \t]/.test(lines[at])) at++;
  lines.splice(at, 0, `UID:${uid}`);
  return lines.join("\n");
}

const REASON_STATE = { "unsupported-version": "unsupported", "unsupported-component": "unsupported" };

export function countIcsRows(rows) {
  const c = { new: 0, duplicate: 0, invalid: 0, unsupported: 0, "file-duplicate": 0 };
  for (const r of rows) c[r.state]++;
  return c;
}

// ---------------------------------------------------------------------------
// Plan

/**
 * Classify the items of a .ics text against the target calendar.
 *
 *  known   items of the target: [{href, etag, uid}]
 *  opts    {collectionHref, limits, random, components: ['VEVENT', 'VTODO']}  (`components`: what the target accepts)
 *
 * Returns {kind: 'calendar', fatal, rows, counts, lossy} like planImport. Row: {index, line, state, reason, uid, href,
 * fn (the title), title, component ('VEVENT'|'VTODO'|the skipped component), itemKind ('event'|'task'|null),
 * recurring, overrides, generatedUid, existingHref, existingEtag, hints: [], lossy: [names], notes: [{code, ...}],
 * text, source}. Notes: `method-dropped` {method}, `wrapper-added` {lines}, `unknown-tzid` {tzids}, `unterminated`.
 */
export function planIcsImport(fileText, known = [], opts = {}) {
  const limits = { ...ICS_LIMITS, ...(opts.limits || {}) };
  const random = opts.random;
  const collection = opts.collectionHref || "";
  const base = collection && !collection.endsWith("/") ? collection + "/" : collection;
  const accepts = new Set((opts.components && opts.components.length ? opts.components : SUPPORTED).map((c) => String(c).toUpperCase()));
  const text = String(fileText ?? "");
  const fatal = (f) => ({ kind: "calendar", fatal: f, rows: [], counts: countIcsRows([]), lossy: [] });
  if (byteLength(text) > limits.fileBytes) return fatal({ reason: "file-too-large", limit: limits.fileBytes });
  const sp = splitIcs(text, { maxChunks: limits.chunks });
  if (sp.overflow) return fatal({ reason: "too-many-chunks", limit: limits.chunks });
  if (sp.error) return fatal({ reason: "unreadable" });
  if (!sp.calendars.length) return fatal({ reason: "empty" });
  const itemBlocks = sp.blocks.filter((b) => !b.problem && SUPPORTED.includes(b.name));
  if (itemBlocks.length > limits.items) return fatal({ reason: "too-many-items", count: itemBlocks.length, limit: limits.items });

  const byUid = new Map();
  const taken = new Set();
  for (const k of known) {
    if (k.uid) byUid.set(String(k.uid).trim(), k);
    const name = String(k.href || "").split("/").pop();
    if (name) taken.add(decodeSafe(name).toLowerCase());
  }

  // 1. VTIMEZONE definitions (per calendar, then the first of the file) and the usable components
  const calTz = sp.calendars.map(() => new Map());
  const fileTz = new Map();
  const rows = [];
  const mkRow = (line, extra) => ({ index: -1, line, state: "new", reason: null, uid: null, href: null, fn: "", title: "", component: null, itemKind: null, recurring: false, overrides: 0, generatedUid: null, existingHref: null, existingEtag: null, hints: [], lossy: [], notes: [], text: null, source: null, ...extra });
  const entries = [];
  for (const b of sp.blocks) {
    if (b.problem) {
      rows.push(mkRow(b.line, { state: "invalid", reason: b.problem, component: b.name }));
      continue;
    }
    if (b.name === "VTIMEZONE") {
      try {
        const [vtz] = parse(b.text);
        const t = vtz.prop("TZID");
        const id = t ? t.value.trim() : "";
        if (id) {
          if (!calTz[b.cal].has(id)) calTz[b.cal].set(id, b.text);
          if (!fileTz.has(id)) fileTz.set(id, b.text);
        }
      } catch {
        /* an unreadable VTIMEZONE is simply not attached; the TZID is then judged by openItem */
      }
      continue;
    }
    if (!SUPPORTED.includes(b.name) || !accepts.has(b.name)) {
      rows.push(mkRow(b.line, { state: "unsupported", reason: "unsupported-component", component: b.name }));
      continue;
    }
    if (byteLength(b.text) > limits.itemBytes) {
      rows.push(mkRow(b.line, { state: "invalid", reason: "too-large", component: b.name }));
      continue;
    }
    let comp;
    try {
      [comp] = parse(b.text);
    } catch {
      rows.push(mkRow(b.line, { state: "invalid", reason: "parse-error", component: b.name }));
      continue;
    }
    const uidProp = comp.prop("UID");
    if (uidProp && !uidProp.value.trim()) {
      rows.push(mkRow(b.line, { state: "invalid", reason: "empty-uid", component: b.name }));
      continue;
    }
    entries.push({ block: b, comp, uid: uidProp ? uidProp.value.trim() : null });
  }
  for (const c of sp.calendars) {
    if (c.unterminated) rows.push(mkRow(c.line, { state: "invalid", reason: "unterminated", component: "VCALENDAR" }));
  }
  for (const s of sp.stray) rows.push(mkRow(s.line, { state: "invalid", reason: "outside-calendar" }));

  // 2. group by UID (a component without UID is its own group)
  const groups = new Map();
  const order = [];
  for (const e of entries) {
    const gid = e.uid === null ? `\u0000${order.length}` : e.uid;
    if (!groups.has(gid)) {
      groups.set(gid, { uid: e.uid, entries: [], seen: new Set() });
      order.push(gid);
    }
    const g = groups.get(gid);
    const dupKey = `${e.block.name}|${ridKey(e.comp)}`;
    if (g.seen.has(dupKey)) {
      rows.push(mkRow(e.block.line, { state: "file-duplicate", reason: "duplicate-uid", uid: e.uid, component: e.block.name }));
      continue;
    }
    g.seen.add(dupKey);
    g.entries.push(e);
  }

  // 3. one resource per group
  for (const gid of order) {
    const g = groups.get(gid);
    const first = g.entries[0];
    const line = Math.min(...g.entries.map((e) => e.block.line));
    const names = new Set(g.entries.map((e) => e.block.name));
    if (names.size > 1) {
      rows.push(mkRow(line, { state: "invalid", reason: "mixed-components", uid: g.uid, component: [...names].join("+") }));
      continue;
    }
    const compName = first.block.name;
    const cal = sp.calendars[first.block.cal];
    const notes = [];
    const header = [];
    let hasVersion = false;
    let hasProdid = false;
    for (const hl of cal.header) {
      const n = headerName(hl);
      if (n === "METHOD") {
        notes.push({ code: "method-dropped", method: headerValue(hl) });
        continue;
      }
      if (n === "VERSION") hasVersion = true;
      if (n === "PRODID") hasProdid = true;
      header.push(hl);
    }
    const added = [];
    if (!hasVersion) added.push("VERSION:2.0");
    if (!hasProdid) added.push(`PRODID:${DEFAULT_PRODID}`);
    if (added.length) notes.push({ code: "wrapper-added", lines: added.length });
    const refs = new Set();
    for (const e of g.entries) referencedTzids(e.comp, refs);
    const tzTexts = [];
    for (const id of refs) {
      const def = calTz[first.block.cal].get(id) || fileTz.get(id);
      if (def && !tzTexts.includes(def)) tzTexts.push(def);
    }
    let generatedUid = null;
    let uid = g.uid;
    const compTexts = g.entries.map((e) => e.block.text);
    if (uid === null) {
      generatedUid = uuid(random);
      uid = generatedUid;
      compTexts[0] = withUid(compTexts[0], uid);
    }
    const body = [...tzTexts, ...compTexts];
    const outText = [cal.beginRaw, ...added, ...header, ...body.map((t) => t.replace(/\n$/, "")), cal.endRaw].join("\n") + "\n";
    const source = [cal.beginRaw, ...cal.header, ...tzTexts.map((t) => t.replace(/\n$/, "")), ...g.entries.map((e) => e.block.text.replace(/\n$/, "")), cal.endRaw].join("\n") + "\n";
    const row = mkRow(line, { uid, component: compName, itemKind: compName === "VEVENT" ? "event" : "task", generatedUid, notes, text: outText, source, extraAdded: added });
    row.overrides = g.entries.filter((e) => e.comp.prop("RECURRENCE-ID")).length;
    rows.push(row);
    if (byteLength(outText) > limits.itemBytes) {
      Object.assign(row, { state: "invalid", reason: "too-large", text: null, source: null });
      continue;
    }
    const item = openItem(outText, row.itemKind);
    if (!item.ok) {
      row.state = REASON_STATE[item.reason] || "invalid";
      row.reason = item.reason;
      row.detail = item.message;
      row.text = null;
      row.source = null;
      continue;
    }
    try {
      row.title = item.fields().summary || "";
    } catch {
      row.title = "";
    }
    row.fn = row.title;
    row.recurring = Boolean(item.main && item.main.prop("RRULE"));
    row.lossy = lossyCalendarProperties(item.root);
    const unknown = item.warnings.filter((w) => w.code === "unknown-tzid").map((w) => w.tzid);
    if (unknown.length) notes.push({ code: "unknown-tzid", tzids: unknown });
    if (generatedUid) notes.push({ code: "generated-uid" });
    const existing = byUid.get(uid);
    if (existing) {
      row.state = "duplicate";
      row.reason = "uid-exists";
      row.href = existing.href;
      row.existingHref = existing.href;
      row.existingEtag = existing.etag || null;
    } else {
      const name = icsFileName(uid, random, taken);
      taken.add(name.toLowerCase());
      row.href = base + encodeURIComponent(name);
    }
  }

  rows.sort((a, b) => a.line - b.line);
  rows.forEach((r, i) => (r.index = i));
  const lossy = rows.filter((r) => r.lossy.length).map((r) => ({ index: r.index, uid: r.uid, fn: r.fn, properties: r.lossy }));
  return { kind: "calendar", fatal: null, rows, counts: countIcsRows(rows), lossy };
}

// ---------------------------------------------------------------------------
// Policies

const newUidLike = (old, random) => (/^urn:uuid:/i.test(old || "") ? `urn:uuid:${uuid(random)}` : uuid(random));

/** Rewrite the UID lines of an item text (master and overrides together); everything else is kept as written. */
function rewriteUid(text, uidMap) {
  const out = [];
  for (const l of logicalLines(normalizeNewlines(text))) {
    const m = /^(UID)((?:;[^:]*)?):(.*)$/is.exec(l.raw);
    const to = m ? uidMap.get(m[3].trim()) : null;
    out.push(to ? foldLine(`${m[1]}${m[2]}:${to}`) : l.folded);
  }
  return out.join("\n") + "\n";
}

/**
 * Turn a calendar plan into requests for a duplicate policy (same contract as resolveImport in importplan.js):
 * 'skip' (default), 'replace' (PUT on the existing href with If-Match of the existing ETag; skipped as
 * 'lossy-needs-confirmation' for a lossy item unless its UID is in `confirmLossy`), 'keep-both' (a new UID for
 * the master AND its overrides, a new href). Returns {operations, skipped, counts, problems}.
 */
export function resolveIcsImport(plan, policy = "skip", opts = {}) {
  if (!POLICIES.includes(policy)) throw new TypeError(`unknown policy ${policy}`);
  const random = opts.random;
  const collection = opts.collectionHref || "";
  const base = collection && !collection.endsWith("/") ? collection + "/" : collection;
  const confirm = new Set(opts.confirmLossy || []);
  const operations = [];
  const skipped = [];
  const problems = [];
  let lossySkipped = 0;
  let lossyOps = 0;
  const taken = new Set();
  for (const r of plan.rows) if (r.href) taken.add(decodeSafe(String(r.href).split("/").pop()).toLowerCase());
  const rekey = new Map();
  if (policy === "keep-both") for (const r of plan.rows) if (r.state === "duplicate") rekey.set(r.uid, newUidLike(r.uid, random));

  for (const r of plan.rows) {
    if (r.state === "invalid" || r.state === "unsupported" || r.state === "file-duplicate") {
      skipped.push({ index: r.index, state: r.state, reason: r.reason });
      continue;
    }
    if (r.state === "duplicate" && policy === "skip") {
      skipped.push({ index: r.index, state: r.state, reason: "kept-existing" });
      continue;
    }
    let href = r.href;
    let op = r.state === "duplicate" ? "replace" : "create";
    let uid = r.uid;
    if (r.state === "duplicate" && policy === "keep-both") {
      op = "create";
      uid = rekey.get(r.uid);
      const name = icsFileName(uid, random, taken);
      taken.add(name.toLowerCase());
      href = base + encodeURIComponent(name);
    }
    if (op === "replace" && r.lossy.length && !confirm.has(r.uid)) {
      problems.push({ index: r.index, code: "lossy-skipped", message: `replacing would damage: ${r.lossy.join(", ")}`, properties: r.lossy });
      skipped.push({ index: r.index, state: r.state, reason: "lossy-needs-confirmation", properties: r.lossy });
      lossySkipped++;
      continue;
    }
    if (op === "replace" && !r.existingEtag) {
      problems.push({ index: r.index, code: "no-etag", message: "the existing item has no ETag" });
      skipped.push({ index: r.index, state: "invalid", reason: "no-etag" });
      continue;
    }
    let out;
    try {
      const own = r.state === "duplicate" && policy === "keep-both" ? new Map([[r.uid, rekey.get(r.uid)]]) : new Map();
      out = own.size ? rewriteUid(r.text, own) : r.text;
      const guardMap = new Map(own);
      if (r.generatedUid) guardMap.set("", r.generatedUid);
      checkSplit(r.source, out, { uidMap: guardMap, complete: true, dropped: ["METHOD"], added: r.extraAdded || [] });
      checkNewItem(out, { requireProdid: false });
    } catch (e) {
      if (!(e instanceof FidelityError)) throw e;
      problems.push({ index: r.index, code: e.problems[0].code, message: e.message });
      skipped.push({ index: r.index, state: "invalid", reason: "guard-failed" });
      continue;
    }
    const o = { op, index: r.index, href, uid, text: out.replace(/\n/g, "\r\n") };
    if (op === "replace") o.etag = r.existingEtag;
    if (r.lossy.length) {
      o.lossy = r.lossy;
      lossyOps++;
    }
    operations.push(o);
  }
  const counts = { create: 0, replace: 0, skipped: skipped.length, lossy: lossyOps, lossySkipped };
  for (const o of operations) counts[o.op]++;
  return { operations, skipped, counts, problems };
}
