// SPDX-License-Identifier: AGPL-3.0-or-later
// Conflict handling for contacts after a 412: a three-way diff of the owned fields
// (diffOwned) and the row-level three-way merge behind "Overwrite with mine"
// (rebasePatch). Pure functions on the plain objects Item.fields() returns; no DOM,
// no network. Contract (RUN2 addendum B1):
//
//  - operations (add / remove / modify of one row) are derived from base -> mine using
//    the base property identity (`prop`) and replayed on theirs, matching rows by their
//    BASE (value, types);
//  - rows I did not touch follow theirs; on rows both sides changed, mine wins;
//  - an operation that cannot be mapped onto theirs (the row was deleted or changed by the
//    other side) is RETURNED in `unmappable`, never guessed and never dropped silently;
//  - group membership is replayed as a delta (add or remove ONE member), never as a list;
//  - a group card is never copied (canSaveAsCopy).
//
// The patch returned by rebasePatch is meant for the THEIRS item whose fields were passed
// in (its entries carry theirs' `prop` objects): item.update(result.patch).
//
// Events and tasks (RUN3 D-R3-5.5): `FIELDS` is the per-kind registry of the compared keys and
// `diffOwned(kind, base, mine, theirs, {occurrences})` compares NORMALISED PROJECTIONS (store/verify.js
// projectEvent / projectTask), not Items. The contact form `diffOwned(base, mine, theirs)` is unchanged.
// There is no row-level rebase for events: an operation list is replayed on theirs (store/writes.js).

import { ADR_FIELDS, N_FIELDS, isGroupCard, partText, sameMember } from "./vcard.js";

const LIST_KEYS = ["tel", "email", "adr", "url"];
/** Fields compared by diffOwned, in display order. */
export const DIFF_FIELDS = Object.freeze(["fn", "n", "nickname", "org", "title", "tel", "email", "adr", "url", "bday", "anniversary", "note", "categories", "photo", "kind", "members"]);

const has = (o, k) => o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);

/** The plain fields of an Item or of a fields() object. */
function fieldsOf(x) {
  return x && typeof x.fields === "function" ? x.fields() : x || {};
}

/** Event keys compared by diffOwned (projection keys of store/verify.js, plus the set of overrides), in display order. */
export const EVENT_FIELDS = Object.freeze(['summary', 'start', 'end', 'rrule', 'exdates', 'overrides', 'location', 'description', 'url', 'categories', 'status', 'transp', 'alarms']);
/** Task keys compared by diffOwned. */
export const TASK_FIELDS = Object.freeze(['summary', 'due', 'start', 'priority', 'status', 'percent', 'categories', 'description', 'rrule']);
/** The per-kind field registry. */
export const FIELDS = Object.freeze({ contact: DIFF_FIELDS, event: EVENT_FIELDS, task: TASK_FIELDS });

/**
 * Can this item be saved as a copy?
 *  - `canSaveAsCopy(contact)`: group cards cannot (a copy would duplicate the group);
 *  - `canSaveAsCopy(kind, recurring)` with kind 'contact' | 'event' | 'task': only a NON-recurring event or task
 *    can (a copy of a series would duplicate every occurrence), and every contact that is not a group.
 */
export function canSaveAsCopy(x, recurring = false) {
  if (typeof x === "string") return x === "contact" ? true : !recurring;
  return !isGroupCard(x);
}

// ---------------------------------------------------------------------------
// Normalisation

