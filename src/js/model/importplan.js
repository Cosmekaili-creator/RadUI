// SPDX-License-Identifier: AGPL-3.0-or-later
// .vcf import planning: split a file into cards, classify every card against the items the
// target address book already holds, and (once a duplicate policy is chosen) produce the
// list of requests to run. Pure functions: no DOM, no network, no timers. The store
// executes the operations (PUT with If-None-Match for a create, If-Match with the existing
// ETag for a replace) and reports the results.
//
// Rules (RUN2 plan 1.2 D-R2-16, addendum A and B5):
//  - the caller decodes the file as UTF-8 (a non-UTF-8 file is refused there);
//  - limits: 10 MB file, 5,000 items, 1 MB per item, 20,000 chunks (a file over the file,
//    item-count or chunk limit is refused as a whole: `fatal`);
//  - cards Radicale would damage on storage (see lossyProperties) are flagged `lossy` at
//    plan time; the text is never rewritten, and a REPLACE of an existing card with such a
//    card is skipped unless the caller confirms its UID (`confirmLossy`);
//  - vCard 2.1 (any version other than 3.0 / 4.0) and chunks that do not parse are listed
//    and skipped with a reason, never uploaded;
//  - a card without a UID gets a generated one: the only mutation, reported (`generatedUid`);
//  - the same UID twice in one file: the first card is kept, later ones are skipped;
//  - every card is imported line for line (no re-serialisation); the output of each
//    operation is verified with checkSplit and checkNewItem before it is handed out;
//  - the .ics split (VCALENDAR wrapper, METHOD, VTIMEZONE, series grouped by UID) lives in importics.js:
//    `planIcsImport` is re-exported here and `resolveImport` dispatches to it for a plan whose `kind` is 'calendar'.

import { newUuid } from "../uuid.js";
import { logicalLines, normalizeNewlines, splitUnescaped } from "./contentlines.js";
import { FidelityError, checkNewItem, checkSplit } from "./fidelity.js";
import { openItem } from "./item.js";
import { planIcsImport, resolveIcsImport } from "./importics.js";
import { isGroupCard, memberUri } from "./vcard.js";
import { foldLine } from "./writer.js";

// `chunks` caps everything the splitter produces (cards and junk), so that a file of bare
// BEGIN:VCARD lines cannot create hundreds of thousands of rows.
export { planIcsImport, resolveIcsImport };

export const LIMITS = Object.freeze({ fileBytes: 10 * 1024 * 1024, items: 5000, itemBytes: 1024 * 1024, chunks: 20000 });
export const POLICIES = Object.freeze(["skip", "replace", "keep-both"]);
const NAME_RE = /^[A-Za-z0-9._@-]{1,100}$/;

const encoder = new TextEncoder();
const byteLength = (s) => encoder.encode(s).length;

function uuid(random) {
  if (random) return random();
  return newUuid();
}

/** File name for a UID: `<uid>.vcf` when the UID is a safe name, else a fresh UUID. */
export function fileNameFor(uid, random, taken = new Set()) {
  const free = (n) => !taken.has(n.toLowerCase());
  if (NAME_RE.test(uid) && !uid.startsWith(".") && free(`${uid}.vcf`)) return `${uid}.vcf`;
  for (;;) {
    const n = `${uuid(random)}.vcf`;
    if (free(n)) return n;
  }
}

// ---------------------------------------------------------------------------
// Splitting

/**
 * Cut a file into chunks. Returns [{index, text, line, problem?}]: `text` is the card text
 * (LF, BEGIN:VCARD .. END:VCARD, original folding), `line` the 1-based line it starts at.
 * A chunk with a `problem` ('unterminated' | 'outside-card') is not a card. With `maxChunks`
 * the scan stops once more than that many chunks exist (the caller refuses the file).
 */
