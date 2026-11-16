// SPDX-License-Identifier: AGPL-3.0-or-later
// Semantic comparison of an item as sent with the same item as served by Radicale.
//
// Both texts are flattened to a multiset of property lines per component path
// (order, parameter-name case, parameter order, quoting, TYPE lists and folding
// do not matter). What is left after that is explained by an ALLOWLIST of known
// server behaviours; every other difference is "unexplained" and is a failure.
// Each rule cites the fixture that shows it; docs/roundtrip.md has the evidence.
//
// Rule classes:
//   normalisation  the value means the same after the server's rewrite;
//   lossy          the server drops information from input that breaks RFC 5545 /
//                  6350 (an unescaped comma in a TEXT value). RadUI's own writer
//                  never produces such input, so tests on writer output accept
//                  normalisation rules only.

import { parse } from "../../src/js/model/contentlines.js";
import { splitUnescaped, unescapeText } from "../../src/js/model/contentlines.js";

const MANAGED = new Set(["DTSTAMP", "SEQUENCE", "LAST-MODIFIED", "REV"]);

export const ALLOWLIST = Object.freeze([
  { code: "vtimezone-generated", lossy: false, evidence: "ics/event-tzid-iana-novtimezone.ics", what: "a VTIMEZONE for an IANA TZID that had none is added (the zone is known to the tz database); an existing VTIMEZONE is never changed" },
  { code: "prodid-added", lossy: false, evidence: "ics/event-quirk-no-dtstamp.ics", what: "PRODID is added to a calendar that had none" },
  { code: "dtstamp-added", lossy: false, evidence: "ics/event-quirk-no-dtstamp.ics", what: "DTSTAMP is added (current time) to an event or task that had none" },
  { code: "zero-duration-dropped", lossy: false, evidence: "ics/event-quirk-zero-duration.ics", what: "DURATION:PT0S next to DTEND is removed (Radicale quirk for a Thunderbird bug)" },
  { code: "exdate-retyped", lossy: false, evidence: "ics/event-quirk-exdate-value-date.ics", what: "an EXDATE or RDATE of type DATE on a date-time series becomes a date-time at the DTSTART time (Radicale quirk for Evolution)" },
  { code: "default-value-param-dropped", lossy: false, evidence: "ics/event-quirk-redundant-params.ics", what: "TRIGGER;VALUE=DURATION loses the redundant VALUE parameter" },
  { code: "text-reescaped", lossy: false, evidence: "vcf/vcard30-vendor-cloud.vcf", what: "a TEXT value is re-escaped (an unescaped semicolon becomes \\;); the decoded value is identical" },
  { code: "text-cut-at-unescaped-comma", lossy: true, evidence: "ics/event-text-unescaped-separators.ics", what: "vobject keeps only the text before the first unescaped comma of a TEXT value (SUMMARY, DESCRIPTION, LOCATION, COMMENT, NOTE, NICKNAME, TITLE and unknown X- properties)" },
  { code: "photo-data-uri-payload-dropped", lossy: true, evidence: "vcf/vcard40-photo.vcf", what: "PHOTO:data:<mime>;base64,<data> is cut at the comma, so the payload is lost (same cause as the previous rule)" },
]);
const LOSSY = new Set(ALLOWLIST.filter((r) => r.lossy).map((r) => r.code));

const LOSSY_NAMES = new Set(["SUMMARY", "DESCRIPTION", "LOCATION", "COMMENT", "NOTE", "NICKNAME", "TITLE", "PHOTO"]);

// ---------------------------------------------------------------------------

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

const valueOf = (c, n) => (c.prop(n) ? c.prop(n).value.trim() : "");

function segment(c) {
  const k = c.key;
  if (k === "VEVENT" || k === "VTODO" || k === "VJOURNAL") return `${k}[${valueOf(c, "RECURRENCE-ID")}]`;
  if (k === "VTIMEZONE") return `${k}[${valueOf(c, "TZID")}]`;
  return k;
}

/** Entries {path, head, value, name} of every property line of a text. */
export function flatten(text, { ignoreManaged = false } = {}) {
  const out = [];
  const walk = (c, path) => {
    for (const p of c.properties) {
      if (ignoreManaged && MANAGED.has(p.key)) continue;
      const params = canonParams(p.params);
      out.push({ path, name: p.key, head: `${p.group ? p.group.toUpperCase() + "." : ""}${p.key}${params ? ";" + params : ""}`, value: p.value });
    }
    for (const s of c.components) walk(s, `${path}/${segment(s)}`);
  };
  for (const r of parse(text)) walk(r, segment(r));
  return out;
}

const keyOf = (e) => `${e.path}\u0000${e.head}\u0000${e.value}`;

/** Lines only in a / only in b (multiset difference). */
export function flatDiff(textA, textB, opts = {}) {
  const A = flatten(textA, opts);
  const B = flatten(textB, opts);
  const count = (list) => {
    const m = new Map();
    for (const e of list) m.set(keyOf(e), (m.get(keyOf(e)) || 0) + 1);
    return m;
  };
  const cb = count(B);
  const ca = count(A);
  const onlyA = [];
  const onlyB = [];
  for (const e of A) {
    const n = cb.get(keyOf(e)) || 0;
    if (n > 0) cb.set(keyOf(e), n - 1);
    else onlyA.push(e);
  }
  for (const e of B) {
    const n = ca.get(keyOf(e)) || 0;
    if (n > 0) ca.set(keyOf(e), n - 1);
    else onlyB.push(e);
  }
  return { onlyA, onlyB };
}

