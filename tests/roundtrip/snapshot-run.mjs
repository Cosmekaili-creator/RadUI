// SPDX-License-Identifier: AGPL-3.0-or-later
// Snapshot runner: runs the round-trip checks over a local copy of real data.
//
// Not a unit test and never part of `make test`: use tests/roundtrip/snapshot-run.sh,
// which extracts the snapshot into a private temp dir, starts a throwaway Radicale
// on that COPY and removes everything at the end.
//
// Environment (set by the shell wrapper):
//   RT_SNAPSHOT_ROOT   the extracted collection-root directory (<owner>/<collection>/<item>)
//   RT_REPORT          path of the detailed report (outside the repository, mode 600)
//   RT_TMP             scratch directory for the sanitiser check (removed by the wrapper)
//   RADUI_TEST_RADICALE, RADUI_TEST_PASSWORDS_FILE   the throwaway instance and its accounts
//   RT_LIMIT           optional: process at most this many items (smoke test)
//   RT_WORKERS         parallel workers (default 4, at most 8)
//
// CONSOLE OUTPUT IS AGGREGATES ONLY (counts, categories, reason codes). The report
// holds per-item rows identified by an index and a path hash; it never contains a
// name, summary, address, UID or any other value of the data.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeSegment } from "../../src/js/dav/http.js";
import { ParseError, parse } from "../../src/js/model/contentlines.js";
import { emit } from "../../src/js/model/writer.js";
import { openItem } from "../../src/js/model/item.js";
import { compareServer, hasLossy } from "./compare.mjs";
import { NOW, PRIMARY, checkEdit, editsFor, lf, makeClient, crlf } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.RT_SNAPSHOT_ROOT;
const REPORT = process.env.RT_REPORT;
const TMP = process.env.RT_TMP;
const LIMIT = Number(process.env.RT_LIMIT || 0);
const WORKERS = Math.min(8, Math.max(1, Number(process.env.RT_WORKERS || 4)));
if (!ROOT || !REPORT || !process.env.RADUI_TEST_RADICALE || !process.env.RADUI_TEST_PASSWORDS_FILE) {
  console.error("snapshot-run: use tests/roundtrip/snapshot-run.sh");
  process.exit(2);
}

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const label = (n) => (n.startsWith("X-") ? "X-*" : n);
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

// ---------------------------------------------------------------------------
// Inventory

const passwords = Object.fromEntries(
  readFileSync(process.env.RADUI_TEST_PASSWORDS_FILE, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]),
);
const clients = new Map();
const clientOf = (owner) => {
  if (!clients.has(owner)) clients.set(owner, makeClient({ user: owner, password: passwords[owner] }));
  return clients.get(owner).client;
};

const items = [];
for (const owner of readdirSync(ROOT).sort()) {
  const od = path.join(ROOT, owner);
  if (owner.startsWith(".") || !statSync(od).isDirectory()) continue;
  for (const coll of readdirSync(od).sort()) {
    const cd = path.join(od, coll);
    if (coll.startsWith(".") || !statSync(cd).isDirectory()) continue;
    for (const file of readdirSync(cd).sort()) {
      if (file.startsWith(".") || !/\.(ics|vcf)$/i.test(file)) continue;
      items.push({ owner, coll, file, full: path.join(cd, file), href: `/${encodeSegment(owner)}/${encodeSegment(coll)}/${encodeSegment(file)}` });
    }
  }
}
if (LIMIT) items.length = Math.min(items.length, LIMIT);
items.forEach((it, i) => {
  it.idx = i + 1;
  it.hash = hash(`${it.owner}/${it.coll}/${it.file}`);
});

// ---------------------------------------------------------------------------
// Offline stage: open, no-edit, one-owned-field edits

