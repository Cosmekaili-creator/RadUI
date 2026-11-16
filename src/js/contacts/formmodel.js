// SPDX-License-Identifier: AGPL-3.0-or-later
// The contact form model: the ONLY place where form values become a model patch (RUN2 risk #1,
// silent damage to real cards). No DOM, no Item: it works on `item.fields()` objects.
//
//   toFormValues(fields)            what the form shows for a card
//   toPatch(baseFields, values)     the patch for `item.update()`: ONLY keys whose normalised
//                                   value differs from what the form showed; {} = nothing to save
//   validate(baseFields, values)    structured field errors (message key + field test id)
//   newCardPatch(values, {...})     the fields of a NEW contact (createItem('contact', fields, ...))
//
// Rules (RUN2 plan 2.1 / addendum C M1):
// - every comparison is made against the DISPLAYED baseline (toFormValues(base)), never against
//   the raw card, so a multi-value NICKNAME, a TEL;VALUE=uri, a comma list in N or ADR, a second
//   PREF row ... that the form cannot show is never re-written by an untouched field;
// - an unchanged row is echoed with its original `prop` handle, its ORIGINAL types array,
//   `pref: undefined` and `label: undefined` (the model leaves everything alone);
// - the type select replaces only the one mapped TYPE token (replaceMappedType); INTERNET, VOICE,
//   x-* and a second mapped token stay;
// - `pref` is sent only for a row whose radio changed; `label` only when the label was edited
//   (K1: "" in an echoed entry means unchanged; null removes the label);
// - NICKNAME shows and compares the FIRST value; an edit writes exactly one value (K3);
// - a key that is absent from `values` is untouched;
// - validation looks only at values that changed (or are new): an old card with an odd phone
//   number can still be saved after an unrelated edit.

import { ADR_FIELDS, MAPPED_TYPES, N_FIELDS, labelInfo, partText, replaceMappedType, splitTypes, stripTel } from "../model/vcard.js";

export const LIMITS = Object.freeze({ text: 1000, note: 10000, card: 1024 * 1024 });
export const ROW_KINDS = Object.freeze(["tel", "email", "adr", "url"]);
/** Names the views use in test ids (`field-phone-value`, `phone-row` ...). */
export const FORM_IDS = Object.freeze({ tel: "phone", email: "email", adr: "address", url: "url" });
export const TYPE_OPTIONS = Object.freeze({
  tel: Object.freeze(["cell", "home", "work", "main", "fax", "pager", "other", "custom"]),
  email: Object.freeze(["home", "work", "other", "custom"]),
  adr: Object.freeze(["home", "work", "other", "custom"]),
  url: Object.freeze(["home", "work", "other", "custom"]),
});
const DEFAULT_TYPE = Object.freeze({ tel: "cell", email: "home", adr: "home", url: "other" });
/**
 * TEL "main": the TYPE=MAIN token (what Apple's own export writes) is the select's "main". A card that
 * already carries the Apple built-in label below also shows "main" and keeps that label form; choosing
 * "main" writes the TYPE token, never the label.
 */
