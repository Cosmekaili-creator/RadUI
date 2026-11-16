// SPDX-License-Identifier: AGPL-3.0-or-later
// UI operations against a throwaway Radicale (tests/roundtrip/run.sh starts one): everything the contact screens
// will do, driven through the same modules (contacts/formmodel.js, contacts/groups.js, model/conflict.js,
// model/importplan.js, store/verify.js), PUT to and read back from a REAL server.
//
//   (1) form no-op: an untouched form gives `{}`, `{changed:false}` and NO request, for the whole contact corpus;
//   (2) every single-field form edit: PUT -> GET -> a semantic diff limited to the edited property, the write
//       verification projection passes on the GET result, the served text re-opens as a stable form;
//   (3) photo (new on 3.0 and 4.0, large payload, removal), custom-label rows, CATEGORIES with commas,
//       anniversary (4.0 written, 3.0 refused), blank-row cards (review M1);
//   (4) group membership for BOTH group forms: only the group card changes, member cards stay byte-identical;
//   (5) a rebase onto a concurrently edited card (three-way merge result PUT -> GET), incl. unmappable rows;
//   (6) `.vcf` import: planImport / resolveImport output PUT -> GET, lossy rows flagged exactly when Radicale
//       damages them, skip / replace / keep-both with MEMBER remapping.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { newRow, toPatch, validate, withPhoto } from "../../src/js/contacts/formmodel.js";
import { addMemberPatch, readGroups, removeMemberPatch } from "../../src/js/contacts/groups.js";
import { summarize } from "../../src/js/contacts/index.js";
import { diffOwned, rebasePatch } from "../../src/js/model/conflict.js";
import { planImport, resolveImport } from "../../src/js/model/importplan.js";
import { openItem } from "../../src/js/model/item.js";
import { isGroupCard } from "../../src/js/model/vcard.js";
import { verifyContact } from "../../src/js/store/verify.js";
import { compareServer, flatDiff, hasLossy } from "./compare.mjs";
import { FIXTURES, NOW, SKIP, loadFixtures } from "./lib.mjs";
import { cloneValues, countingEnv, formEdits, itemOf, formSave, model, newCollection, openForm, putServed, runFormEdit } from "./uilib.mjs";

const env = SKIP ? null : countingEnv();
const it = (name, opts, fn) => (typeof opts === "function" ? test(name, { skip: SKIP }, opts) : test(name, { skip: SKIP, ...opts }, fn));

const IMPORT_FILE = readFileSync(path.join(FIXTURES, "vcf/import/book-basic.vcf"), "utf8");

/** Contact fixtures the corpus tests use: they open editable and are not group cards. */
const corpus = loadFixtures().filter((f) => f.name.startsWith("vcf/") && !f.meta.expect);
const probes = corpus.map((f) => ({ f, item: openItem(f.text, "contact") })).filter((x) => x.item.ok && !x.item.readOnly);
const cards = probes.filter((x) => !isGroupCard(x.item));
const groupCards = probes.filter((x) => isGroupCard(x.item));

const uidOf = (n) => `7b1d2e00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uri = (n) => `urn:uuid:${uidOf(n)}`;
const card = (n, fn, extra = "", version = "3.0") =>
  `BEGIN:VCARD\r\nVERSION:${version}\r\nPRODID:-//Example Contacts//Contacts 1.0//EN\r\nUID:${uri(n)}\r\nFN:${fn}\r\nN:${fn.split(" ")[1]};${fn.split(" ")[0]};;;\r\n${extra}END:VCARD\r\n`;
const appleGroup = (n, name, members) => `BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Example Contacts//Contacts 1.0//EN\r\nUID:${uri(n)}\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nFN:${name}\r\nN:${name};;;;\r\n${members.map((m) => `X-ADDRESSBOOKSERVER-MEMBER:${m}\r\n`).join("")}END:VCARD\r\n`;
const rfcGroup = (n, name, members) => `BEGIN:VCARD\r\nVERSION:4.0\r\nPRODID:-//Example Contacts//Contacts 1.0//EN\r\nUID:${uri(n)}\r\nKIND:group\r\nFN:${name}\r\n${members.map((m) => `MEMBER:${m}\r\n`).join("")}END:VCARD\r\n`;

/** Every card of a book as the server holds it: [{href, etag, text}] sorted by href. */
async function entriesOf(col) {
  const list = await env.client.listItemEtags(col);
  if (!list.length) return [];
  const { items } = await env.client.addressbookMultiget(col, list.map((x) => x.href));
  return items.map((i) => ({ href: i.href, etag: i.etag, text: i.text })).sort((a, b) => (a.href < b.href ? -1 : 1));
}
const lines = (text) => text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter(Boolean);
const membersOf = (text) => lines(text).filter((l) => /^(?:X-ADDRESSBOOKSERVER-)?MEMBER[:;]/i.test(l)).map((l) => l.slice(l.indexOf(":") + 1)).sort();