const typeSet = (types) => [...new Set((types || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort();
const sameSet = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
const labelOrNull = (l) => (l === undefined || l === null ? null : String(l));

function valueText(key, v) {
  if (key === "adr") return JSON.stringify(ADR_FIELDS.map((f) => partText(v ? v[f] : "")));
  return String(v === undefined || v === null ? "" : v).trim();
}

/** Identity of a row for matching: its value and its type set. */
const identity = (key, e) => `${valueText(key, e.value)}\u0000${typeSet(e.types).join(",")}`;
/** Everything a row says (used to compare lists). */
const fullKey = (key, e) => `${identity(key, e)}\u0000${e.pref ? 1 : 0}\u0000${labelOrNull(e.label) || ""}`;

function entryText(key, e) {
  let v;
  if (key === "adr") v = ADR_FIELDS.map((f) => partText(e.value ? e.value[f] : "")).filter(Boolean).join(", ");
  else v = valueText(key, e.value);
  const bits = [...typeSet(e.types)];
  if (e.pref) bits.push("pref");
  const label = labelOrNull(e.label);
  return `${v}${bits.length ? ` (${bits.join(", ")})` : ""}${label ? ` [${label}]` : ""}`;
}

function dateKey(d) {
  if (!d) return "";
  if (d.text) return `text:${d.raw}`;
  return `${d.year || ""}-${d.month}-${d.day}`;
}

const memberSetKey = (list) => [...(list || [])].map((m) => String(m).trim().replace(/^urn:uuid:/i, "").toLowerCase()).sort().join("\n");

// ---------------------------------------------------------------------------
// diffOwned

/**
 * Rows of the conflict dialog: every owned field that either side changed and on which
 * mine and theirs now differ. `base`, `mine` and `theirs` are Items or fields() objects
 * (`mine` = base with my patch applied). Row: {field, kind, mine, theirs, both,
 * changedMine, changedTheirs}; `both` is true when both sides changed the field. Values
 * are display strings or lists of strings; the photo is only 'changed' / 'unchanged'.
 */
export function diffOwned(first, ...rest) {
  if (first === "event" || first === "task") return diffCalendar(first, ...rest);
  if (first === "contact") return diffContacts(...rest);
  return diffContacts(first, ...rest);
}

function diffContacts(base, mine, theirs) {
  const b = fieldsOf(base);
  const m = fieldsOf(mine);
  const t = fieldsOf(theirs);
  const rows = [];
  for (const field of DIFF_FIELDS) {
    const bv = view(field, b);
    const mv = view(field, m);
    const tv = view(field, t);
    const changedMine = mv.key !== bv.key;
    const changedTheirs = tv.key !== bv.key;
    if (!(changedMine || changedTheirs) || mv.key === tv.key) continue;
    if (field === "photo") {
      rows.push({ field, kind: "photo", mine: changedMine ? "changed" : "unchanged", theirs: changedTheirs ? "changed" : "unchanged", both: changedMine && changedTheirs, changedMine, changedTheirs });
    } else {
      rows.push({ field, kind: mv.kind, mine: mv.display, theirs: tv.display, both: changedMine && changedTheirs, changedMine, changedTheirs });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Events and tasks

function timeView(t) {
  if (!t) return { key: "", display: "" };
  const key = JSON.stringify([t.kind, t.tzid || null, t.at]);
  if (t.kind === "date") return { key, display: t.wall };
  if (t.kind === "utc") return { key, display: `${t.wall}Z` };
  return { key, display: t.tzid ? `${t.wall} ${t.tzid}` : t.wall };
}

function alarmText(a) {
  const [sec, rel] = String(a).split("|");
  const n = Number(sec);
  const abs = Math.abs(n);
  const unit = abs % 86400 === 0 && abs ? `${abs / 86400} d` : abs % 3600 === 0 && abs ? `${abs / 3600} h` : abs % 60 === 0 ? `${abs / 60} min` : `${abs} s`;
  return `${n === 0 ? "0" : n < 0 ? "-" : "+"}${n === 0 ? "" : unit}${rel === "END" ? " (end)" : ""}`;
}

function calView(field, p) {
  const v = p === undefined ? null : p;
  switch (field) {
    case "start":
    case "end":
    case "due":
      return { ...timeView(v), kind: "text" };
    case "categories":
      return { key: JSON.stringify(v || []), display: [...(v || [])], kind: "list" };
    case "exdates":
      return { key: JSON.stringify(v || []), display: (v || []).map((k) => String(k).replace(/^[iw]/, "")), kind: "list" };
    case "overrides":
      return { key: JSON.stringify(v || []), display: [...(v || [])], kind: "list" };
    case "alarms":
      return { key: JSON.stringify(v || []), display: (v || []).map(alarmText), kind: "list" };
    case "percent":
    case "priority":
      return { key: JSON.stringify(v), display: v === null || v === undefined ? "" : String(v), kind: "text" };
    default: {
      const t = v === null || v === undefined ? "" : String(v);
      return { key: t, display: t, kind: "text" };
    }
  }
}

/**
 * Rows for an event or a task. `base`, `mine` and `theirs` are projections (store/verify.js projectEvent /
 * projectTask); `occurrences` ([{key, label}]) lists the occurrences the operations target: their override
 * fields are compared too (row.occurrence = label). Row shape as for contacts.
 */
function diffCalendar(kind, base, mine, theirs, { occurrences = [] } = {}) {
  const rows = [];
  const push = (field, bv, mv, tv, extra = {}) => {
    const b = calView(field, bv);
    const m = calView(field, mv);
    const t = calView(field, tv);
    const changedMine = m.key !== b.key;
    const changedTheirs = t.key !== b.key;
    if (!(changedMine || changedTheirs) || m.key === t.key) return;
    rows.push({ field, kind: m.kind, mine: m.display, theirs: t.display, both: changedMine && changedTheirs, changedMine, changedTheirs, ...extra });
  };
  const get = (p, field) => (field === "overrides" ? Object.keys((p && p.overrides) || {}).sort() : p && p.master ? p.master[field] : undefined);
  for (const field of FIELDS[kind]) push(field, get(base, field), get(mine, field), get(theirs, field));
  for (const occ of occurrences) {
    const part = (p) => (p && p.overrides ? p.overrides[occ.key] : undefined);
    if (!part(base) && !part(mine) && !part(theirs)) continue;
    for (const field of EVENT_FIELDS) {
      if (field === "overrides" || field === "exdates" || field === "rrule") continue;
      const g = (p) => (part(p) ? part(p)[field] : undefined);
      push(field, g(base), g(mine), g(theirs), { occurrence: occ.label });
    }
  }
  return rows;
}

function view(field, f) {
  switch (field) {
    case "fn":
    case "title":
    case "note": {
      const v = f[field] || "";
      return { key: v, display: v, kind: "text" };
    }
    case "kind": {
      const v = f.kind || "";
      return { key: v, display: v, kind: "text" };
    }
    case "n": {
      const parts = N_FIELDS.map((k) => partText(f.n ? f.n[k] : ""));
      return { key: JSON.stringify(parts), display: parts.some(Boolean) ? `${parts[1]} ${parts[2]} ${parts[0]}`.replace(/\s+/g, " ").trim() : "", kind: "text" };
    }
    case "nickname": {
      const v = (f.nickname || [])[0] || "";
      return { key: v, display: v, kind: "text" };
    }
    case "org": {
      const o = f.org;
      const list = o ? [o.name || "", ...(o.units || [])].filter(Boolean) : [];
      return { key: JSON.stringify([o ? o.name || "" : "", o ? o.units || [] : []]), display: list.join(" / "), kind: "text" };
    }
    case "tel":
    case "email":
    case "adr":
    case "url": {
      const list = f[field] || [];
      return { key: JSON.stringify(list.map((e) => fullKey(field, e)).sort()), display: list.map((e) => entryText(field, e)), kind: "list" };
    }
    case "bday":
    case "anniversary": {
      const d = f[field];
      return { key: dateKey(d), display: d ? (d.text ? d.raw : `${d.year ? d.year + "-" : "--"}${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`) : "", kind: "text" };
    }
    case "categories": {
      const list = f.categories || [];
      return { key: JSON.stringify([...list].sort()), display: [...list], kind: "list" };
    }
    case "photo": {
      const present = !!(f.photo && f.photo.present);
      return { key: present ? `1:${f.photoSig || (f.photo.mime || "")}` : "", display: present ? "present" : "", kind: "photo" };
    }
    case "members": {
      const g = f.group;
      const list = g && g.isGroup ? g.members : [];
      return { key: memberSetKey(list), display: [...list], kind: "list" };
    }
    default:
      return { key: "", display: "", kind: "text" };
  }
}

// ---------------------------------------------------------------------------
// Membership

/**
 * Replay a membership delta ({add:[uri], remove:[uri|uid]}) on their member list: remove
 * only members they still have, add only members they do not have. Returns
 * {delta, members, changed}: `delta` is what is really left to do (the patch key
 * `membersDelta`), `members` the resulting list (theirs order, additions last). Unknown
 * and foreign members are never touched.
 */
export function rebaseMembership(delta, theirsMembers) {
  const theirs = [...(theirsMembers || [])];
  const remove = (delta && delta.remove ? delta.remove : []).filter((u) => theirs.some((m) => sameMember(m, u)));
  const kept = theirs.filter((m) => !remove.some((u) => sameMember(m, u)));
  const add = [];
  for (const u of delta && delta.add ? delta.add : []) {
    if (kept.some((m) => sameMember(m, u)) || add.some((a) => sameMember(a, u))) continue;
    add.push(u);
  }
  return { delta: { add, remove }, members: [...kept, ...add], changed: add.length > 0 || remove.length > 0 };
}

/** The delta between two member lists. */
export function membershipDelta(baseMembers, newMembers) {
  const base = baseMembers || [];
  const now = newMembers || [];
  return {
    add: now.filter((u) => !base.some((b) => sameMember(b, u))),
    remove: base.filter((b) => !now.some((u) => sameMember(b, u))),
  };
}

// ---------------------------------------------------------------------------
// rebasePatch

/**
 * Three-way merge of my patch onto their fields.
 *
 *  baseFields    fields() of the item the form was opened on (its entries carry the base `prop`)
 *  minePatch     my patch as the form built it (entries list `prop` of the base item, new rows have none)
 *  theirsFields  fields() of their item (entries carry their `prop`)
 *
 * Returns {patch, unmappable, applied, notes, noop}:
 *  patch       a patch for THEIR item (untouched keys absent, entry lists reference their props)
 *  unmappable  [{field, op: 'modify'|'remove', reason: 'row-not-found', base, mine}] operations
 *              that could not be matched on theirs; the caller lists them and asks for confirmation
 *  applied     [{field, op}] what the patch does (add, remove, modify, set, unpref)
 *  notes       [{field, code, ...}] places where mine silently won and the dialog should say so:
 *              'both-edited' (ORG units edited on both sides), 'theirs-removed' (they removed ORG or N
 *              while I edited a part: my version is kept), 'pref-moved' (a row they marked preferred
 *              lost its mark to the row I marked)
 *  noop        true when the patch is empty
 */
export function rebasePatch(baseFields, minePatch, theirsFields) {
  const base = fieldsOf(baseFields);
  const theirs = fieldsOf(theirsFields);
  const mine = minePatch || {};
  const patch = {};
  const unmappable = [];
  const applied = [];
  const notes = [];

  const scalar = (key, mineVal, baseVal, theirsVal, same = (a, b) => a === b) => {
    if (same(mineVal, baseVal) || same(mineVal, theirsVal)) return;
    patch[key] = mineVal;
    applied.push({ field: key, op: "set" });
  };

  for (const key of ["fn", "title", "note"]) {
    if (has(mine, key)) scalar(key, mine[key] || "", base[key] || "", theirs[key] || "");
  }
  if (has(mine, "kind")) scalar("kind", mine.kind ? String(mine.kind).toLowerCase() : null, base.kind || null, theirs.kind || null);
  if (has(mine, "nickname")) {
    const first = (l) => (l || []).map((x) => String(x).trim()).filter(Boolean)[0] || "";
    const mv = first(mine.nickname);
    if (mv !== first(base.nickname) && mv !== first(theirs.nickname)) {
      patch.nickname = mv ? [mv] : [];
      applied.push({ field: "nickname", op: "set" });
    }
  }
  if (has(mine, "n")) rebaseN(mine.n, base.n, theirs.n, patch, applied, notes);
  if (has(mine, "org")) rebaseOrg(mine.org, base.org, theirs.org, patch, applied, notes);
  for (const key of ["bday", "anniversary"]) {
    if (has(mine, key)) scalar(key, mine[key] || null, base[key] || null, theirs[key] || null, (a, b) => dateKey(a) === dateKey(b));
  }
  if (has(mine, "categories")) rebaseCategories(mine.categories, base.categories, theirs.categories, patch, applied);
  if (has(mine, "photo")) {
    const basePresent = !!(base.photo && base.photo.present);
    const theirsPresent = !!(theirs.photo && theirs.photo.present);
    if (mine.photo === null) {
      if (basePresent && theirsPresent) {
        patch.photo = null;
        applied.push({ field: "photo", op: "remove" });
      }
    } else if (mine.photo) {
      patch.photo = mine.photo;
      applied.push({ field: "photo", op: "set" });
    }
  }
  for (const key of LIST_KEYS) {
    if (has(mine, key)) rebaseEntries(key, base[key] || [], mine[key] || [], theirs[key] || [], patch, unmappable, applied, notes);
  }

  // membership: always a delta
  let delta = null;
  if (has(mine, "membersDelta")) delta = mine.membersDelta;
  else if (has(mine, "members")) delta = membershipDelta(base.group ? base.group.members : [], mine.members);
  if (delta && (delta.add || []).concat(delta.remove || []).length) {
    const r = rebaseMembership(delta, theirs.group ? theirs.group.members : []);
    if (r.changed) {
      patch.membersDelta = r.delta;
      for (const u of r.delta.remove) applied.push({ field: "members", op: "remove", member: u });
      for (const u of r.delta.add) applied.push({ field: "members", op: "add", member: u });
    }
  }
  return { patch, unmappable, applied, notes, noop: Object.keys(patch).length === 0 };
}

function rebaseN(mineN, baseN, theirsN, patch, applied, notes) {
  if (!mineN) {
    if (baseN && theirsN) {
      patch.n = null;
      applied.push({ field: "n", op: "remove" });
    }
    return;
  }
  const changedParts = N_FIELDS.filter((f) => partText(mineN[f]) !== partText(baseN ? baseN[f] : ""));
  if (!theirsN && baseN && changedParts.length) {
    // they removed N while I edited a part: my whole name is kept
    patch.n = { ...mineN };
    applied.push({ field: "n", op: "set" });
    notes.push({ field: "n", code: "theirs-removed", parts: changedParts });
    return;
  }
  const out = {};
  for (const f of N_FIELDS) out[f] = theirsN ? theirsN[f] || "" : "";
  let touched = false;
  for (const f of changedParts) {
    if (partText(mineN[f]) === partText(theirsN ? theirsN[f] : "")) continue; // theirs already says it
    out[f] = mineN[f];
    touched = true;
  }
  if (touched) {
    patch.n = out;
    applied.push({ field: "n", op: "set" });
  }
}

function rebaseOrg(mineOrg, baseOrg, theirsOrg, patch, applied, notes) {
  if (!mineOrg || (!mineOrg.name && !(mineOrg.units || []).length)) {
    if (baseOrg && theirsOrg) {
      patch.org = null;
      applied.push({ field: "org", op: "remove" });
    }
    return;
  }
  const units = (mineOrg.units || []).filter(Boolean);
  const baseUnits = baseOrg ? baseOrg.units : [];
  const same = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);
  const mineName = mineOrg.name || "";
  const nameEdited = mineName !== (baseOrg ? baseOrg.name : "");
  const unitsEdited = !same(units, baseUnits);
  if (!theirsOrg && baseOrg && (nameEdited || unitsEdited)) {
    // they removed ORG while I edited a part: my version is kept
    patch.org = { name: mineName, units };
    applied.push({ field: "org", op: "set" });
    notes.push({ field: "org", code: "theirs-removed", parts: [nameEdited ? "name" : null, unitsEdited ? "units" : null].filter(Boolean) });
    return;
  }
  const theirsUnits = theirsOrg ? theirsOrg.units : [];
  const nameChanged = nameEdited && mineName !== (theirsOrg ? theirsOrg.name : "");
  const unitsChanged = unitsEdited && !same(units, theirsUnits);
  if (unitsChanged && !same(theirsUnits, baseUnits)) notes.push({ field: "org", code: "both-edited", parts: ["units"] });
  if (!nameChanged && !unitsChanged) return;
  patch.org = { name: nameChanged ? mineName : theirsOrg ? theirsOrg.name : "", units: unitsChanged ? units : theirsUnits };
  applied.push({ field: "org", op: "set" });
}

function rebaseCategories(mineList, baseList, theirsList, patch, applied) {
  const norm = (l) => (l || []).map((c) => String(c).trim()).filter(Boolean);
  const m = norm(mineList);
  const b = norm(baseList);
  const t = norm(theirsList);
  const add = m.filter((c) => !b.includes(c) && !t.includes(c));
  const remove = b.filter((c) => !m.includes(c) && t.includes(c));
  if (!add.length && !remove.length) return;
  patch.categories = [...t.filter((c) => !remove.includes(c)), ...add];
  for (const c of remove) applied.push({ field: "categories", op: "remove", value: c });
  for (const c of add) applied.push({ field: "categories", op: "add", value: c });
}

// -- entry lists (tel, email, adr, url)

function changedAttrs(key, b, m) {
  const a = {};
  a.value = has(m, "value") && m.value !== undefined && valueText(key, m.value) !== valueText(key, b.value);
  a.types = m.types !== undefined && !sameSet(typeSet(m.types), typeSet(b.types));
  a.pref = m.pref !== undefined && !!m.pref !== !!b.pref;
  // label: undefined and "" mean unchanged (K1); null removes
  a.label = m.label !== undefined && m.label !== "" && labelOrNull(m.label) !== labelOrNull(b.label);
  a.any = a.value || a.types || a.pref || a.label;
  return a;
}

/** Value of a merged ADR row: my changed parts over theirs. Other kinds: mine. */
function mergeValue(key, bVal, mVal, tVal) {
  if (key !== "adr") return mVal;
  const out = {};
  for (const f of ADR_FIELDS) {
    const mp = mVal ? mVal[f] : "";
    out[f] = partText(mp) !== partText(bVal ? bVal[f] : "") ? mp : tVal ? tVal[f] || "" : "";
  }
  return out;
}

/** The parts ("value", "types") that both sides changed to different results (so mine overrides something of theirs). */
function overlaps(key, a, b, m, t) {
  const parts = [];
  if (a.value) {
    if (key === "adr") {
      if (ADR_FIELDS.some((f) => partText(m.value ? m.value[f] : "") !== partText(b.value ? b.value[f] : "") && partText(t.value ? t.value[f] : "") !== partText(b.value ? b.value[f] : "") && partText(m.value ? m.value[f] : "") !== partText(t.value ? t.value[f] : ""))) parts.push("value");
    } else if (valueText(key, t.value) !== valueText(key, b.value) && valueText(key, m.value) !== valueText(key, t.value)) parts.push("value");
  }
  if (a.types && !sameSet(typeSet(t.types), typeSet(b.types)) && !sameSet(typeSet(m.types), typeSet(t.types))) parts.push("types");
  return parts;
}

function rebaseEntries(key, baseList, mineList, theirsList, patch, unmappable, applied, notes) {
  const baseByProp = new Map(baseList.map((e) => [e.prop, e]));
  const mineByProp = new Map();
  const added = [];
  for (const e of mineList) {
    if (e.prop && baseByProp.has(e.prop)) mineByProp.set(e.prop, e);
    else added.push(e);
  }
  // match EVERY base row to theirs in order (identical rows are consumed one by one)
  const used = new Set();
  const matchOf = new Map();
  for (const b of baseList) {
    const id = identity(key, b);
    const j = theirsList.findIndex((t, i) => !used.has(i) && identity(key, t) === id);
    if (j >= 0) {
      used.add(j);
      matchOf.set(b, j);
    }
  }
  const baseOfTheirs = new Map([...matchOf].map(([b, j]) => [j, b]));
  const dropped = new Set();
  const merged = new Map();
  const minePref = new Set(); // indexes of their rows I marked preferred

  // effective row: what the entry will say after the update (also used for the comparisons below)
  const eff = (t, r) => ({ value: r.value, types: r.types === undefined ? t.types : r.types, pref: r.pref === undefined ? t.pref : r.pref, label: r.label === undefined ? t.label : r.label });
  for (const b of baseList) {
    const m = mineByProp.get(b.prop);
    if (!m) {
      const j = matchOf.get(b);
      // I removed it
      if (j === undefined) unmappable.push({ field: key, op: "remove", reason: "row-not-found", base: entryText(key, b), mine: null });
      else {
        dropped.add(j);
        applied.push({ field: key, op: "remove", row: entryText(key, b) });
      }
      continue;
    }
    const a = changedAttrs(key, b, m);
    if (!a.any) continue;
    let j = matchOf.get(b);
    let bothEdited = false;
    if (j === undefined && baseList.length === theirsList.length) {
      // Both sides edited this row (its value or types, so the identity no longer matches): when the two lists line up
      // (same length, this row and their row unmatched at the same position) it is still the same row. A removed or
      // inserted row changes the length or the positions, so rows are never paired by guesswork.
      // Position alone is not enough: their row at that slot must still share something with the base row (the same value
      // text or the same set of types), otherwise it is another row (reordered list, row deleted and another one added).
      const slot = baseList.indexOf(b);
      const tc = slot >= 0 ? theirsList[slot] : null;
      if (tc && !used.has(slot) && (valueText(key, tc.value) === valueText(key, b.value) || sameSet(typeSet(tc.types), typeSet(b.types)))) {
        j = slot;
        used.add(j);
        baseOfTheirs.set(j, b);
        bothEdited = true;
      }
    }
    if (j === undefined) {
      unmappable.push({ field: key, op: "modify", reason: "row-not-found", base: entryText(key, b), mine: entryText(key, { ...b, ...m }) });
      continue;
    }
    const t = theirsList[j];
    merged.set(j, {
      prop: t.prop,
      value: a.value ? mergeValue(key, b.value, m.value, t.value) : t.value,
      types: a.types ? m.types : undefined,
      pref: a.pref ? m.pref : undefined,
      label: a.label ? m.label : undefined,
    });
    if (a.pref && m.pref) minePref.add(j);
    applied.push({ field: key, op: "modify", row: entryText(key, b) });
    // mine won where theirs also changed the row (only when it actually differs from what they now say)
    const parts = bothEdited ? overlaps(key, a, b, m, t) : [];
    if (parts.length) notes.push({ field: key, code: "both-edited", parts });
  }
  const result = [];
  const effective = [];
  theirsList.forEach((t, j) => {
    if (dropped.has(j)) return;
    const r = merged.has(j) ? merged.get(j) : { prop: t.prop, value: t.value, types: undefined, pref: undefined, label: undefined };
    result.push(r);
    effective.push(eff(t, r));
  });
  // One preferred row per kind: when I marked a row preferred (set or added) and they marked a
  // DIFFERENT row preferred (a row that was not preferred in the base), mine wins and the other
  // mark is cleared. Preferred rows that were already preferred in the base are left alone.
  const minePrefAdded = added.some((e) => e.pref);
  if (minePref.size || minePrefAdded) {
    let k = 0;
    theirsList.forEach((t, j) => {
      if (dropped.has(j)) return;
      const idx = k++;
      if (minePref.has(j) || !effective[idx].pref) return;
      const b = baseOfTheirs.get(j);
      if (b && b.pref) return;
      result[idx] = { ...result[idx], pref: false };
      effective[idx] = { ...effective[idx], pref: false };
      applied.push({ field: key, op: "unpref", row: entryText(key, t) });
      notes.push({ field: key, code: "pref-moved", row: entryText(key, t) });
    });
  }
  const have = new Set(effective.map((e) => identity(key, e)));
  for (const e of added) {
    const row = { value: e.value, types: e.types || [], pref: !!e.pref, label: e.label || undefined };
    const id = identity(key, row);
    if (have.has(id)) continue; // they added the same row
    have.add(id);
    result.push(row);
    effective.push(row);
    applied.push({ field: key, op: "add", row: entryText(key, row) });
  }
  const before = theirsList.map((e) => fullKey(key, e));
  const after = effective.map((e) => fullKey(key, e));
  if (before.length === after.length && before.every((k, i) => k === after[i])) return; // theirs already says it
  patch[key] = result;
}
