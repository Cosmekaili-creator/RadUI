// SPDX-License-Identifier: AGPL-3.0-or-later
// vCard 3.0 / 4.0: the properties RadUI owns (SPECS 4.3). vCard data is read
// and written only through the content-line layer (never through ical.js, D6).
// The VERSION of a card is never changed. PHOTO is never re-serialised: a photo
// is either left alone or replaced by a new property. Apple "itemN." group
// siblings (X-ABLabel ...) travel with their parent property.

import { newUuid } from "../uuid.js";
import {
  Component,
  escapeText,
  getText,
  getTextList,
  splitUnescaped,
  unescapeText,
} from "./contentlines.js";
import {
  FieldError,
  addProp,
  encodeValue,
  makeParam,
  newProp,
  setParam,
  setSingle,
  setText,
  setTextList,
  setValue,
  touch,
} from "./writer.js";

export const OWNED_PROPS = Object.freeze([
  "N",
  "FN",
  "NICKNAME",
  "ORG",
  "TITLE",
  "TEL",
  "EMAIL",
  "ADR",
  "URL",
  "BDAY",
  "ANNIVERSARY",
  "NOTE",
  "CATEGORIES",
  "PHOTO",
  "KIND",
  "MEMBER",
  "X-ADDRESSBOOKSERVER-KIND",
  "X-ADDRESSBOOKSERVER-MEMBER",
]);
export const LABEL_PROP = "X-ABLABEL";
export const DEFAULT_PRODID = "-//RadUI//Contacts//EN";
const KINDS = ["individual", "group", "org", "location"];

export function cardOf(root) {
  return root.key === "VCARD" ? root : root.comp("VCARD");
}

export function versionOf(card) {
  const v = card.prop("VERSION");
  return v ? v.value.trim() : "";
}

// ---------------------------------------------------------------------------
// Groups (Apple itemN.) and labels

export function siblingsOf(card, prop) {
  if (!prop.group) return [];
  const g = prop.groupKey;
  return card.properties.filter((p) => p !== prop && p.groupKey === g);
}

function freeGroup(card) {
  const used = new Set(card.properties.filter((p) => p.group).map((p) => p.groupKey));
  for (let i = 1; ; i++) if (!used.has(`ITEM${i}`)) return `item${i}`;
}

/** Remove a property together with its group siblings. */
export function removeWithSiblings(card, prop) {
  const block = [prop, ...siblingsOf(card, prop)];
  for (const p of block) card.remove(p);
  touch(card);
}

/** Move a property and its siblings as a block next to `target` (and its siblings). */
export function moveEntry(card, prop, target, where = "before") {
  if (prop === target) return false;
  const block = card.items.filter((n) => n === prop || siblingsOf(card, prop).includes(n));
  const tblock = card.items.filter((n) => n === target || siblingsOf(card, target).includes(n));
  if (block.includes(target)) throw new FieldError("cannot move a property next to its own sibling");
  for (const n of block) card.remove(n);
  const idx = tblock.map((n) => card.items.indexOf(n));
  const at = where === "before" ? Math.min(...idx) : Math.max(...idx) + 1;
  card.items.splice(at, 0, ...block);
  touch(card);
  return true;
}

export function labelOf(card, prop) {
  const sib = siblingsOf(card, prop).find((p) => p.key === LABEL_PROP);
  return sib ? unescapeText(sib.value) : null;
}

function setLabel(card, prop, label) {
  // "" means unchanged (an empty X-ABLabel read back by fields() must survive an echo);
  // null removes the label.
  if (label === "") return false;
  const sib = siblingsOf(card, prop).find((p) => p.key === LABEL_PROP);
  if (!label) {
    if (!sib) return false;
    card.remove(sib);
    touch(card);
    return true;
  }
  if (sib) {
    if (unescapeText(sib.value) === label) return false;
    setValue(sib, encodeValue(LABEL_PROP, label));
    touch(card);
    return true;
  }
  if (!prop.group) {
    prop.group = freeGroup(card);
    prop.dirty = true;
  }
  const last = [prop, ...siblingsOf(card, prop)].reduce((a, b) => (card.items.indexOf(b) > card.items.indexOf(a) ? b : a));
  card.insertAfter(last, newProp(LABEL_PROP, encodeValue(LABEL_PROP, label), { group: prop.group }));
  touch(card);
  return true;
}

// ---------------------------------------------------------------------------
// TYPE / PREF

function typeList(prop) {
  return prop
    .paramValues("TYPE")
    .flatMap((v) => v.split(","))
    .map((t) => t.trim())
    .filter(Boolean);
}

function typesAndPref(prop) {
  const all = typeList(prop).map((t) => t.toLowerCase());
  const pref = all.includes("pref") || !!prop.param("PREF");
  return { types: all.filter((t) => t !== "pref"), pref };
}