// ---------------------------------------------------------------------------
// (1) the form no-op over the whole corpus

for (const { f } of cards) {
  it(`form no-op sends nothing: ${f.name}`, async () => {
    const col = await newCollection(env, "contact", "n");
    const { href, served } = await putServed(env, col, f.text);
    const form = openForm(served.text);
    assert.ok(form, "the served text opens as an editable card");
    // as the server serves it, and as typed into textareas (CR LF -> LF) and single-line inputs (trimmed)
    const mark = env.mark();
    const r = await formSave(env, href, served, form.fields, form.values);
    assert.equal(r.changed, false);
    assert.deepEqual(r.patch, {});
    assert.deepEqual(env.since(mark, "PUT"), [], "no PUT");
    const typed = cloneValues(form.values);
    for (const k of ["note"]) typed[k] = String(typed[k]).replace(/\r\n?/g, "\n");
    for (const row of typed.adr) for (const p of Object.keys(row.value)) row.value[p] = String(row.value[p]).replace(/\r\n?/g, "\n");
    assert.deepEqual(toPatch(form.fields, typed), {}, "textarea-normalised values change nothing");
    // an unrelated edit leaves every blank, odd or foreign row where it was (review M1)
    const back = await runFormEdit(env, href, served, { field: "title", props: ["TITLE"], apply: (v) => void (v.title = "Edited title") });
    assert.deepEqual(back.problems, []);
    for (const name of ["ADR", "TEL", "EMAIL", "URL", "X-ABLABEL"]) {
      const count = (t) => lines(t).filter((l) => new RegExp(`^(?:[A-Za-z0-9-]+\\.)?${name}[;:]`, "i").test(l)).length;
      assert.equal(count(back.back.text), count(served.text), `${name} rows kept by an unrelated edit`);
    }
  });
}

// ---------------------------------------------------------------------------
// (2) every single-field form edit

const skipped = [];
for (const { f, item } of cards) {
  const edits = formEdits(item.fields());
  it(`one form edit at a time through PUT -> GET: ${f.name}`, async (t) => {
    const col = await newCollection(env, "contact", "e");
    const { href, served: first } = await putServed(env, col, f.text);
    const failures = [];
    let ran = 0;
    for (const edit of edits) {
      // restore the card: every edit starts from the same served text
      const cur = await env.client.getItem(href);
      if (cur.text !== first.text) await env.client.putItem(href, first.text, { etag: cur.etag });
      const served = await env.client.getItem(href);
      const r = await runFormEdit(env, href, served, edit);
      if (r.skipped) {
        skipped.push(`${f.name}:${edit.field}:${r.skipped}`);
        continue;
      }
      ran++;
      if (r.problems.length) failures.push(`${edit.field}: ${r.problems.join("; ")}`);
    }
    assert.ok(ran > 0, "at least one edit ran");
    assert.deepEqual(failures, []);
    t.diagnostic(`${ran} edits ran`);
  });
}

it("summary of edits skipped on purpose", (t) => {
  t.diagnostic(`${skipped.length} skipped: ${skipped.filter((s) => /guard/.test(s)).join(" | ") || "none refused by the guard"}`);
});

// ---------------------------------------------------------------------------
// (3) photos, labels, categories, anniversaries, blank rows

const bigB64 = (bytes) => Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 7 + 3) % 256)).toString("base64");
const photoLine = (text) => text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n").find((l) => /^PHOTO[;:]/.test(l));

for (const version of ["3.0", "4.0"]) {
  for (const size of [3000, 150000]) {
    it(`a new photo through the form keeps its payload (vCard ${version}, ${size} bytes)`, async () => {
      const col = await newCollection(env, "contact", "p");
      const { href, served } = await putServed(env, col, card(1, "Pia Photo", "", version));
      const form = openForm(served.text);
      const b64 = bigB64(size);
      const values = withPhoto(form.values, { mime: "image/jpeg", base64: b64 });
      const r = await formSave(env, href, served, form.fields, values);
      assert.equal(r.changed, true);
      assert.deepEqual(Object.keys(r.patch), ["photo"]);
      const back = await env.client.getItem(href);
      const line = photoLine(back.text);
      assert.ok(line.startsWith(version === "4.0" ? "PHOTO;ENCODING=b;MEDIATYPE=image/jpeg:" : "PHOTO;ENCODING=b;TYPE=JPEG:"), line.slice(0, 60));
      assert.equal(line.slice(line.indexOf(":") + 1), b64, "identical base64, nothing lost");
      assert.equal(verifyContact(model, { sentText: r.out.text, gotText: back.text, keys: ["photo"] }).ok, true);
      assert.deepEqual(flatDiff(served.text, back.text, { ignoreManaged: true }).onlyA.map((e) => e.name), [], "nothing but the photo was added");
      // the photo survives an unrelated edit made from the served text, and a no-op afterwards
      const again = await runFormEdit(env, href, back, { field: "title", props: ["TITLE"], apply: (v) => void (v.title = "With photo") });
      assert.deepEqual(again.problems, []);
      assert.equal(photoLine(again.back.text).slice(photoLine(again.back.text).indexOf(":") + 1), b64);
      // removal
      const form2 = openForm(again.back.text);
      const removed = await formSave(env, href, again.back, form2.fields, withPhoto(form2.values, null));
      assert.equal(removed.changed, true);
      const gone = await env.client.getItem(href);
      assert.equal(photoLine(gone.text), undefined, "no PHOTO line left");
      assert.equal(openItem(gone.text, "contact").fields().photo.present, false);
    });
  }
}

