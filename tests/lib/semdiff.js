// SPDX-License-Identifier: AGPL-3.0-or-later
// Semantic diff of two iCalendar / vCard items for the round-trip tests.
//
// Ignored: property order, parameter-name case, parameter order, quoting of
// parameter values, merged vs repeated TYPE parameters (a set), folding, line
// endings, blank lines, the order of sub-components, and (optionally) the
// writer-managed properties DTSTAMP, SEQUENCE, LAST-MODIFIED, REV.
// Not ignored: property-name case is folded to upper case, but values and the
// group prefix (item1.) are compared as written.

import { Component, parse } from "../../src/js/model/contentlines.js";

const MANAGED = new Set(["DTSTAMP", "SEQUENCE", "LAST-MODIFIED", "REV"]);

function canonParams(params) {
  const byName = new Map();
  for (const p of params) {
    const k = p.name.toUpperCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(...p.values.flatMap((v) => (k === "TYPE" ? v.text.split(",") : [v.text])));
  }
  return [...byName.entries()]
    .map(([k, vals]) => {
      if (k === "TYPE") vals = vals.map((v) => v.trim().toLowerCase()).filter(Boolean).sort();
      return `${k}=${vals.join(",")}`;
    })
    .sort()
    .join(";");
}

function canonProp(p) {
  const params = canonParams(p.params);
  return `${p.group ? p.group.toUpperCase() + "." : ""}${p.name.toUpperCase()}${params ? ";" + params : ""}:${p.value}`;
}

function identity(c) {
  const k = c.key;
  const get = (n) => (c.prop(n) ? c.prop(n).value.trim() : "");
  if (k === "VEVENT" || k === "VTODO" || k === "VJOURNAL") return `${k}:${get("UID")}:${get("RECURRENCE-ID")}`;
  if (k === "VTIMEZONE") return `${k}:${get("TZID")}`;
  if (k === "VCALENDAR" || k === "VCARD") return `${k}:`;
  return null;
}

function canonComponent(c, opts) {
  const props = c.properties
    .filter((p) => !(opts.ignoreManaged && MANAGED.has(p.key)))
    .filter((p) => !(opts.ignoreProps && opts.ignoreProps.includes(p.key)))
    .map(canonProp)
    .sort();
  const subs = c.components.map((s) => canonComponent(s, opts)).sort();
  return `${c.key}{${props.join("|")}${subs.length ? "||" + subs.join("|") : ""}}`;
}

function diffComponent(a, b, path, opts, out) {
  const keep = (p) => !(opts.ignoreManaged && MANAGED.has(p.key)) && !(opts.ignoreProps && opts.ignoreProps.includes(p.key));
  const count = (list) => {
    const m = new Map();
    for (const l of list) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const pa = count(a.properties.filter(keep).map(canonProp));
  const pb = count(b.properties.filter(keep).map(canonProp));
  for (const [l, n] of pa) if ((pb.get(l) || 0) < n) out.push({ path, side: "a", line: l });
  for (const [l, n] of pb) if ((pa.get(l) || 0) < n) out.push({ path, side: "b", line: l });

  const key = (c) => identity(c) || `${c.key}:${canonComponent(c, opts)}`;
  const group = (list) => {
    const m = new Map();
    for (const c of list) {
      const k = key(c);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(c);
    }
    return m;
  };
  const ga = group(a.components);
  const gb = group(b.components);
  for (const [k, list] of ga) {
    const other = gb.get(k) || [];
    list.forEach((c, i) => {
      if (other[i]) diffComponent(c, other[i], `${path}/${c.key}`, opts, out);
      else out.push({ path: `${path}/${c.key}`, side: "a", line: `<component ${k.length > 80 ? k.slice(0, 80) + "..." : k}>` });
    });
  }
  for (const [k, list] of gb) {
    const other = ga.get(k) || [];
    list.forEach((c, i) => {
      if (!other[i]) out.push({ path: `${path}/${c.key}`, side: "b", line: `<component ${k.length > 80 ? k.slice(0, 80) + "..." : k}>` });
    });
  }
}

/**
 * Compare two item texts. Returns {equal, diffs}, where each diff is
 * {path, side: 'a'|'b', line}: a line present only on that side.
 * options: {ignoreManaged: false, ignoreProps: [upper-case names]}.
 */
export function semdiff(textA, textB, options = {}) {
  const ra = parse(textA);
  const rb = parse(textB);
  const wrap = (roots) => {
    const w = new Component("ROOT");
    w.items = roots;
    return w;
  };
  const out = [];
  diffComponent(wrap(ra), wrap(rb), "", options, out);
  return { equal: out.length === 0, diffs: out };
}

/** Names (upper case, group prefix kept) of every property that differs. */
export function changedNames(result) {
  return [...new Set(result.diffs.map((d) => d.line.split(/[;:]/)[0]))].sort();
}
