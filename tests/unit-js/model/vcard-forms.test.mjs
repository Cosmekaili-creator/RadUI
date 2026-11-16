// SPDX-License-Identifier: AGPL-3.0-or-later
// vCard additions for the contact form (RUN2 M1): TYPE tokens, PREF, NICKNAME, CATEGORIES,
// tel: URIs, per-part N / ADR / ORG, photo data, groups (both forms), anniversaries, labels.
import test from "node:test";
import assert from "node:assert/strict";
import { openItem } from "../../../src/js/model/item.js";
import { checkFidelity } from "../../../src/js/model/fidelity.js";
import { parse } from "../../../src/js/model/contentlines.js";
import {
  MAPPED_TYPES,
  addMember,
  anniversaryPolicy,
  cardOf,
  isGroupCard,
  labelInfo,
  mergeStructured,
  memberMatches,
  pickGroupForm,
  pickNewCardVersion,
  readAnniversaries,
  readGroup,
  readPhotoData,
  removeMember,
  replaceMappedType,
  restoreTel,
  splitTypes,
  stripTel,
  telUriForm,
} from "../../../src/js/model/vcard.js";
import { fixture, lf } from "./helpers.mjs";

const NOW = new Date("2026-11-13T10:00:00Z");
const open = (name) => openItem(fixture(name), "contact");
const save = (item) => item.save({ now: NOW }).text;
const lines = (text) => lf(text).replace(/\n[ \t]/g, "").split("\n").filter(Boolean);
const changed = (a, b) => {
  const A = lines(a);
  const B = lines(b);
  return { removed: A.filter((l) => !B.includes(l)), added: B.filter((l) => !A.includes(l)) };
};
const echo = (item, keys) => {
  const f = item.fields();
  return Object.fromEntries(keys.map((k) => [k, f[k]]));
};

// -- (a) TYPE tokens and PREF --------------------------------------------------

test("splitTypes / replaceMappedType replace only the one mapped token", () => {
  const m = MAPPED_TYPES.tel;
  assert.deepEqual(splitTypes(["home", "fax"], m), { selected: "home", rest: ["fax"] });
  assert.deepEqual(splitTypes(["voice", "x-custom"], m), { selected: null, rest: ["voice", "x-custom"] });
  assert.deepEqual(replaceMappedType(["home", "fax"], m, "work"), ["work", "fax"]);
  assert.deepEqual(replaceMappedType(["work", "voice"], m, "cell"), ["cell", "voice"]);
  assert.deepEqual(replaceMappedType(["voice", "x-Custom"], m, "work"), ["work", "voice", "x-custom"]);
  assert.deepEqual(replaceMappedType(["home", "voice"], m, null), ["voice"]);
  assert.deepEqual(replaceMappedType(["home", "voice"], m, ""), ["voice"]);
  assert.deepEqual(replaceMappedType(["voice"], m, null), ["voice"]);
  assert.deepEqual(replaceMappedType(["home", "voice"], m, "home"), ["home", "voice"]);
  // the new token already present elsewhere is not duplicated
  assert.deepEqual(replaceMappedType(["home", "fax"], m, "fax"), ["fax"]);
  assert.deepEqual(MAPPED_TYPES.email, ["home", "work"]);
});

test("multi-TYPE rows: changing the mapped token keeps INTERNET, VOICE and x-* (original spelling)", () => {
  const src = fixture("vcard30-multi-type.vcf");
  const item = openItem(src, "contact");
  const f = item.fields();
  assert.deepEqual(f.tel.map((t) => t.types), [["home", "fax"], ["work", "voice"], ["cell", "x-mobile-work"]]);
  assert.deepEqual(f.email.map((t) => t.types), [["internet", "home"], ["internet", "work"]]);
  const tel = f.tel.map((e) => ({ prop: e.prop, value: e.value, types: e.types, pref: undefined, label: undefined }));
  tel[0].types = replaceMappedType(tel[0].types, MAPPED_TYPES.tel, "work");
  tel[2].types = replaceMappedType(tel[2].types, MAPPED_TYPES.tel, "home");
  const email = f.email.map((e) => ({ prop: e.prop, value: e.value, types: e.types }));
  email[0].types = replaceMappedType(email[0].types, MAPPED_TYPES.email, "work");
  assert.equal(item.update({ tel, email }), true);
  const out = save(item);
  const d = changed(src, out);
  assert.ok(out.includes("TEL;TYPE=work,fax:+1 555 0131") || out.includes("TEL;TYPE=WORK,fax:+1 555 0131") || /TEL;TYPE=work,fax:/i.test(out), out);
  assert.ok(/TEL;type=home;type=x-Mobile-Work:/.test(out), "repeated form and the original spelling of x-Mobile-Work are kept\n" + out);
  assert.ok(/EMAIL;TYPE=work,internet:|EMAIL;TYPE=internet,work:|EMAIL;TYPE=INTERNET,WORK:/i.test(out), out);
  assert.equal(d.removed.filter((l) => l.startsWith("TEL")).length, 2);
  assert.ok(d.removed.concat(d.added).every((l) => /^(TEL|EMAIL|REV)/.test(l)), JSON.stringify(d));
  checkFidelity(src, out);
});