for (const version of ["3.0", "4.0"]) {
  it(`custom-label rows survive PUT -> GET and later edits (vCard ${version})`, async () => {
    const col = await newCollection(env, "contact", "l");
    const { href, served } = await putServed(env, col, card(2, "Lia Labels", "TEL;TYPE=CELL:+1 555 0120\r\n", version));
    const form = openForm(served.text);
    const rows = [
      ["tel", "+1 555 0121", "Beach house, north"],
      ["tel", "+1 555 0122", "Mum & Dad"],
      ["email", "lia.second@example.org", "Club"],
      ["url", "https://example.org/lia", "Blog"],
    ];
    for (const [kind, value, label] of rows) {
      const r = newRow(kind, { typeSel: "custom" });
      r.value = value;
      r.label = label;
      form.values[kind].push(r);
    }
    assert.equal(validate(form.fields, form.values, { now: NOW }).ok, true);
    const r = await formSave(env, href, served, form.fields, form.values);
    assert.equal(r.changed, true);
    const back = await env.client.getItem(href);
    assert.equal(compareServer(r.out.text, back.text).unexplained.length, 0);
    assert.equal(hasLossy(compareServer(r.out.text, back.text).explained), false);
    const shown = openForm(back.text);
    for (const [kind, value, label] of rows) {
      const hit = shown.values[kind].find((x) => (kind === "tel" ? x.value.replace(/\s/g, "") === value.replace(/\s/g, "") : x.value === value));
      assert.ok(hit, `${kind} ${value} is shown`);
      assert.equal(hit.typeSel, "custom");
      assert.equal(hit.label, label, "the label text is what was typed");
    }
    // the server upper-cases X-ABLabel: a later unrelated edit and a no-op still leave every label alone
    assert.ok(lines(back.text).some((l) => /^item\d+\.X-ABLABEL:/i.test(l)));
    const unrelated = await runFormEdit(env, href, back, { field: "note", props: ["NOTE"], apply: (v) => void (v.note = "Later edit") });
    assert.deepEqual(unrelated.problems, []);
    assert.deepEqual(flatDiff(back.text, unrelated.back.text, { ignoreManaged: true }).onlyA.map((e) => e.name), ["NOTE"].filter(() => /^NOTE/m.test(back.text)));
    // editing one label changes that label only
    const f3 = openForm(unrelated.back.text);
    const target = f3.values.tel.find((x) => x.label === "Mum & Dad");
    target.label = "Parents";
    const edited = await formSave(env, href, unrelated.back, f3.fields, f3.values);
    assert.equal(edited.changed, true);
    const after = await env.client.getItem(href);
    const d = flatDiff(unrelated.back.text, after.text, { ignoreManaged: true });
    assert.deepEqual([...new Set([...d.onlyA, ...d.onlyB].map((e) => e.name))], ["X-ABLABEL"]);
  });
}

it("CATEGORIES with commas and semicolons survive as chips", async () => {
  const col = await newCollection(env, "contact", "c");
  const { href, served } = await putServed(env, col, card(3, "Cleo Chips", "CATEGORIES:Friends,Work\r\n"));
  const form = openForm(served.text);
  assert.deepEqual(form.values.categories, ["Friends", "Work"]);
  form.values.categories = [...form.values.categories, "Smith, John & Sons", "a;b", "back\\slash"];
  const r = await formSave(env, href, served, form.fields, form.values);
  assert.equal(r.changed, true);
  const back = await env.client.getItem(href);
  assert.deepEqual(openItem(back.text, "contact").fields().categories, ["Friends", "Work", "Smith, John & Sons", "a;b", "back\\slash"]);
  assert.equal(verifyContact(model, { sentText: r.out.text, gotText: back.text, keys: ["categories"] }).ok, true);
  // removing the chip with the comma leaves the others and a no-op afterwards
  const f2 = openForm(back.text);
  f2.values.categories = f2.values.categories.filter((c) => c !== "Smith, John & Sons");
  const r2 = await formSave(env, href, back, f2.fields, f2.values);
  const back2 = await env.client.getItem(href);
  assert.deepEqual(openItem(back2.text, "contact").fields().categories, ["Friends", "Work", "a;b", "back\\slash"]);
  assert.equal(r2.changed, true);
  const f3 = openForm(back2.text);
  assert.deepEqual(toPatch(f3.fields, f3.values), {});
});

