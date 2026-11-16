// SPDX-License-Identifier: AGPL-3.0-or-later
// Contact-editing safety replay over a local COPY of a real address book.
//
// Not a unit test and never part of `make test`: use tests/roundtrip/snapshot-contacts.sh, which copies the data
// directory into a private temp dir, starts a throwaway Radicale on that copy and removes everything at the end.
// The replay runs the REAL store modules (createStoreContext, writes.*, exportCollection, startImport), the form
// model and the writer over real HTTP, on one address book of the copy.
//
// Environment (set by the shell wrapper):
//   GS_ROOT       the copied collection-root directory (<owner>/<book>/<card files>); only the first
//                 owner/book pair is replayed
//   GS_REPORT     path of the detailed report (outside the repository, mode 600)
//   RADUI_TEST_RADICALE, RADUI_TEST_PASSWORDS_FILE   the throwaway instance and its accounts
//   GS_LIMIT      optional: replay at most this many cards (smoke test)
//
// CONSOLE OUTPUT IS AGGREGATES ONLY (counts, categories, reason codes). The report identifies cards by an index and
// a hash of the file name; it never holds a name, e-mail address, phone number, UID or free text. Problem codes name
// properties and parameters, never values. The file contains no real value.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createClient } from "../../src/js/dav/client.js";
import { createTransport } from "../../src/js/dav/http.js";
import { isEmptyPatch, newRow, serverLossWarnings, toFormValues, toPatch, validate, withPhoto } from "../../src/js/contacts/formmodel.js";
import { readGroups } from "../../src/js/contacts/groups.js";
import { summarize } from "../../src/js/contacts/index.js";
import { bytesToBase64, canDisplayPhoto, processPhoto } from "../../src/js/contacts/photo.js";
import { openItem } from "../../src/js/model/item.js";
import { planImport } from "../../src/js/model/importplan.js";
import { createSession } from "../../src/js/session.js";
import { createStoreContext } from "../../src/js/store/index.js";
import { createActivityLog, createFeedback, createWriteGate } from "../../src/js/ui.js";
import { semdiff } from "../lib/semdiff.js";
import { compareServer, hasLossy } from "./compare.mjs";

const ROOT = process.env.GS_ROOT;
const REPORT = process.env.GS_REPORT;
const ORIGIN = process.env.RADUI_TEST_RADICALE;
const PW_FILE = process.env.RADUI_TEST_PASSWORDS_FILE;
const LIMIT = Number(process.env.GS_LIMIT || 0);
if (!ROOT || !REPORT || !ORIGIN || !PW_FILE) {
  console.error("snapshot-contacts: use tests/roundtrip/snapshot-contacts.sh");
  process.exit(2);
}

const NOW = new Date("2026-01-15T12:00:00Z");
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const fmt = (m) =>
  [...(m instanceof Map ? m.entries() : Object.entries(m))]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([k, n]) => `${k}=${n}`)
    .join(", ") || "(none)";
