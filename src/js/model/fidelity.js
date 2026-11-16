// SPDX-License-Identifier: AGPL-3.0-or-later
// Fidelity guard, run before every PUT. The new text must
//  - parse again;
//  - keep UID, VERSION and PRODID (they are never owned, so any change shows up
//    as a changed foreign line);
//  - keep the same set of components EXCEPT those the operation owns:
//    VTIMEZONE, override VEVENTs (RECURRENCE-ID) and relative DISPLAY VALARMs.
//    A VTIMEZONE may be added or removed, but never removed while a TZID
//    parameter in the new text still refers to it;
//  - keep every untouched line, in order. Lines are compared after LF
//    normalisation and unfolding. "Untouched" means: not an owned property of
//    its component (the registries of event.js/todo.js/vcard.js), not a
//    writer-managed property, and not a sibling in a property group that holds an
//    owned property: an X-ABLabel travels with its parent; every other sibling
//    (X-ABADR, X-ABDATE ...) is tolerated only when ALL owned lines of its group are
//    gone from the new text (the whole group was removed or replaced).
// Otherwise FidelityError is thrown and the save is refused.

import { Component, ParseError, normalizeNewlines, parse } from "./contentlines.js";
import { OWNED_PROPS as EVENT_OWNED, modelledAlarm } from "./event.js";
import { OWNED_PROPS as TODO_OWNED } from "./todo.js";
import { OWNED_PROPS as VCARD_OWNED, LABEL_PROP, memberMatches } from "./vcard.js";
import { MANAGED_PROPS } from "./writer.js";

export class FidelityError extends Error {
  constructor(problems) {
    super("fidelity check failed: " + problems.map((p) => p.message).join("; "));
    this.name = "FidelityError";
    this.problems = problems;
  }
}

const OWNED_BY_COMPONENT = {
  VEVENT: new Set([...EVENT_OWNED, ...MANAGED_PROPS.VEVENT]),
  VTODO: new Set([...TODO_OWNED, ...MANAGED_PROPS.VTODO]),
  VCARD: new Set([...VCARD_OWNED, ...MANAGED_PROPS.VCARD]),
};
const NONE = new Set();

function allLines(comp, out = []) {
  out.push(comp.beginRaw);
  for (const n of comp.items) {
    if (n instanceof Component) allLines(n, out);
    else out.push(n.raw);
  }
  out.push(comp.endRaw);
  return out;
}

const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);

function ridKey(comp) {
  const p = comp.prop("RECURRENCE-ID");
  if (!p) return null;
  return `${p.value.trim()}|${p.paramValues("TZID").join(",")}|${p.paramValues("VALUE").join(",")}`;
}

/** Every TZID named by a property parameter outside the VTIMEZONE components. */
function referencedTzids(comp, out = new Set()) {
  for (const p of comp.properties) for (const v of p.paramValues("TZID")) out.add(v.trim());
  for (const c of comp.components) if (c.key !== "VTIMEZONE") referencedTzids(c, out);
  return out;
}

const tzidOf = (v) => {
  const t = v.prop("TZID");
  return t ? t.value.trim() : "";
};