it("anniversary: written on a 4.0 card, refused on a 3.0 card", async () => {
  const col = await newCollection(env, "contact", "a");
  const four = await putServed(env, col, card(4, "Ann Four", "", "4.0"), "four");
  const f4 = openForm(four.served.text);
  assert.equal(f4.values.anniversary.writable, true);
  f4.values.anniversary = { ...f4.values.anniversary, date: { year: 2001, month: 6, day: 9 }, replace: true };
  assert.equal(validate(f4.fields, f4.values, { now: NOW }).ok, true);
  const r4 = await formSave(env, four.href, four.served, f4.fields, f4.values);
  assert.equal(r4.changed, true);
  const back4 = await env.client.getItem(four.href);
  assert.ok(lines(back4.text).includes("ANNIVERSARY:20010609"), "ANNIVERSARY written on 4.0");
  assert.deepEqual(openItem(back4.text, "contact").fields().anniversary && openItem(back4.text, "contact").fields().anniversary.month, 6);

  const three = await putServed(env, col, card(5, "Ann Three", "item1.X-ABDATE;type=pref:2001-06-09\r\nitem1.X-ABLabel:_$!<Anniversary>!$_\r\n"), "three");
  const f3 = openForm(three.served.text);
  assert.equal(f3.values.anniversary.writable, false, "disabled on 3.0");
  assert.equal(f3.values.anniversary.reason, "anniversary-needs-vcard-4");
  assert.ok(f3.values.anniversary.others.length >= 1, "the existing X-ABDATE is shown read-only");
  const typed = cloneValues(f3.values);
  typed.anniversary = { ...typed.anniversary, date: { year: 2005, month: 1, day: 2 }, replace: true };
  const v = validate(f3.fields, typed, { now: NOW });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.key === "contact.err.anniversaryVersion"));
  assert.equal("anniversary" in toPatch(f3.fields, typed), false, "no ANNIVERSARY line is ever written on 3.0");
  const mark = env.mark();
  const r3 = await formSave(env, three.href, three.served, f3.fields, typed);
  assert.equal(r3.changed, false);
  assert.deepEqual(env.since(mark, "PUT"), []);
  assert.equal((await env.client.getItem(three.href)).text, three.served.text);
});

it("a card with blank rows: an untouched form removes nothing, an unrelated edit keeps them (review M1)", async () => {
  const text = readFileSync(path.join(FIXTURES, "vcf/vcard30-empty-rows.vcf"), "utf8");
  const col = await newCollection(env, "contact", "b");
  const { href, served } = await putServed(env, col, text);
  const before = lines(served.text);
  const adrBefore = before.filter((l) => /^ADR/i.test(l));
  const telBefore = before.filter((l) => /^(?:item\d+\.)?TEL/i.test(l));
  assert.ok(adrBefore.length >= 1 && telBefore.length >= 1);
  const form = openForm(served.text);
  const mark = env.mark();
  const r = await formSave(env, href, served, form.fields, form.values);
  assert.equal(r.changed, false);
  assert.deepEqual(env.since(mark, "PUT"), []);
  for (const field of ["title", "note", "org"]) {
    const cur = await env.client.getItem(href);
    const res = await runFormEdit(env, href, cur, { field, props: [field.toUpperCase()], apply: (v) => void (v[field] = `Edited ${field}`) });
    assert.deepEqual(res.problems, [], field);
    const after = lines(res.back.text);
    assert.deepEqual(after.filter((l) => /^ADR/i.test(l)), adrBefore, `ADR rows kept after a ${field} edit`);
    assert.deepEqual(after.filter((l) => /^(?:item\d+\.)?TEL/i.test(l)), telBefore, `TEL rows kept after a ${field} edit`);
    assert.deepEqual(after.filter((l) => /X-ABLABEL/i.test(l)), before.filter((l) => /X-ABLABEL/i.test(l)));
  }
  // a row that WAS filled and is cleared IS removed (and only that row)
  const cur = await env.client.getItem(href);
  const f2 = openForm(cur.text);
  const filled = f2.values.adr.find((x) => Object.values(x.value).some((p) => p));
  for (const p of Object.keys(filled.value)) filled.value[p] = "";
  const cleared = await formSave(env, href, cur, f2.fields, f2.values);
  assert.equal(cleared.changed, true);
  const after = await env.client.getItem(href);
  assert.equal(lines(after.text).filter((l) => /^ADR/i.test(l)).length, adrBefore.length - 1);
});