test("an untouched row is a no-op even with several TYPE tokens; pref undefined changes nothing", () => {
  for (const name of ["vcard30-multi-type.vcf", "vcard30-multi-pref.vcf", "vcard40-multi-pref.vcf"]) {
    const item = open(name);
    const f = item.fields();
    const rows = (l) => l.map((e) => ({ prop: e.prop, value: e.value, types: e.types, pref: undefined, label: undefined }));
    assert.equal(item.update({ tel: rows(f.tel), email: rows(f.email) }), false, name);
    assert.deepEqual(item.save(), { changed: false });
  }
});

test("PREF=1/2 on 4.0 and several TYPE=pref rows on 3.0 survive a type change; pref is read per row", () => {
  const four = open("vcard40-multi-pref.vcf");
  const f4 = four.fields();
  assert.deepEqual(f4.tel.map((t) => t.pref), [true, true, false]);
  const rows = f4.tel.map((e) => ({ prop: e.prop, value: e.value, types: e.types }));
  rows[1].types = replaceMappedType(rows[1].types, MAPPED_TYPES.tel, "home");
  four.update({ tel: rows });
  const out4 = save(four);
  assert.match(out4, /TEL;PREF=1;TYPE=cell:/);
  assert.match(out4, /TEL;PREF=2;TYPE=home,voice:/);
  const three = open("vcard30-multi-pref.vcf");
  const f3 = three.fields();
  assert.deepEqual(f3.tel.map((t) => t.pref), [true, true, false]);
  assert.deepEqual(f3.email.map((t) => t.pref), [true, true]);
  const rows3 = f3.tel.map((e) => ({ prop: e.prop, value: e.value, types: e.types }));
  rows3[0].types = replaceMappedType(rows3[0].types, MAPPED_TYPES.tel, "home");
  three.update({ tel: rows3 });
  const out3 = save(three);
  assert.match(out3, /TEL;TYPE=HOME,pref:\+1 555 0134/);
  assert.match(out3, /TEL;TYPE=WORK,VOICE,pref:\+1 555 0135/, "the other preferred row is untouched");
  checkFidelity(fixture("vcard30-multi-pref.vcf"), out3);
});

test("pref is changed only when explicitly sent", () => {
  const item = open("vcard40-multi-pref.vcf");
  const f = item.fields();
  const rows = f.tel.map((e) => ({ prop: e.prop, value: e.value, types: e.types }));
  rows[2].pref = true;
  rows[0].pref = false;
  item.update({ tel: rows });
  const out = save(item);
  assert.match(out, /TEL;TYPE=cell:\+1 555 0137/);
  assert.match(out, /TEL;PREF=2;TYPE=work,voice:/);
  assert.match(out, /TEL;TYPE=home;PREF=1:\+1 555 0139/);
});

// -- (b) NICKNAME ----------------------------------------------------------------

test("NICKNAME: the first value of a list is what the form shows; echoing it changes nothing", () => {
  const item = open("vcard30-multi-nickname.vcf");
  assert.deepEqual(item.fields().nickname, ["Nini", "Nicky", "Nine"]);
  assert.equal(item.update({ nickname: ["Nini"] }), false);
  assert.deepEqual(item.save(), { changed: false });
  assert.equal(item.update({ nickname: ["Nicky"] }), true);
  const out = save(item);
  assert.deepEqual(changed(fixture("vcard30-multi-nickname.vcf"), out).added.filter((l) => l.startsWith("NICKNAME")), ["NICKNAME:Nicky"]);
  const gone = open("vcard30-multi-nickname.vcf");
  assert.equal(gone.update({ nickname: [] }), true);
  assert.ok(!/NICKNAME/.test(save(gone)));
});