export function splitVcf(fileText, { maxChunks = Infinity } = {}) {
  const lines = normalizeNewlines(fileText).split("\n");
  const chunks = [];
  let cur = null;
  let stray = null;
  const flushStray = () => {
    if (stray && stray.lines.some((l) => l.trim())) chunks.push({ text: stray.lines.join("\n"), line: stray.line, problem: "outside-card" });
    stray = null;
  };
  for (let i = 0; i < lines.length; i++) {
    if (chunks.length > maxChunks) break;
    const l = lines[i];
    const continuation = l.startsWith(" ") || l.startsWith("\t");
    if (!cur) {
      if (!continuation && /^BEGIN:VCARD\s*$/i.test(l)) {
        flushStray();
        cur = { lines: [l], line: i + 1 };
      } else {
        if (!stray) stray = { lines: [], line: i + 1 };
        stray.lines.push(l);
      }
      continue;
    }
    if (!continuation && /^BEGIN:VCARD\s*$/i.test(l)) {
      chunks.push({ text: cur.lines.join("\n"), line: cur.line, problem: "unterminated" });
      cur = { lines: [l], line: i + 1 };
      continue;
    }
    cur.lines.push(l);
    if (!continuation && /^END:VCARD\s*$/i.test(l)) {
      chunks.push({ text: cur.lines.join("\n") + "\n", line: cur.line });
      cur = null;
    }
  }
  if (cur) chunks.push({ text: cur.lines.join("\n"), line: cur.line, problem: "unterminated" });
  flushStray();
  return chunks.map((c, index) => ({ index, ...c }));
}

const REASON_STATE = { "unsupported-version": "unsupported" };

function uidOf(item) {
  return item.uid;
}