function compare(b, a, path, opts, problems) {
  const owned = OWNED_BY_COMPONENT[b.key] || NONE;
  const ownedGroups = new Set();
  for (const p of [...b.properties, ...a.properties]) if (p.group && owned.has(p.key)) ownedGroups.add(p.groupKey);
  // A property group whose owned parent line(s) are all gone from the new text (removed, or
  // replaced by another line) loses ALL its siblings with it (X-ABLabel, X-ABADR, X-ABDATE ...).
  // While a parent line survives unchanged only its X-ABLabel is owned: any other sibling that
  // disappears is a silently dropped untouched line.
  const parentLines = new Map();
  for (const p of b.properties) {
    if (p.groupKey && owned.has(p.key)) parentLines.set(p.groupKey, [...(parentLines.get(p.groupKey) || []), p.raw]);
  }
  const keptRaw = new Set(a.properties.filter((p) => p.groupKey && owned.has(p.key)).map((p) => p.raw));
  const removedGroups = new Set([...parentLines].filter(([, raws]) => !raws.some((r) => keptRaw.has(r))).map(([g]) => g));
  const isOwned = (p) =>
    owned.has(p.key) || (p.groupKey && ownedGroups.has(p.groupKey) && (p.key === LABEL_PROP || removedGroups.has(p.groupKey)));
  const fb = b.properties.filter((p) => !isOwned(p)).map((p) => p.raw);
  const fa = a.properties.filter((p) => !isOwned(p)).map((p) => p.raw);
  if (!sameLines(fb, fa)) {
    const missing = fb.filter((l) => !fa.includes(l));
    const added = fa.filter((l) => !fb.includes(l));
    const what = missing.length ? `dropped or changed untouched line "${missing[0].slice(0, 40)}"` : added.length ? `unexpected new line "${added[0].slice(0, 40)}"` : "untouched lines reordered";
    problems.push({ code: "foreign-lines", path, message: `${path}: ${what}` });
  }

  const cb = b.components;
  const ca = a.components;
  // VTIMEZONE: added/removed freely (but not while still referenced); one that stays is never rewritten.
  const tb = new Map(cb.filter((c) => c.key === "VTIMEZONE").map((c) => [tzidOf(c), c]));
  if (tb.size) {
    const kept = new Set(ca.filter((c) => c.key === "VTIMEZONE").map(tzidOf));
    const used = referencedTzids(a);
    for (const id of tb.keys()) {
      if (!kept.has(id) && used.has(id)) problems.push({ code: "vtimezone-referenced", path, message: `${path}: VTIMEZONE ${id} was removed but a TZID still refers to it` });
    }
  }
  for (const c of ca.filter((x) => x.key === "VTIMEZONE")) {
    const old = tb.get(tzidOf(c));
    if (old && !sameLines(allLines(old), allLines(c))) {
      problems.push({ code: "vtimezone-changed", path, message: `${path}: VTIMEZONE ${tzidOf(c)} was rewritten` });
    }
  }
  // VALARM: relative DISPLAY alarms are owned; every other alarm must stay.
  const foreignAlarms = (list) => list.filter((c) => c.key === "VALARM" && !modelledAlarm(c)).map((c) => allLines(c));
  const ab = foreignAlarms(cb);
  const aa = foreignAlarms(ca);
  if (ab.length !== aa.length || ab.some((l, i) => !sameLines(l, aa[i]))) {
    problems.push({ code: "alarm-changed", path, message: `${path}: an unmodelled VALARM was changed or removed` });
  }
  // Override VEVENTs: matched by RECURRENCE-ID; may appear or disappear.
  const isOverride = (c) => c.key === "VEVENT" && c.prop("RECURRENCE-ID");
  const ob = new Map(cb.filter(isOverride).map((c) => [ridKey(c), c]));
  const oa = new Map(ca.filter(isOverride).map((c) => [ridKey(c), c]));
  for (const [k, c] of oa) {
    if (ob.has(k)) compare(ob.get(k), c, `${path}/VEVENT[${k.split("|")[0]}]`, opts, problems);
    else if (!opts.allowOverrides) problems.push({ code: "override-added", path, message: `${path}: an override VEVENT was added` });
  }
  for (const [k] of ob) {
    if (!oa.has(k) && !opts.allowOverrides) problems.push({ code: "override-removed", path, message: `${path}: an override VEVENT was removed` });
  }
  // Everything else: same list, same order, compared recursively.
  const rest = (list) => list.filter((c) => c.key !== "VTIMEZONE" && c.key !== "VALARM" && !isOverride(c));
  const rb = rest(cb);
  const ra = rest(ca);
  if (rb.length !== ra.length || rb.some((c, i) => c.key !== ra[i].key)) {
    problems.push({ code: "components", path, message: `${path}: the set of components changed (${rb.map((c) => c.key).join(",")} -> ${ra.map((c) => c.key).join(",")})` });
  } else {
    rb.forEach((c, i) => compare(c, ra[i], `${path}/${c.key}`, opts, problems));
  }
}