// -- (c) CATEGORIES ----------------------------------------------------------------

test("CATEGORIES: an array of strings; an escaped comma stays inside one category", () => {
  const item = open("vcard30-category-comma.vcf");
  assert.deepEqual(item.fields().categories, ["Friends, family", "Work", "Book club"]);
  assert.equal(item.update({ categories: item.fields().categories }), false);
  item.update({ categories: ["Friends, family", "Work", "Book club", "New, one"] });
  const out = save(item);
  assert.ok(lines(out).includes("CATEGORIES:Friends\\, family,Work,Book club,New\\, one"), out);
  item.update({ categories: ["Work"] });
  assert.ok(lines(save(item)).includes("CATEGORIES:Work"));
});

// -- (d) tel: URIs ------------------------------------------------------------------

test("tel: helpers strip for display and restore on write", () => {
  const item = open("vcard40-tel-uri.vcf");
  const rows = cardOf(item.root).props("TEL");
  const form = telUriForm(rows[0]);
  assert.deepEqual(form, { uri: true, prefix: "tel:" });
  assert.equal(stripTel(rows[0].value), "+1-555-0140");
  assert.equal(restoreTel("+1 555 0150", form), "tel:+1-555-0150");
  assert.equal(restoreTel("tel:+1-555-0150", form), "tel:+1-555-0150", "already a URI");
  assert.equal(restoreTel("+1 555 0150", telUriForm(rows[2])), "+1 555 0150", "a text TEL stays text");
  assert.equal(telUriForm({ value: "TEL:+15550100", paramValues: () => [] }).prefix, "TEL:");
  assert.equal(stripTel("TEL:+15550100"), "+15550100");
});

test("editing a URI-valued TEL through its display value writes the tel: prefix back", () => {
  const src = fixture("vcard40-tel-uri.vcf");
  const item = openItem(src, "contact");
  const f = item.fields();
  // echo of the stripped values is a no-op
  assert.equal(item.update({ tel: f.tel.map((e) => ({ prop: e.prop, value: stripTel(e.value), types: e.types })) }), false);
  const rows = f.tel.map((e) => ({ prop: e.prop, value: stripTel(e.value), types: e.types }));
  rows[0].value = "+1 555 0150";
  item.update({ tel: rows });
  const out = save(item);
  assert.deepEqual(changed(src, out).added.filter((l) => l.startsWith("TEL")), ["TEL;VALUE=uri;TYPE=cell;PREF=1:tel:+1-555-0150"]);
  // a raw edit to the bare number is restored by the model as well
  const again = openItem(src, "contact");
  const r2 = again.fields().tel.map((e) => ({ prop: e.prop, value: e.value, types: e.types }));
  r2[1].value = "+1 555 0160";
  again.update({ tel: r2 });
  assert.match(save(again), /TEL;VALUE=uri;TYPE=work:tel:\+1-555-0160/);
});

// -- (e) per-part re-encoding ------------------------------------------------------------

test("N: changing one part leaves the comma lists of the other parts byte-stable", () => {
  const src = fixture("vcard30-structured-lists.vcf");
  const item = openItem(src, "contact");
  const f = item.fields();
  assert.equal(f.n.given, "Alex, Alexis");
  assert.equal(f.n.prefix, "Dr., Prof.");
  assert.equal(item.update({ n: { ...f.n } }), false, "the joined display values are not a change");
  item.update({ n: { ...f.n, family: "Listing" } });
  const out = save(item);
  assert.deepEqual(changed(src, out).added.filter((l) => l.startsWith("N:")), ["N:Listing;Alex,Alexis;Quinn,Q;Dr.,Prof.;Jr.,III"]);
  checkFidelity(src, out);
});

test("N: a part may be a list; mergeStructured keeps raw parts that did not change", () => {
  assert.equal(mergeStructured("A;B,C;D", { family: "A", given: ["B", "C"], additional: "X" }, ["family", "given", "additional"]), "A;B,C;X");
  assert.equal(mergeStructured("A;B\\, C", { family: "A", given: "B, C" }, ["family", "given"]), "A;B\\, C");
  assert.equal(mergeStructured("A", { family: "A", given: "Q,R" }, ["family", "given"]), "A;Q\\,R");
  assert.equal(mergeStructured("A;B;C;extra", { family: "Z" }, ["family", "given"]), "Z;;C;extra");
});