function setTypes(prop, types, pref, version) {
  const cur = typesAndPref(prop);
  const want = [...new Set((types || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  const sameTypes = cur.types.length === want.length && want.every((t) => cur.types.includes(t));
  if (sameTypes && cur.pref === !!pref) return false;
  const old = prop.params.filter((p) => p.name.toUpperCase() === "TYPE");
  const nameCase = old.length ? old[0].name : "TYPE";
  const oldVals = old.flatMap((p) => p.values.map((v) => v.text)).filter((t) => t.toLowerCase() !== "pref");
  const upperStyle = oldVals.length ? oldVals.every((t) => t === t.toUpperCase()) : version === "3.0";
  const repeated = old.length > 1;
  const quotedList = old.length === 1 && old[0].values.some((v) => v.quoted && v.text.includes(","));
  // tokens that survive keep their original spelling (x-Custom, INTERNET ...)
  const orig = new Map(typeList(prop).map((t) => [t.toLowerCase(), t]));
  const style = (t) => orig.get(t) ?? (upperStyle ? t.toUpperCase() : t.toLowerCase());
  const items = want.map(style);
  const prefInType = version !== "4.0" || typeList(prop).some((t) => t.toLowerCase() === "pref");
  if (pref && prefInType) items.push(orig.get("pref") ?? "pref");
  let newParams = [];
  if (items.length) {
    if (repeated) newParams = items.map((t) => ({ name: nameCase, values: [{ text: t, quoted: false }], bare: false, raw: null }));
    else if (quotedList) newParams = [{ name: nameCase, values: [{ text: items.join(","), quoted: true }], bare: false, raw: null }];
    else newParams = [{ name: nameCase, values: items.map((t) => ({ text: t, quoted: false })), bare: false, raw: null }];
  }
  const at = old.length ? prop.params.indexOf(old[0]) : prop.params.length;
  const rest = prop.params.filter((p) => p.name.toUpperCase() !== "TYPE");
  rest.splice(Math.min(at, rest.length), 0, ...newParams);
  prop.params = rest;
  if (!prefInType) {
    if (pref && !prop.param("PREF")) setParam(prop, "PREF", ["1"]);
    else if (!pref) setParam(prop, "PREF", null);
  } else if (!pref) setParam(prop, "PREF", null);
  prop.dirty = true;
  return true;
}

/** TYPE tokens the type select of each entry kind maps (the form's "other" is none of them). */
export const MAPPED_TYPES = Object.freeze({
  tel: Object.freeze(["cell", "home", "work", "fax", "pager"]),
  email: Object.freeze(["home", "work"]),
  adr: Object.freeze(["home", "work"]),
  url: Object.freeze(["home", "work"]),
});

const lowerTokens = (types) => (types || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);

/**
 * A row's types are a token set. The type select shows the FIRST token that `mapped`
 * knows; every other token (INTERNET, VOICE, a second mapped one, x-*) is `rest`.
 * Returns {selected: string|null, rest: string[]}.
 */
export function splitTypes(types, mapped) {
  const list = lowerTokens(types);
  const i = list.findIndex((t) => mapped.includes(t));
  return i < 0 ? { selected: null, rest: list } : { selected: list[i], rest: list.filter((_, k) => k !== i) };
}

/**
 * The type list after the select changed to `next` (null or "" = "other"): only the one
 * mapped token is replaced (in place), added (first) or removed; every other token stays
 * in its order. The result is meant for the `types` of a setEntries entry; leave `pref`
 * undefined there, it is only sent when the preferred radio itself was changed.
 */
export function replaceMappedType(types, mapped, next) {
  const list = lowerTokens(types);
  const want = next ? String(next).trim().toLowerCase() : null;
  const i = list.findIndex((t) => mapped.includes(t));
  if (want === null) return i < 0 ? list : list.filter((_, k) => k !== i);
  if (i < 0) return [want, ...list.filter((t) => t !== want)];
  if (list[i] === want) return list;
  const out = list.map((t, k) => (k === i ? want : t));
  return out.filter((t, k) => t !== want || k === i);
}

// ---------------------------------------------------------------------------
// Structured values

export const N_FIELDS = ["family", "given", "additional", "prefix", "suffix"];
export const ADR_FIELDS = ["pobox", "ext", "street", "locality", "region", "code", "country"];

function decodeStructured(value, fields) {
  const parts = splitUnescaped(value, ";");
  const out = {};
  fields.forEach((f, i) => {
    out[f] = decodePart(parts[i] || "");
  });
  return out;
}

const decodePart = (raw) =>
  splitUnescaped(raw, ",")
    .map((s) => unescapeText(s))
    .filter((s) => s !== "")
    .join(", ");

/** Text shown for one structured part: a string, or a list joined by ", ". */
export const partText = (v) => (Array.isArray(v) ? v.map(String).filter((s) => s !== "").join(", ") : v === undefined || v === null ? "" : String(v));

function encodePart(v) {
  if (Array.isArray(v)) return v.map(String).filter((s) => s !== "").map(escapeText).join(",");
  return escapeText(partText(v));
}

/** New structured value from an object whose parts are strings or string lists. */
function encodeStructured(obj, fields) {
  return fields.map((f) => encodePart(obj ? obj[f] : "")).join(";");
}

export function readN(card) {
  const p = card.prop("N");
  return p ? decodeStructured(p.value, N_FIELDS) : null;
}

export function readOrg(card) {
  const p = card.prop("ORG");
  if (!p) return null;
  const parts = splitUnescaped(p.value, ";").map((s) => unescapeText(s));
  return { name: parts[0] || "", units: parts.slice(1).filter(Boolean) };
}

/**
 * Re-encode a structured value (N, ADR) from the existing raw text: a part whose
 * displayed value did not change keeps its raw text (comma lists, escaping
 * forms), only changed parts are re-encoded. Parts beyond `fields` are kept.
 */
export function mergeStructured(rawValue, obj, fields) {
  const raw = splitUnescaped(rawValue, ";");
  const parts = fields.map((f, i) => {
    const rp = raw[i] === undefined ? "" : raw[i];
    const want = obj ? obj[f] : "";
    return partText(want) === decodePart(rp) ? rp : encodePart(want);
  });
  return [...parts, ...raw.slice(fields.length)].join(";");
}

const sameObj = (a, b, fields) => fields.every((f) => partText(a[f]) === partText(b[f]));

// ---------------------------------------------------------------------------
// Dates (BDAY, ANNIVERSARY): 1990-04-01, 19900401, --0401, --04-01

/** {year|null, month, day, raw} or {raw, text:true} when the value is not a date. */
export function parseCardDate(prop) {
  const raw = prop.value.trim();
  const base = raw.split("T")[0];
  let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(base);
  if (m) {
    const omit = prop.paramValues("X-APPLE-OMIT-YEAR")[0];
    const year = omit && String(+omit) === String(+m[1]) ? null : +m[1];
    return { year, month: +m[2], day: +m[3], raw };
  }
  m = /^--(\d{2})-?(\d{2})$/.exec(base);
  if (m) return { year: null, month: +m[1], day: +m[2], raw };
  return { raw, text: true };
}

function formatCardDate(d, version) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  if (!Number.isInteger(d.month) || !Number.isInteger(d.day) || d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31) {
    throw new FieldError("invalid month or day");
  }
  const ext = version !== "4.0";
  if (d.year === null || d.year === undefined) return ext ? `--${p(d.month)}-${p(d.day)}` : `--${p(d.month)}${p(d.day)}`;
  if (!Number.isInteger(d.year) || d.year < 1 || d.year > 9999) throw new FieldError("invalid year");
  return ext ? `${p(d.year, 4)}-${p(d.month)}-${p(d.day)}` : `${p(d.year, 4)}${p(d.month)}${p(d.day)}`;
}

function sameCardDate(existing, d) {
  if (!existing) return !d;
  if (!d) return false;
  const cur = parseCardDate(existing);
  return !cur.text && cur.month === d.month && cur.day === d.day && (cur.year || null) === (d.year || null);
}

function setCardDate(card, name, d) {
  if (!d) return setSingle(card, name, null);
  const existing = card.prop(name);
  if (existing) {
    const cur = parseCardDate(existing);
    if (!cur.text && cur.month === d.month && cur.day === d.day && (cur.year || null) === (d.year || null)) return false;
  }
  const text = formatCardDate(d, versionOf(card));
  if (existing) {
    // an edited date drops a stale "omit year" marker and a VALUE=text override
    setParam(existing, "X-APPLE-OMIT-YEAR", null);
    setParam(existing, "VALUE", null);
    setValue(existing, text);
    touch(card);
    return true;
  }
  return setSingle(card, name, text);
}

// ---------------------------------------------------------------------------
// Entries (TEL, EMAIL, ADR, URL)

const decodeEntry = {
  TEL: (p) => p.value.trim(),
  EMAIL: (p) => unescapeText(p.value),
  URL: (p) => p.value.trim(),
  ADR: (p) => decodeStructured(p.value, ADR_FIELDS),
};

const encodeEntry = {
  TEL: (v) => String(v).trim(),
  EMAIL: (v) => encodeValue("EMAIL", v),
  URL: (v) => String(v).trim(),
  ADR: (v) => encodeStructured(v, ADR_FIELDS),
};

function sameEntryValue(name, a, b) {
  return name === "ADR" ? sameObj(a, b, ADR_FIELDS) : a === b;
}

// TEL written as a URI (`TEL;VALUE=uri:tel:+1-555-0100`, or a `tel:` prefix on a plain
// TEL): the form shows the number without the prefix and the write restores it.

/** {uri, prefix}: does this TEL property hold a URI, and which spelling of "tel:" does it use. */
export function telUriForm(prop) {
  const m = /^(tel:)/i.exec(prop.value.trim());
  const valueUri = prop.paramValues("VALUE").some((v) => v.toLowerCase() === "uri");
  return { uri: !!m || valueUri, prefix: m ? m[1] : "tel:" };
}

/** The number without a leading `tel:`. */
export function stripTel(value) {
  return String(value).trim().replace(/^tel:/i, "");
}

/** Number to store: with a `tel:` prefix (and no spaces, which a URI cannot hold) when the property is URI-valued. */
export function restoreTel(display, form) {
  const v = String(display).trim();
  if (!form || !form.uri || /^tel:/i.test(v)) return v;
  return form.prefix + v.replace(/\s+/g, "-");
}

export function readEntries(card, name) {
  return card.props(name).map((prop) => {
    const { types, pref } = typesAndPref(prop);
    return { prop, value: decodeEntry[name](prop), types, pref, label: labelOf(card, prop) };
  });
}

/**
 * Make the TEL / EMAIL / ADR / URL entries equal `entries`
 * ([{prop?, value, types, pref, label}]). Entries carrying `prop` are existing
 * ones: only the parts that differ are rewritten (name case, group and
 * parameter form stay). Entries not listed are removed together with their
 * group siblings; new entries are added after the last existing one.
 */
export function setEntries(card, name, entries) {
  const key = name.toUpperCase();
  if (!decodeEntry[key]) throw new FieldError(`unsupported entry property ${name}`);
  const version = versionOf(card);
  let changed = false;
  const keep = new Set(entries.filter((e) => e.prop).map((e) => e.prop));
  for (const p of card.props(key)) {
    if (!keep.has(p)) {
      removeWithSiblings(card, p);
      changed = true;
    }
  }
  for (const e of entries) {
    if (e.prop) {
      if (!card.items.includes(e.prop)) throw new FieldError("entry does not belong to this card");
      const p = e.prop;
      if (key === "TEL") {
        const next = restoreTel(e.value, telUriForm(p));
        if (next !== p.value.trim() && setValue(p, encodeEntry.TEL(next))) {
          touch(card);
          changed = true;
        }
      } else if (!sameEntryValue(key, decodeEntry[key](p), e.value)) {
        setValue(p, key === "ADR" ? mergeStructured(p.value, e.value, ADR_FIELDS) : encodeEntry[key](e.value));
        touch(card);
        changed = true;
      }
      if (e.types !== undefined || e.pref !== undefined) {
        const cur = typesAndPref(p);
        if (setTypes(p, e.types === undefined ? cur.types : e.types, e.pref === undefined ? cur.pref : e.pref, version)) {
          touch(card);
          changed = true;
        }
      }
      if (e.label !== undefined) changed = setLabel(card, p, e.label) || changed;
    } else {
      const p = newProp(key, encodeEntry[key](e.value));
      const prev = card.props(key);
      if (prev.length) {
        const blockEnd = [prev[prev.length - 1], ...siblingsOf(card, prev[prev.length - 1])].reduce((a, b) =>
          card.items.indexOf(b) > card.items.indexOf(a) ? b : a,
        );
        card.insertAfter(blockEnd, p);
      } else card.appendProperty(p);
      setTypes(p, e.types || [], !!e.pref, version);
      if (e.label) setLabel(card, p, e.label);
      touch(card);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Photo

const PHOTO_TYPES = { "image/jpeg": "JPEG", "image/jpg": "JPEG", "image/png": "PNG", "image/gif": "GIF" };

/** {present, form: 'data-uri'|'base64'|'uri', mime|null} */
export function readPhoto(card) {
  const p = card.prop("PHOTO");
  if (!p) return { present: false };
  const v = p.value.trim();
  const m = /^data:([^;,]+)/i.exec(v);
  if (m) return { present: true, form: "data-uri", mime: m[1].toLowerCase() };
  const enc = p.paramValues("ENCODING")[0];
  const type = (p.paramValues("TYPE")[0] || "").toLowerCase();
  const media = (p.paramValues("MEDIATYPE")[0] || "").toLowerCase();
  if (enc && /^(b|base64)$/i.test(enc)) return { present: true, form: "base64", mime: media || (type ? `image/${type === "jpg" ? "jpeg" : type}` : null) };
  return { present: true, form: "uri", mime: null };
}

export const PHOTO_MIMES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const MAX_PHOTO_PAYLOAD = 1536 * 1024;

function sniffMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBORw0KGgo")) return "image/png";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return null;
}

const TYPE_MIME = { jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", tiff: "image/tiff", tif: "image/tiff" };

/**
 * The embedded photo of a card, without decoding it. Returns
 *   {ok:true, mime, base64, bytes, declared}
 * or {ok:false, reason, mime?, bytes?} with reason
 *   'none' | 'external-uri' | 'not-base64' | 'bad-base64' | 'unsupported-mime' | 'too-large'.
 * `mime` is the declared type (MEDIATYPE, TYPE or the data-URI type), else a guess from the
 * first base64 characters; `bytes` is the decoded size computed from the base64 length.
 * Only JPEG, PNG, WebP and GIF are `ok` (never SVG). The caller still checks the magic
 * bytes and the pixel size (contacts/photo.js) before drawing it.
 */
export function readPhotoData(card, { maxBytes = MAX_PHOTO_PAYLOAD } = {}) {
  const p = card.prop("PHOTO");
  if (!p) return { ok: false, reason: "none" };
  const v = p.value.trim();
  let b64;
  let declared = null;
  const dm = /^data:([^;,]*)((?:;[^,;]*)*),(.*)$/is.exec(v);
  if (dm) {
    declared = dm[1].toLowerCase() || null;
    if (!/;base64$/i.test(dm[2])) return { ok: false, reason: "not-base64", mime: declared };
    b64 = dm[3];
  } else {
    const enc = p.paramValues("ENCODING")[0];
    if (!(enc && /^(b|base64)$/i.test(enc))) {
      return { ok: false, reason: /^[a-z][a-z0-9+.-]*:/i.test(v) ? "external-uri" : "not-base64" };
    }
    const media = (p.paramValues("MEDIATYPE")[0] || "").toLowerCase();
    const type = (p.paramValues("TYPE")[0] || "").toLowerCase();
    declared = media || (type ? TYPE_MIME[type] || `image/${type}` : null);
    b64 = v;
  }
  b64 = b64.replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) return { ok: false, reason: "bad-base64", mime: declared };
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor(((b64.length - pad) * 3) / 4);
  if (declared === "image/jpg") declared = "image/jpeg";
  const mime = declared || sniffMime(b64);
  if (!mime || !PHOTO_MIMES.includes(mime)) return { ok: false, reason: "unsupported-mime", mime, bytes };
  if (bytes > maxBytes) return { ok: false, reason: "too-large", mime, bytes };
  return { ok: true, mime, base64: b64, bytes, declared };
}

/** Cheap change signature of the embedded photo payload (length + FNV-1a), or null. */
export function photoSig(card) {
  const p = card.prop("PHOTO");
  if (!p) return null;
  const v = p.value.replace(/\s+/g, "");
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 0x01000193) >>> 0;
  return `${v.length}:${h.toString(16)}`;
}

/**
 * Replace (or, with null, remove) the photo. A NEW photo is written as
 * `PHOTO;ENCODING=b;TYPE=JPEG:<b64>` (3.0) or
 * `PHOTO;ENCODING=b;MEDIATYPE=image/jpeg:<b64>` (4.0; a Radicale workaround,
 * the data-URI form loses its payload on the server). An existing photo that is not
 * replaced is never touched.
 */
export function setPhoto(card, photo) {
  const old = card.props("PHOTO");
  if (!photo) {
    for (const p of old) removeWithSiblings(card, p);
    return old.length > 0;
  }
  const b64 = String(photo.base64 || "").replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new FieldError("photo must be base64 data");
  const mime = String(photo.mime || "image/jpeg").toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/.test(mime)) throw new FieldError("photo mime type must be image/*");
  const version = versionOf(card);
  // Radicale drops the payload of a 4.0 data URI, so both versions use ENCODING=b.
  const typeParam = version === "4.0" ? makeParam("MEDIATYPE", [mime]) : makeParam("TYPE", [PHOTO_TYPES[mime] || mime.slice(6).toUpperCase()]);
  const prop = newProp("PHOTO", b64, { params: [makeParam("ENCODING", ["b"]), typeParam] });
  const first = old[0];
  if (first) {
    card.insertBefore(first, prop);
    for (const p of old) removeWithSiblings(card, p);
    touch(card);
  } else addProp(card, prop);
  return true;
}

// ---------------------------------------------------------------------------
// Groups of contacts

export function memberUri(uid) {
  return /^urn:/i.test(uid) ? uid : `urn:uuid:${uid}`;
}

const canonUid = (u) => String(u).trim().replace(/^urn:uuid:/i, "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Does the MEMBER value (urn:uuid:<uid>, or a bare uid) refer to the card with this UID?
 * The `urn:uuid:` prefix is optional on either side; UUIDs compare case-insensitively.
 */
export function memberMatches(member, uid) {
  if (typeof member !== "string" || typeof uid !== "string" || !member.trim() || !uid.trim()) return false;
  const a = canonUid(member);
  const b = canonUid(uid);
  return a === b || (UUID_RE.test(a) && UUID_RE.test(b) && a.toLowerCase() === b.toLowerCase());
}

/** {isGroup, form: 'rfc6350'|'apple'|null, members: [uri]} */
export function readGroup(card) {
  const kind = card.prop("KIND");
  const apple = card.prop("X-ADDRESSBOOKSERVER-KIND");
  const rfc = kind && kind.value.trim().toLowerCase() === "group";
  const isApple = apple && apple.value.trim().toLowerCase() === "group";
  const form = rfc ? "rfc6350" : isApple ? "apple" : null;
  const names = rfc ? ["MEMBER"] : isApple ? ["X-ADDRESSBOOKSERVER-MEMBER"] : [];
  const members = names.flatMap((n) => card.props(n).map((p) => p.value.trim()));
  return { isGroup: !!form, form, members };
}

/** The VCARD component of an Item, a root component or a VCARD; null for anything else. */
function cardOfAny(x) {
  if (!x) return null;
  if (x.main && x.kind === "contact") return x.main;
  if (x.key === "VCARD") return x;
  if (x.key === "VCALENDAR") return null;
  return typeof x.comp === "function" ? x.comp("VCARD") : null;
}

/** Is this a group card (KIND:group or the Apple form)? Accepts an Item, a component or readCard() fields. */
export function isGroupCard(x) {
  if (x && x.group && typeof x.group === "object" && "isGroup" in x.group) return !!x.group.isGroup;
  const c = cardOfAny(x);
  return c ? readGroup(c).isGroup : false;
}

function versionOfAny(x) {
  if (typeof x === "string") return x.trim();
  if (x && typeof x.version === "string") return x.version.trim();
  const c = cardOfAny(x);
  return c ? versionOf(c) : "";
}

function majority(counts, tie) {
  let best = null;
  let n = 0;
  let tied = false;
  for (const [k, c] of counts) {
    if (c > n) {
      best = k;
      n = c;
      tied = false;
    } else if (c === n) tied = true;
  }
  return best === null || tied ? tie : best;
}

/** VERSION for a new contact: the majority of 3.0 / 4.0 among `cards` (strings, fields, Items or components); 3.0 when none or tied. */
export function pickNewCardVersion(cards) {
  const counts = new Map([["3.0", 0], ["4.0", 0]]);
  for (const c of cards || []) {
    const v = versionOfAny(c);
    if (counts.has(v)) counts.set(v, counts.get(v) + 1);
  }
  return majority(counts, "3.0");
}

/**
 * Form of a NEW group card for a book: the form most existing group cards use;
 * without a decisive answer the majority VERSION (3.0 -> 'apple', 4.0 -> 'rfc6350');
 * an empty book -> 'apple'.
 */
export function pickGroupForm(cards) {
  const counts = new Map([["apple", 0], ["rfc6350", 0]]);
  for (const c of cards || []) {
    const k = cardOfAny(c);
    const g = k ? readGroup(k) : c && c.group;
    if (g && g.isGroup && counts.has(g.form)) counts.set(g.form, counts.get(g.form) + 1);
  }
  const byGroups = majority(counts, null);
  if (byGroups) return byGroups;
  return pickNewCardVersion(cards) === "4.0" ? "rfc6350" : "apple";
}

const memberName = (form) => (form === "apple" ? "X-ADDRESSBOOKSERVER-MEMBER" : "MEMBER");
export const sameMember = (a, b) => a.trim() === b.trim() || memberMatches(a, b);

/** Make the member list of a group card equal `uris`. Existing member lines that stay are untouched. */
export function setMembers(card, uris) {
  const g = readGroup(card);
  if (!g.isGroup) throw new FieldError("not a group card");
  const name = memberName(g.form);
  const want = [...new Set(uris.map((u) => u.trim()).filter(Boolean))];
  let changed = false;
  const have = new Set();
  for (const p of card.props(name)) {
    const v = p.value.trim();
    if (want.includes(v) && !have.has(v)) have.add(v);
    else {
      removeWithSiblings(card, p);
      changed = true;
    }
  }
  for (const u of want) {
    if (have.has(u)) continue;
    const prev = card.props(name);
    const p = newProp(name, u);
    if (prev.length) card.insertAfter(prev[prev.length - 1], p);
    else card.appendProperty(p);
    changed = true;
  }
  if (changed) touch(card);
  return changed;
}

/**
 * Add ONE member (a urn:uuid: URI): a no-op when a member line already refers to it.
 * Touches no other line, foreign and unknown members stay.
 */
export function addMember(card, uri) {
  const g = readGroup(card);
  if (!g.isGroup) throw new FieldError("not a group card");
  const u = String(uri).trim();
  if (!u) throw new FieldError("empty member");
  const name = memberName(g.form);
  const prev = card.props(name);
  if (prev.some((p) => sameMember(p.value, u))) return false;
  const p = newProp(name, u);
  if (prev.length) card.insertAfter(prev[prev.length - 1], p);
  else card.appendProperty(p);
  touch(card);
  return true;
}

/** Remove ONE member (a URI or a UID): every line referring to it goes, nothing else is touched. */
export function removeMember(card, uriOrUid) {
  const g = readGroup(card);
  if (!g.isGroup) throw new FieldError("not a group card");
  const u = String(uriOrUid).trim();
  let changed = false;
  for (const p of card.props(memberName(g.form))) {
    if (sameMember(p.value, u)) {
      removeWithSiblings(card, p);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Apple built-in labels (`_$!<Mobile>!$_`) and anniversaries

/** Readable keys of the Apple built-in label names (the UI maps a key to a translated text). */
export const APPLE_LABELS = Object.freeze({
  mobile: "mobile",
  iphone: "iphone",
  home: "home",
  work: "work",
  main: "main",
  homefax: "home-fax",
  workfax: "work-fax",
  otherfax: "other-fax",
  pager: "pager",
  other: "other",
  homepage: "home-page",
  anniversary: "anniversary",
  friend: "friend",
  spouse: "spouse",
  partner: "partner",
  father: "father",
  mother: "mother",
  parent: "parent",
  brother: "brother",
  sister: "sister",
  child: "child",
  assistant: "assistant",
  manager: "manager",
});

/**
 * {builtin, key, text} of a label. A built-in Apple label gives its readable key
 * (null when unknown) and an English text derived from the name; any other label is
 * returned as written (builtin false, key null).
 */
export function labelInfo(label) {
  const m = /^_\$!<(.*)>!\$_$/s.exec(String(label ?? ""));
  if (!m) return { builtin: false, key: null, text: label === null || label === undefined ? "" : String(label) };
  const name = m[1];
  const text = name.replace(/(?<=[a-z]{2})(?=[A-Z])/g, " ").replace(/FAX/g, "fax");
  return { builtin: true, key: APPLE_LABELS[name.toLowerCase()] || null, text };
}

/**
 * Anniversaries held by a card, in every spelling: ANNIVERSARY (writable on 4.0 only),
 * `itemN.X-ABDATE` with the Anniversary label and X-ANNIVERSARY (read-only). Other
 * X-ABDATE dates (other labels) are listed with kind 'other'.
 * [{source, kind: 'anniversary'|'other', date, label, prop, readOnly}]
 */
export function readAnniversaries(card) {
  const version = versionOf(card);
  const out = [];
  for (const p of card.props("ANNIVERSARY")) {
    out.push({ source: "ANNIVERSARY", kind: "anniversary", date: parseCardDate(p), label: null, prop: p, readOnly: version !== "4.0" });
  }
  for (const p of card.props("X-ANNIVERSARY")) {
    out.push({ source: "X-ANNIVERSARY", kind: "anniversary", date: parseCardDate(p), label: null, prop: p, readOnly: true });
  }
  for (const p of card.props("X-ABDATE")) {
    const label = labelOf(card, p);
    const info = labelInfo(label);
    const ann = info.key === "anniversary" || /anniversar/i.test(info.text);
    out.push({ source: "X-ABDATE", kind: ann ? "anniversary" : "other", date: parseCardDate(p), label, prop: p, readOnly: true });
  }
  return out;
}

/** {writable, reason, existing}: an anniversary is written only on vCard 4.0 cards. */
export function anniversaryPolicy(card) {
  const version = versionOf(card);
  const existing = readAnniversaries(card).filter((a) => a.kind === "anniversary");
  const writable = version === "4.0";
  return { writable, reason: writable ? null : "anniversary-needs-vcard-4", existing };
}

// ---------------------------------------------------------------------------
// Read / patch

export function readCard(card) {
  const bday = card.prop("BDAY");
  const ann = card.prop("ANNIVERSARY");
  const kind = card.prop("KIND");
  return {
    version: versionOf(card),
    uid: getText(card, "UID"),
    fn: getText(card, "FN") || "",
    n: readN(card),
    nickname: getTextList(card, "NICKNAME"),
    org: readOrg(card),
    title: getText(card, "TITLE") || "",
    tel: readEntries(card, "TEL"),
    email: readEntries(card, "EMAIL"),
    adr: readEntries(card, "ADR"),
    url: readEntries(card, "URL"),
    bday: bday ? parseCardDate(bday) : null,
    anniversary: ann ? parseCardDate(ann) : null,
    note: getText(card, "NOTE") || "",
    categories: getTextList(card, "CATEGORIES"),
    photo: readPhoto(card),
    photoSig: photoSig(card),
    anniversaries: readAnniversaries(card),
    kind: kind ? kind.value.trim().toLowerCase() : null,
    group: readGroup(card),
  };
}

/**
 * Apply a patch of owned fields to a VCARD (absent keys untouched). Keys: fn,
 * n ({family, given, additional, prefix, suffix} or null), nickname[], org
 * ({name, units[]} or null), title, tel/email/adr/url (setEntries lists), bday,
 * anniversary ({year?, month, day} or null), note, categories[], photo (null |
 * {mime, base64}), kind, members[] (the full list) or membersDelta ({add:[uri], remove:[uri|uid]},
 * touches only those member lines). N and ADR re-encode only the parts whose value changed (a
 * part may be a string or a list of strings). Returns true when anything changed.
 * With `strict`, an anniversary is refused unless the card is vCard 4.0 (see anniversaryPolicy).
 */
export function applyCardPatch(card, patch, { strict = false } = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  let changed = false;
  if (has("fn")) changed = setText(card, "FN", patch.fn, unescapeText) || changed;
  if (has("n")) {
    if (!patch.n) changed = setSingle(card, "N", null) || changed;
    else {
      const cur = readN(card);
      if (!(cur && sameObj(cur, patch.n, N_FIELDS))) {
        const existing = card.prop("N");
        const value = existing ? mergeStructured(existing.value, patch.n, N_FIELDS) : encodeStructured(patch.n, N_FIELDS);
        changed = setSingle(card, "N", value) || changed;
      }
    }
  }
  if (has("nickname")) {
    // Radicale keeps only the first value of a NICKNAME list: write exactly one. The form shows
    // (and sends back) the FIRST value of a list, so the comparison is against that value and
    // an untouched multi-value NICKNAME stays as it is.
    const want = (patch.nickname || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 1);
    const cur = getTextList(card, "NICKNAME");
    const same = want.length ? cur.length > 0 && cur[0] === want[0] : cur.length === 0;
    if (!same) changed = setTextList(card, "NICKNAME", want) || changed;
  }
  if (has("org")) {
    if (!patch.org || (!patch.org.name && !(patch.org.units || []).length)) changed = setSingle(card, "ORG", null) || changed;
    else {
      const cur = readOrg(card);
      const units = (patch.org.units || []).filter(Boolean);
      const same = cur && cur.name === (patch.org.name || "") && cur.units.length === units.length && units.every((u, i) => u === cur.units[i]);
      if (!same) {
        // parts that did not change keep their raw text; when only the name changed the unit
        // parts (empty middle units included) stay exactly as written
        const raw = splitUnescaped(card.prop("ORG") ? card.prop("ORG").value : "", ";");
        const rawName = raw[0] === undefined ? "" : raw[0];
        const name = patch.org.name || "";
        const nameText = cur && unescapeText(rawName) === name ? rawName : escapeText(name);
        let value;
        if (cur && cur.units.length === units.length && units.every((u, i) => u === cur.units[i])) {
          value = [nameText, ...raw.slice(1)].join(";");
        } else if (cur && units.length > cur.units.length && cur.units.every((u, i) => u === units[i])) {
          value = [nameText, ...raw.slice(1), ...units.slice(cur.units.length).map(escapeText)].join(";");
        } else {
          const rawParts = [rawName, ...raw.slice(1).filter((x) => x !== "")];
          const next = [name, ...units];
          value = next.map((t, i) => (i === 0 ? nameText : i < rawParts.length && unescapeText(rawParts[i]) === t ? rawParts[i] : escapeText(t))).join(";");
        }
        changed = setSingle(card, "ORG", value) || changed;
      }
    }
  }
  if (has("title")) changed = setText(card, "TITLE", patch.title, unescapeText) || changed;
  for (const name of ["tel", "email", "adr", "url"]) {
    if (has(name)) changed = setEntries(card, name, patch[name]) || changed;
  }
  if (has("bday")) changed = setCardDate(card, "BDAY", patch.bday) || changed;
  if (has("anniversary")) {
    if (strict && versionOf(card) !== "4.0" && !sameCardDate(card.prop("ANNIVERSARY"), patch.anniversary)) {
      throw new FieldError("an anniversary can only be written on a vCard 4.0 card");
    }
    changed = setCardDate(card, "ANNIVERSARY", patch.anniversary) || changed;
  }
  if (has("note")) changed = setText(card, "NOTE", patch.note, unescapeText) || changed;
  if (has("categories")) changed = setTextList(card, "CATEGORIES", patch.categories) || changed;
  if (has("photo")) changed = setPhoto(card, patch.photo) || changed;
  if (has("kind")) {
    const v = patch.kind ? String(patch.kind).toLowerCase() : null;
    if (v !== null && !KINDS.includes(v)) throw new FieldError(`KIND must be one of ${KINDS.join(", ")}`);
    const cur = card.prop("KIND");
    if (!(cur && v && cur.value.trim().toLowerCase() === v)) changed = setSingle(card, "KIND", v) || changed;
  }
  if (has("members")) changed = setMembers(card, patch.members) || changed;
  if (has("membersDelta")) {
    const d = patch.membersDelta || {};
    for (const u of d.remove || []) changed = removeMember(card, u) || changed;
    for (const u of d.add || []) changed = addMember(card, u) || changed;
  }
  return changed;
}

function newUid(uid) {
  const id = uid || newUuid();
  return id;
}

/** New contact card (VERSION defaults to 3.0, the form most existing cards use). */
export function createCard(fields, { uid, prodid = DEFAULT_PRODID, version = "3.0" } = {}) {
  if (version !== "3.0" && version !== "4.0") throw new FieldError("version must be 3.0 or 4.0");
  const card = new Component("VCARD");
  card.touched = true;
  card.items.push(newProp("VERSION", version));
  card.items.push(newProp("PRODID", encodeValue("PRODID", prodid)));
  card.items.push(newProp("UID", encodeValue("UID", newUid(uid))));
  const f = { ...fields };
  if (!f.fn && f.n) f.fn = [f.n.prefix, f.n.given, f.n.additional, f.n.family, f.n.suffix].filter(Boolean).join(" ");
  if (!f.fn) throw new FieldError("a new contact needs a name");
  applyCardPatch(card, f);
  return card;
}

/**
 * New group card. form 'rfc6350' (default: KIND:group + MEMBER, version 4.0) or
 * 'apple' (X-ADDRESSBOOKSERVER-KIND/-MEMBER, version 3.0).
 */
export function createGroup(name, memberUids = [], { uid, prodid = DEFAULT_PRODID, form = "rfc6350" } = {}) {
  const apple = form === "apple";
  const card = createCard({ fn: name, ...(apple ? { n: { family: name } } : {}) }, { uid, prodid, version: apple ? "3.0" : "4.0" });
  card.appendProperty(newProp(apple ? "X-ADDRESSBOOKSERVER-KIND" : "KIND", "group"));
  for (const u of memberUids) card.appendProperty(newProp(apple ? "X-ADDRESSBOOKSERVER-MEMBER" : "MEMBER", memberUri(u)));
  return card;
}