function offline(it, text) {
  const rec = { open: "", family: "", noedit: "n/a", edits: { clean: 0, total: 0, problems: new Map() }, primaryClean: null };
  let roots = null;
  try {
    roots = parse(text);
  } catch (e) {
    if (!(e instanceof ParseError)) rec.open = `failure:exception:${e.name}`;
  }
  let opened;
  try {
    opened = openItem(text);
  } catch (e) {
    rec.open = `failure:exception:${e.name}`;
    return rec;
  }
  rec.family = roots && roots[0] ? ({ VCARD: "contact" }[roots[0].key] || (opened.ok ? opened.kind : "calendar")) : "unparseable";
  if (roots) {
    const out = roots.map(emit).join("");
    rec.noedit = out === lf(text).replace(/\n/g, "\r\n") ? "exact" : out === crlf(text) ? "normalised" : "MISMATCH";
  }
  if (!opened.ok) {
    rec.open = `refused:${opened.reason}`;
    return rec;
  }
  rec.open = opened.readOnly ? `readonly:${opened.readOnlyReason}` : "ok";
  rec.kind = opened.kind;
  if (opened.readOnly) return rec;
  if (opened.save().changed !== false) rec.noedit = "MISMATCH:save-changed";
  for (const edit of editsFor(opened)) {
    rec.edits.total++;
    let r;
    try {
      r = checkEdit(text, opened.kind, edit);
    } catch (e) {
      r = { problems: [`exception:${e.name}`] };
    }
    if (!r.problems.length) rec.edits.clean++;
    for (const p of r.problems) bump(rec.edits.problems, `${edit.field}:${p}`);
    if (edit.field === PRIMARY[opened.kind]) rec.primaryClean = !r.problems.length;
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Server stage (throwaway copy): PUT the item back, GET, compare; then PUT the edited item

async function server(it, text, rec) {
  const s = { servedSame: null, put: "", cmp: "", codes: [], lossy: false, editPut: "n/a", editCmp: "" };
  const client = clientOf(it.owner);
  try {
    const g0 = await client.getItem(it.href);
    s.servedSame = lf(g0.text) === lf(text);
    try {
      await client.putItem(it.href, text, { etag: g0.etag });
      s.put = "ok";
    } catch (e) {
      s.put = `rejected:${e.status || e.kind}`;
      return s;
    }
    const g1 = await client.getItem(it.href);
    let cmp = null;
    try {
      cmp = compareServer(text, g1.text);
    } catch (e) {
      s.cmp = `uncomparable:${e.name}`;
    }
    if (cmp) {
      s.cmp = cmp.equal ? (cmp.explained.length ? "explained" : "equal") : "UNEXPLAINED";
      s.codes = [...new Set([...cmp.explained.map((x) => x.code), ...cmp.unexplained.map((u) => `unexplained:${u.side}:${u.path.split("/").pop().replace(/\[.*/, "")}:${label(u.name)}`)])];
      s.lossy = hasLossy(cmp.explained);
    }
    // the edited item (RadUI only edits served text)
    if (rec.open === "ok") {
      const item = openItem(g1.text);
      const edit = editsFor(item).find((e) => e.field === PRIMARY[item.kind]);
      if (edit && edit.apply(item) !== false) {
        const out = item.save({ now: NOW });
        try {
          await client.putItem(it.href, out.text, { etag: g1.etag });
          const g2 = await client.getItem(it.href);
          const c2 = compareServer(out.text, g2.text);
          const re = openItem(g2.text);
          const bad = [];
          if (c2.unexplained.length) bad.push("unexplained");
          if (hasLossy(c2.explained)) bad.push("lossy");
          if (!re.ok || re.readOnly) bad.push("reopen-readonly");
          else if (re.save().changed !== false) bad.push("not-stable");
          s.editPut = bad.length ? `FAIL:${bad.join("+")}` : "ok";
          s.editCmp = c2.explained.map((x) => x.code).join("+");
        } catch (e) {
          s.editPut = `rejected:${e.status || e.kind}`;
        }
      }
    }
  } catch (e) {
    s.put = s.put || `exception:${e.name}:${e.status || ""}`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Run

const records = new Array(items.length);
let next = 0;
const sizes = [];
async function worker() {
  while (true) {
    const i = next++;
    if (i >= items.length) return;
    const it = items[i];
    let text;
    try {
      text = readFileSync(it.full, "utf8");
    } catch {
      records[i] = { ...it, rec: { open: "failure:unreadable" }, srv: null };
      continue;
    }
    sizes.push(Buffer.byteLength(text));
    const rec = offline(it, text);
    const srv = await server(it, text, rec);
    records[i] = { ...it, rec, srv };
    if ((i + 1) % 500 === 0) process.stderr.write(`progress ${i + 1}/${items.length}\n`);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: WORKERS }, worker));

// ---------------------------------------------------------------------------
// Sanitiser check on a sample (python, stdlib): structure, folding layout and leaks

function sanitiserCheck() {
  if (!TMP) return null;
  const sample = items.filter((_, i) => i % Math.max(1, Math.floor(items.length / 300)) === 0).slice(0, 300);
  const din = path.join(TMP, "sanin");
  const dout = path.join(TMP, "sanout");
  mkdirSync(din, { recursive: true, mode: 0o700 });
  mkdirSync(dout, { recursive: true, mode: 0o700 });
  const files = [];
  for (const it of sample) {
    const f = path.join(din, `${it.idx}${path.extname(it.file)}`);
    writeFileSync(f, readFileSync(it.full), { mode: 0o600 });
    files.push(f);
  }
  const py = spawnSync("python3", ["-I", path.resolve(here, "../../tools/sanitize-fixture.py"), ...files, "-o", dout], { encoding: "utf8" });
  if (py.status !== 0) return { sample: sample.length, error: "sanitiser failed" };
  const sig = (text) => {
    const out = [];
    const walk = (c) => {
      out.push(`[${c.key}`);
      for (const n of c.items) {
        if (n.items) walk(n);
        else out.push(`${n.groupKey || ""}.${n.key}(${n.params.map((p) => p.name.toUpperCase() + (p.values.some((v) => v.quoted) ? "q" : "")).join(",")})`);
      }
    };
    for (const r of parse(text)) walk(r);
    return out.join("|");
  };
  const layout = (t) => t.split(/\r\n|\r|\n/).map((l) => Buffer.byteLength(l)).join(",");
  const FREE = new Set(["SUMMARY", "DESCRIPTION", "LOCATION", "NOTE", "FN", "N", "ORG", "TITLE", "NICKNAME", "COMMENT", "CATEGORIES"]);
  const words = (text) => {
    const w = new Set();
    try {
      const walk = (c) => {
        for (const n of c.items) {
          if (n.items) walk(n);
          else if (FREE.has(n.key)) for (const m of n.value.matchAll(/[\p{L}]{6,}/gu)) w.add(m[0].toLowerCase());
        }
      };
      for (const r of parse(text)) walk(r);
    } catch {
      /* unparseable: no words */
    }
    return w;
  };
  let sameSig = 0;
  let sameLayout = 0;
  let leaking = 0;
  let compared = 0;
  const layoutByProp = new Map();
  const propsOf = (text) => {
    const out = [];
    const walk = (c) => {
      for (const n of c.items) {
        if (n.items) walk(n);
        else out.push(n);
      }
    };
    for (const r of parse(text)) walk(r);
    return out;
  };
  for (const it of sample) {
    const ext = path.extname(it.file);
    let a;
    let b;
    try {
      a = readFileSync(path.join(din, `${it.idx}${ext}`), "utf8");
      b = readFileSync(path.join(dout, `${it.idx}${ext}`), "utf8");
    } catch {
      continue;
    }
    compared++;
    try {
      if (sig(a) === sig(b)) sameSig++;
    } catch {
      /* unparseable original */
    }
    if (layout(a) === layout(b)) sameLayout++;
    else {
      try {
        const pa = propsOf(a);
        const pb = propsOf(b);
        pa.forEach((p, i) => {
          if (pb[i] && p.folded.split("\n").map((l) => Buffer.byteLength(l)).join() !== pb[i].folded.split("\n").map((l) => Buffer.byteLength(l)).join()) bump(layoutByProp, label(p.key));
        });
      } catch {
        /* ignore */
      }
    }
    const wa = words(a);
    const wb = words(b);
    if ([...wa].some((x) => wb.has(x))) leaking++;
  }
  return { sample: compared, sameStructure: sameSig, sameFoldLayout: sameLayout, itemsWithSurvivingWord: leaking, layoutDiffersByProperty: Object.fromEntries(layoutByProp) };
}
const san = sanitiserCheck();

// ---------------------------------------------------------------------------
// Aggregates

const agg = {
  total: records.length,
  open: new Map(),
  family: new Map(),
  noedit: new Map(),
  editClean: 0,
  editTotal: 0,
  editProblems: new Map(),
  primaryClean: 0,
  primaryTotal: 0,
  servedSame: 0,
  put: new Map(),
  cmp: new Map(),
  codes: new Map(),
  lossyItems: 0,
  editPut: new Map(),
  failures: 0,
  unexplained: 0,
};
for (const r of records) {
  const o = r.rec.open;
  bump(agg.open, o);
  bump(agg.family, r.rec.family || "?");
  bump(agg.noedit, r.rec.noedit || "n/a");
  if (r.rec.edits) {
    agg.editClean += r.rec.edits.clean;
    agg.editTotal += r.rec.edits.total;
    for (const [k, n] of r.rec.edits.problems) bump(agg.editProblems, k, n);
  }
  if (r.rec.primaryClean !== null && r.rec.primaryClean !== undefined) {
    agg.primaryTotal++;
    if (r.rec.primaryClean) agg.primaryClean++;
  }
  if (r.srv) {
    if (r.srv.servedSame) agg.servedSame++;
    bump(agg.put, r.srv.put || "?");
    bump(agg.cmp, r.srv.cmp || "n/a");
    for (const c of r.srv.codes) bump(agg.codes, c);
    if (r.srv.lossy) agg.lossyItems++;
    bump(agg.editPut, r.srv.editPut);
    if (r.srv.cmp === "UNEXPLAINED") agg.unexplained++;
  }
  if (o.startsWith("failure") || String(r.rec.noedit).startsWith("MISMATCH") || (r.srv && (r.srv.editPut.startsWith("FAIL") || r.srv.put.startsWith("exception")))) agg.failures++;
}
const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(", ") || "(none)";
const secs = Math.round((Date.now() - t0) / 1000);
sizes.sort((a, b) => a - b);

const lines = [];
const out = (s = "") => lines.push(s);
out("# Round-trip report over the local snapshot copy");
out("");
out(`Generated by tests/roundtrip/snapshot-run.mjs. Items are identified by an index and a hash of their path; no value of the data appears here. Run time ${secs} s, ${WORKERS} workers.`);
out("");
out("## Aggregates");
out(`- items: ${agg.total} (${fmt(agg.family)})`);
out(`- model verdict: ${fmt(agg.open)}`);
out(`- no-edit emission: ${fmt(agg.noedit)}`);
out(`- one-owned-field edits clean: ${agg.editClean}/${agg.editTotal}; primary field clean: ${agg.primaryClean}/${agg.primaryTotal}`);
out(`- edit problems by field:code: ${fmt(agg.editProblems)}`);
out(`- served text equals the stored file (LF-normalised): ${agg.servedSame}/${agg.total}`);
out(`- PUT of the item back onto the copy: ${fmt(agg.put)}`);
out(`- GET vs input: ${fmt(agg.cmp)}; items with a lossy allowlist hit: ${agg.lossyItems}`);
out(`- allowlist and unexplained codes: ${fmt(agg.codes)}`);
out(`- edited item PUT -> GET -> open: ${fmt(agg.editPut)}`);
out(`- item size (bytes): median ${sizes[Math.floor(sizes.length / 2)] || 0}, max ${sizes[sizes.length - 1] || 0}`);
if (san) out(`- sanitiser check on a sample: ${JSON.stringify(san)}`);
out("");
out("## Per item");
out("| # | path hash | family | model | no-edit | edits clean | edit problems | PUT | GET vs input | codes | edited PUT |");
out("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of records) {
  const e = r.rec.edits;
  out(`| ${r.idx} | ${r.hash} | ${r.rec.family || "?"} | ${r.rec.open} | ${r.rec.noedit} | ${e ? `${e.clean}/${e.total}` : "-"} | ${e ? [...e.problems.keys()].join(" ") : ""} | ${r.srv ? r.srv.put : "-"} | ${r.srv ? r.srv.cmp : "-"} | ${r.srv ? r.srv.codes.join(" ") : ""} | ${r.srv ? r.srv.editPut : "-"} |`);
}
mkdirSync(path.dirname(REPORT), { recursive: true });
writeFileSync(REPORT, lines.join("\n") + "\n", { mode: 0o600 });
chmodSync(REPORT, 0o600);

console.log("snapshot round-trip summary (aggregates only)");
console.log(`  items: ${agg.total} (${fmt(agg.family)})`);
console.log(`  model verdict: ${fmt(agg.open)}`);
console.log(`  no-edit emission: ${fmt(agg.noedit)}`);
console.log(`  owned-field edits clean: ${agg.editClean}/${agg.editTotal}; primary: ${agg.primaryClean}/${agg.primaryTotal}`);
console.log(`  edit problems: ${fmt(agg.editProblems)}`);
console.log(`  served == stored: ${agg.servedSame}/${agg.total}; PUT back: ${fmt(agg.put)}`);
console.log(`  GET vs input: ${fmt(agg.cmp)}; lossy-hit items: ${agg.lossyItems}`);
console.log(`  codes: ${fmt(agg.codes)}`);
console.log(`  edited PUT -> GET -> open: ${fmt(agg.editPut)}`);
if (san) console.log(`  sanitiser sample: ${JSON.stringify(san)}`);
console.log(`  UNEXPLAINED diffs: ${agg.unexplained}; failures: ${agg.failures}; ${secs} s`);
console.log("  detailed report written outside the repository (mode 600)");
process.exit(agg.unexplained === 0 && agg.failures === 0 ? 0 : 1);
