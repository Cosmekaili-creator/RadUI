// SPDX-License-Identifier: AGPL-3.0-or-later
// vCard: owned fields, Apple groups, PHOTO (decision D6), contact groups.
import test from "node:test";
import assert from "node:assert/strict";
import { createGroupItem, createItem, openItem } from "../../../src/js/model/item.js";
import { moveEntry, siblingsOf } from "../../../src/js/model/vcard.js";
import { checkFidelity } from "../../../src/js/model/fidelity.js";
import { semdiff, changedNames } from "../../lib/semdiff.js";
import { BS, D, fixture, logical, octets, physical } from "./helpers.mjs";

const NOW = D("2026-11-12T10:00:00Z");
const open = (name) => openItem(fixture(name), "contact");
const save = (item) => item.save({ now: NOW }).text;

test("read: names, entries with types, labels and groups", () => {
  const f = open("vcard30-groups.vcf").fields();
  assert.equal(f.version, "3.0");
  assert.equal(f.fn, "Bob Sample");
  assert.deepEqual(f.n, { family: "Sample", given: "Bob", additional: "", prefix: "", suffix: "" });
  assert.equal(f.tel.length, 2);
  assert.deepEqual({ value: f.tel[0].value, types: f.tel[0].types, pref: f.tel[0].pref, label: f.tel[0].label }, { value: "+1 555 0101", types: ["voice"], pref: true, label: "main line" });
  assert.deepEqual(f.tel[1].types, ["home", "voice"]);
  assert.equal(f.tel[1].label, null);
  assert.equal(f.url[0].label, "_$!<HomePage>!$_");
  assert.equal(f.email[0].label, "team");
});

test("read: multi-valued, repeated and quoted TYPE parameters", () => {
  const f = open("vcard30-types.vcf").fields();
  assert.deepEqual(f.tel.map((t) => t.types), [["home", "voice"], ["work", "voice"], ["cell", "msg"]]);
  assert.equal(f.tel[1].pref, true);
  assert.deepEqual(f.adr[0].types, ["home", "postal"]);
  assert.equal(f.adr[0].value.street, "2 Example Road");
  assert.equal(f.email[0].value, "dave@example.org");
});

test("read: escapes in N, ORG, ADR and NOTE", () => {
  const f = open("vcard30-escapes.vcf").fields();
  assert.equal(f.fn, "Escapes, Test");
  assert.equal(f.n.family, "Escapes, Test");
  assert.equal(f.n.given, "Anna;Maria");
  assert.deepEqual(f.org, { name: "Foo; Bar, Inc.", units: ["Unit"] });
  assert.equal(f.adr[0].value.street, "10 Example Lane, Suite 4");
  assert.equal(f.note, `Backslash ${BS} and newline\nend`);
});

test("edit an Apple group entry: name case, group, parameter form and sibling stay", () => {
  const src = fixture("vcard30-groups.vcf");
  const item = openItem(src, "contact");
  const e = item.fields().tel;
  item.update({ tel: [{ ...e[0], value: "+1 555 0199" }, e[1]] });
  const out = save(item);
  assert.ok(out.includes("\r\nitem1.TEL;type=pref;type=VOICE:+1 555 0199\r\nitem1.X-ABLabel:main line\r\n"), out);
  assert.deepEqual(changedNames(semdiff(src, out, { ignoreManaged: true })), ["ITEM1.TEL"]);
  checkFidelity(src, out);
});

test("changing TYPE keeps the original parameter form (repeated, comma list, quoted list)", () => {
  const src = fixture("vcard30-types.vcf");
  const item = openItem(src, "contact");
  const t = item.fields().tel;
  item.update({ tel: [{ ...t[0], types: ["work"] }, { ...t[1], types: ["home", "voice"] }, { ...t[2], types: ["cell"] }] });
  const out = save(item);
  assert.ok(out.includes("\r\nTEL;TYPE=WORK:+1 555 0105\r\n"), "comma-list form, upper-case values kept");
  assert.ok(out.includes("\r\nTEL;type=HOME;type=VOICE;type=pref:+1 555 0106\r\n"), "repeated form kept, pref kept");
  assert.ok(out.includes('\r\nTEL;TYPE="CELL":+1 555 0107\r\n') || out.includes("\r\nTEL;TYPE=CELL:+1 555 0107\r\n"));
  const re = openItem(out, "contact").fields();
  assert.equal(re.tel[1].pref, true);
  const item2 = openItem(src, "contact");
  const t2 = item2.fields().tel;
  item2.update({ tel: [t2[0], { ...t2[1], pref: false }, t2[2]] });
  assert.ok(save(item2).includes("\r\nTEL;type=WORK;type=VOICE:+1 555 0106\r\n"), "pref dropped from the repeated form");
});