test("ADR: editing the city keeps the street's comma list as it was; other rows untouched", () => {
  const src = fixture("vcard30-structured-lists.vcf");
  const item = openItem(src, "contact");
  const f = item.fields();
  assert.equal(f.adr[0].value.street, "1 Example Road, Building 2");
  const rows = f.adr.map((e) => ({ prop: e.prop, value: { ...e.value }, types: e.types }));
  assert.equal(item.update({ adr: rows }), false);
  rows[0].value.locality = "Newtown";
  item.update({ adr: rows });
  const out = save(item);
  const d = changed(src, out);
  assert.equal(d.removed.filter((l) => l.startsWith("ADR")).length, 1);
  assert.deepEqual(d.added.filter((l) => l.startsWith("ADR")), ["ADR;TYPE=HOME:;;1 Example Road,Building 2;Newtown;Exampleshire;00001;Exampleland"]);
});

test("ORG: editing the name keeps the escaped unit text", () => {
  const src = fixture("vcard30-structured-lists.vcf");
  const item = openItem(src, "contact");
  const f = item.fields();
  assert.deepEqual(f.org, { name: "Example Org", units: ["Research", "Applied; Division"] });
  assert.equal(item.update({ org: { ...f.org } }), false);
  item.update({ org: { name: "New Org", units: f.org.units } });
  assert.ok(lines(save(item)).includes("ORG:New Org;Research;Applied\\; Division"));
});

// -- (f) photo data ----------------------------------------------------------------------------

const B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/";
const card = (photoLine) => openItem(`BEGIN:VCARD\nVERSION:3.0\nUID:p1\nFN:P\n${photoLine}\nEND:VCARD\n`, "contact");
const photoOf = (photoLine, opts) => readPhotoData(cardOf(card(photoLine).root), opts);

test("readPhotoData: ENCODING=b, data URI, declared and sniffed types, byte count without decoding", () => {
  const r = photoOf(`PHOTO;ENCODING=b;TYPE=JPEG:${B64}`);
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/jpeg");
  assert.equal(r.base64, B64);
  assert.equal(r.bytes, Buffer.from(B64, "base64").length);
  const d = photoOf(`PHOTO:data:image/png;base64,${B64}`);
  assert.equal(d.ok && d.mime, "image/png");
  assert.equal(photoOf(`PHOTO;ENCODING=b:${B64}`).mime, "image/jpeg", "sniffed from the data");
  assert.equal(photoOf(`PHOTO;ENCODING=BASE64;MEDIATYPE=image/webp:${B64}`).mime, "image/webp");
  assert.equal(photoOf(`PHOTO;ENCODING=b;TYPE=JPG:${B64.slice(0, 40)} ${B64.slice(40)}`.replace(" ", "")).mime, "image/jpeg");
});

test("readPhotoData: reasons for what it will not hand out", () => {
  assert.deepEqual(readPhotoData(cardOf(openItem("BEGIN:VCARD\nVERSION:3.0\nUID:a\nFN:A\nEND:VCARD\n", "contact").root)), { ok: false, reason: "none" });
  assert.equal(photoOf("PHOTO;VALUE=uri:https://example.org/a.jpg").reason, "external-uri");
  assert.equal(photoOf("PHOTO:data:image/png,%89PNG").reason, "not-base64");
  assert.equal(photoOf("PHOTO;ENCODING=b;TYPE=JPEG:@@@@").reason, "bad-base64");
  assert.equal(photoOf(`PHOTO;ENCODING=b;TYPE=SVG:${B64}`).reason, "unsupported-mime");
  assert.equal(photoOf(`PHOTO:data:image/svg+xml;base64,${B64}`).reason, "unsupported-mime");
  assert.equal(photoOf(`PHOTO;ENCODING=b;TYPE=BMP:${B64}`).reason, "unsupported-mime");
  const big = photoOf(`PHOTO;ENCODING=b;TYPE=JPEG:${B64}`, { maxBytes: 10 });
  assert.equal(big.reason, "too-large");
  assert.ok(big.bytes > 10);
  assert.equal(photoOf("PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==").ok, true);
});