const lf = (t) => String(t).replace(/\r\n?/g, "\n");
const unfold = (t) => lf(t).replace(/\n[ \t]/g, "");
const nameOf = (line) => line.split(/[;:]/)[0].split(".").pop().toUpperCase();
const errCode = (e) => `${(e && e.name) || "Error"}${e && e.status ? ":" + e.status : ""}${e && e.reason ? ":" + e.reason : ""}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

// ---------------------------------------------------------------------------
// Account, counting clients, store context

const first = readFileSync(PW_FILE, "utf8").trim().split("\n")[0];
const LOGIN = first.slice(0, first.indexOf(":"));
const PASS = first.slice(first.indexOf(":") + 1);
const AUTH = "Basic " + Buffer.from(`${LOGIN}:${PASS}`).toString("base64");

function makeEnv() {
  const log = [];
  const bodies = new Map(); // url -> last PUT body (kept in memory only)
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    if (method === "PUT") bodies.set(new URL(url).pathname, init.body);
    const resp = await fetch(url, init);
    log.push({ method, status: resp.status });
    return resp;
  };
  const transport = createTransport({ origin: ORIGIN, getAuth: () => AUTH, fetchImpl, timeoutMs: 60000 });
  const client = createClient(transport);
  return {
    client,
    log,
    mark: () => log.length,
    since: (mark = 0, method) => log.slice(mark).filter((r) => !method || r.method === method),
    sentBody: (href) => bodies.get(href) || null,
  };
}

const api = { me: async () => ({ login: LOGIN, ownSpace: true }), meAccess: async () => [], grants: async () => [], putGrant: async () => ({}) };
const env = makeEnv();
const other = makeEnv(); // "a second client": raw DAV, never through the write path
const session = createSession({ login: LOGIN, storage: null });
const ctx = createStoreContext({ session, client: env.client, api, activity: createActivityLog(), feedback: createFeedback(), t: (k) => k, gate: createWriteGate(), isOnline: () => true });
const { writes } = ctx;

// the book of the copy: the first <owner>/<book> directory
const OWNER = readdirSync(ROOT).filter((n) => !n.startsWith(".") && statSync(path.join(ROOT, n)).isDirectory()).sort()[0];
const BOOK = readdirSync(path.join(ROOT, OWNER)).filter((n) => !n.startsWith(".") && statSync(path.join(ROOT, OWNER, n)).isDirectory()).sort()[0];
const HOME = `/${encodeURIComponent(OWNER)}/`;
const BOOK_HREF = `${HOME}${encodeURIComponent(BOOK)}/`;
const FILES = readdirSync(path.join(ROOT, OWNER, BOOK)).filter((n) => /\.vcf$/i.test(n)).sort();

const report = []; // lines of the detailed report
const out = (s = "") => report.push(s);
const results = []; // { title, lines[] } printed to the console as aggregates
const con = (s) => console.log(s);

// ---------------------------------------------------------------------------
// Helpers

const itemOfFields = new WeakMap();
function openForm(text) {
  const item = openItem(text, "contact");
  if (!item.ok || item.readOnly) return null;
  const fields = item.fields();
  itemOfFields.set(fields, item);
  return { item, fields, values: toFormValues(fields) };
}

/** Shape of a card text: property names only (no values). */
function shapeOf(text) {
  const names = new Map();
  let grouped = false;
  for (const l of unfold(text).split("\n")) {
    if (!l.includes(":") || /^(BEGIN|END):/i.test(l)) continue;
    const head = l.split(":")[0];
    if (/^[A-Za-z0-9-]+\./.test(head)) grouped = true;
    bump(names, nameOf(l));
  }
  const ver = (/^VERSION:(\S+)/im.exec(unfold(text)) || [])[1] || "?";
  return `v${ver}${grouped ? " grouped" : ""} [${[...names.entries()].sort().map(([k, n]) => (n > 1 ? `${k}x${n}` : k)).join(" ")}]`;
}

const isGroupText = (t) => /^(?:[A-Za-z0-9-]+\.)?(?:X-ADDRESSBOOKSERVER-)?KIND(?:;[^:]*)?:\s*group\s*$/im.test(unfold(t));
const uidOf = (t) => {
  const m = /^(?:[A-Za-z0-9-]+\.)?UID(?:;[^:]*)?:(.*)$/im.exec(unfold(t));
  return m ? m[1].trim() : null;
};

async function serverCards(client, href) {
  const list = await client.listItemEtags(href);
  const outList = [];
  for (let i = 0; i < list.length; i += 100) {
    const { items } = await client.addressbookMultiget(href, list.slice(i, i + 100).map((x) => x.href));
    outList.push(...items.map((x) => ({ href: x.href, etag: x.etag, text: x.text })));
  }
  return outList.sort((a, b) => (a.href < b.href ? -1 : 1));
}

const sameSem = (a, b) => semdiff(a, b, { ignoreManaged: true }).equal;

// a synthetic JPEG: SOI, JFIF, a baseline frame header (64x48), filler, EOI. Known bytes, never decoded by the replay.
function syntheticJpeg(seed = 7, filler = 1500) {
  const b = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  b.push(0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x30, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00);
  let x = seed;
  for (let i = 0; i < filler; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const v = (x >> 16) & 0xff;
    b.push(v === 0xff ? 0xfe : v);
  }
  b.push(0xff, 0xd9);
  return Uint8Array.from(b);
}

// ---------------------------------------------------------------------------
// Setup: sync the store, open the book

const t0 = performance.now();
const access = await ctx.access.refetch({ reason: "gsnap" });
const accessLevel = (ctx.access.get(BOOK_HREF) || {}).level || null;
const store = ctx.stores.open({ href: BOOK_HREF, kind: "addressbook" });
const tSync0 = performance.now();
const s0 = await store.sync({ reason: "load" });
const tSync = performance.now() - tSync0;
if (!s0.ok) {
  console.error("snapshot-contacts: first sync failed");
  process.exit(3);
}
let entries = store.list().sort((a, b) => (a.href < b.href ? -1 : 1));
if (LIMIT) entries = entries.slice(0, LIMIT);
const cards = entries.map((e, i) => ({ idx: i + 1, hash: hash(e.href.split("/").pop()), href: e.href, text: e.text, etag: e.etag, shape: shapeOf(e.text), group: isGroupText(e.text) }));
const byHref = new Map(cards.map((c) => [c.href, c]));
con("snapshot-contacts: aggregates only");
con(`  setup: access=${access.ok ? "ok" : "failed"}, level=${accessLevel}, ${entries.length} cards of ${FILES.length} files, first sync ${Math.round(tSync)} ms (${s0.via})`);

const failures = []; // {step, idx, hash, what}
const problem = (step, c, what) => failures.push({ step, idx: c ? c.idx : 0, hash: c ? c.hash : "-", what });

// ---------------------------------------------------------------------------
// STEP 1: open every card with the model; no-op guarantee

out("# Contact-editing safety replay (G-snap) over a copy of a real address book");
out("");
out("Generated by tests/roundtrip/snapshot-contacts.mjs on a THROWAWAY Radicale loaded with a copy. Cards are identified by an index and a hash of the file name; no value of the data appears here. Problem codes name properties and parameters only.");
out("");

const s1 = { open: new Map(), editable: 0, groups: 0, patchEmpty: 0, updateNoChange: 0, saveNoPut: 0, validateOk: 0, lossWarn: 0, noUid: 0, versions: new Map(), photos: 0, reqDuring: 0 };
const editable = [];
for (const c of cards) {
  let it;
  try {
    it = openItem(c.text, "contact");
  } catch (e) {
    bump(s1.open, `exception:${errCode(e)}`);
    problem("1-open", c, `open threw ${errCode(e)}`);
    continue;
  }
  if (!it.ok) {
    bump(s1.open, `refused:${it.reason}`);
    c.open = `refused:${it.reason}`;
    continue;
  }
  if (c.group) {
    s1.groups++;
    bump(s1.open, it.readOnly ? `group-readonly:${it.readOnlyReason}` : "group");
    c.open = "group";
    continue;
  }
  if (it.readOnly) {
    bump(s1.open, `readonly:${it.readOnlyReason}`);
    c.open = `readonly:${it.readOnlyReason}`;
    continue;
  }
  bump(s1.open, "ok");
  c.open = "ok";
  s1.editable++;
  editable.push(c);
  bump(s1.versions, it.fields().version);
  if (!uidOf(c.text)) {
    s1.noUid++;
    c.noUid = true;
  }
  if (it.fields().photo && it.fields().photo.present) s1.photos++;
  const form = openForm(c.text);
  const patch = toPatch(form.fields, form.values);
  if (isEmptyPatch(patch)) s1.patchEmpty++;
  else problem("1-noop", c, `untouched form gives a patch: ${Object.keys(patch).join(",")}`);
  const v = validate(form.fields, form.values, { now: NOW });
  if (v.ok) s1.validateOk++;
  else problem("1-validate", c, `untouched form does not validate: ${v.errors.map((e) => e.key).join(",")}`);
  let changed;
  try {
    form.item.update(patch, { strict: true });
    changed = form.item.save().changed;
  } catch (e) {
    changed = `threw:${errCode(e)}`;
  }
  if (changed === false) s1.updateNoChange++;
  else problem("1-noop", c, `item.update/save of the empty patch: ${changed}`);
  if (serverLossWarnings(form.fields).length) {
    s1.lossWarn++;
    c.nicknameWarn = true;
  }
  const mark = env.mark();
  const r = await writes.saveItem({ collection: BOOK_HREF, href: c.href, patch, baseFields: form.fields, base: { text: c.text, etag: c.etag } });
  const sent = env.since(mark).length;
  s1.reqDuring += sent;
  if (r.status === "unchanged" && r.changed === false && sent === 0) s1.saveNoPut++;
  else problem("1-noop", c, `saveItem of the empty patch: status ${r.status}, ${sent} request(s)`);
}
// census of shapes (property names and parameter names only): in how many cards does each occur?
const census = new Map();
for (const c of cards) {
  const seen = new Set();
  for (const l of unfold(c.text).split("\n")) {
    if (!l.includes(":") || /^(BEGIN|END):/i.test(l)) continue;
    const head = l.slice(0, l.indexOf(":"));
    const parts = head.split(";");
    const name = parts[0].split(".").pop().toUpperCase();
    seen.add(name);
    if (/^[A-Za-z0-9-]+\./.test(parts[0])) seen.add("(grouped item)");
    for (const p of parts.slice(1)) {
      const pn = p.split("=")[0].toUpperCase();
      seen.add(`${name};${pn}${pn === "TYPE" && /pref/i.test(p) ? "=pref" : ""}${pn === "VALUE" ? "=" + (p.split("=")[1] || "").toLowerCase() : ""}`);
    }
    if (name === "BDAY") seen.add(/^BDAY[^:]*:\d{4}-?\d\d-?\d\d$/i.test(l) ? "BDAY=full-date" : "BDAY=other-form");
  }
  for (const k of seen) bump(census, k);
}
results.push({
  title: "STEP 1 open + no-op",
  lines: [
    `cards: ${cards.length}; model verdict: ${fmt(s1.open)}`,
    `editable contacts: ${s1.editable} (vCard ${fmt(s1.versions)}); group cards: ${s1.groups}; contacts without UID: ${s1.noUid}; with a photo: ${s1.photos}`,
    `untouched form -> empty patch: ${s1.patchEmpty}/${s1.editable}; validates: ${s1.validateOk}/${s1.editable}; item.update+save unchanged: ${s1.updateNoChange}/${s1.editable}`,
    `saveItem(empty patch) sent no request and answered unchanged: ${s1.saveNoPut}/${s1.editable} (requests sent: ${s1.reqDuring})`,
    `cards with a multi-value NICKNAME warning (server cuts it): ${s1.lossWarn}`,
    `shape census (cards holding each property / parameter; names only): ${fmt(census)}`,
  ],
});

// ---------------------------------------------------------------------------
// STEP 2: one change per owned field, through formmodel -> saveItem -> PUT -> GET -> semdiff

const ROW_PROPS = { tel: ["TEL", "X-ABLABEL"], email: ["EMAIL", "X-ABLABEL"], adr: ["ADR", "X-ABLABEL", "X-ABADR"], url: ["URL", "X-ABLABEL"] };
const ROW_VALUE = { tel: "+1 555 0199", email: "edited@example.org", url: "https://example.org/edited" };
const TYPE_CYCLE = { tel: ["cell", "home", "work", "fax", "pager"], email: ["home", "work", "other"], adr: ["home", "work", "other"], url: ["home", "work", "other"] };
const filled = (kind, r) => (kind === "adr" ? Object.values(r.value).some((p) => String(p).trim()) : String(r.value).trim() !== "");

/** The edits applicable to a card: {id, field, props, apply(values, fields), removal?, last?}. */
function editsFor(f) {
  const E = [];
  const add = (field, props, apply, extra = {}) => E.push({ id: `${field}${extra.row !== undefined ? "#" + extra.row : ""}`, field, props, apply, ...extra });
  add("fn", ["FN"], (v) => {
    v.fn = "Edited Display, Name";
    v.fnEdited = true;
  });
  for (const part of ["prefix", "given", "additional", "family", "suffix"]) {
    add(`name-${part}`, ["N", "FN"], (v) => {
      v[part] = "Edited, Part; X";
    });
  }
  add("nickname", ["NICKNAME"], (v) => {
    v.nickname = "Edited";
  });
  add("org", ["ORG", "FN"], (v) => {
    v.org = "Edited, Org; Inc";
  });
  add("department", ["ORG"], (v) => {
    v.department = "Edited, Dept";
  });
  add("title", ["TITLE"], (v) => {
    v.title = "Edited, Title; Lead";
  });
  add("note", ["NOTE"], (v) => {
    v.note = "Edited, note; with\nnewline é 日本";
  });
  for (const kind of ["tel", "email", "adr", "url"]) {
    const props = ROW_PROPS[kind];
    const rows = f[kind] || [];
    rows.forEach((_, i) => {
      add(`${kind}-value`, props, (v) => {
        const r = v[kind][i];
        if (!r || !r.prop || !filled(kind, r)) return false;
        if (kind === "adr") r.value = { ...r.value, street: "Edited Street, 9" };
        else r.value = ROW_VALUE[kind];
      }, { row: i });
      add(`${kind}-type`, props, (v) => {
        const r = v[kind][i];
        if (!r || !r.prop || !filled(kind, r) || r.typeSel === "custom") return false;
        r.typeSel = TYPE_CYCLE[kind].find((t) => t !== r.typeSel);
      }, { row: i });
      add(`${kind}-pref`, props, (v) => {
        const r = v[kind][i];
        if (!r || !r.prop || !filled(kind, r)) return false;
        const on = !r.pref;
        v[kind].forEach((x) => {
          x.pref = false;
        });
        r.pref = on;
      }, { row: i });
      add(`${kind}-remove`, props, (v) => {
        const r = v[kind][i];
        if (!r || !r.prop || !filled(kind, r)) return false;
        v[kind].splice(i, 1);
      }, { row: i, removal: true, last: i === rows.length - 1 });
    });
    add(`${kind}-add`, props, (v) => {
      const r = newRow(kind, { typeSel: kind === "tel" ? "work" : "other" });
      if (kind === "adr") r.value = { ...r.value, street: "7 Added Lane, Unit 2", city: "Sampletown" };
      else r.value = ROW_VALUE[kind];
      v[kind].push(r);
    });
  }
  add("tel-custom-label", ["TEL", "X-ABLABEL"], (v) => {
    const r = newRow("tel", { typeSel: "custom" });
    r.value = "+1 555 0123";
    r.label = "Beach house, north";
    v.tel.push(r);
  });
  add("bday-set", ["BDAY"], (v, fields) => {
    const cur = fields.bday;
    const same = cur && !cur.text && cur.year === 1985 && cur.month === 5 && cur.day === 17;
    v.bday = { ...v.bday, date: { year: 1985, month: 5, day: same ? 18 : 17 }, replace: true };
  });
  if (f.bday) {
    add("bday-clear", ["BDAY"], (v, fields) => {
      if (fields.bday && fields.bday.text) return false;
      v.bday = { ...v.bday, date: null };
    }, { removal: true });
  }
  if (f.version === "4.0") {
    add("anniversary-set", ["ANNIVERSARY"], (v, fields) => {
      const cur = fields.anniversary;
      const same = cur && !cur.text && cur.year === 2001 && cur.month === 6 && cur.day === 9;
      v.anniversary = { ...v.anniversary, date: { year: 2001, month: 6, day: same ? 10 : 9 }, replace: true };
    });
  }
  add("categories-add", ["CATEGORIES"], (v) => {
    v.categories = [...v.categories, "Edited, one", "two;three"];
  });
  (f.categories || []).forEach((_, i) => {
    add("categories-remove", ["CATEGORIES"], (v) => {
      v.categories = v.categories.filter((__, j) => j !== i);
    }, { row: i, removal: true });
  });
  return E;
}

const s2 = new Map(); // field -> {total, clean, skipped, refused, problems: Map}
const s2perf = { saveMs: [], cycleMs: [] };
const s2cards = new Map(); // idx -> {clean, total}
const s2refusedShapes = new Map();
const cur = new Map(); // href -> {text, etag}: the version the next edit starts from

async function restoreCard(c, wrote) {
  // put the original text back (current ETag), fetch it again as the next baseline
  const now = await env.client.getItem(c.href);
  if (sameSemExact(now.text, c.text)) {
    cur.set(c.href, { text: now.text, etag: now.etag });
    return null;
  }
  try {
    await env.client.putItem(c.href, c.text, { etag: now.etag });
  } catch (e) {
    return `restore-put:${errCode(e)}`;
  }
  const back = await env.client.getItem(c.href);
  cur.set(c.href, { text: back.text, etag: back.etag });
  store.applyWrite(c.href, { etag: back.etag, text: back.text });
  if (!sameSem(c.text, back.text)) return "restore-drift";
  return null;
}
/** Property name + sorted parameter NAMES (TYPE and PREF left out) -> number of lines; REV is writer-managed. */
function paramSig(text) {
  const m = new Map();
  for (const l of unfold(text).split("\n")) {
    if (!l.includes(":") || /^(BEGIN|END):/i.test(l)) continue;
    const parts = l.slice(0, l.indexOf(":")).split(";");
    const name = parts[0].split(".").pop().toUpperCase();
    if (name === "REV") continue;
    const ps = parts.slice(1).map((p) => p.split("=")[0].toUpperCase()).filter((p) => p !== "TYPE" && p !== "PREF").sort().join(",");
    if (!ps) continue;
    const k = `${name}|${ps}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function sameSemExact(a, b) {
  return unfold(a) === unfold(b);
}