// ---------------------------------------------------------------------------
// (4) groups, both forms

for (const [label, make] of [["Apple (X-ADDRESSBOOKSERVER-KIND)", appleGroup], ["RFC 6350 (KIND:group)", rfcGroup]]) {
  it(`group membership add and remove: only the group card changes, member cards stay byte-identical: ${label}`, async () => {
    const col = await newCollection(env, "contact", "g");
    const unknown = "mailto:agent-1@example.org";
    await putServed(env, col, card(11, "Mia Member"), "m1");
    await putServed(env, col, card(12, "Ned Newcomer", "", "4.0"), "m2");
    await putServed(env, col, card(13, "Oda Other"), "m3");
    const g = await putServed(env, col, make(20, "Chess club", [uri(11), unknown]), "group");
    const before = await entriesOf(col);
    const summaries = () => entriesOf(col).then((es) => es.filter((e) => !/KIND:group/i.test(e.text)).map((e) => summarize(e.text, { href: e.href, etag: e.etag })));
    const groupOf = async () => {
      const es = await entriesOf(col);
      return readGroups(es.filter((e) => /KIND:group/i.test(e.text)), await summaries())[0];
    };
    const memberBytes = async () => (await entriesOf(col)).filter((e) => !/KIND:group/i.test(e.text)).map((e) => `${e.href}|${e.etag}|${e.text}`);
    const membersBefore = await memberBytes();

    // add Ned
    let group = await groupOf();
    assert.equal(group.memberCount, 2);
    const ned = (await summaries()).find((s) => s.uid === uri(12) || s.uid === uidOf(12));
    const add = addMemberPatch(group, ned);
    assert.equal(add.ok, true);
    let item = openItem((await env.client.getItem(g.href)).text, "contact");
    const e0 = (await env.client.getItem(g.href)).etag;
    item.update(add.patch, { strict: true });
    let out = item.save({ now: NOW });
    assert.equal(out.changed, true);
    await env.client.putItem(g.href, out.text, { etag: e0 });
    let back = await env.client.getItem(g.href);
    assert.deepEqual(membersOf(back.text), [unknown, uri(11), uri(12)].sort());
    const d = flatDiff(g.served.text, back.text, { ignoreManaged: true });
    assert.deepEqual([...new Set([...d.onlyA, ...d.onlyB].map((e) => e.name))], [label.startsWith("Apple") ? "X-ADDRESSBOOKSERVER-MEMBER" : "MEMBER"]);
    assert.equal(d.onlyA.length, 0, "no member line was removed");
    assert.equal(verifyContact(model, { sentText: out.text, gotText: back.text, keys: ["members"] }).ok, true);
    assert.deepEqual(await memberBytes(), membersBefore, "member cards: same bytes and same ETags");
    // adding him again is a no-op
    group = await groupOf();
    assert.equal(addMemberPatch(group, ned).noop, true);

    // remove Mia and the unknown member: only those lines go
    group = await groupOf();
    const miaUid = (await summaries()).find((s) => s.name === "Mia Member").uid;
    const mia = group.members.find((m) => m.kind === "contact" && m.uid === miaUid);
    const rm = removeMemberPatch(group, mia);
    item = openItem(back.text, "contact");
    item.update(rm.patch, { strict: true });
    out = item.save({ now: NOW });
    await env.client.putItem(g.href, out.text, { etag: back.etag });
    const rmUnknown = removeMemberPatch(await groupOf(), group.members.find((m) => m.kind === "unknown"));
    back = await env.client.getItem(g.href);
    item = openItem(back.text, "contact");
    item.update(rmUnknown.patch, { strict: true });
    out = item.save({ now: NOW });
    await env.client.putItem(g.href, out.text, { etag: back.etag });
    back = await env.client.getItem(g.href);
    assert.deepEqual(membersOf(back.text), [uri(12)]);
    assert.deepEqual(await memberBytes(), membersBefore, "member cards untouched after the removals too");
    assert.equal(before.length, (await entriesOf(col)).length, "no card appeared or vanished");
  });
}

// ---------------------------------------------------------------------------
// (5) rebase onto a concurrently edited card

/** Save `patch` (built by the form on `base`) once, the way the write path does: {conflict, theirs} on a 412. */
async function tryPut(href, base, fields, values) {
  const patch = toPatch(fields, values);
  const item = itemOf(fields);
  item.update(patch, { strict: true });
  const out = item.save({ now: NOW });
  try {
    await env.client.putItem(href, out.text, { etag: base.etag });
    return { saved: true, patch };
  } catch (e) {
    assert.equal(e.kind, "precondition", "a stale ETag is a 412");
    return { saved: false, patch, theirs: await env.client.getItem(href) };
  }
}