export const MAIN_LABEL = "_$!<Main>!$_";
export const ANNIVERSARY_REASON = "anniversary-needs-vcard-4";
/** Form part -> model key and test-id suffix of an address row. */
export const ADR_PARTS = Object.freeze([
  { part: "street", id: "street" },
  { part: "ext", id: "extended" },
  { part: "pobox", id: "pobox" },
  { part: "code", id: "code" },
  { part: "locality", id: "city" },
  { part: "region", id: "region" },
  { part: "country", id: "country" },
]);
const NAME_PARTS = Object.freeze(["prefix", "given", "additional", "family", "suffix"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const PHONE_RE = /^[0-9+()\-.\s/#*pPwWxX]+$/;

const str = (v) => (v === undefined || v === null ? "" : String(v));
const nl = (s) => str(s).replace(/\r\n?/g, "\n");
const trim = (s) => nl(s).trim();
const has = (o, k) => o !== null && o !== undefined && o[k] !== undefined;

// ---------------------------------------------------------------------------
// Names

/** The display name composed from name parts: prefix given additional family suffix. */
export function composeFn(parts) {
  return NAME_PARTS.map((k) => trim(parts && parts[k]))
    .filter(Boolean)
    .join(" ");
}

function nameParts(n) {
  const o = {};
  for (const k of NAME_PARTS) o[k] = partText(n ? n[k] : "");
  return o;
}

/**
 * The FN the form should hold: it follows the name parts only while the user has not edited FN AND
 * the ORIGINAL FN equals the composition of the ORIGINAL parts; otherwise the FN field is kept.
 */
export function followFn(baseFields, values) {
  const b = toFormValues(baseFields);
  const parts = {};
  for (const k of NAME_PARTS) parts[k] = values && has(values, k) ? values[k] : b[k];
  const composed = composeFn(parts);
  const shown = trim(values && has(values, "fn") ? values.fn : b.fn);
  // A field that holds neither the original FN nor the current composition was typed by the
  // user, whether or not the view raised `fnEdited`.
  const follows = !(values && values.fnEdited) && trim(b.fn) === composeFn(b) && (shown === trim(b.fn) || shown === composed);
  return follows ? composed : str(values && has(values, "fn") ? values.fn : b.fn);
}

// ---------------------------------------------------------------------------
// Rows

let rowCounter = 0;
const nextId = (kind) => `${kind}-new-${++rowCounter}`;

function emptyValue(kind) {
  return kind === "adr" ? Object.fromEntries(ADR_PARTS.map((p) => [p.part, ""])) : "";
}

/** A blank row to append to the form. */
export function newRow(kind, { typeSel } = {}) {
  if (!ROW_KINDS.includes(kind)) throw new Error(`unknown row kind ${kind}`);
  return { id: nextId(kind), prop: null, value: emptyValue(kind), typeSel: typeSel || DEFAULT_TYPE[kind], label: "", labelKey: null, pref: false };
}

function adrDisplay(v) {
  return Object.fromEntries(ADR_PARTS.map((p) => [p.part, partText(v ? v[p.part] : "")]));
}

/** The TYPE tokens the select of a kind maps: the model's list, plus MAIN for TEL. */
const mappedOf = (kind) => (kind === "tel" ? [...MAPPED_TYPES.tel, "main"] : MAPPED_TYPES[kind]);

function typeSelOf(kind, e) {
  if (e.label) {
    const info = labelInfo(e.label);
    if (kind === "tel" && info.builtin && info.key === "main") return "main";
    return "custom";
  }
  return splitTypes(e.types, mappedOf(kind)).selected || "other";
}

/** One preferred radio per kind: only the FIRST preferred row is shown as preferred. */
function prefsShown(entries) {
  let seen = false;
  return entries.map((e) => {
    const p = !!e.pref && !seen;
    if (e.pref) seen = true;
    return p;
  });
}

function rowFromEntry(kind, e, pref, i) {
  const typeSel = typeSelOf(kind, e);
  const info = typeSel === "custom" ? labelInfo(e.label) : null;
  return {
    id: `${kind}-${i}`,
    prop: e.prop,
    value: kind === "adr" ? adrDisplay(e.value) : kind === "tel" ? stripTel(e.value) : str(e.value),
    typeSel,
    label: info ? info.text : "",
    labelKey: info && info.builtin ? info.key : null,
    pref,
  };
}

function rowsOf(kind, entries) {
  const prefs = prefsShown(entries || []);
  return (entries || []).map((e, i) => rowFromEntry(kind, e, prefs[i], i));
}

const isBlank = (kind, v) => (kind === "adr" ? ADR_PARTS.every((p) => !trim(v && v[p.part])) : !trim(kind === "tel" ? stripTel(str(v)) : v));

function sameRowValue(kind, a, b) {
  if (kind === "adr") return ADR_PARTS.every((p) => trim(a && a[p.part]) === trim(b && b[p.part]));
  return trim(a) === trim(b);
}

// ---------------------------------------------------------------------------
// Dates

function dateValue(d) {
  return {
    date: d && !d.text ? { year: d.year === undefined ? null : d.year, month: d.month, day: d.day } : null,
    text: d && d.text ? str(d.raw) : null,
    replace: false,
  };
}

const sameDate = (a, b) => (!a && !b) || (!!a && !!b && a.month === b.month && a.day === b.day && (a.year || null) === (b.year || null));

function datePatch(baseField, values) {
  if (baseField.text !== null) {
    // a text-valued date is read-only until the user chose Replace and typed a real date
    return values.replace && values.date ? { set: true, value: values.date } : { set: false };
  }
  return sameDate(baseField.date, values.date || null) ? { set: false } : { set: true, value: values.date || null };
}

const dayCount = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** A real calendar date; a missing year allows February 29. */
export function isRealDate(d) {
  if (!d || typeof d !== "object" || d.invalid) return false;
  const { year, month, day } = d;
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12) return false;
  const y = year === null || year === undefined ? 2000 : year;
  if (!Number.isInteger(y) || y < 1 || y > 9999) return false;
  return day >= 1 && day <= dayCount(y, month);
}

// ---------------------------------------------------------------------------
// fields -> form values

/** What the form shows for the fields of a card (a fresh deep copy; mutate it freely). */
export function toFormValues(f) {
  const n = nameParts(f.n);
  const nick = f.nickname || [];
  const units = (f.org && f.org.units) || [];
  const writable = f.version === "4.0";
  const others = (f.anniversaries || [])
    .filter((a) => a.source !== "ANNIVERSARY")
    .map((a) => {
      const info = labelInfo(a.label);
      return { source: a.source, kind: a.kind, ...dateValue(a.date), label: info.text, labelKey: info.builtin ? info.key : null };
    });
  return {
    version: str(f.version),
    photo: { action: "keep", data: null, present: !!(f.photo && f.photo.present) },
    fn: str(f.fn),
    fnEdited: false,
    ...n,
    nickname: str(nick[0]),
    nicknameMore: Math.max(0, nick.length - 1),
    org: str(f.org && f.org.name),
    department: str(units[0]),
    orgMoreUnits: Math.max(0, units.length - 1),
    title: str(f.title),
    tel: rowsOf("tel", f.tel),
    email: rowsOf("email", f.email),
    adr: rowsOf("adr", f.adr),
    url: rowsOf("url", f.url),
    bday: dateValue(f.bday),
    anniversary: { ...dateValue(f.anniversary), writable, reason: writable ? null : ANNIVERSARY_REASON, others },
    categories: [...(f.categories || [])],
    note: nl(f.note),
  };
}

/** The fields of a card that does not exist yet (the baseline of the new-contact form). */
export function emptyFields({ version = "3.0" } = {}) {
  return {
    version,
    uid: null,
    fn: "",
    n: null,
    nickname: [],
    org: null,
    title: "",
    tel: [],
    email: [],
    adr: [],
    url: [],
    bday: null,
    anniversary: null,
    note: "",
    categories: [],
    photo: { present: false },
    photoSig: null,
    anniversaries: [],
    kind: null,
    group: { isGroup: false, form: null, members: [] },
  };
}

/** Choose the photo action: data {mime, base64} replaces, null removes (the form's "Remove"), undefined keeps. */
export function withPhoto(values, data) {
  const photo = data === undefined ? { action: "keep", data: null } : data === null ? { action: "remove", data: null } : { action: "replace", data };
  return { ...values, photo: { ...values.photo, ...photo } };
}

// ---------------------------------------------------------------------------
// values -> patch

/** The FN that would be written for these values (see followFn); "" when there is none. */
export function effectiveFn(baseFields, values) {
  return trim(followFn(baseFields, values));
}

function typeEdit(kind, baseEntry, sel, labelText) {
  const mapped = mappedOf(kind);
  const hadLabel = !!baseEntry.label;
  const drop = replaceMappedType(baseEntry.types, mapped, null);
  if (mapped.includes(sel)) return { types: replaceMappedType(baseEntry.types, mapped, sel), label: hadLabel ? null : undefined };
  if (sel === "custom") return { types: drop, label: trim(labelText) || null };
  return { types: drop, label: hadLabel ? null : undefined }; // "other"
}

function newEntry(kind, r) {
  const mapped = mappedOf(kind);
  const value = kind === "adr" ? Object.fromEntries(ADR_PARTS.map((p) => [p.part, trim(r.value && r.value[p.part])])) : trim(kind === "tel" ? stripTel(str(r.value)) : r.value);
  const label = r.typeSel === "custom" ? trim(r.label) || undefined : undefined;
  return { value, types: mapped.includes(r.typeSel) ? [r.typeSel] : [], pref: !!r.pref, label };
}

/** Per-row comparison with the shown baseline; shared by toPatch and validate. */
function rowDiff(kind, shownBase, r) {
  if (!shownBase) return { isNew: true, value: true, type: true, label: true, pref: !!r.pref };
  const type = r.typeSel !== shownBase.typeSel;
  return {
    isNew: false,
    value: !sameRowValue(kind, r.value, shownBase.value),
    type,
    label: !type && r.typeSel === "custom" && trim(r.label) !== trim(shownBase.label),
    pref: !!r.pref !== !!shownBase.pref,
  };
}

function rowsPatch(kind, baseEntries, rows) {
  const entries = baseEntries || [];
  const shown = rowsOf(kind, entries);
  const byProp = new Map(entries.map((e, i) => [e.prop, { entry: e, shown: shown[i] }]));
  const used = new Set();
  const out = [];
  let changed = false;
  for (const r of rows) {
    const hit = r.prop && !used.has(r.prop) ? byProp.get(r.prop) : null;
    if (isBlank(kind, r.value)) {
      // A row that was blank in the shown baseline too (ADR;TYPE=home:;;;;;;, an empty labelled TEL)
      // is echoed unchanged. Only a row that WAS filled and is now blank is removed; a new blank row is not written.
      if (hit && isBlank(kind, hit.shown.value)) {
        used.add(r.prop);
        out.push({ prop: r.prop, value: hit.entry.value, types: hit.entry.types, pref: undefined, label: undefined });
      }
      continue;
    }
    if (!hit) {
      out.push(newEntry(kind, r));
      changed = true;
      continue;
    }
    used.add(r.prop);
    const { entry, shown: sb } = hit;
    const d = rowDiff(kind, sb, r);
    let value = entry.value;
    if (d.value) {
      changed = true;
      value =
        kind === "adr"
          ? Object.fromEntries(ADR_PARTS.map((p) => [p.part, trim(r.value[p.part]) === trim(sb.value[p.part]) ? entry.value[p.part] : trim(r.value[p.part])]))
          : trim(kind === "tel" ? stripTel(str(r.value)) : r.value);
    }
    let types = entry.types; // the ORIGINAL array unless the select was touched
    let label;
    if (d.type) {
      ({ types, label } = typeEdit(kind, entry, r.typeSel, r.label));
      changed = true;
    } else if (d.label) {
      label = trim(r.label) || null;
      changed = true;
    }
    const pref = d.pref ? !!r.pref : undefined;
    if (d.pref) changed = true;
    out.push({ prop: r.prop, value, types, pref, label });
  }
  if (used.size !== entries.length) changed = true; // a row was removed
  return changed ? out : null;
}

/**
 * The patch for `item.update()` that turns the card `baseFields` into the form's `values`.
 * Contains only keys whose normalised value differs from what the form showed; {} means "no
 * changes to save" (no request is sent).
 */
export function toPatch(baseFields, values) {
  const patch = {};
  const b = toFormValues(baseFields);
  const v = values || {};

  // name
  const fn = effectiveFn(baseFields, v);
  if (fn !== trim(b.fn)) {
    const fallback = fn || trim(v.org) || "";
    if (fallback) patch.fn = fallback;
  }
  if (NAME_PARTS.some((k) => has(v, k) && trim(v[k]) !== trim(b[k]))) {
    const n = {};
    for (const k of N_FIELDS) n[k] = has(v, k) && trim(v[k]) !== trim(b[k]) ? trim(v[k]) : b[k];
    patch.n = n;
  }
  if (has(v, "nickname") && trim(v.nickname) !== trim(b.nickname)) patch.nickname = trim(v.nickname) ? [trim(v.nickname)] : [];

  // organisation: the name and the FIRST unit; further units are kept
  const orgChanged = has(v, "org") && trim(v.org) !== trim(b.org);
  const deptChanged = has(v, "department") && trim(v.department) !== trim(b.department);
  if (orgChanged || deptChanged) {
    const units = (baseFields.org && baseFields.org.units) || [];
    patch.org = {
      name: orgChanged ? trim(v.org) : str(baseFields.org && baseFields.org.name),
      units: deptChanged ? [trim(v.department), ...units.slice(1)].filter(Boolean) : [...units],
    };
  }
  if (has(v, "title") && trim(v.title) !== trim(b.title)) patch.title = trim(v.title);

  for (const kind of ROW_KINDS) {
    if (!Array.isArray(v[kind])) continue;
    const rows = rowsPatch(kind, baseFields[kind], v[kind]);
    if (rows) patch[kind] = rows;
  }

  if (v.bday) {
    const p = datePatch(b.bday, v.bday);
    if (p.set) patch.bday = p.value;
  }
  if (v.anniversary && b.anniversary.writable) {
    const p = datePatch(b.anniversary, v.anniversary);
    if (p.set) patch.anniversary = p.value;
  }

  if (Array.isArray(v.categories)) {
    const was = b.categories.map(trim).filter(Boolean);
    const now = v.categories.map(trim).filter(Boolean);
    if (was.length !== now.length || was.some((c, i) => c !== now[i])) patch.categories = [...new Set(now)];
  }
  if (has(v, "note") && trim(v.note) !== trim(b.note)) patch.note = trim(v.note);

  if (v.photo) {
    if (v.photo.action === "replace" && v.photo.data) patch.photo = { mime: v.photo.data.mime, base64: v.photo.data.base64 };
    else if (v.photo.action === "remove" && b.photo.present) patch.photo = null;
  }
  return patch;
}

/** True when the patch holds no change. */
export const isEmptyPatch = (patch) => !patch || Object.keys(patch).length === 0;

/**
 * The arguments for `createItem('contact', fields, options)` of a NEW contact:
 * `{fields, options: {version, uid}}`. `fields` holds only non-empty values. The FN falls back
 * to the composed name, then to the organisation; an anniversary is never written on a 3.0 card
 * (validate() reports it). `version` comes from pickNewCardVersion(cards).
 */
export function newCardPatch(values, { version = "3.0", uid } = {}) {
  const fields = toPatch(emptyFields({ version }), values);
  if (!fields.fn) {
    const fn = composeFn(values) || trim(values.org);
    if (fn) fields.fn = fn;
  }
  return { fields, options: { version, uid } };
}

// ---------------------------------------------------------------------------
// Validation

function urlProblem(v) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v) || /^[^:/?#]+:\d+(\/|$)/.test(v)) return "scheme";
  try {
    new URL(v); // eslint-disable-line no-new
  } catch {
    return "invalid";
  }
  return null;
}

const dayKey = (y, m, d) => y * 10000 + m * 100 + d;

/**
 * Validate form values against the card they were opened on (`emptyFields()` for a new one).
 * Returns {ok, errors}; an error is {field, testId, key, params?, row?}. Only changed or new
 * values are checked (a legacy value that was not touched never blocks a save); `now` is
 * injectable.
 */
export function validate(baseFields, values, { now = new Date() } = {}) {
  const errors = [];
  const add = (field, testId, key, extra = {}) => errors.push({ field, testId, key, ...extra });
  const b = toFormValues(baseFields);
  const v = values || {};
  const tooLong = (field, testId, s, max = LIMITS.text, extra) => {
    if (str(s).length > max) add(field, testId, "contact.err.tooLong", { params: { max }, ...extra });
  };

  if (!effectiveFn(baseFields, v) && !trim(v.given) && !trim(v.family) && !trim(v.org)) add("fn", "field-fn", "contact.err.name");
  for (const k of ["fn", ...NAME_PARTS, "nickname", "org", "department", "title"]) {
    if (has(v, k) && trim(v[k]) !== trim(b[k])) tooLong(k, `field-${k}`, v[k]);
  }
  if (has(v, "note") && trim(v.note) !== trim(b.note)) tooLong("note", "field-note", v.note, LIMITS.note);

  for (const kind of ROW_KINDS) {
    if (!Array.isArray(v[kind])) continue;
    const shown = new Map(rowsOf(kind, baseFields[kind]).map((r) => [r.prop, r]));
    const seen = new Set();
    v[kind].forEach((r, row) => {
      if (isBlank(kind, r.value)) return;
      const sb = r.prop && !seen.has(r.prop) ? shown.get(r.prop) : null;
      if (sb) seen.add(r.prop);
      const d = rowDiff(kind, sb, r);
      const id = (suffix) => `field-${FORM_IDS[kind]}-${suffix}`;
      if (d.value) {
        if (kind === "adr") {
          for (const p of ADR_PARTS) tooLong(kind, id(p.id), trim(r.value[p.part]), LIMITS.text, { row, part: p.part });
        } else {
          const text = trim(kind === "tel" ? stripTel(str(r.value)) : r.value);
          const at = { row };
          if (text.length > LIMITS.text) add(kind, id("value"), "contact.err.tooLong", { params: { max: LIMITS.text }, ...at });
          else if (kind === "email" && !EMAIL_RE.test(text)) add(kind, id("value"), "contact.err.email", at);
          else if (kind === "tel" && !(PHONE_RE.test(text) && (text.match(/[0-9]/g) || []).length >= 3)) add(kind, id("value"), "contact.err.phone", at);
          else if (kind === "url") {
            const p = urlProblem(text);
            if (p === "scheme") add(kind, id("value"), "contact.err.urlScheme", { ...at, params: { scheme: "https" } });
            else if (p) add(kind, id("value"), "contact.err.url", at);
          }
        }
      }
      if ((d.isNew || d.type || d.label) && r.typeSel === "custom") {
        if (!trim(r.label)) add(kind, id("custom"), "contact.err.label", { row });
        else tooLong(kind, id("custom"), trim(r.label), LIMITS.text, { row });
      }
    });
  }

  if (Array.isArray(v.categories)) {
    const was = new Set(b.categories.map(trim));
    v.categories.forEach((c, i) => {
      if (!was.has(trim(c))) tooLong("categories", "field-categories", trim(c), LIMITS.text, { row: i });
    });
  }

  const today = dayKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const checkDate = (field, base, val, future) => {
    const p = datePatch(base, val);
    if (!p.set || !p.value) return false;
    if (!isRealDate(p.value)) add(field, `field-${field}`, "contact.err.date");
    else if (future && p.value.year && dayKey(p.value.year, p.value.month, p.value.day) > today) add(field, `field-${field}`, "contact.err.bdayFuture");
    return true;
  };
  if (v.bday) checkDate("bday", b.bday, v.bday, true);
  if (v.anniversary) {
    if (b.anniversary.writable) checkDate("anniversary", b.anniversary, v.anniversary, false);
    else if (!sameDate(b.anniversary.date, v.anniversary.date || null) && b.anniversary.text === null) add("anniversary", "field-anniversary", "contact.err.anniversaryVersion");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * What the SERVER will damage on any PUT of this card whatever the form does (spike S2-3):
 * a multi-value NICKNAME is cut to its first value. The write path warns before saving.
 * [{code: 'nickname-truncated', lost: [values]}]
 */
export function serverLossWarnings(baseFields) {
  const nick = (baseFields && baseFields.nickname) || [];
  return nick.length > 1 ? [{ code: "nickname-truncated", lost: nick.slice(1) }] : [];
}

/** An error when the serialised card is larger than 1 MB (check the text `item.save()` returned), else null. */
export function cardSizeError(text) {
  const bytes = new TextEncoder().encode(str(text)).length;
  return bytes > LIMITS.card ? { field: "card", testId: "form-errors", key: "contact.err.cardTooLarge", params: { max: LIMITS.card, bytes } } : null;
}