async function runEdit(c, edit) {
  const base = cur.get(c.href);
  const form = openForm(base.text);
  if (!form) return { skipped: "not-editable" };
  const { fields, values } = form;
  if (edit.apply(values, fields) === false) return { skipped: "n/a" };
  const problems = [];
  const v = validate(fields, values, { now: NOW });
  if (!v.ok) problems.push(`invalid:${v.errors.map((e) => e.key).join(",")}`);
  const patch = toPatch(fields, values);
  if (isEmptyPatch(patch)) return { problems: ["empty-patch"] };
  const t1 = performance.now();
  const mark = env.mark();
  let res = await writes.saveItem({ collection: BOOK_HREF, href: c.href, patch, baseFields: fields, base: { text: base.text, etag: base.etag } });
  let refusedNote = null;
  if (res.status === "nickname-loss") {
    refusedNote = "nickname-loss-needs-confirmation";
    res = await writes.saveItem({ collection: BOOK_HREF, href: c.href, patch, baseFields: fields, base: { text: base.text, etag: base.etag }, acceptNicknameLoss: true });
  }
  const dt = performance.now() - t1;
  if (res.status === "fidelity") return { refused: `fidelity:${(res.problems || []).map((p) => p.code).join("+")}`, removal: !!edit.removal };
  if (res.status !== "saved") return { problems: [`status:${res.status}${res.reason ? ":" + res.reason : ""}`] };
  const puts = env.since(mark, "PUT").length;
  if (puts !== 1) problems.push(`puts:${puts}`);
  if (res.verified !== true) problems.push(`verify:${(res.mismatched || []).join(",") || "unverified"}`);
  const back = await env.client.getItem(c.href);
  const sent = env.sentBody(c.href);
  if (sent) {
    const cmp = compareServer(sent, back.text);
    if (cmp.unexplained.length) problems.push(`unexplained:${[...new Set(cmp.unexplained.map((u) => u.name))].join(",")}`);
    if (hasLossy(cmp.explained)) problems.push("server-changed-a-value");
  }
  const diff = semdiff(base.text, back.text, { ignoreManaged: true });
  const names = new Set(diff.diffs.map((d) => nameOf(d.line)));
  for (const n of names) if (!edit.props.includes(n)) problems.push(`outside-edit:${n}`);
  if (!names.size) problems.push("no-diff");
  if (/-(value|pref)$/.test(edit.field)) {
    // the parameters other than TYPE / PREF of every property (VALUE=..., ENCODING, vendor ones) must survive a value or pref edit
    const a = paramSig(base.text);
    const b = paramSig(back.text);
    for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) || 0) !== (b.get(k) || 0)) problems.push(`param-changed:${k.split("|")[0]}`);
  }
  const again = openForm(back.text);
  if (!again) problems.push("reopen-failed");
  else if (!isEmptyPatch(toPatch(again.fields, again.values))) problems.push("form-not-stable");
  s2perf.saveMs.push(dt);
  cur.set(c.href, { text: back.text, etag: back.etag });
  return { problems: [...new Set(problems)], refusedNote };
}