const THREE_ROWS = "TEL;TYPE=CELL:+1 555 0131\r\nTEL;TYPE=WORK:+1 555 0132\r\nEMAIL;TYPE=INTERNET:rae@example.org\r\nNOTE:Original note\r\n";

it("a rebase onto a concurrently edited card: my phone edit lands on their version, theirs stays (PUT -> GET)", async () => {
  const col = await newCollection(env, "contact", "r");
  const { href, served: base } = await putServed(env, col, card(31, "Rae Rebase", THREE_ROWS));
  // I open the form and change the work number
  const mine = openForm(base.text);
  mine.values.tel.find((r) => r.value === "+1 555 0132").value = "+1 555 0139";
  // another client edits the note and adds an e-mail in the meantime
  const other = openItem(base.text, "contact");
  other.update({ note: "Their note", email: [...other.fields().email, { value: "rae.second@example.org", types: ["work"] }] });
  await env.client.putItem(href, other.save({ now: NOW }).text, { etag: base.etag });
  const r = await tryPut(href, base, mine.fields, mine.values);
  assert.equal(r.saved, false, "stale base: 412");
  const theirsItem = openItem(r.theirs.text, "contact");
  const rows = diffOwned(mine.fields, openItem(base.text, "contact").fields(), theirsItem.fields());
  assert.ok(Array.isArray(rows));
  const rb = rebasePatch(mine.fields, r.patch, theirsItem.fields());
  assert.deepEqual(rb.unmappable, []);
  assert.equal(rb.noop, false);
  theirsItem.update(rb.patch, { strict: true });
  const merged = theirsItem.save({ now: NOW });
  await env.client.putItem(href, merged.text, { etag: r.theirs.etag });
  const back = await env.client.getItem(href);
  const f = openItem(back.text, "contact").fields();
  assert.deepEqual(f.tel.map((e) => e.value).sort(), ["+1 555 0131", "+1 555 0139"], "my phone edit, their other phone untouched");
  assert.equal(f.note, "Their note", "their note survived");
  assert.deepEqual(f.email.map((e) => e.value).sort(), ["rae.second@example.org", "rae@example.org"], "their new e-mail survived");
  const d = flatDiff(r.theirs.text, back.text, { ignoreManaged: true });
  assert.deepEqual([...new Set([...d.onlyA, ...d.onlyB].map((e) => e.name))], ["TEL"], "the merge touched the phone row only");
  assert.equal(verifyContact(model, { sentText: merged.text, gotText: back.text, keys: ["tel"] }).ok, true);
});

it("a rebase where they deleted the row I edited: the operation is listed as unmappable, nothing is guessed", async () => {
  const col = await newCollection(env, "contact", "r");
  const { href, served: base } = await putServed(env, col, card(32, "Rob Rebase", THREE_ROWS));
  const mine = openForm(base.text);
  mine.values.tel.find((r) => r.value === "+1 555 0132").value = "+1 555 0149";
  mine.values.note = "My note";
  const other = openItem(base.text, "contact");
  other.update({ tel: other.fields().tel.filter((e) => e.value !== "+1 555 0132") });
  await env.client.putItem(href, other.save({ now: NOW }).text, { etag: base.etag });
  const r = await tryPut(href, base, mine.fields, mine.values);
  assert.equal(r.saved, false);
  const theirsItem = openItem(r.theirs.text, "contact");
  const rb = rebasePatch(mine.fields, r.patch, theirsItem.fields());
  assert.equal(rb.unmappable.length, 1);
  assert.equal(rb.unmappable[0].field, "tel");
  assert.equal(rb.unmappable[0].op, "modify");
  assert.equal("tel" in rb.patch, false, "the phone edit is NOT applied to another row");
  theirsItem.update(rb.patch, { strict: true });
  await env.client.putItem(href, theirsItem.save({ now: NOW }).text, { etag: r.theirs.etag });
  const f = openItem((await env.client.getItem(href)).text, "contact").fields();
  assert.deepEqual(f.tel.map((e) => e.value), ["+1 555 0131"], "their deletion stands, no row was resurrected or overwritten");
  assert.equal(f.note, "My note", "the mappable part of my change landed");
});