/** Property name of a diff entry without group prefix. */
export const propName = (e) => e.name;

// ---------------------------------------------------------------------------

function intlAccepts(tzid) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

function removeOne(list, e) {
  const i = list.indexOf(e);
  if (i >= 0) list.splice(i, 1);
}

const dec = (v) => unescapeText(v);
const cutAtComma = (v) => splitUnescaped(v, ",")[0];

/**
 * Compare input text with the text served after PUT.
 * Returns {equal, unexplained: [{side, path, name, head}], explained: [{code, lossy, path, name}]}.
 * (Values are not returned: callers print codes only.)
 */
export function compareServer(inputText, servedText) {
  const { onlyA, onlyB } = flatDiff(inputText, servedText);
  const A = flatten(inputText);
  const explained = [];
  const note = (code, e) => explained.push({ code, lossy: LOSSY.has(code), path: e.path, name: e.name });

  // 1. VTIMEZONE generated for a TZID the input used without defining it
  const generated = new Set();
  for (const b of onlyB.slice()) {
    const m = /(?:^|\/)VTIMEZONE\[([^\]]*)\]/.exec(b.path);
    if (!m) continue;
    const tz = m[1];
    const defined = A.some((a) => a.path.includes(`VTIMEZONE[${tz}]`));
    const used = A.some((a) => a.head.includes(`TZID=${tz}`));
    if (!defined && used && intlAccepts(tz)) {
      removeOne(onlyB, b);
      if (!generated.has(tz)) {
        generated.add(tz);
        note("vtimezone-generated", b);
      }
    }
  }
  // 2. PRODID / DTSTAMP added
  const hasIn = (path, name) => A.some((a) => a.path === path && a.name === name);
  for (const b of onlyB.slice()) {
    if (b.name === "PRODID" && !hasIn(b.path, "PRODID") && /PYVOBJECT/i.test(b.value)) {
      removeOne(onlyB, b);
      note("prodid-added", b);
    } else if (b.name === "DTSTAMP" && !hasIn(b.path, "DTSTAMP")) {
      removeOne(onlyB, b);
      note("dtstamp-added", b);
    }
  }
  // 3. zero duration dropped
  for (const a of onlyA.slice()) {
    if (a.name === "DURATION" && /^[+-]?PT?0+[SMHDW]$/i.test(a.value.trim()) && hasIn(a.path, "DTEND")) {
      removeOne(onlyA, a);
      note("zero-duration-dropped", a);
    }
  }
  // 4. EXDATE / RDATE retyped from DATE to the DTSTART type
  for (const a of onlyA.slice()) {
    if ((a.name !== "EXDATE" && a.name !== "RDATE") || !/VALUE=DATE(?:;|$)/.test(a.head)) continue;
    const days = a.value.split(",").map((s) => s.trim());
    const b = onlyB.find((x) => x.path === a.path && x.name === a.name && x.value.split(",").map((s) => s.slice(0, 8)).join() === days.join());
    if (b) {
      removeOne(onlyA, a);
      removeOne(onlyB, b);
      note("exdate-retyped", a);
    }
  }
  // 5. pair rules on lines with the same path and head (3.: value-param, 6.: re-escape, 7.: cut)
  for (const a of onlyA.slice()) {
    // default VALUE parameter dropped: head differs by VALUE=DURATION
    if (a.name === "TRIGGER" && /VALUE=DURATION/.test(a.head)) {
      const head = a.head.replace(/;?VALUE=DURATION/, "");
      const b = onlyB.find((x) => x.path === a.path && x.head === head && x.value === a.value);
      if (b) {
        removeOne(onlyA, a);
        removeOne(onlyB, b);
        note("default-value-param-dropped", a);
        continue;
      }
    }
    const same = onlyB.filter((x) => x.path === a.path && x.head === a.head);
    const re = same.find((x) => dec(x.value) === dec(a.value));
    if (re) {
      removeOne(onlyA, a);
      removeOne(onlyB, re);
      note("text-reescaped", a);
      continue;
    }
    if (LOSSY_NAMES.has(a.name) || a.name.startsWith("X-")) {
      const cut = same.find((x) => dec(x.value) === dec(cutAtComma(a.value)));
      if (cut) {
        removeOne(onlyA, a);
        removeOne(onlyB, cut);
        const photo = a.name === "PHOTO" && /^data:/i.test(a.value.trim());
        note(photo ? "photo-data-uri-payload-dropped" : "text-cut-at-unescaped-comma", a);
      }
    }
  }
  const unexplained = [
    ...onlyA.map((e) => ({ side: "input", path: e.path, name: e.name, head: e.head })),
    ...onlyB.map((e) => ({ side: "served", path: e.path, name: e.name, head: e.head })),
  ];
  return { equal: unexplained.length === 0, unexplained, explained };
}

/** Summary {code: count} of explained entries. */
export function tally(explained) {
  const t = {};
  for (const e of explained) t[e.code] = (t[e.code] || 0) + 1;
  return t;
}

export const hasLossy = (explained) => explained.some((e) => e.lossy);