const tStep2 = performance.now();
for (const c of editable) {
  cur.set(c.href, { text: c.text, etag: c.etag });
  const rec = { clean: 0, total: 0, probs: new Map(), refused: new Map(), notes: new Set() };
  const edits = editsFor(openItem(c.text, "contact").fields());
  for (const edit of edits) {
    const f = s2.get(edit.field) || { total: 0, clean: 0, skipped: 0, refused: new Map(), problems: new Map() };
    s2.set(edit.field, f);
    const tE = performance.now();
    let r;
    try {
      r = await runEdit(c, edit);
    } catch (e) {
      r = { problems: [`threw:${errCode(e)}`] };
    }
    if (r.skipped) {
      f.skipped++;
    } else if (r.refused) {
      f.total++;
      bump(f.refused, r.refused);
      bump(rec.refused, `${edit.id}:${r.refused}`);
    } else {
      f.total++;
      rec.total++;
      if (r.refusedNote) rec.notes.add(r.refusedNote);
      if (!r.problems.length) {
        f.clean++;
        rec.clean++;
      } else {
        for (const p of r.problems) {
          bump(f.problems, p);
          bump(rec.probs, `${edit.id}:${p}`);
        }
      }
    }
    // restore the original card for the next test
    const rr = await restoreCard(c);
    if (rr) {
      bump(f.problems, rr);
      bump(rec.probs, `${edit.id}:${rr}`);
    }
    s2perf.cycleMs.push(performance.now() - tE);
  }
  s2cards.set(c.idx, rec);
  for (const [k, n] of rec.probs) problem("2-edit", c, `${k} x${n}`);
  for (const [k, n] of rec.refused) {
    bump(s2refusedShapes, `${k.split(":").slice(1).join(":")}`, n);
    problem("2-refused", c, `${k} x${n}`);
  }
}
const s2total = [...s2.values()].reduce((a, f) => a + f.total, 0);
const s2clean = [...s2.values()].reduce((a, f) => a + f.clean, 0);
const s2refused = [...s2.values()].reduce((a, f) => a + [...f.refused.values()].reduce((x, y) => x + y, 0), 0);
const s2skipped = [...s2.values()].reduce((a, f) => a + f.skipped, 0);
const s2probCodes = new Map();
for (const f of s2.values()) for (const [k, n] of f.problems) bump(s2probCodes, k.replace(/:.*$/, ""), n);
const s2byField = [...s2.entries()].sort().map(([k, f]) => `${k} ${f.clean}/${f.total - [...f.refused.values()].reduce((x, y) => x + y, 0)}`);
results.push({
  title: "STEP 2 one edit per owned field",
  lines: [
    `edits run: ${s2total} (${s2skipped} not applicable); clean: ${s2clean}; refused by the guard: ${s2refused} (${fmt(s2refusedShapes)}); with problems: ${s2total - s2clean - s2refused}`,
    `problem codes: ${fmt(s2probCodes)}`,
    `clean/run per field kind: ${s2byField.join("; ")}`,
    `save latency (saveItem incl. read-back + verification): median ${Math.round(pct(s2perf.saveMs, 0.5))} ms, p95 ${Math.round(pct(s2perf.saveMs, 0.95))} ms; full edit+restore cycle median ${Math.round(pct(s2perf.cycleMs, 0.5))} ms; step ${Math.round((performance.now() - tStep2) / 1000)} s`,
  ],
});
const step2Detail = [...s2.entries()].sort();

// ---------------------------------------------------------------------------
// STEP 3: photos and groups