/** Text with a UID line inserted before END:VCARD (the one mutation allowed for a card without UID). */
function withUid(text, uid) {
  const lines = text.split("\n");
  let at = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^END:VCARD\s*$/i.test(lines[i])) {
      at = i;
      break;
    }
  }
  lines.splice(at, 0, `UID:${uid}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Lossy cards

const LOSSY_TEXT = new Set(["NOTE", "TITLE", "NICKNAME", "COMMENT", "DESCRIPTION", "LOCATION", "SUMMARY"]);

/**
 * Names of the properties Radicale would damage when it stores this card (docs/roundtrip.md,
 * rules text-cut-at-unescaped-comma and photo-data-uri-payload-dropped): a TEXT property
 * (NOTE, TITLE, NICKNAME, unknown X- properties) holding an unescaped comma is cut at the comma,
 * and the payload of a `PHOTO:data:...;base64,<data>` URI is dropped. `item` is an opened card.
 */
export function lossyProperties(item) {
  const out = new Set();
  for (const p of item.main.properties) {
    const key = p.key;
    if ((LOSSY_TEXT.has(key) || key.startsWith("X-")) && splitUnescaped(p.value, ",").length > 1) out.add(key);
    if (key === "PHOTO" && /^data:/i.test(p.value.trim())) out.add("PHOTO");
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Plan

/**
 * Classify the cards of a .vcf text.
 *
 *  known   items of the target book: [{href, etag, uid, fn?, emails?: [string]}]
 *  opts    {collectionHref, limits, random}  (`random` returns a UUID; for tests)
 *
 * Returns {fatal: null | {reason: 'file-too-large'|'too-many-items'|'too-many-chunks'|'empty', ...}, rows, counts, lossy}.
 * `lossy` lists the flagged cards: [{index, uid, fn, properties}].
 * Row: {index, line, state: 'new'|'duplicate'|'invalid'|'file-duplicate'|'unsupported', reason, uid,
 * href, fn, version, isGroup, generatedUid, existingHref, existingEtag, hints, text}.
 *  - reason: a machine code ('unsupported-version', 'parse-error', 'too-large', 'unterminated',
 *    'outside-card', 'invalid-value', 'duplicate-property', 'duplicate-uid', 'uid-in-use' ...);
 *  - href: where the card would be created ('new'), or the existing item ('duplicate');
 *  - lossy: [property names] Radicale would damage on storage (empty when none);
 *  - hints: [{kind: 'same-name'|'same-email', href, uid}] information only (different UID);
 *  - text: the card text to send (LF; with the generated UID line when it had none);
 *  - source: the card text as it stands in the file (what the output guard compares against).
 */
export function planImport(fileText, known = [], opts = {}) {
  const limits = { ...LIMITS, ...(opts.limits || {}) };
  const random = opts.random;
  const collection = opts.collectionHref || "";
  const base = collection && !collection.endsWith("/") ? collection + "/" : collection;
  const text = String(fileText ?? "");
  if (byteLength(text) > limits.fileBytes) return { fatal: { reason: "file-too-large", limit: limits.fileBytes }, rows: [], counts: countRows([]) };
  const chunks = splitVcf(text, { maxChunks: limits.chunks });
  if (chunks.length > limits.chunks) return { fatal: { reason: "too-many-chunks", limit: limits.chunks }, rows: [], counts: countRows([]) };
  const cards = chunks.filter((c) => !c.problem).length;
  if (!chunks.length) return { fatal: { reason: "empty" }, rows: [], counts: countRows([]) };
  if (cards > limits.items) return { fatal: { reason: "too-many-items", count: cards, limit: limits.items }, rows: [], counts: countRows([]) };

  const byUid = new Map();
  const taken = new Set();
  const names = new Map(); // normalised FN -> [{href, uid}]
  const mails = new Map();
  for (const k of known) {
    if (k.uid) byUid.set(String(k.uid).trim(), k);
    const name = String(k.href || "").split("/").pop();
    if (name) taken.add(decodeSafe(name).toLowerCase());
    const fn = normName(k.fn);
    if (fn) push(names, fn, k);
    for (const e of k.emails || []) push(mails, String(e).trim().toLowerCase(), k);
  }

  const seen = new Set();
  const rows = [];
  for (const ch of chunks) {
    const row = { index: ch.index, line: ch.line, state: "new", reason: null, uid: null, href: null, fn: "", version: null, isGroup: false, generatedUid: null, existingHref: null, existingEtag: null, hints: [], lossy: [], text: null, source: null };
    rows.push(row);
    if (ch.problem) {
      row.state = "invalid";
      row.reason = ch.problem;
      row.fn = "";
      continue;
    }
    if (byteLength(ch.text) > limits.itemBytes) {
      row.state = "invalid";
      row.reason = "too-large";
      continue;
    }
    const item = openItem(ch.text, "contact");
    if (!item.ok) {
      row.state = REASON_STATE[item.reason] || "invalid";
      row.reason = item.reason;
      row.detail = item.message;
      const v = /^VERSION:(.*)$/im.exec(ch.text);
      row.version = v ? v[1].trim() : null;
      continue;
    }
    const f = item.fields();
    row.fn = f.fn || "";
    row.version = f.version;
    row.isGroup = isGroupCard(f);
    row.lossy = lossyProperties(item);
    let cardText = ch.text;
    let uid = uidOf(item);
    if (!uid && item.main.props("UID").length) {
      row.state = "invalid";
      row.reason = "empty-uid";
      continue;
    }
    row.source = ch.text;
    if (!uid) {
      uid = uuid(random);
      row.generatedUid = uid;
      cardText = withUid(cardText, uid);
    }
    row.uid = uid;
    row.text = cardText;
    if (seen.has(uid)) {
      row.state = "file-duplicate";
      row.reason = "duplicate-uid";
      row.text = null;
      row.source = null;
      continue;
    }
    seen.add(uid);
    const existing = byUid.get(uid);
    if (existing) {
      row.state = "duplicate";
      row.reason = "uid-exists";
      row.href = existing.href;
      row.existingHref = existing.href;
      row.existingEtag = existing.etag || null;
    } else {
      const name = fileNameFor(uid, random, taken);
      taken.add(name.toLowerCase());
      row.href = base + encodeURIComponent(name);
    }
    if (!row.isGroup) addHints(row, f, names, mails);
  }
  const lossy = rows.filter((r) => r.lossy.length).map((r) => ({ index: r.index, uid: r.uid, fn: r.fn, properties: r.lossy }));
  return { fatal: null, rows, counts: countRows(rows), lossy };
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
const normName = (s) => String(s || "").normalize("NFKD").replace(/\s+/g, " ").trim().toLowerCase();
function push(map, k, v) {
  if (!k) return;
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
}

function addHints(row, fields, names, mails) {
  const seenHint = new Set();
  const add = (kind, k) => {
    if (k.uid && String(k.uid).trim() === row.uid) return;
    const id = `${kind}|${k.href}`;
    if (seenHint.has(id)) return;
    seenHint.add(id);
    row.hints.push({ kind, href: k.href, uid: k.uid || null });
  };
  for (const k of names.get(normName(fields.fn)) || []) add("same-name", k);
  for (const e of fields.email || []) for (const k of mails.get(String(e.value).trim().toLowerCase()) || []) add("same-email", k);
}

/** {new, duplicate, invalid, unsupported, 'file-duplicate'} */
export function countRows(rows) {
  const c = { new: 0, duplicate: 0, invalid: 0, unsupported: 0, "file-duplicate": 0 };
  for (const r of rows) c[r.state]++;
  return c;
}

// ---------------------------------------------------------------------------
// Policies

/** Same style of new UID as the old one (`urn:uuid:` stays `urn:uuid:`). */
function newUidLike(old, random) {
  const id = uuid(random);
  return /^urn:uuid:/i.test(old || "") ? `urn:uuid:${id}` : id;
}

/** Rewrite the UID line and the member lines of a card text; everything else is kept as written. */
function rewriteLines(text, uidMap) {
  const out = [];
  for (const l of logicalLines(normalizeNewlines(text))) {
    const m = /^((?:[A-Za-z0-9_-]+\.)?)(UID|MEMBER|X-ADDRESSBOOKSERVER-MEMBER)((?:;[^:]*)?):(.*)$/is.exec(l.raw);
    if (!m) {
      out.push(l.folded);
      continue;
    }
    const name = m[2].toUpperCase();
    const value = m[4].trim();
    if (name === "UID") {
      const to = uidMap.get(value);
      out.push(to ? foldLine(`${m[1]}${m[2]}${m[3]}:${to}`) : l.folded);
      continue;
    }
    let to = null;
    for (const [oldUid, newUid] of uidMap) {
      if (!oldUid) continue;
      if (matchesUid(value, oldUid)) {
        to = /^urn:uuid:/i.test(value) ? memberUri(stripUrn(newUid)) : stripUrn(newUid);
        break;
      }
    }
    out.push(to ? foldLine(`${m[1]}${m[2]}${m[3]}:${to}`) : l.folded);
  }
  return out.join("\n") + "\n";
}
const stripUrn = (u) => String(u).replace(/^urn:uuid:/i, "");
const matchesUid = (member, uid) => stripUrn(member).toLowerCase() === stripUrn(uid).toLowerCase();

/**
 * Turn a plan into requests for a duplicate policy.
 *
 *  policy  'skip' (default) | 'replace' | 'keep-both'
 *  opts    {collectionHref, random, confirmLossy: [uid]}
 *
 * Returns {operations, skipped, counts, problems}:
 *  operations  [{op: 'create'|'replace', index, href, uid, text (CRLF), etag?}]; create is sent with
 *              If-None-Match: *, replace to the existing href with If-Match: the existing ETag;
 *  skipped     [{index, state, reason}] rows that are not imported;
 *  counts      {create, replace, skipped, lossy, lossySkipped}: `lossy` counts operations whose card
 *              Radicale will damage, `lossySkipped` the replacements skipped for that reason;
 *  problems    [{index, code, message}] cards the guard refused (they are in `skipped` too) and, with
 *              code 'lossy-skipped', replacements skipped because the card would be damaged.
 * A REPLACE of an existing card with a lossy card is skipped (reason 'lossy-needs-confirmation')
 * unless its UID is in `confirmLossy`; creates (new cards, keep-both) go ahead, flagged.
 * With 'keep-both' a duplicate gets a new UID and href, and MEMBER lines of every imported
 * group card that point at a re-keyed UID are rewritten to the new UID.
 */
export function resolveImport(plan, policy = "skip", opts = {}) {
  if (!POLICIES.includes(policy)) throw new TypeError(`unknown policy ${policy}`);
  if (plan && plan.kind === "calendar") return resolveIcsImport(plan, policy, opts);
  const random = opts.random;
  const collection = opts.collectionHref || "";
  const base = collection && !collection.endsWith("/") ? collection + "/" : collection;
  const operations = [];
  const skipped = [];
  const problems = [];
  const confirm = new Set(opts.confirmLossy || []);
  let lossySkipped = 0;
  let lossyOps = 0;
  const taken = new Set();
  for (const r of plan.rows) if (r.href) taken.add(decodeSafe(String(r.href).split("/").pop()).toLowerCase());

  // 1. which UIDs are re-keyed
  const rekey = new Map();
  if (policy === "keep-both") {
    for (const r of plan.rows) if (r.state === "duplicate") rekey.set(r.uid, newUidLike(r.uid, random));
  }
  // 2. build every operation
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
      const name = fileNameFor(uid, random, taken);
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
    // r.text already carries a generated UID line; re-keyed UIDs and member lines are rewritten
    // line by line, and the guard compares the result with the card as it stands in the file.
    let out;
    try {
      out = rekey.size ? rewriteLines(r.text, rekey) : r.text;
      const guardMap = new Map(rekey);
      if (r.generatedUid) guardMap.set("", r.generatedUid);
      checkSplit(r.source, out, { uidMap: guardMap, complete: true });
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