test("adding an entry with a label creates a free Apple group; removing one removes its sibling", () => {
  const src = fixture("vcard30-groups.vcf");
  const item = openItem(src, "contact");
  const f = item.fields();
  item.update({ tel: [...f.tel, { value: "+1 555 0150", types: ["work"], label: "desk" }], email: [] });
  const out = save(item);
  assert.ok(out.includes("\r\nitem4.TEL;TYPE=WORK:+1 555 0150\r\nitem4.X-ABLABEL:desk\r\n"), out);
  assert.doesNotMatch(out, /item3|bob@example\.org/);
  checkFidelity(src, out);
  const back = openItem(out, "contact").fields();
  assert.equal(back.tel[2].label, "desk");
  assert.equal(back.email.length, 0);
});

test("removing an entry removes the whole group", () => {
  const src = fixture("vcard30-groups.vcf");
  const item = openItem(src, "contact");
  const f = item.fields();
  item.update({ tel: [f.tel[1]] });
  const out = save(item);
  assert.doesNotMatch(out, /item1/);
  assert.ok(out.includes("item2.URL"));
});

test("a label on a plain entry creates the group; editing a label edits the sibling only", () => {
  const item = openItem(fixture("vcard30-groups.vcf"), "contact");
  const f = item.fields();
  item.update({ tel: [f.tel[0], { ...f.tel[1], label: "home" }] });
  let out = save(item);
  assert.match(out, /\r\nitem4\.TEL;TYPE=HOME,VOICE:\+1 555 0102\r\nitem4\.X-ABLABEL:home\r\n/);
  const item2 = openItem(fixture("vcard30-groups.vcf"), "contact");
  const f2 = item2.fields();
  item2.update({ tel: [{ ...f2.tel[0], label: "renamed" }, f2.tel[1]] });
  out = save(item2);
  assert.ok(out.includes("item1.X-ABLabel:renamed"));
  assert.deepEqual(changedNames(semdiff(fixture("vcard30-groups.vcf"), out, { ignoreManaged: true })), ["ITEM1.X-ABLABEL"]);
});

test("Apple group siblings move with their parent property", () => {
  const item = openItem(fixture("vcard30-groups.vcf"), "contact");
  const card = item.main;
  const tel1 = card.prop("TEL") && card.props("TEL")[0];
  const url = card.prop("URL");
  assert.equal(siblingsOf(card, tel1).length, 1);
  moveEntry(card, tel1, url, "after");
  const out = save(item);
  const order = logical(out).filter((l) => /^(item\d\.)/i.test(l)).map((l) => l.split(/[;:]/)[0]);
  assert.deepEqual(order, ["item2.URL", "item2.X-ABLabel", "item1.TEL", "item1.X-ABLabel", "item3.EMAIL", "item3.X-ABLabel"]);
  checkFidelity(fixture("vcard30-groups.vcf"), out);
});

test("the VERSION is never changed and REV follows the card's own format", () => {
  const v3 = open("vcard30-basic.vcf");
  v3.update({ title: "Lead" });
  const o3 = save(v3);
  assert.ok(o3.includes("\r\nVERSION:3.0\r\n"));
  assert.ok(o3.includes("\r\nREV:2026-11-12T10:00:00Z\r\n"));
  const v4 = open("vcard40-groups.vcf");
  v4.update({ title: "Lead" });
  const o4 = save(v4);
  assert.ok(o4.includes("\r\nVERSION:4.0\r\n"));
  assert.ok(o4.includes("\r\nREV:20261112T100000Z\r\n"));
});

test("vCard 4.0: PREF parameter, TYPE and tel: URIs", () => {
  const item = open("vcard40-groups.vcf");
  const f = item.fields();
  assert.equal(f.tel[0].pref, true);
  assert.equal(f.tel[0].value, "tel:+1-555-0103");
  item.update({ tel: [{ ...f.tel[0], pref: false }, f.tel[1]] });
  const out = save(item);
  assert.ok(out.includes("\r\nitem1.TEL;VALUE=uri;TYPE=cell:tel:+1-555-0103\r\n"), out);
});