const s3 = { photoTried: 0, photoAdded: 0, photoIdentical: 0, photoRemoved: 0, photoOther: 0, photoProblems: new Map(), groups: new Map() };
const photoFake = (bytes) => ({
  file: { size: bytes.length + 10, type: "image/jpeg", slice: () => ({ bytes, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
  api: {
    createImageBitmap: async () => ({ width: 64, height: 48, close() {} }),
    createCanvas: () => ({ getContext: () => ({ fillRect() {}, drawImage() {}, set fillStyle(_) {} }), convertToBlob: async () => ({ bytes: SYN }) }),
    readBytes: async (blob) => {
      const b = blob.bytes;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  },
});
const SYN = syntheticJpeg(11, 1800);
const SRC = syntheticJpeg(3, 4000);
const processed = await processPhoto(photoFake(SRC).file, photoFake(SRC).api);
const processedOk = processed.mime === "image/jpeg" && Buffer.from(processed.base64, "base64").equals(Buffer.from(SYN));
const sample = editable.filter((c) => !c.noUid).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 12)) === 0).slice(0, 12);
for (const c of sample) {
  s3.photoTried++;
  const hadPhoto = Boolean(openItem(c.text, "contact").fields().photo.present);
  const base = (await env.client.getItem(c.href));
  const form = openForm(base.text);
  Object.assign(form.values, withPhoto(form.values, { mime: processed.mime, base64: processed.base64 }));
  const patch = toPatch(form.fields, form.values);
  const mark = env.mark();
  const r = await writes.saveItem({ collection: BOOK_HREF, href: c.href, patch, baseFields: form.fields, base: { text: base.text, etag: base.etag } });
  if (r.status !== "saved") {
    bump(s3.photoProblems, `add:${r.status}`);
    problem("3-photo", c, `photo add: ${r.status}`);
    await restoreCard(c);
    continue;
  }
  s3.photoAdded++;
  if (env.since(mark, "PUT").length !== 1) bump(s3.photoProblems, "add:puts");
  if (r.verified !== true) bump(s3.photoProblems, `add:verify:${(r.mismatched || []).join(",")}`);
  const back = await env.client.getItem(c.href);
  const shown = canDisplayPhoto(openItem(back.text, "contact"));
  if (shown.ok && shown.base64.replace(/\s/g, "") === processed.base64) s3.photoIdentical++;
  else {
    bump(s3.photoProblems, `add:payload:${shown.ok ? "differs" : shown.reason}`);
    problem("3-photo", c, `photo payload after GET: ${shown.ok ? "differs" : shown.reason}`);
  }
  const d = semdiff(base.text, back.text, { ignoreManaged: true });
  const names = new Set(d.diffs.map((x) => nameOf(x.line)));
  for (const n of names) if (n !== "PHOTO") {
    bump(s3.photoProblems, `add:outside:${n}`);
    problem("3-photo", c, `photo add changed ${n}`);
  }
  // remove it again
  const form2 = openForm(back.text);
  Object.assign(form2.values, withPhoto(form2.values, null));
  const patch2 = toPatch(form2.fields, form2.values);
  const r2 = await writes.saveItem({ collection: BOOK_HREF, href: c.href, patch: patch2, baseFields: form2.fields, base: { text: back.text, etag: back.etag } });
  if (r2.status !== "saved" || r2.verified !== true) {
    bump(s3.photoProblems, `remove:${r2.status}`);
    problem("3-photo", c, `photo remove: ${r2.status}`);
  } else {
    s3.photoRemoved++;
    const back2 = await env.client.getItem(c.href);
    const hasNow = Boolean(openItem(back2.text, "contact").fields().photo.present);
    if (hasNow) {
      bump(s3.photoProblems, "remove:photo-still-there");
      problem("3-photo", c, "photo still present after remove");
    }
    if (!hadPhoto && !sameSem(base.text, back2.text)) {
      bump(s3.photoProblems, "remove:not-back-to-original");
      problem("3-photo", c, "card differs from the original after add+remove");
    }
  }
  const rr = await restoreCard(c);
  if (rr) bump(s3.photoProblems, rr);
}

// --- groups
const g = { created: new Map(), steps: 0, ok: 0, bad: new Map(), noUidRefused: 0, noUidTried: 0, deleteOk: 0, deleteTried: 0, cleanupOk: 0, realGroups: cards.filter((c) => c.group).length };
const members = editable.filter((c) => !c.noUid).slice(0, 5);
const snapshotCards = async (skip) => {
  const all = await serverCards(env.client, BOOK_HREF);
  return new Map(all.filter((x) => !skip.has(x.href)).map((x) => [x.href, x]));
};
const groupHrefs = [];
const memberLines = (text) => unfold(text).split("\n").filter((l) => /^(?:X-ADDRESSBOOKSERVER-)?MEMBER[:;]/i.test(l)).length;
async function groupStep(label, form, fn) {
  const skip = new Set(groupHrefs);
  const before = await snapshotCards(skip);
  g.steps++;
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { status: `threw:${errCode(e)}` };
  }
  const after = await snapshotCards(skip);
  let identical = before.size === after.size;
  for (const [h, x] of before) {
    const y = after.get(h);
    if (!y || y.text !== x.text || y.etag !== x.etag) identical = false;
  }
  const accepted = r.ok === true || r.status === "unchanged";
  if (!accepted) bump(g.bad, `${form}:${label}:${r.status}`);
  else if (!identical) bump(g.bad, `${form}:${label}:other-cards-changed`);
  else g.ok++;
  return r;
}
for (const form of ["apple", "rfc6350"]) {
  const res = await writes.createItem({ collection: BOOK_HREF, group: { name: `Example Group ${form}`, memberUids: [], form } });
  if (res.status !== "created") {
    bump(g.bad, `${form}:create:${res.status}`);
    continue;
  }
  g.created.set(form, res.href);
  groupHrefs.push(res.href);
  store.applyWrite(res.href, { etag: res.etag, text: res.text });
  const gh = res.href;
  const uids = members.map((m) => uidOf(m.text));
  let r = await groupStep("add3", form, () => writes.putGroupMembers({ collection: BOOK_HREF, href: gh, delta: { add: uids.slice(0, 3) } }));
  let gt = (await env.client.getItem(gh)).text;
  if (memberLines(gt) !== 3) bump(g.bad, `${form}:add3:member-count=${memberLines(gt)}`);
  r = await groupStep("add-more", form, () => writes.putGroupMembers({ collection: BOOK_HREF, href: gh, delta: { add: uids.slice(3) } }));
  gt = (await env.client.getItem(gh)).text;
  if (memberLines(gt) !== uids.length) bump(g.bad, `${form}:add-more:member-count=${memberLines(gt)}`);
  r = await groupStep("remove1", form, () => writes.putGroupMembers({ collection: BOOK_HREF, href: gh, delta: { remove: [uids[0]] } }));
  gt = (await env.client.getItem(gh)).text;
  if (memberLines(gt) !== uids.length - 1) bump(g.bad, `${form}:remove1:member-count=${memberLines(gt)}`);
  r = await groupStep("add-existing", form, () => writes.putGroupMembers({ collection: BOOK_HREF, href: gh, delta: { add: [uids[1]] } }));
  if (r.status !== "unchanged") bump(g.bad, `${form}:add-existing:expected-unchanged-got-${r.status}`);
  r = await groupStep("remove-rest", form, () => writes.putGroupMembers({ collection: BOOK_HREF, href: gh, delta: { remove: uids.slice(1) } }));
  gt = (await env.client.getItem(gh)).text;
  if (memberLines(gt) !== 0) bump(g.bad, `${form}:remove-rest:member-count=${memberLines(gt)}`);
  await writes.putGroupMembers({ collection: BOOK_HREF, href: gh, delta: { add: uids } });
}
// a contact without UID cannot be added
const nouid = cards.find((c) => c.noUid && !c.group);
g.noUidTried = nouid ? 1 : 0;
if (nouid && groupHrefs[0]) {
  const r = await writes.putGroupMembers({ collection: BOOK_HREF, href: groupHrefs[0], delta: { add: [""] } });
  if (r.status === "no-uid") g.noUidRefused++;
}
// deleting a contact that is a member of both groups: cleanup
if (groupHrefs.length && members[0]) {
  const victim = members[0];
  const vUid = uidOf(victim.text);
  const cur2 = await env.client.getItem(victim.href);
  for (const gh of groupHrefs) {
    const t = (await env.client.getItem(gh)).text;
    if (!unfold(t).includes(vUid)) bump(g.bad, "delete:precondition-not-member");
  }
  g.deleteTried = 1;
  const before = await snapshotCards(new Set([...groupHrefs, victim.href]));
  const res = await writes.deleteItem({ collection: BOOK_HREF, href: victim.href, etag: cur2.etag, uid: vUid });
  if (res.status === "deleted" && res.cleanupFailed === 0) g.deleteOk++;
  else bump(g.bad, `delete:${res.status}`);
  let cleaned = true;
  for (const gh of groupHrefs) {
    const t = (await env.client.getItem(gh)).text;
    if (unfold(t).includes(vUid)) cleaned = false;
    if (memberLines(t) !== members.length - 1) cleaned = false;
  }
  if (cleaned) g.cleanupOk++;
  else bump(g.bad, "delete:group-cleanup-incomplete");
  const after = await snapshotCards(new Set([...groupHrefs, victim.href]));
  let same = before.size === after.size;
  for (const [h, x] of before) if (!after.get(h) || after.get(h).text !== x.text) same = false;
  if (!same) bump(g.bad, "delete:other-cards-changed");
  // restore the deleted card (create again with its original text) and sync
  try {
    await env.client.putItem(victim.href, victim.text, { create: true });
  } catch (e) {
    bump(g.bad, `delete:restore-${errCode(e)}`);
  }
}
// clean up the groups of this step
for (const gh of groupHrefs) {
  const x = await env.client.getItem(gh);
  await env.client.deleteItem(gh, x.etag);
}
await store.sync({ reason: "manual" });
results.push({
  title: "STEP 3 photos and groups",
  lines: [
    `processPhoto with fakes: ${processedOk ? "output = known bytes" : "OUTPUT DIFFERS"}; photo add on ${s3.photoTried} cards: saved ${s3.photoAdded}, payload identical after GET ${s3.photoIdentical}, removed again ${s3.photoRemoved}; problems: ${fmt(s3.photoProblems)}`,
    `groups: real group cards in the book ${g.realGroups}; forms created ${[...g.created.keys()].join("+") || "none"}; membership steps ${g.steps}, only the group card changed in ${g.ok}; problems: ${fmt(g.bad)}`,
    `contact without UID refused (no-uid): ${g.noUidRefused}/${g.noUidTried}; delete a contact that is a member of both groups: ${g.deleteOk}/${g.deleteTried}, cleanup complete ${g.cleanupOk}/${g.deleteTried}`,
  ],
});
if (!processedOk) problem("3-photo", null, "processPhoto output differs from the known bytes");