function parseOne(text, what) {
  let roots;
  try {
    roots = parse(text);
  } catch (e) {
    if (e instanceof ParseError) throw new FidelityError([{ code: "parse", path: what, message: `${what} does not parse: ${e.message}` }]);
    throw e;
  }
  if (roots.length !== 1) throw new FidelityError([{ code: "roots", path: what, message: `${what} must hold exactly one top-level component` }]);
  return roots[0];
}

/**
 * Compare the text before an edit with the text about to be sent.
 * options: {allowOverrides: true} (default true; pass false for operations
 * that must not add or remove override VEVENTs).
 * Throws FidelityError; returns true when the guard passes.
 */
export function checkFidelity(before, after, { allowOverrides = true } = {}) {
  const b = parseOne(before, "original item");
  const a = parseOne(after, "new item");
  const problems = [];
  if (b.key !== a.key) problems.push({ code: "root", path: "", message: `top-level component changed (${b.key} -> ${a.key})` });
  else compare(b, a, b.key, { allowOverrides }, problems);
  if (problems.length) throw new FidelityError(problems);
  return true;
}

/**
 * Guard for an item that did not exist before: it must parse and carry VERSION and PRODID, and
 * exactly one UID (a VCARD has one UID line; a calendar item one UID over all its components).
 * `requireProdid: false` is for foreign cards imported line by line (PRODID is optional in vCard).
 */
export function checkNewItem(text, { requireProdid = true } = {}) {
  const root = parseOne(text, "new item");
  const problems = [];
  if (!root.prop("VERSION")) problems.push({ code: "no-version", path: root.key, message: "new item has no VERSION" });
  if (requireProdid && !root.prop("PRODID")) problems.push({ code: "no-prodid", path: root.key, message: "new item has no PRODID" });
  const inner = root.key === "VCARD" ? [root] : root.components.filter((c) => c.key === "VEVENT" || c.key === "VTODO");
  if (!inner.length) problems.push({ code: "empty", path: root.key, message: "new item holds no event, task or card" });
  if (root.key === "VCARD") {
    const lines = root.props("UID");
    if (lines.length !== 1 || !lines[0].value.trim()) problems.push({ code: "uid", path: root.key, message: "new card needs exactly one UID" });
  } else {
    const uids = new Set(inner.map((c) => (c.prop("UID") || { value: "" }).value));
    if (uids.size !== 1 || uids.has("")) problems.push({ code: "uid", path: root.key, message: "new item needs exactly one UID" });
  }
  if (problems.length) throw new FidelityError(problems);
  return true;
}

const MEMBER_PROPS = new Set(["MEMBER", "X-ADDRESSBOOKSERVER-MEMBER"]);

const canonUid = (u) => String(u).trim().replace(/^urn:uuid:/i, "");

/** Unfolded, LF-normalised, non-blank lines of a text. */
function unfoldedLines(text) {
  return normalizeNewlines(text)
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((l) => l !== "");
}

/** {name, value} of a content line, or null when it does not look like one. */
function headOf(line) {
  const m = /^(?:[A-Za-z0-9_-]+\.)?([A-Za-z0-9_-]+)(?:;[^:]*)?:(.*)$/s.exec(line);
  return m ? { name: m[1].toUpperCase(), value: m[2] } : null;
}