test("fields(): photoSig changes with the payload, not with folding", () => {
  const a = card(`PHOTO;ENCODING=b;TYPE=JPEG:${B64}`).fields().photoSig;
  const b = card(`PHOTO;ENCODING=b;TYPE=JPEG:${B64.slice(0, 20)}\n ${B64.slice(20)}`).fields().photoSig;
  const c = card(`PHOTO;ENCODING=b;TYPE=JPEG:${B64.replace("AAQ", "AAR")}`).fields().photoSig;
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(open("vcard30-basic.vcf").fields().photoSig, null);
});

// -- (g) groups ---------------------------------------------------------------------------------

test("memberMatches: urn:uuid prefix optional, UUIDs case-insensitive, other schemes never match", () => {
  const u = "11111111-2222-3333-4444-555555555501";
  assert.equal(memberMatches(`urn:uuid:${u}`, u), true);
  assert.equal(memberMatches(u, `urn:uuid:${u}`), true);
  assert.equal(memberMatches(`urn:uuid:${u.toUpperCase()}`, u), true);
  assert.equal(memberMatches(`urn:uuid:${u}`, "other"), false);
  assert.equal(memberMatches("mailto:a@example.org", "a@example.org"), false);
  assert.equal(memberMatches("abc", "ABC"), false, "non-UUID uids compare exactly");
  assert.equal(memberMatches("", u), false);
  assert.equal(memberMatches(undefined, u), false);
});

test("pickNewCardVersion: majority of 3.0/4.0, 3.0 for none or a tie", () => {
  assert.equal(pickNewCardVersion([]), "3.0");
  assert.equal(pickNewCardVersion(undefined), "3.0");
  assert.equal(pickNewCardVersion(["4.0", "4.0", "3.0"]), "4.0");
  assert.equal(pickNewCardVersion(["4.0", "3.0"]), "3.0");
  assert.equal(pickNewCardVersion(["2.1", "2.1"]), "3.0");
  assert.equal(pickNewCardVersion([open("vcard40-anniversary.vcf"), open("vcard40-multi-pref.vcf"), open("vcard30-basic.vcf")]), "4.0");
  assert.equal(pickNewCardVersion([{ version: "4.0" }, open("vcard40-hostile.vcf").fields()]), "4.0");
});

test("isGroupCard / pickGroupForm: both forms, majority, version fallback, empty book", () => {
  const apple = open("vcard30-group-apple-labels.vcf");
  const rfc = open("vcard40-group-unknown-member.vcf");
  const plain3 = open("vcard30-basic.vcf");
  const plain4 = open("vcard40-anniversary.vcf");
  assert.equal(isGroupCard(apple), true);
  assert.equal(isGroupCard(rfc), true);
  assert.equal(isGroupCard(apple.fields()), true);
  assert.equal(isGroupCard(cardOf(rfc.root)), true);
  assert.equal(isGroupCard(plain3), false);
  assert.equal(isGroupCard(plain3.fields()), false);
  assert.equal(pickGroupForm([]), "apple");
  assert.equal(pickGroupForm([plain3, plain3, plain4]), "apple");
  assert.equal(pickGroupForm([plain4, plain4, plain3]), "rfc6350");
  assert.equal(pickGroupForm([rfc, rfc, apple, plain3, plain3, plain3]), "rfc6350", "existing groups win over the version");
  assert.equal(pickGroupForm([apple, plain4, plain4]), "apple");
  assert.equal(pickGroupForm([apple, rfc, plain4, plain4]), "rfc6350", "a tie of forms falls back to the majority version");
  assert.equal(pickGroupForm([apple.fields(), apple.fields()]), "apple");
});