// ---------------------------------------------------------------------------
// STEP 4: export and import

const bookNow = await serverCards(env.client, BOOK_HREF);
const exCollection = { href: BOOK_HREF, kind: "addressbook", displayName: "Example book" };
const t4 = performance.now();
const exNo = await ctx.exportCollection({ collection: exCollection, includeGroups: false });
const exYes = await ctx.exportCollection({ collection: exCollection, includeGroups: true });
const tExport = performance.now() - t4;
const serverGroups = bookNow.filter((x) => isGroupText(x.text)).length;
const s4 = { noGroups: exNo.count, withGroups: exYes.count, serverTotal: bookNow.length, serverGroups, excluded: exNo.groupsExcluded, semEqual: 0, semDiff: 0, plan: null, planDup: null, policies: [] };
{
  // every exported card equals the server card with the same UID
  const byUid = new Map(bookNow.map((x) => [uidOf(x.text), x]));
  const { splitCards } = await import("../../src/js/store/export.js");
  for (const t of splitCards(exYes.text)) {
    const x = byUid.get(uidOf(t));
    if (x && sameSem(t, x.text)) s4.semEqual++;
    else s4.semDiff++;
  }
}
const summariesOf = (list) => list.map((x) => summarize(x.text, { href: x.href, etag: x.etag }));
const knownOf = (list) => summariesOf(list).map((s) => ({ href: s.href, etag: s.etag, uid: s.uid, fn: s.name, emails: s.emails }));
{
  const plan = planImport(exYes.text, [], { collectionHref: `${HOME}gs-plan/` });
  const reasons = new Map();
  for (const r of plan.rows) if (r.reason) bump(reasons, `${r.state}:${r.reason}`);
  const lossyProps = new Map();
  for (const r of plan.rows) for (const p of r.lossy) bump(lossyProps, p);
  const hints = plan.rows.filter((r) => r.hints.length).length;
  s4.plan = { fatal: plan.fatal ? plan.fatal.reason : null, counts: plan.counts, lossyCards: plan.lossy.length, lossyProps, reasons, hints };
  const planB = planImport(exYes.text, knownOf(bookNow), { collectionHref: BOOK_HREF });
  s4.planDup = { counts: planB.counts, lossyCards: planB.lossy.length };
}
let nicknameWarnCards = 0;
for (const x of bookNow) {
  const it = openItem(x.text, "contact");
  if (it.ok && !it.readOnly && serverLossWarnings(it.fields()).length) nicknameWarnCards++;
}
s4.nicknameWarnCards = nicknameWarnCards;

async function importInto(name, policy, text, { prior = false } = {}) {
  const href = `${HOME}${name}/`;
  if (!prior) {
    const mk = await writes.mkcol({ home: HOME, name, displayName: name });
    if (mk.status !== "created") return { error: `mkcol:${mk.status}` };
  }
  const st = ctx.stores.get(href) || ctx.stores.open({ href, kind: "addressbook" });
  await st.sync({ reason: "load" });
  const known = knownOf(st.list());
  const plan = planImport(text, known, { collectionHref: href });
  const tI = performance.now();
  const h = ctx.startImport({ collection: href, plan, policy });
  const rep = await h.done;
  const ms = performance.now() - tI;
  await st.sync({ reason: "manual" });
  return { href, st, plan, rep, ms };
}