/**
 * Guard for a resource cut out of a larger text (the .vcf import). Every logical line of
 * `outText` must be a line of `sourceText` (lines are consumed one for one), except
 *  - UID: the value may be the new UID that `uidMap` gives for a UID line of the source,
 *    and a UID line may be added when the source has none (`uidMap[""]` is that UID);
 *  - MEMBER / X-ADDRESSBOOKSERVER-MEMBER: a member that refers to an old UID of `uidMap` may
 *    be rewritten to the same form of the new UID.
 * `uidMap` is an object or a Map {oldUid: newUid}. With `complete` (default false) every
 * source line must also be present in the output, except the rewritten UID and MEMBER lines.
 * Calendar split (.ics import): `dropped` lists property names (upper case, e.g. ["METHOD"]) that may be
 * missing from the output in `complete` mode, and `added` lists exact lines (unfolded) the output may contain
 * although the source does not (wrapper VERSION / PRODID the plan reported). A UID line the source lacks
 * is accepted through `uidMap[""]` as before.
 * Throws FidelityError (codes split-parse, split-foreign-line, split-uid, split-member,
 * split-missing-line); returns true when the guard passes.
 */
export function checkSplit(sourceText, outText, { uidMap = {}, complete = false, dropped = [], added = [] } = {}) {
  const map = uidMap instanceof Map ? new Map(uidMap) : new Map(Object.entries(uidMap || {}));
  const problems = [];
  const fail = (code, message) => problems.push({ code, path: "", message });
  try {
    parse(outText);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    throw new FidelityError([{ code: "split-parse", path: "", message: `output does not parse: ${e.message}` }]);
  }
  const src = unfoldedLines(sourceText);
  const out = unfoldedLines(outText);
  const avail = new Map();
  for (const l of src) avail.set(l, (avail.get(l) || 0) + 1);
  const take = (l) => {
    const n = avail.get(l) || 0;
    if (n > 0) avail.set(l, n - 1);
    return n > 0;
  };
  const srcUids = src.map(headOf).filter((h) => h && h.name === "UID").map((h) => h.value.trim());
  const newUids = new Set([...map.values()].map((v) => String(v).trim()));
  const rewritten = []; // source lines replaced by a rewrite
  const extra = [];
  const allowedAdded = new Map();
  for (const l of added) allowedAdded.set(l, (allowedAdded.get(l) || 0) + 1);
  const droppedNames = new Set(dropped.map((n) => String(n).toUpperCase()));
  for (const line of out) {
    if (take(line)) continue;
    if ((allowedAdded.get(line) || 0) > 0) {
      allowedAdded.set(line, allowedAdded.get(line) - 1);
      extra.push(line);
      continue;
    }
    const h = headOf(line);
    if (h && h.name === "UID") {
      const v = h.value.trim();
      if (newUids.has(v) && (srcUids.some((u) => map.get(u) === v) || (!srcUids.length && map.get("") === v))) {
        extra.push(line);
        continue;
      }
      fail("split-uid", `the UID line "${line.slice(0, 60)}" is neither a source line nor a mapped rewrite`);
    } else if (h && MEMBER_PROPS.has(h.name)) {
      const v = h.value.trim();
      const ok = [...avail.keys()].some((l) => {
        if ((avail.get(l) || 0) <= 0) return false;
        const sh = headOf(l);
        if (!sh || sh.name !== h.name) return false;
        const sv = sh.value.trim();
        for (const [oldUid, newUid] of map) {
          if (!oldUid || !memberMatches(sv, oldUid)) continue;
          const want = /^urn:uuid:/i.test(sv) ? `urn:uuid:${canonUid(newUid)}` : canonUid(newUid);
          if (want === v) {
            take(l);
            rewritten.push(l);
            return true;
          }
        }
        return false;
      });
      if (!ok) fail("split-member", `the member line "${line.slice(0, 60)}" is neither a source line nor a mapped rewrite`);
    } else fail("split-foreign-line", `output line "${line.slice(0, 60)}" is not a source line`);
  }
  if (complete) {
    for (const [l, n] of avail) {
      if (n <= 0) continue;
      const h = headOf(l);
      const replaced = h && ((h.name === "UID" && map.has(h.value.trim())) || droppedNames.has(h.name));
      if (!replaced) fail("split-missing-line", `source line "${l.slice(0, 60)}" is missing from the output`);
    }
  }
  if (problems.length) throw new FidelityError(problems);
  return true;
}