test("new entries: 3.0 puts pref in TYPE, 4.0 uses PREF=1", () => {
  const c3 = open("vcard30-basic.vcf");
  c3.update({ email: [...c3.fields().email, { value: "a@example.org", types: ["home"], pref: true }] });
  assert.ok(save(c3).includes("\r\nEMAIL;TYPE=HOME,pref:a@example.org\r\n"));
  const c4 = open("vcard40-bday-nomd.vcf");
  c4.update({ email: [{ value: "a@example.org", types: ["work"], pref: true }] });
  assert.ok(save(c4).includes("\r\nEMAIL;TYPE=work;PREF=1:a@example.org\r\n"));
});

test("structured fields: N, ORG, ADR, NICKNAME, CATEGORIES, NOTE escape correctly", () => {
  const item = open("vcard30-basic.vcf");
  item.update({
    n: { family: "O'Neil, Jr.", given: "Anna;Maria", additional: "", prefix: "Dr", suffix: "" },
    org: { name: "Foo; Bar", units: ["A", "B,C"] },
    nickname: ["x,y", "z"],
    categories: ["one", "two,three"],
    note: `line1\nline2, ${BS}`,
    adr: [{ value: { street: "1 A, B", locality: "Town;ship", country: "X" }, types: ["home"] }],
  });
  const out = save(item);
  assert.ok(out.includes(`\r\nN:O'Neil${BS}, Jr.;Anna${BS};Maria;;Dr;\r\n`));
  assert.ok(out.includes(`\r\nORG:Foo${BS}; Bar;A;B${BS},C\r\n`));
  assert.ok(out.includes(`\r\nNICKNAME:x${BS},y\r\n`));
  assert.ok(out.includes(`\r\nCATEGORIES:one,two${BS},three\r\n`));
  assert.ok(out.includes(`\r\nNOTE:line1${BS}nline2${BS}, ${BS}${BS}\r\n`));
  assert.ok(out.includes(`\r\nADR;TYPE=HOME:;;1 A${BS}, B;Town${BS};ship;;;X\r\n`));
  const back = openItem(out, "contact").fields();
  assert.equal(back.n.family, "O'Neil, Jr.");
  assert.equal(back.n.given, "Anna;Maria");
  assert.deepEqual(back.org, { name: "Foo; Bar", units: ["A", "B,C"] });
  assert.equal(back.note, `line1\nline2, ${BS}`);
  assert.equal(back.adr[0].value.locality, "Town;ship");
});

test("BDAY / ANNIVERSARY forms: --MMDD, full dates and Apple omit-year", () => {
  const a = open("vcard40-bday-nomd.vcf").fields();
  assert.deepEqual({ y: a.bday.year, m: a.bday.month, d: a.bday.day }, { y: null, m: 4, d: 1 });
  assert.deepEqual({ y: a.anniversary.year, m: a.anniversary.month, d: a.anniversary.day }, { y: 2010, m: 6, d: 15 });
  const o = open("vcard30-bday-omit-year.vcf").fields();
  assert.equal(o.bday.year, null);
  assert.equal(o.bday.month, 4);
  const full = open("vcard30-basic.vcf").fields();
  assert.equal(full.bday.year, 1990);
  // writing follows the card version
  const c4 = open("vcard40-bday-nomd.vcf");
  c4.update({ bday: { month: 5, day: 7 }, anniversary: { year: 2011, month: 7, day: 8 } });
  const out4 = save(c4);
  assert.ok(out4.includes("\r\nBDAY:--0507\r\n") && out4.includes("\r\nANNIVERSARY:20110708\r\n"));
  const c3 = open("vcard30-basic.vcf");
  c3.update({ bday: { month: 5, day: 7 } });
  assert.ok(save(c3).includes("\r\nBDAY:--05-07\r\n"));
  const same = open("vcard40-bday-nomd.vcf");
  assert.equal(same.update({ bday: { month: 4, day: 1 } }), false);
  const oy = open("vcard30-bday-omit-year.vcf");
  assert.equal(oy.update({ bday: { month: 4, day: 1 } }), false, "Apple omit-year form is the same date");
  assert.throws(() => c4.update({ bday: { month: 13, day: 1 } }), /month/);
});

test("PHOTO is never re-serialised: untouched when another field changes (3.0 base64 and 4.0 data URI)", () => {
  for (const name of ["vcard30-photo.vcf", "vcard30-photo-jpeg.vcf", "vcard40-photo.vcf"]) {
    const src = fixture(name);
    const item = openItem(src, "contact");
    assert.equal(item.fields().photo.present, true);
    item.update({ fn: "Someone Else", note: "n" });
    const out = save(item);
    const m = /\r\nPHOTO[\s\S]*?(?=\r\n[A-Z])/.exec(src.replace(/^/, "\r\n"));
    assert.ok(m, name);
    assert.ok(out.includes(m[0].slice(2)), `${name}: the PHOTO lines are byte-identical`);
    checkFidelity(src, out);
  }
});