for (const [name, member] of [["vcard30-group-apple-labels.vcf", "X-ADDRESSBOOKSERVER-MEMBER"], ["vcard40-group-unknown-member.vcf", "MEMBER"]]) {
  test(`group card ${name}: add or remove ONE member touches only that member line; unknown members stay`, () => {
    const src = fixture(name);
    const base = openItem(src, "contact");
    const g = readGroup(cardOf(base.root));
    assert.equal(g.isGroup, true);
    assert.equal(g.members.length, 4);
    const add = openItem(src, "contact");
    assert.equal(addMember(add.main, "urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"), true);
    const outAdd = save(add);
    const d = changed(src, outAdd);
    assert.deepEqual(d.added.filter((l) => !l.startsWith("REV")), [`${member}:urn:uuid:aaaaaaaa-0000-4000-8000-000000000001`]);
    assert.deepEqual(d.removed.filter((l) => !l.startsWith("REV")), []);
    checkFidelity(src, outAdd);
    assert.equal(addMember(openItem(outAdd, "contact").main, "urn:uuid:AAAAAAAA-0000-4000-8000-000000000001"), false, "already a member");

    const rm = openItem(src, "contact");
    assert.equal(removeMember(rm.main, "mailto:" + (g.members.find((m) => m.startsWith("mailto:")) || "").slice(7)), true);
    const r1 = changed(src, save(rm));
    assert.equal(r1.removed.filter((l) => !l.startsWith("REV")).length, 1);
    assert.ok(r1.removed.some((l) => l.includes("mailto:")));
    const uid = name.includes("apple") ? "22222222-3333-4444-5555-000000000001" : "22222222-3333-4444-5555-000000000003";
    const rm2 = openItem(src, "contact");
    removeMember(rm2.main, uid);
    assert.equal(rm2.fields().group.members.length, 3);
    assert.equal(removeMember(rm2.main, "urn:uuid:not-there"), false);
    // through the patch
    const viaPatch = openItem(src, "contact");
    assert.equal(viaPatch.update({ membersDelta: { add: ["urn:uuid:aaaaaaaa-0000-4000-8000-000000000002"], remove: [uid] } }), true);
    const members = viaPatch.fields().group.members;
    assert.equal(members.length, 4);
    assert.ok(members.includes("urn:uuid:99999999-8888-7777-6666-" + (name.includes("apple") ? "555555555555" : "444444444444")), "unknown member passed through");
  });
}

test("member operations refuse a card that is not a group", () => {
  const item = open("vcard30-basic.vcf");
  assert.throws(() => addMember(item.main, "urn:uuid:x"), /not a group/);
  assert.throws(() => removeMember(item.main, "x"), /not a group/);
});

// -- (h) anniversaries and labels ---------------------------------------------------------------

test("3.0: X-ABDATE and X-ANNIVERSARY are listed read-only; ANNIVERSARY is writable on 4.0 only", () => {
  const three = open("vcard30-anniversary-xabdate.vcf");
  const list = readAnniversaries(three.main);
  assert.deepEqual(list.map((a) => [a.source, a.kind, a.readOnly]), [["X-ANNIVERSARY", "anniversary", true], ["X-ABDATE", "anniversary", true], ["X-ABDATE", "other", true]]);
  assert.deepEqual(list[1].date, { year: 2010, month: 6, day: 12, raw: "2010-06-12" });
  assert.equal(list[2].label, "Moved in together");
  assert.equal(three.fields().anniversary, null, "the ANNIVERSARY property itself is absent");
  assert.equal(three.fields().anniversaries.length, 3);
  const pol = anniversaryPolicy(three.main);
  assert.equal(pol.writable, false);
  assert.equal(pol.reason, "anniversary-needs-vcard-4");
  assert.equal(pol.existing.length, 2);
  assert.throws(() => three.update({ anniversary: { year: 2000, month: 1, day: 2 } }, { strict: true }), /vCard 4.0/);
  assert.equal(three.update({ anniversary: null }, { strict: true }), false, "no change is not refused");
  const four = open("vcard40-anniversary.vcf");
  assert.equal(anniversaryPolicy(four.main).writable, true);
  assert.deepEqual(four.fields().anniversary.month, 6);
  assert.equal(four.update({ anniversary: { year: 1996, month: 6, day: 12 } }, { strict: true }), true);
  assert.ok(lines(save(four)).includes("ANNIVERSARY:19960612"));
});

test("text BDAY and year-less BDAY are read as such", () => {
  assert.deepEqual(open("vcard30-text-bday.vcf").fields().bday, { raw: "circa 1950", text: true });
  const y = open("vcard30-bday-yearless.vcf").fields().bday;
  assert.deepEqual([y.year, y.month, y.day], [null, 4, 1]);
  assert.equal(open("vcard30-bday-yearless.vcf").update({ bday: { year: null, month: 4, day: 1 } }), false);
});