const sourceByUid = new Map();
{
  const { splitCards } = await import("../../src/js/store/export.js");
  for (const t of splitCards(exYes.text)) sourceByUid.set(uidOf(t), t);
}
const pol = new Map();
for (const policy of ["skip", "replace", "keep-both"]) {
  const rec = { policy, empty: null, second: null };
  const r1 = await importInto(`gs-${policy}`, policy, exYes.text);
  if (r1.error) {
    rec.empty = { error: r1.error };
    pol.set(policy, rec);
    continue;
  }
  const rep = r1.rep;
  const got = await serverCards(env.client, r1.href);
  let equal = 0;
  let explained = 0;
  let lossyItems = 0;
  let unexplained = 0;
  let missing = 0;
  const gotByUid = new Map(got.map((x) => [uidOf(x.text), x]));
  for (const [uid, src] of sourceByUid) {
    const x = gotByUid.get(uid);
    if (!x) {
      missing++;
      continue;
    }
    const cmp = compareServer(src, x.text);
    if (cmp.equal && !cmp.explained.length) equal++;
    else if (cmp.equal) {
      explained++;
      if (hasLossy(cmp.explained)) lossyItems++;
    } else unexplained++;
  }
  rec.empty = { total: rep.total, created: rep.created, replaced: rep.replaced, skipped: rep.skipped, failed: rep.failed, notRun: rep.notRun, reasons: rep.reasons, warnings: rep.warnings.length, verifyMismatch: rep.verify.mismatched.length, stored: got.length, equal, explained, lossyItems, unexplained, missing, ms: r1.ms };
  // second pass: same file into the now populated book
  const r2 = await importInto(`gs-${policy}`, policy, exYes.text, { prior: true });
  const rep2 = r2.rep;
  const after = await serverCards(env.client, r2.href);
  let secondDiff = 0;
  const afterByUid = new Map(after.map((x) => [uidOf(x.text), x]));
  for (const [uid, src] of sourceByUid) {
    const x = afterByUid.get(uid);
    if (!x || !sameSem(src, x.text)) secondDiff++;
  }
  rec.second = { semDiffFromSource: secondDiff, created: rep2.created, replaced: rep2.replaced, skipped: rep2.skipped, failed: rep2.failed, reasons: rep2.reasons, storedAfter: after.length, planCounts: r2.plan.counts };
  pol.set(policy, rec);
}
s4.policies = [...pol.values()];
const fmtPol = (rec) => {
  if (rec.empty.error) return `${rec.policy}: ${rec.empty.error}`;
  const e = rec.empty;
  const s = rec.second;
  return `${rec.policy}: empty book -> created ${e.created}, replaced ${e.replaced}, skipped ${e.skipped}, failed ${e.failed}, notRun ${e.notRun}, stored ${e.stored}, semantic equal ${e.equal}, equal after allowlisted normalisation ${e.explained} (lossy ${e.lossyItems}), UNEXPLAINED ${e.unexplained}, missing ${e.missing}, verify mismatches ${e.verifyMismatch}, ${Math.round(e.ms)} ms; second pass into the populated book -> originals differing from the source ${s.semDiffFromSource}, created ${s.created}, replaced ${s.replaced}, skipped ${s.skipped}, failed ${s.failed} (${fmt(s.reasons)}), stored ${s.storedAfter}`;
};
results.push({
  title: "STEP 4 export and import",
  lines: [
    `export: contacts only ${s4.noGroups} (groups excluded ${s4.excluded}), with groups ${s4.withGroups}; server holds ${s4.serverTotal} cards of which ${s4.serverGroups} group cards; exported cards semantically equal to the server's ${s4.semEqual}/${s4.semEqual + s4.semDiff}; export took ${Math.round(tExport)} ms`,
    `planImport on the export (empty target): ${s4.plan.fatal ? "fatal " + s4.plan.fatal : fmt(s4.plan.counts)}; lossy cards ${s4.plan.lossyCards} (${fmt(s4.plan.lossyProps)}); rows with same-name/e-mail hints ${s4.plan.hints}; reasons ${fmt(s4.plan.reasons)}`,
    `planImport on the export (onto the book itself): ${fmt(s4.planDup.counts)}; lossy cards ${s4.planDup.lossyCards}`,
    `serverLossWarnings (multi-value NICKNAME) on server cards: ${s4.nicknameWarnCards}`,
    ...s4.policies.map(fmtPol),
  ],
});

// ---------------------------------------------------------------------------
// STEP 5: concurrent edit on 3 real cards

const s5 = { scenarios: [], bad: new Map() };
const pickSet = editable.filter((c) => !c.noUid && (openItem(c.text, "contact").fields().tel || []).length >= 1);
const pick3 = [pickSet[0], pickSet[Math.floor(pickSet.length / 2)], pickSet[pickSet.length - 1]].filter(Boolean);
const noteOf = (t) => (/^NOTE[;:]/im.test(unfold(t)) ? "has-note" : "no-note");
for (const c of pick3) {
  const rec = { idx: c.idx, hash: c.hash, shape: c.shape, results: [] };
  async function scenario(name, otherEdit, mineEdit, resolve) {
    // fresh baseline = the original card
    const baseSrv = await env.client.getItem(c.href);
    if (!sameSemExact(baseSrv.text, c.text)) {
      await env.client.putItem(c.href, c.text, { etag: baseSrv.etag });
    }
    const b0 = await env.client.getItem(c.href);
    store.applyWrite(c.href, { etag: b0.etag, text: b0.text });
    const base = { text: b0.text, etag: b0.etag };
    // my form
    const mine = openForm(base.text);
    mineEdit(mine.values);
    const myPatch = toPatch(mine.fields, mine.values);
    // the other client changes the card first (raw DAV, real PUT)
    const their = openForm(base.text);
    otherEdit(their.values);
    const tp = toPatch(their.fields, their.values);
    their.item.update(tp, { strict: true });
    const to = their.item.save();
    await other.client.putItem(c.href, to.text, { etag: base.etag });
    const theirsSrv = await env.client.getItem(c.href);
    const mark = env.mark();
    const first = await writes.saveItem({ collection: BOOK_HREF, href: c.href, patch: myPatch, baseFields: mine.fields, base });
    const rec1 = { name, first: first.status, putsOnFirst: env.since(mark, "PUT").length };
    if (first.status !== "conflict") {
      rec1.problem = `expected conflict, got ${first.status}`;
      rec.results.push(rec1);
      return;
    }
    let res;
    try {
      res = await resolve(first);
    } catch (e) {
      rec1.problem = `resolve threw ${errCode(e)}`;
      rec.results.push(rec1);
      return;
    }
    const final = await env.client.getItem(c.href);
    rec1.resolution = res.status;
    rec1.unmappable = (first.unmappable || []).length;
    rec1.rows = (first.rows || []).length;
    rec1.bothChanged = first.bothChanged;
    rec1.canOverwrite = first.canOverwrite;
    rec1.canCopy = first.canCopy;
    rec1.finalVsTheirs = [...new Set(semdiff(theirsSrv.text, final.text, { ignoreManaged: true }).diffs.map((d) => nameOf(d.line)))].join("+") || "same";
    rec1.finalVsBase = [...new Set(semdiff(base.text, final.text, { ignoreManaged: true }).diffs.map((d) => nameOf(d.line)))].join("+") || "same";
    rec1.res = res;
    rec1.final = final;
    rec1.theirs = theirsSrv;
    rec.results.push(rec1);
  }
  const hasTel = (v) => v.tel.length > 0;
  const bumpNote = (v) => {
    v.note = "Edited by the second client";
  };
  const mineTitle = (v) => {
    v.title = "Edited by me, title";
  };
  const mineTel = (v) => {
    if (hasTel(v)) v.tel[0].value = "+1 555 0142";
  };
  const theirTel = (v) => {
    if (hasTel(v)) v.tel[0].value = "+1 555 0177";
  };
  // 1 different fields, overwrite: both edits survive
  await scenario("overwrite-different-field", bumpNote, mineTitle, (first) => writes.resolveOverwrite(first, { confirmUnmappable: false }));
  let r = rec.results[rec.results.length - 1];
  if (r.res) {
    if (r.resolution !== "saved") r.problem = `overwrite status ${r.resolution}`;
    else if (r.finalVsTheirs !== "TITLE") r.problem = `final differs from theirs by ${r.finalVsTheirs}`;
    else if (!/NOTE/.test(r.finalVsBase) || !/TITLE/.test(r.finalVsBase)) r.problem = `final lacks one side: ${r.finalVsBase}`;
  }
  // 2 same row, overwrite: mine wins on that row
  await scenario("overwrite-same-row", theirTel, mineTel, (first) => writes.resolveOverwrite(first, { confirmUnmappable: true }));
  r = rec.results[rec.results.length - 1];
  if (r.res) {
    // Outcome is recorded, not judged: either mine won on the row, or the operation was LISTED as unmappable and,
    // after the explicit confirmation, their row was kept. Silent loss (nothing listed, mine not written) is a problem.
    const digits = (v) => String(v).replace(/\D/g, "");
    const fin = openItem(r.final.text, "contact").fields();
    const mineWon = Boolean(fin.tel[0]) && digits(fin.tel[0].value).endsWith("0142");
    r.outcome = mineWon ? "mine-won" : r.unmappable > 0 ? "listed-unmappable-theirs-kept" : "SILENT-LOSS";
    if (r.outcome === "SILENT-LOSS") r.problem = "my change dropped without being listed";
    else if (!["saved", "unchanged"].includes(r.resolution)) r.problem = `overwrite status ${r.resolution}`;
  }
  // 3 save as copy: original stays theirs, the copy holds my version
  await scenario("save-as-copy", bumpNote, mineTitle, (first) => writes.resolveCopy(first));
  r = rec.results[rec.results.length - 1];
  if (r.res) {
    if (r.resolution !== "copied") r.problem = `copy status ${r.resolution}`;
    else {
      if (r.finalVsTheirs !== "same") r.problem = `the original changed by ${r.finalVsTheirs}`;
      const copyText = (await env.client.getItem(r.res.href)).text;
      const copyFields = openItem(copyText, "contact").fields();
      if (copyFields.title !== "Edited by me, title") r.problem = "the copy lacks my change";
      if (uidOf(copyText) === uidOf(r.final.text)) r.problem = "the copy has the same UID";
      const ch = await env.client.getItem(r.res.href);
      await env.client.deleteItem(r.res.href, ch.etag);
    }
  }
  // 4 reload: theirs kept, mine dropped
  await scenario("reload", bumpNote, mineTitle, async (first) => writes.resolveReload(first));
  r = rec.results[rec.results.length - 1];
  if (r.res) {
    if (r.resolution !== "reloaded") r.problem = `reload status ${r.resolution}`;
    else if (r.finalVsTheirs !== "same") r.problem = `server changed by ${r.finalVsTheirs}`;
    const inStore = store.get(c.href);
    if (!inStore || inStore.etag !== r.final.etag) r.problem = "store does not hold their version";
  }
  // 5 they remove the row I edit: unmappable listed, needs confirmation, nothing sent before consent
  if (hasTelCard(c)) {
    await scenario("overwrite-row-removed-by-them", (v) => v.tel.splice(0, 1), mineTel, async (first) => {
      const noConsent = await writes.resolveOverwrite(first, { confirmUnmappable: false });
      if (first.unmappable.length === 0) return { status: "no-unmappable-listed", noConsent: noConsent.status };
      if (noConsent.status !== "needs-confirmation") return { status: `no-consent-sent:${noConsent.status}` };
      return writes.resolveOverwrite(first, { confirmUnmappable: true });
    });
    r = rec.results[rec.results.length - 1];
    if (r.res && !["saved", "unchanged"].includes(r.res.status)) r.problem = `result ${r.res.status}`;
  }
  // restore the card
  const nowSrv = await env.client.getItem(c.href);
  if (!sameSemExact(nowSrv.text, c.text)) await env.client.putItem(c.href, c.text, { etag: nowSrv.etag });
  await restoreCard(c);
  s5.scenarios.push(rec);
}
function hasTelCard(c) {
  return (openItem(c.text, "contact").fields().tel || []).length >= 1;
}
let s5n = 0;
let s5ok = 0;
const s5res = new Map();
for (const sc of s5.scenarios) {
  for (const r of sc.results) {
    s5n++;
    bump(s5res, `${r.name}:${r.resolution || r.first}${r.outcome ? "/" + r.outcome : ""}`);
    if (r.problem) problem("5-conflict", { idx: sc.idx, hash: sc.hash }, `${r.name}: ${r.problem}`);
    else s5ok++;
  }
}
results.push({
  title: "STEP 5 concurrent edit (real 412)",
  lines: [`cards ${s5.scenarios.length}; scenarios ${s5n}; sane ${s5ok}/${s5n}; outcomes ${fmt(s5res)}`],
});