test("PHOTO form read: data URI and base64", () => {
  assert.deepEqual(open("vcard40-photo.vcf").fields().photo, { present: true, form: "data-uri", mime: "image/png" });
  assert.deepEqual(open("vcard30-photo.vcf").fields().photo, { present: true, form: "base64", mime: "image/png" });
  assert.deepEqual(open("vcard30-basic.vcf").fields().photo, { present: false });
});

const B64 = Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 37 + 251) & 255)).toString("base64");

test("K2 new photo, vCard 4.0: PHOTO;ENCODING=b;MEDIATYPE=image/jpeg:<b64> (no data URI)", () => {
  const item = open("vcard40-bday-nomd.vcf");
  item.update({ photo: { mime: "image/jpeg", base64: B64 } });
  const out = save(item);
  assert.ok(logical(out).includes(`PHOTO;ENCODING=b;MEDIATYPE=image/jpeg:${B64}`));
  assert.ok(!out.includes("data:image"));
  for (const l of physical(out)) assert.ok(octets(l) <= 75);
  assert.deepEqual(openItem(out, "contact").fields().photo, { present: true, form: "base64", mime: "image/jpeg" });
  checkFidelity(fixture("vcard40-bday-nomd.vcf"), out);
});

test("K2 new photo, vCard 3.0: PHOTO;ENCODING=b;TYPE=JPEG:<b64>", () => {
  const item = open("vcard30-basic.vcf");
  item.update({ photo: { mime: "image/jpeg", base64: B64 } });
  const out = save(item);
  assert.ok(logical(out).includes(`PHOTO;ENCODING=b;TYPE=JPEG:${B64}`));
  for (const l of physical(out)) assert.ok(octets(l) <= 75);
  assert.equal(openItem(out, "contact").fields().photo.form, "base64");
});

test("replacing and removing a photo", () => {
  const src = fixture("vcard30-photo.vcf");
  const item = openItem(src, "contact");
  item.update({ photo: { mime: "image/png", base64: B64 } });
  let out = save(item);
  assert.equal(logical(out).filter((l) => l.startsWith("PHOTO")).length, 1);
  assert.ok(logical(out).includes(`PHOTO;ENCODING=b;TYPE=PNG:${B64}`));
  const rm = openItem(src, "contact");
  rm.update({ photo: null });
  out = save(rm);
  assert.doesNotMatch(out, /PHOTO/);
  assert.deepEqual(changedNames(semdiff(src, out, { ignoreManaged: true })), ["PHOTO"]);
  assert.throws(() => item.update({ photo: { mime: "image/png", base64: "not base64!" } }), /base64/);
  assert.throws(() => item.update({ photo: { mime: "text/html", base64: B64 } }), /mime/);
});

test("groups: KIND:group + MEMBER (4.0) and the Apple form", () => {
  const rfc = open("vcard40-group-kind.vcf");
  let g = rfc.fields().group;
  assert.deepEqual({ isGroup: g.isGroup, form: g.form, n: g.members.length }, { isGroup: true, form: "rfc6350", n: 2 });
  rfc.update({ members: [...g.members.slice(1), "urn:uuid:aaaaaaaa-0000-0000-0000-000000000009"] });
  const out = save(rfc);
  assert.ok(out.includes("MEMBER:urn:uuid:aaaaaaaa-0000-0000-0000-000000000009"));
  assert.doesNotMatch(out, /555555555501/);
  assert.ok(out.includes("KIND:group") && out.includes("VERSION:4.0"));
  const apple = open("vcard30-group-apple.vcf");
  g = apple.fields().group;
  assert.deepEqual({ form: g.form, n: g.members.length }, { form: "apple", n: 2 });
  apple.update({ members: [] });
  const out2 = save(apple);
  assert.doesNotMatch(out2, /X-ADDRESSBOOKSERVER-MEMBER/);
  assert.ok(out2.includes("X-ADDRESSBOOKSERVER-KIND:group") && out2.includes("VERSION:3.0"));
  assert.throws(() => open("vcard30-basic.vcf").update({ members: ["x"] }), /not a group/);
});