it("a membership change rebases as ONE delta on their member list", async () => {
  const col = await newCollection(env, "contact", "r");
  const { href, served: base } = await putServed(env, col, appleGroup(40, "Rebase club", [uri(1), uri(2)]), "group");
  // they add 3, I (on the stale copy) add 4: both must remain
  const theirs = openItem(base.text, "contact");
  theirs.update({ membersDelta: { add: [uri(3)] } });
  await env.client.putItem(href, theirs.save({ now: NOW }).text, { etag: base.etag });
  const mine = openItem(base.text, "contact");
  mine.update({ membersDelta: { add: [uri(4)] } });
  await assert.rejects(env.client.putItem(href, mine.save({ now: NOW }).text, { etag: base.etag }), (e) => e.kind === "precondition");
  const now = await env.client.getItem(href);
  const again = openItem(now.text, "contact");
  again.update({ membersDelta: { add: [uri(4)] } });
  await env.client.putItem(href, again.save({ now: NOW }).text, { etag: now.etag });
  assert.deepEqual(membersOf((await env.client.getItem(href)).text), [uri(1), uri(2), uri(3), uri(4)].sort());
});

// ---------------------------------------------------------------------------
// (6) .vcf import

/** PUT every operation of a resolved plan; returns {href: served} read back with ONE multiget. */
async function runOps(col, ops) {
  for (const o of ops) await env.client.putItem(o.href, o.text, o.op === "create" ? { create: true } : { etag: o.etag });
  if (!ops.length) return new Map();
  const { items } = await env.client.addressbookMultiget(col, ops.map((o) => o.href));
  return new Map(items.map((i) => [i.href, i]));
}
const known = (es) => es.map((e) => ({ href: e.href, etag: e.etag, uid: (/^UID[:;][^\n]*$/im.exec(lines(e.text).join("\n")) || [""])[0].replace(/^UID[^:]*:/i, "").trim() }));