test("labelInfo maps Apple built-in labels to readable keys; other labels are returned as written", () => {
  assert.deepEqual(labelInfo("_$!<Mobile>!$_"), { builtin: true, key: "mobile", text: "Mobile" });
  assert.deepEqual(labelInfo("_$!<HomeFAX>!$_"), { builtin: true, key: "home-fax", text: "Home fax" });
  assert.deepEqual(labelInfo("_$!<HomePage>!$_"), { builtin: true, key: "home-page", text: "Home Page" });
  assert.deepEqual(labelInfo("_$!<iPhone>!$_"), { builtin: true, key: "iphone", text: "iPhone" });
  assert.deepEqual(labelInfo("_$!<Strange>!$_"), { builtin: true, key: null, text: "Strange" });
  assert.deepEqual(labelInfo("Night shift"), { builtin: false, key: null, text: "Night shift" });
  assert.deepEqual(labelInfo(null), { builtin: false, key: null, text: "" });
  const f = open("vcard30-apple-labels.vcf").fields();
  assert.deepEqual(f.tel.map((t) => labelInfo(t.label).key), ["mobile", "iphone", "main", "home-fax", null]);
  assert.equal(labelInfo(f.tel[4].label).text, "Night shift");
  assert.equal(labelInfo(f.url[0].label).key, "home-page");
});

// -- fixtures ------------------------------------------------------------------------------------

test("hostile and bidi fixtures keep their text literally through read and an unrelated edit", () => {
  const item = open("vcard40-hostile.vcf");
  const f = item.fields();
  assert.equal(f.fn, "<script>alert(1)</script> Hostile");
  assert.ok(f.note.includes("<img src=x onerror=alert(1)>"));
  assert.ok(f.url.some((u) => u.value.startsWith("javascript:")));
  item.update({ title: "Boss" });
  checkFidelity(fixture("vcard40-hostile.vcf"), save(item));
  const bidi = open("vcard30-bidi.vcf").fields();
  assert.ok(bidi.fn.includes("‮") && bidi.note.includes("‏"));
});

test("a card without UID opens (the server refuses it, the fixture lives in server-refused/)", async () => {
  const { readFileSync } = await import("node:fs");
  const { FIXTURES } = await import("./helpers.mjs");
  const text = readFileSync(`${FIXTURES}/vcf/server-refused/vcard30-no-uid.vcf`, "utf8");
  const item = openItem(text, "contact");
  assert.equal(item.ok, true);
  assert.equal(item.uid, null);
  assert.equal(parse(text)[0].props("UID").length, 0);
});

test("every new fixture echoes its own fields back as a no-op", () => {
  for (const name of ["vcard30-multi-type.vcf", "vcard30-multi-pref.vcf", "vcard40-multi-pref.vcf", "vcard40-tel-uri.vcf", "vcard30-category-comma.vcf", "vcard30-structured-lists.vcf", "vcard30-multi-nickname.vcf", "vcard30-apple-labels.vcf", "vcard40-hostile.vcf", "vcard30-anniversary-xabdate.vcf"]) {
    const item = open(name);
    const f = item.fields();
    const patch = {
      fn: f.fn, n: f.n, nickname: f.nickname.slice(0, 1), org: f.org, title: f.title, note: f.note, categories: f.categories,
      tel: f.tel.map((e) => ({ prop: e.prop, value: e.value, types: e.types, pref: undefined, label: undefined })),
      email: f.email.map((e) => ({ prop: e.prop, value: e.value, types: e.types })),
      adr: f.adr.map((e) => ({ prop: e.prop, value: { ...e.value }, types: e.types })),
      url: f.url.map((e) => ({ prop: e.prop, value: e.value, types: e.types })),
    };
    assert.equal(item.update(patch), false, name);
    assert.deepEqual(item.save(), { changed: false }, name);
  }
  assert.deepEqual(echo(open("vcard30-basic.vcf"), ["version"]), { version: "3.0" });
});

test("ORG: a name edit keeps empty middle units; a unit appended keeps them too", () => {
  const src = "BEGIN:VCARD\nVERSION:3.0\nUID:o1\nFN:O\nORG:Acme;;Sales\nEND:VCARD\n";
  const a = openItem(src, "contact");
  assert.deepEqual(a.fields().org, { name: "Acme", units: ["Sales"] });
  a.update({ org: { name: "NewCo", units: ["Sales"] } });
  assert.ok(lines(save(a)).includes("ORG:NewCo;;Sales"));
  const b = openItem(src, "contact");
  b.update({ org: { name: "Acme", units: ["Sales", "EMEA"] } });
  assert.ok(lines(save(b)).includes("ORG:Acme;;Sales;EMEA"));
  const c = openItem(src, "contact");
  assert.equal(c.update({ org: { name: "Acme", units: ["Sales"] } }), false);
});