// ---------------------------------------------------------------------------
// Final integrity: the book still equals the copy it started from (all restored, helper books apart)

const finalCards = await serverCards(env.client, BOOK_HREF);
let drift = 0;
const origByHref = new Map(entries.map((e) => [e.href, e.text]));
for (const x of finalCards) {
  const o = origByHref.get(x.href);
  if (o !== undefined && !sameSem(o, x.text)) drift++;
}
const extra = finalCards.length - entries.length;
results.push({ title: "FINAL integrity of the replay book", lines: [`cards now ${finalCards.length} (started with ${entries.length}); semantic drift from the start text: ${drift}; extra cards: ${extra}`] });
if (drift || extra) problem("final", null, `book not restored: drift ${drift}, extra ${extra}`);

// ---------------------------------------------------------------------------
// Report and console

const secs = Math.round((performance.now() - t0) / 1000);
out("## Aggregates");
for (const r of results) {
  out(`### ${r.title}`);
  for (const l of r.lines) out(`- ${l}`);
  out("");
}
out(`Total run time ${secs} s.`);
out("");
out("## Step 2 detail by field kind (clean / run, refused, problem codes)");
for (const [k, f] of step2Detail) {
  const refused = [...f.refused.values()].reduce((a, b) => a + b, 0);
  out(`- ${k}: run ${f.total}, clean ${f.clean}, not applicable ${f.skipped}, refused ${refused}${refused ? " (" + fmt(f.refused) + ")" : ""}${f.problems.size ? "; problems: " + fmt(f.problems) : ""}`);
}
out("");
out("## Failures and refusals by card (anonymous index, hash of the file name, shape = property names only)");
if (!failures.length) out("(none)");
for (const f of failures) {
  const c = byHref.get([...byHref.keys()].find((h) => byHref.get(h).idx === f.idx) || "");
  out(`- #${f.idx} ${f.hash} [${f.step}] ${f.what}${c ? " | shape: " + c.shape : ""}`);
}
out("");
out("## Per card");
out("| # | hash | version | model | edits clean/run | refused | problems |");
out("|---|---|---|---|---|---|---|");
for (const c of cards) {
  const rec = s2cards.get(c.idx);
  const ver = (/^v(\S+)/.exec(c.shape) || [])[1] || "?";
  out(`| ${c.idx} | ${c.hash} | ${ver}${c.noUid ? " no-uid" : ""} | ${c.open || "?"} | ${rec ? `${rec.clean}/${rec.total}` : "-"} | ${rec ? rec.refused.size : "-"} | ${rec ? [...rec.probs.keys()].length : "-"} |`);
}
out("");
out("## Step 5 scenarios (anonymous)");
for (const sc of s5.scenarios) {
  out(`- #${sc.idx} ${sc.hash} shape: ${sc.shape}`);
  for (const r of sc.results) out(`  - ${r.name}: first save ${r.first} (${r.putsOnFirst} PUT), resolution ${r.resolution || "-"}${r.outcome ? " (" + r.outcome + ")" : ""}, rows listed ${r.rows ?? "-"}, unmappable ${r.unmappable ?? "-"}, final vs theirs: ${r.finalVsTheirs || "-"}, final vs base: ${r.finalVsBase || "-"}${r.problem ? ", PROBLEM: " + r.problem : ""}`);
}
mkdirSync(path.dirname(REPORT), { recursive: true });
writeFileSync(REPORT, report.join("\n") + "\n", { mode: 0o600 });
chmodSync(REPORT, 0o600);

for (const r of results) {
  con(`  ${r.title}`);
  for (const l of r.lines) con(`    ${l}`);
}
const failCounts = new Map();
for (const f of failures) bump(failCounts, f.step);
con(`  FAILURES by step: ${fmt(failCounts)}; total ${failures.length}; ${secs} s`);
con("  detailed report written outside the repository (mode 600)");
await session.dispose();
process.exit(0);