test("createGroupItem: both forms", () => {
  const a = createGroupItem("Team", ["11111111-2222-3333-4444-555555555501"], { uid: "g1" }).save({ now: NOW }).text;
  assert.match(a, /VERSION:4\.0/);
  assert.match(a, /\r\nKIND:group\r\n/);
  assert.match(a, /\r\nMEMBER:urn:uuid:11111111-2222-3333-4444-555555555501\r\n/);
  const b = createGroupItem("Team", ["m1"], { uid: "g2", form: "apple" }).save({ now: NOW }).text;
  assert.match(b, /VERSION:3\.0/);
  assert.match(b, /X-ADDRESSBOOKSERVER-KIND:group/);
  assert.match(b, /X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:m1/);
  assert.equal(openItem(a, "contact").ok, true);
  assert.equal(openItem(b, "contact").ok, true);
});

test("createItem(contact): UID/PRODID/VERSION on a new card, FN derived from N", () => {
  const item = createItem("contact", { n: { given: "Zoe", family: "Example" }, tel: [{ value: "+1 555 0120", types: ["cell"], label: "mobile" }], email: [{ value: "zoe@example.org", types: ["work"] }] }, { uid: "c-1", version: "4.0" });
  const out = item.save({ now: NOW }).text;
  assert.match(out, /^BEGIN:VCARD\r\nVERSION:4\.0\r\nPRODID:-\/\/RadUI\/\/Contacts\/\/EN\r\nUID:c-1\r\n/);
  assert.match(out, /\r\nFN:Zoe Example\r\n/);
  assert.match(out, /\r\nitem1\.TEL;TYPE=cell:\+1 555 0120\r\nitem1\.X-ABLABEL:mobile\r\n/);
  assert.match(out, /\r\nREV:20261112T100000Z\r\n/);
  assert.throws(() => createItem("contact", {}, { uid: "x" }), /name/);
  assert.throws(() => createItem("contact", { fn: "a" }, { version: "2.1" }), /version/);
});

test("non-owned vCard properties survive an edit (X-, IMPP, X-ABRELATEDNAMES with its label)", () => {
  const src = fixture("vcard40-vendor.vcf");
  const item = openItem(src, "contact");
  item.update({ fn: "Changed", tel: [{ value: "+1 555 0130", label: "x" }] });
  const out = save(item);
  for (const l of ["X-SOCIALPROFILE;type=twitter;x-user=judy:https://example.org/judy", "X-ABRELATEDNAMES;type=pref:Somebody", "item1.X-ABRELATEDNAMES:Another", "item1.X-ABLabel:_$!<Friend>!$_", "IMPP;X-SERVICE-TYPE=Example:example:judy"]) {
    assert.ok(logical(out).includes(l), l);
  }
  assert.ok(logical(out).some((l) => /^item2\.TEL/.test(l)), "the new label group does not reuse item1");
  checkFidelity(src, out);
});

test("echoing fields() back is a no-op for every contact in the corpus", async () => {
  const { fixtures } = await import("./helpers.mjs");
  let n = 0;
  for (const f of fixtures().filter((x) => x.meta.kind === "contact" && !x.meta.expect)) {
    const item = openItem(f.text, "contact");
    const c = item.fields();
    const date = (d) => (d && !d.text ? { year: d.year, month: d.month, day: d.day } : undefined);
    const patch = { fn: c.fn, n: c.n, nickname: c.nickname, org: c.org, title: c.title, tel: c.tel, email: c.email, adr: c.adr, url: c.url, note: c.note, categories: c.categories };
    if (c.bday && !c.bday.text) patch.bday = date(c.bday);
    if (c.anniversary && !c.anniversary.text) patch.anniversary = date(c.anniversary);
    assert.equal(item.update(patch), false, f.name);
    assert.deepEqual(item.save(), { changed: false }, f.name);
    n++;
  }
  assert.ok(n >= 12);
});

test("K3 nickname: exactly one value is written; K1 an empty label survives an echo", () => {
  const item = open("vcard30-basic.vcf");
  item.update({ nickname: ["Al, the first", "B"] });
  assert.ok(save(item).includes(`\r\nNICKNAME:Al${BS}, the first\r\n`));
  const v = open("vcard30-vendor-device.vcf");
  const f = v.fields();
  const all = [...f.tel, ...f.email, ...f.adr, ...f.url];
  assert.ok(all.some((e) => e.label === ""), "the fixture has an empty label");
  assert.equal(v.update({ tel: f.tel, email: f.email, adr: f.adr, url: f.url }), false);
  v.update({ fn: "x" });
  assert.ok(logical(save(v)).includes("item1.X-ABLabel:"));
});