it("import plan: states, lossy rows (flagged at plan time) and the PUT -> GET comparison", async () => {
  const col = await newCollection(env, "contact", "i");
  const plan = planImport(IMPORT_FILE, [], { collectionHref: col });
  assert.equal(plan.fatal, null);
  assert.deepEqual(plan.counts, { new: 10, duplicate: 0, invalid: 2, unsupported: 1, "file-duplicate": 1 });
  assert.deepEqual(
    plan.lossy.map((l) => [l.fn, l.properties.slice().sort()]),
    [["Fay Lossynote", ["NOTE", "TITLE"]], ["Gus Xprop", ["X-CUSTOM-FIELD"]], ["Hana Photo", ["PHOTO"]], ["Ivo Nick", ["NICKNAME"]]],
  );
  const noUid = plan.rows.find((r) => r.fn === "Jo Nouid");
  assert.ok(noUid.generatedUid, "a card without UID gets a generated UID");
  const res = resolveImport(plan, "skip", { collectionHref: col });
  assert.equal(res.operations.length, 10);
  const served = await runOps(col, res.operations);
  for (const o of res.operations) {
    const got = served.get(o.href);
    assert.ok(got, `${o.href} stored`);
    const cmp = compareServer(o.text, got.text);
    assert.deepEqual(cmp.unexplained, [], `${o.uid}: differences outside the allowlist`);
    // flagged at plan time exactly when Radicale damages the card
    assert.equal(hasLossy(cmp.explained), Boolean(o.lossy), `${o.uid}: lossy flag ${JSON.stringify(o.lossy)} vs server ${JSON.stringify(cmp.explained.map((e) => e.code))}`);
    // the model opens what the server holds, and the verification projection agrees for non-lossy cards
    const opened = openItem(got.text, "contact");
    assert.equal(opened.ok && !opened.readOnly, true);
    if (!o.lossy) assert.equal(verifyContact(model, { sentText: o.text, gotText: got.text }).ok, true, o.uid);
  }
  // the generated UID is the one on the server
  const created = res.operations.find((o) => o.uid === noUid.generatedUid);
  assert.ok(created);
  assert.ok(lines(served.get(created.href).text).includes(`UID:${noUid.generatedUid}`));
  // group cards arrive with their MEMBER lines as written, unknown members included
  const groups = [...served.values()].filter((s) => /KIND:group/i.test(s.text));
  assert.equal(groups.length, 2);
  assert.deepEqual(membersOf(groups.find((g) => /X-ADDRESSBOOKSERVER-KIND/i.test(g.text)).text), [uri2(1), uri2(2), "urn:uuid:7a0c1e00-0000-4000-8000-0000000000ff"].sort());
});
const uri2 = (n) => `urn:uuid:7a0c1e00-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("import policies against the server: skip (idempotent), replace (If-Match, lossy rows held back), keep-both (MEMBER remapping)", async () => {
  const col = await newCollection(env, "contact", "i");
  const first = resolveImport(planImport(IMPORT_FILE, [], { collectionHref: col }), "skip", { collectionHref: col });
  await runOps(col, first.operations);
  let es = await entriesOf(col);
  assert.equal(es.length, 10);
  const serverBefore = new Map(es.map((e) => [e.href, e]));

  // skip: a second import of the same file changes nothing
  let plan = planImport(IMPORT_FILE, known(es), { collectionHref: col });
  assert.equal(plan.counts.duplicate, 9, "every card with a UID is now a duplicate (the UID-less one gets a new UID)");
  let res = resolveImport(plan, "skip", { collectionHref: col });
  assert.equal(res.operations.filter((o) => o.op === "replace").length, 0);
  assert.equal(res.skipped.filter((s) => s.reason === "kept-existing").length, 9);

  // replace: If-Match with the existing ETag; the cards Radicale would damage are held back
  res = resolveImport(plan, "replace", { collectionHref: col });
  const replaced = res.operations.filter((o) => o.op === "replace");
  assert.equal(replaced.length, 5, "9 duplicates minus the 4 lossy ones");
  assert.equal(res.counts.lossySkipped, 4);
  assert.deepEqual(res.skipped.filter((s) => s.reason === "lossy-needs-confirmation").map((s) => s.properties.slice().sort()).sort(), [["NICKNAME"], ["NOTE", "TITLE"], ["PHOTO"], ["X-CUSTOM-FIELD"]]);
  // a card edited on the server after the plan was made: the replace is refused (412), nothing is overwritten
  const stale = replaced[0];
  const outside = openItem((await env.client.getItem(stale.href)).text, "contact");
  outside.update({ note: "Edited elsewhere" });
  await env.client.putItem(stale.href, outside.save({ now: NOW }).text, { etag: stale.etag });
  await assert.rejects(env.client.putItem(stale.href, stale.text, { etag: stale.etag }), (e) => e.kind === "precondition");
  const servedReplace = await runOps(col, replaced.slice(1));
  for (const o of replaced.slice(1)) assert.deepEqual(compareServer(o.text, servedReplace.get(o.href).text).unexplained, [], o.uid);
  // the lossy cards on the server are untouched
  es = await entriesOf(col);
  for (const e of es) {
    const was = serverBefore.get(e.href);
    if (/Lossynote|Xprop|Hana Photo|Ivo Nick/.test(e.text)) assert.equal(e.text, was.text, "a held-back card stays as it was");
  }

  // keep-both: new UIDs and new names, MEMBER lines of the imported groups point at the NEW contacts
  plan = planImport(IMPORT_FILE, known(es), { collectionHref: col });
  res = resolveImport(plan, "keep-both", { collectionHref: col });
  const created = res.operations.filter((o) => o.op === "create");
  assert.equal(created.length, 10, "9 duplicates re-keyed plus the UID-less card");
  const newUids = new Map(created.map((o) => [o.uid, o]));
  const servedBoth = await runOps(col, created);
  const gApple = [...servedBoth.values()].find((s) => /X-ADDRESSBOOKSERVER-KIND/i.test(s.text));
  const gRfc = [...servedBoth.values()].find((s) => /^KIND:group/im.test(lines(s.text).join("\n")));
  const oldUids = new Set([1, 2, 3, 4, 5, 6, 8].map(uri2));
  for (const g of [gApple, gRfc]) {
    for (const m of membersOf(g.text)) {
      if (m.endsWith("0000000000ff")) continue; // a member that is not in the file stays as written
      assert.equal(oldUids.has(m), false, `${m} was re-keyed`);
      assert.ok(newUids.has(m.replace(/^urn:uuid:/, "urn:uuid:")) || [...newUids.keys()].some((u) => u.toLowerCase() === m.toLowerCase()), `${m} is the UID of a card created by this import`);
    }
  }
  assert.equal((await entriesOf(col)).length, 20);
  // the first import's group still lists the ORIGINAL contacts
  const original = es.find((e) => /X-ADDRESSBOOKSERVER-KIND/i.test(e.text));
  assert.deepEqual(membersOf(original.text), membersOf(serverBefore.get(original.href).text));
});

it("a replace of a lossy card goes ahead only with an explicit confirmation, and the server then damages it as flagged", async () => {
  const col = await newCollection(env, "contact", "i");
  const first = resolveImport(planImport(IMPORT_FILE, [], { collectionHref: col }), "skip", { collectionHref: col });
  await runOps(col, first.operations);
  const es = await entriesOf(col);
  const plan = planImport(IMPORT_FILE, known(es), { collectionHref: col });
  const lossy = plan.rows.find((r) => r.fn === "Fay Lossynote");
  const res = resolveImport(plan, "replace", { collectionHref: col, confirmLossy: [lossy.uid] });
  const op = res.operations.find((o) => o.uid === lossy.uid);
  assert.ok(op && op.lossy.includes("NOTE"), "confirmed: the replace is part of the run, still flagged");
  const served = await runOps(col, [op]);
  const cmp = compareServer(op.text, served.get(op.href).text);
  assert.deepEqual(cmp.unexplained, []);
  assert.equal(hasLossy(cmp.explained), true, "Radicale cut the unescaped comma, as the flag said");
});
