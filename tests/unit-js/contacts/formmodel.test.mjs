// SPDX-License-Identifier: AGPL-3.0-or-later
// The form -> patch mapping (RUN2 risk #1): no-op over the whole vcf corpus, one field at a time.
import test from "node:test";
import assert from "node:assert/strict";
import { openItem, createItem } from "../../../src/js/model/item.js";
import { anniversaryPolicy } from "../../../src/js/model/vcard.js";
import { semdiff, changedNames } from "../../lib/semdiff.js";
import { fixtures, fixture } from "../model/helpers.mjs";
import {
  ADR_PARTS,
  MAIN_LABEL,
  composeFn,
  effectiveFn,
  emptyFields,
  followFn,
  isEmptyPatch,
  isRealDate,
  newCardPatch,
  newRow,
  toFormValues,
  toPatch,
  validate,
  withPhoto,
  cardSizeError,
  serverLossWarnings,
} from "../../../src/js/contacts/formmodel.js";

const NOW = new Date("2026-11-13T10:00:00Z");
const open = (name) => openItem(fixture(name), "contact");
const corpus = () => fixtures().filter((f) => f.name.startsWith("vcf/") && f.meta.kind === "contact" && !f.meta.expect);
const baseName = (n) => n.split(/[;:]/)[0].split(".").pop();
const names = (a, b) => [...new Set(changedNames(semdiff(a, b, { ignoreManaged: true })).map(baseName))].sort();

test("the corpus covers every vcf fixture that opens (server-refused excluded)", () => {
  const all = fixtures().filter((f) => f.name.startsWith("vcf/"));
  assert.ok(all.length >= 45, String(all.length));
  assert.ok(corpus().length >= 40);
  for (const f of all) {
    const item = openItem(f.text, "contact");
    assert.equal(!item.ok, !!f.meta.expect, `${f.name}: manifest verdict`);
  }
});

test("MANDATORY: toPatch(fields, toFormValues(fields)) is empty and item.update({}) changes nothing, for every vcf fixture", () => {
  let n = 0;
  for (const f of corpus()) {
    const item = openItem(f.text, "contact");
    const fields = item.fields();
    const patch = toPatch(fields, toFormValues(fields));
    assert.deepEqual(patch, {}, f.name);
    assert.equal(isEmptyPatch(patch), true);
    assert.equal(item.update(patch), false, f.name);
    assert.deepEqual(item.save(), { changed: false }, f.name);
    assert.equal(validate(fields, toFormValues(fields), { now: NOW }).ok || f.name, true);
    n++;
  }
  assert.ok(n >= 40);
});

test("toFormValues returns a deep copy: editing the values never touches the fields", () => {
  const item = open("vcard30-structured-lists.vcf");
  const fields = item.fields();
  const snapshot = JSON.stringify({ ...fields, tel: undefined, email: undefined, adr: fields.adr.map((a) => a.value) });
  const v = toFormValues(fields);
  v.adr[0].value.street = "changed";
  v.categories.push("x");
  v.given = "zzz";
  assert.equal(JSON.stringify({ ...fields, tel: undefined, email: undefined, adr: fields.adr.map((a) => a.value) }), snapshot);
});

// -- one field at a time, over the corpus ---------------------------------------------------------

/** The first row that holds a value (rows of a blank value are never edited). */
const r0 = (rows) => rows.find((r) => (typeof r.value === "string" ? r.value.trim() : Object.values(r.value).some((x) => String(x).trim())));
const KIND_PROP = { tel: "TEL", email: "EMAIL", adr: "ADR", url: "URL" };

/** [label, mutate(values, fields) -> boolean (applicable), allowed patch keys, allowed property names] */
function mutations() {
  const list = [
    ["fn", (v) => ((v.fn += " Z"), (v.fnEdited = true), true), ["fn"], ["FN"]],
    ["given", (v) => ((v.given += "x"), (v.fnEdited = true), true), ["n"], ["N"]],
    ["family", (v) => ((v.family = "Zed" + v.family), (v.fnEdited = true), true), ["n"], ["N"]],
    ["nickname", (v) => ((v.nickname = "Zed"), true), ["nickname"], ["NICKNAME"]],
    ["org", (v) => ((v.org = "Zed Org"), true), ["org"], ["ORG"]],
    ["department", (v) => ((v.department = "Zed Dept"), true), ["org"], ["ORG"]],
    ["title", (v) => ((v.title = "Zed Title"), true), ["title"], ["TITLE"]],
    ["note", (v) => ((v.note = v.note + "\nline two; with, separators"), true), ["note"], ["NOTE"]],
    ["category added", (v) => (v.categories.push("Zed, tag"), true), ["categories"], ["CATEGORIES"]],
    ["category removed", (v) => v.categories.length > 0 && (v.categories.shift(), true), ["categories"], ["CATEGORIES"]],
    ["bday", (v) => v.bday.text === null && ((v.bday.date = { year: 1999, month: 1, day: 2 }), true), ["bday"], ["BDAY"]],
    ["bday replace text", (v) => v.bday.text !== null && ((v.bday.replace = true), (v.bday.date = { year: 1999, month: 1, day: 2 }), true), ["bday"], ["BDAY"]],
    ["anniversary (4.0 only)", (v) => v.anniversary.writable && v.anniversary.text === null && ((v.anniversary.date = { year: 2001, month: 3, day: 4 }), true), ["anniversary"], ["ANNIVERSARY"]],
    ["photo replace", (v) => ((v.photo = { ...v.photo, action: "replace", data: { mime: "image/jpeg", base64: "QUJDRA==" } }), true), ["photo"], ["PHOTO"]],
    ["photo remove", (v) => v.photo.present && ((v.photo = { ...v.photo, action: "remove" }), true), ["photo"], ["PHOTO"]],
  ];
  for (const kind of ["tel", "email", "adr", "url"]) {
    const P = KIND_PROP[kind];
    const sib = ["X-ABLABEL"];
    list.push([`${kind} value`, (v) => r0(v[kind]) && (kind === "adr" ? (r0(v[kind]).value.locality = "Zedtown") : (r0(v[kind]).value = kind === "email" ? "zed@example.org" : kind === "url" ? "https://example.org/zed" : "+1 555 0199"), true), [kind], [P]]);
    list.push([`${kind} type`, (v) => r0(v[kind]) && ((r0(v[kind]).typeSel = r0(v[kind]).typeSel === "work" ? "home" : "work"), true), [kind], [P, ...sib]]);
    list.push([`${kind} to other`, (v) => r0(v[kind]) && r0(v[kind]).typeSel !== "other" && ((r0(v[kind]).typeSel = "other"), true), [kind], [P, ...sib]]);
    list.push([`${kind} preferred`, (v) => r0(v[kind]) && ((r0(v[kind]).pref = !r0(v[kind]).pref), true), [kind], [P]]);
    list.push([`${kind} label edit`, (v) => r0(v[kind]) && r0(v[kind]).typeSel === "custom" && ((r0(v[kind]).label += " Z"), true), [kind], sib]);
    list.push([`${kind} custom label`, (v) => r0(v[kind]) && ((r0(v[kind]).typeSel = "custom"), (r0(v[kind]).label = "Zed label"), true), [kind], [P, ...sib]]);
    list.push([
      `${kind} row added`,
      (v) => {
        const r = newRow(kind);
        if (kind === "adr") r.value.street = "1 Zed Road";
        else r.value = kind === "email" ? "new.zed@example.org" : kind === "url" ? "https://example.org/new" : "+1 555 0188";
        v[kind].push(r);
        return true;
      },
      [kind],
      [P],
    ]);
    list.push([`${kind} last row removed`, (v) => r0(v[kind]) && (v[kind].splice(v[kind].indexOf(r0(v[kind])), 1), true), [kind], [P, ...sib, "X-ABRELATEDNAMES", "X-ABADR", "X-ABDATE"]]);
  }
  return list;
}

test("each field changed alone: the patch holds only that key and the card differs only in that property", () => {
  const counts = new Map();
  for (const f of corpus()) {
    for (const [label, mutate, keys, props] of mutations()) {
      const item = openItem(f.text, "contact");
      const fields = item.fields();
      const values = toFormValues(fields);
      if (!mutate(values, fields)) continue;
      const where = `${f.name} / ${label}`;
      const patch = toPatch(fields, values);
      assert.ok(Object.keys(patch).length > 0, `${where}: a change must give a patch`);
      assert.deepEqual(Object.keys(patch).filter((k) => !keys.includes(k)), [], `${where}: keys ${Object.keys(patch)}`);
      assert.equal(item.update(patch), true, where);
      let out;
      try {
        out = item.save({ now: NOW });
      } catch (e) {
        throw new Error(`${where}: ${e.message}`);
      }
      assert.equal(out.changed, true, where);
      const diff = names(f.text, out.text);
      assert.deepEqual(diff.filter((n) => !props.includes(n)), [], `${where}: properties ${diff}`);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  for (const [label] of mutations()) if (label !== "adr label edit") assert.ok((counts.get(label) || 0) >= 1, `mutation never applied: ${label}`);
});

test("a changed row touches that row only: the other rows of the kind keep their exact lines", () => {
  for (const name of ["vcard30-multi-type.vcf", "vcard30-multi-pref.vcf", "vcard40-multi-pref.vcf", "vcard30-apple-labels.vcf", "vcard40-tel-uri.vcf"]) {
    const src = fixture(name);
    const item = openItem(src, "contact");
    const fields = item.fields();
    const v = toFormValues(fields);
    v.tel[1].value = v.tel[1].value + "9";
    item.update(toPatch(fields, v));
    const d = semdiff(src, item.save({ now: NOW }).text, { ignoreManaged: true }).diffs;
    assert.equal(d.filter((x) => x.side === "a").length, 1, name);
    assert.equal(d.filter((x) => x.side === "b").length, 1, name);
  }
});

// -- M1 cases ---------------------------------------------------------------------------------------

test("untouched type select: the ORIGINAL types array goes back; pref and label are undefined", () => {
  const item = open("vcard30-multi-type.vcf");
  const fields = item.fields();
  const v = toFormValues(fields);
  v.tel[0].value += "1"; // value edit only
  const patch = toPatch(fields, v);
  assert.equal(patch.tel[0].types, fields.tel[0].types, "same array object");
  assert.equal(patch.tel[0].pref, undefined);
  assert.equal(patch.tel[0].label, undefined);
  assert.equal(patch.tel[1].prop, fields.tel[1].prop, "unchanged rows carry their prop");
  assert.equal(patch.tel[1].types, fields.tel[1].types);
});

test("the type select replaces only the mapped token and keeps INTERNET, VOICE and x-*", () => {
  const src = fixture("vcard30-multi-type.vcf");
  const item = openItem(src, "contact");
  const fields = item.fields();
  const v = toFormValues(fields);
  assert.deepEqual(v.tel.map((r) => r.typeSel), ["home", "work", "cell"]);
  assert.deepEqual(v.email.map((r) => r.typeSel), ["home", "work"]);
  assert.deepEqual(v.url.map((r) => r.typeSel), ["work"]);
  v.tel[0].typeSel = "work";
  v.tel[2].typeSel = "other";
  v.email[0].typeSel = "work";
  const patch = toPatch(fields, v);
  assert.deepEqual(patch.tel[0].types, ["work", "fax"]);
  assert.deepEqual(patch.tel[1].types, ["work", "voice"]);
  assert.deepEqual(patch.tel[2].types, ["x-mobile-work"]);
  assert.deepEqual(patch.email[0].types, ["internet", "work"]);
  item.update(patch);
  const out = item.save({ now: NOW }).text;
  assert.match(out, /TEL;[Tt][Yy][Pp][Ee]=[A-Za-z,-]*fax/);
  assert.ok(/x-Mobile-Work/.test(out), "original spelling of x-Mobile-Work kept");
});

test("pref is sent only when the radio of a row changed (multi-PREF cards)", () => {
  for (const name of ["vcard30-multi-pref.vcf", "vcard40-multi-pref.vcf"]) {
    const fields = open(name).fields();
    const v = toFormValues(fields);
    assert.equal(v.tel.filter((r) => r.pref).length, 1, "one radio per kind shows the first preferred row");
    v.tel[1].value += "7";
    const patch = toPatch(fields, v);
    assert.deepEqual(patch.tel.map((e) => e.pref), [undefined, undefined, undefined], name);
    const v2 = toFormValues(fields);
    v2.tel[2].pref = true;
    v2.tel[0].pref = false;
    const p2 = toPatch(fields, v2);
    assert.deepEqual(p2.tel.map((e) => e.pref), [false, undefined, true], name);
  }
});

test("NICKNAME: the first value is shown; a multi-value NICKNAME is emitted only when edited (K3)", () => {
  const fields = open("vcard30-multi-nickname.vcf").fields();
  const v = toFormValues(fields);
  assert.equal(v.nickname, fields.nickname[0]);
  assert.equal(v.nicknameMore, 2);
  assert.ok(!("nickname" in toPatch(fields, v)));
  v.nickname = "Only";
  assert.deepEqual(toPatch(fields, v).nickname, ["Only"]);
  v.nickname = "";
  assert.deepEqual(toPatch(fields, v).nickname, []);
});

test("CATEGORIES are chips: an escaped comma stays inside one category; reorder or removal is a change", () => {
  const fields = open("vcard30-category-comma.vcf").fields();
  const v = toFormValues(fields);
  assert.deepEqual(v.categories, ["Friends, family", "Work", "Book club"]);
  assert.deepEqual(toPatch(fields, v), {});
  v.categories = v.categories.filter((c) => c !== "Work");
  assert.deepEqual(toPatch(fields, v).categories, ["Friends, family", "Book club"]);
  v.categories = ["Friends, family", "Friends, family", "Work", ""];
  assert.deepEqual(toPatch(fields, v).categories, ["Friends, family", "Work"], "duplicates and blanks dropped");
});

test("TEL VALUE=uri is shown without tel: and written back with it", () => {
  const src = fixture("vcard40-tel-uri.vcf");
  const item = openItem(src, "contact");
  const fields = item.fields();
  const v = toFormValues(fields);
  assert.ok(fields.tel[0].value.startsWith("tel:"));
  assert.ok(!v.tel[0].value.startsWith("tel:"));
  v.tel[0].value = "+1 555 0150";
  const patch = toPatch(fields, v);
  assert.equal(patch.tel[0].value, "+1 555 0150");
  item.update(patch);
  assert.match(item.save({ now: NOW }).text, /TEL;[^:\n]*:tel:\+1-555-0150/);
  assert.equal(patch.tel[1].value, fields.tel[1].value, "an unchanged row passes its raw value (prefix included)");
});

test("N and ADR: only changed parts are named; untouched comma lists stay byte-stable", () => {
  const src = fixture("vcard30-structured-lists.vcf");
  const item = openItem(src, "contact");
  const fields = item.fields();
  const v = toFormValues(fields);
  assert.equal(v.given, "Alex, Alexis");
  v.family = "Listing";
  v.fnEdited = true;
  v.adr[0].value.locality = "Newtown";
  v.org = "New Org";
  item.update(toPatch(fields, v));
  const out = item.save({ now: NOW }).text.replace(/\r\n /g, "").split("\r\n");
  assert.ok(out.includes("N:Listing;Alex,Alexis;Quinn,Q;Dr.,Prof.;Jr.,III"));
  assert.ok(out.includes("ADR;TYPE=HOME:;;1 Example Road,Building 2;Newtown;Exampleshire;00001;Exampleland"));
  assert.ok(out.includes("ORG:New Org;Research;Applied\\; Division"), "other ORG units kept");
});

test("department edits the first ORG unit only; further units stay", () => {
  const fields = open("vcard30-structured-lists.vcf").fields();
  const v = toFormValues(fields);
  assert.equal(v.department, "Research");
  assert.equal(v.orgMoreUnits, 1);
  v.department = "Lab";
  assert.deepEqual(toPatch(fields, v).org, { name: "Example Org", units: ["Lab", "Applied; Division"] });
  v.department = "";
  assert.deepEqual(toPatch(fields, v).org, { name: "Example Org", units: ["Applied; Division"] });
});

test("labels: K1 undefined unless edited; the Apple built-in label is shown readably; TEL main uses the built-in label", () => {
  const src = fixture("vcard30-apple-labels.vcf");
  const item = openItem(src, "contact");
  const fields = item.fields();
  const v = toFormValues(fields);
  assert.equal(v.tel[0].typeSel, "custom");
  assert.equal(v.tel[0].label, "Mobile");
  assert.equal(v.tel[0].labelKey, "mobile");
  assert.equal(v.tel[2].typeSel, "main");
  assert.deepEqual(toPatch(fields, v), {});
  v.tel[4].label = "Night shift 2";
  const p = toPatch(fields, v);
  assert.equal(p.tel[4].label, "Night shift 2");
  assert.equal(p.tel[0].label, undefined);
  assert.equal(p.tel[4].types, fields.tel[4].types);
  v.tel[4].label = "Night shift";
  v.tel[4].typeSel = "work";
  assert.equal(toPatch(fields, v).tel[4].label, null, "leaving 'custom' removes the label");
  const w = toFormValues(fields);
  w.tel[1].typeSel = "main";
  const mp = toPatch(fields, w).tel[1];
  assert.equal(mp.label, null, "the old custom label goes; main writes the TYPE token, not the Apple label");
  assert.ok(mp.types.includes("main"));
  const wk = toFormValues(fields);
  wk.tel[2].typeSel = "work";
  assert.equal(toPatch(fields, wk).tel[2].label, null, "leaving the Apple main label removes it");
  assert.ok(MAIN_LABEL.includes("Main"));
  const empty = openItem(fixture("vcard30-vendor-device.vcf"), "contact");
  const ef = empty.fields();
  const ev = toFormValues(ef);
  assert.deepEqual(toPatch(ef, ev), {}, "an empty X-ABLabel is not touched (K1)");
});

test("blank rows are ignored; a cleared existing row is removed; an unknown handle is a new row", () => {
  const fields = open("vcard30-multi-type.vcf").fields();
  const v = toFormValues(fields);
  v.tel.push(newRow("tel"));
  assert.deepEqual(toPatch(fields, v), {}, "a blank new row is not a change");
  v.tel[0].value = "  ";
  const p = toPatch(fields, v);
  assert.equal(p.tel.length, 2);
  assert.ok(p.tel.every((e) => e.prop !== fields.tel[0].prop));
  const w = toFormValues(fields);
  w.email[0] = { ...w.email[0], prop: {} };
  const q = toPatch(fields, w);
  assert.equal(q.email.length, 2);
  assert.equal(q.email[0].prop, undefined, "stale handle: written as a new entry");
});

test("a key absent from values is untouched", () => {
  const fields = open("vcard30-basic.vcf").fields();
  assert.deepEqual(toPatch(fields, {}), {});
  assert.deepEqual(toPatch(fields, { title: "Chief" }), { title: "Chief" });
});

// -- FN following ------------------------------------------------------------------------------------

test("FN follows the name parts only while unedited AND equal to the composition of the original parts", () => {
  const plain = { ...emptyFields(), fn: "Jane Doe", n: { given: "Jane", family: "Doe", additional: "", prefix: "", suffix: "" } };
  const v = toFormValues(plain);
  v.given = "Janet";
  assert.equal(followFn(plain, v), "Janet Doe");
  assert.equal(toPatch(plain, v).fn, "Janet Doe");
  assert.deepEqual(Object.keys(toPatch(plain, v)).sort(), ["fn", "n"]);
  v.fnEdited = true;
  v.fn = "J. Doe";
  assert.equal(toPatch(plain, v).fn, "J. Doe");
  v.fn = "Jane Doe";
  assert.ok(!("fn" in toPatch(plain, v)), "edited back to the original: nothing");
  const custom = { ...plain, fn: "Doc Jane" };
  const w = toFormValues(custom);
  w.given = "Janet";
  assert.equal(followFn(custom, w), "Doc Jane");
  assert.ok(!("fn" in toPatch(custom, w)), "FN is not the composition: left alone");
  assert.equal(composeFn({ prefix: "Dr.", given: "A", additional: "B", family: "C", suffix: "Jr." }), "Dr. A B C Jr.");
  assert.equal(effectiveFn(plain, { ...toFormValues(plain), given: "X" }), "X Doe");
});

test("clearing every name part never empties FN: it falls back to the organisation, else nothing is emitted", () => {
  const plain = { ...emptyFields(), fn: "Jane Doe", n: { given: "Jane", family: "Doe" } };
  const v = toFormValues(plain);
  v.given = "";
  v.family = "";
  assert.equal("fn" in toPatch(plain, v), false);
  v.org = "Example Org";
  assert.equal(toPatch(plain, v).fn, "Example Org");
});

// -- dates ----------------------------------------------------------------------------------------------

test("dates: text BDAY is read-only until Replace; a year-less date is unchanged; anniversary is read-only on 3.0", () => {
  const t = open("vcard30-text-bday.vcf").fields();
  const v = toFormValues(t);
  assert.equal(v.bday.text, "circa 1950");
  assert.equal(v.bday.date, null);
  v.bday.date = { year: 1950, month: 1, day: 1 };
  assert.ok(!("bday" in toPatch(t, v)), "no Replace: ignored");
  v.bday.replace = true;
  assert.deepEqual(toPatch(t, v).bday, { year: 1950, month: 1, day: 1 });
  v.bday.date = null;
  assert.ok(!("bday" in toPatch(t, v)), "Replace without a date keeps the text");
  const y = open("vcard30-bday-yearless.vcf").fields();
  const yv = toFormValues(y);
  assert.equal(yv.bday.date.year, null);
  assert.deepEqual(toPatch(y, yv), {});
  yv.bday.date = null;
  assert.equal(toPatch(y, yv).bday, null, "clearing removes");
  const a3 = open("vcard30-anniversary-xabdate.vcf").fields();
  const av = toFormValues(a3);
  assert.equal(av.anniversary.writable, false);
  assert.equal(av.anniversary.reason, "anniversary-needs-vcard-4");
  assert.equal(av.anniversary.others.length, 3, "X-ANNIVERSARY and the two X-ABDATE are listed read-only; ANNIVERSARY itself is the field");
  av.anniversary.date = { year: 2000, month: 1, day: 1 };
  assert.ok(!("anniversary" in toPatch(a3, av)));
  assert.equal(validate(a3, av, { now: NOW }).errors[0].key, "contact.err.anniversaryVersion");
  const a4 = open("vcard40-anniversary.vcf").fields();
  const a4v = toFormValues(a4);
  assert.equal(a4v.anniversary.writable, true);
  a4v.anniversary.date = { year: 1996, month: 6, day: 12 };
  assert.deepEqual(toPatch(a4, a4v).anniversary, { year: 1996, month: 6, day: 12 });
});

test("anniversary writability agrees with the model's anniversaryPolicy on every card", () => {
  for (const f of corpus()) {
    const item = openItem(f.text, "contact");
    assert.equal(toFormValues(item.fields()).anniversary.writable, anniversaryPolicy(item.main).writable, f.name);
  }
});

test("isRealDate", () => {
  assert.equal(isRealDate({ year: 2024, month: 2, day: 29 }), true);
  assert.equal(isRealDate({ year: 2023, month: 2, day: 29 }), false);
  assert.equal(isRealDate({ year: null, month: 2, day: 29 }), true);
  assert.equal(isRealDate({ year: null, month: 2, day: 30 }), false);
  assert.equal(isRealDate({ year: 1900, month: 2, day: 29 }), false);
  assert.equal(isRealDate({ year: 2000, month: 13, day: 1 }), false);
  assert.equal(isRealDate({ year: 2000, month: 1, day: 0 }), false);
  assert.equal(isRealDate({ year: 0, month: 1, day: 1 }), false);
  assert.equal(isRealDate({ invalid: true }), false);
  assert.equal(isRealDate(null), false);
});

// -- photo ------------------------------------------------------------------------------------------------

test("photo: keep sends nothing; replace sends {mime, base64} (K2); remove sends null only when there is a photo", () => {
  const p = open("vcard30-photo.vcf").fields();
  const v = toFormValues(p);
  assert.equal(v.photo.present, true);
  assert.deepEqual(toPatch(p, v), {});
  assert.deepEqual(toPatch(p, withPhoto(v, { mime: "image/jpeg", base64: "QUJD" })).photo, { mime: "image/jpeg", base64: "QUJD" });
  assert.equal(toPatch(p, withPhoto(v, null)).photo, null);
  const none = open("vcard30-basic.vcf").fields();
  assert.deepEqual(toPatch(none, withPhoto(toFormValues(none), null)), {});
});

// -- validation -----------------------------------------------------------------------------------------------

const errs = (base, v) => validate(base, v, { now: NOW }).errors;
const fresh = (over = {}) => ({ ...toFormValues(emptyFields()), ...over });

test("validation: a name is required (FN, given, family or org)", () => {
  assert.deepEqual(errs(emptyFields(), fresh()).map((e) => [e.key, e.testId]), [["contact.err.name", "field-fn"]]);
  for (const k of ["fn", "given", "family", "org"]) assert.equal(validate(emptyFields(), fresh({ [k]: "X" }), { now: NOW }).ok, true, k);
});

test("validation: e-mail, phone, URL rules with structured errors", () => {
  const v = fresh({ fn: "A" });
  const row = (kind, value) => Object.assign(newRow(kind), { value });
  v.email = [row("email", "a@b"), row("email", "no at sign"), row("email", "x@@y")];
  v.tel = [row("tel", "+1 (555) 010-0199 x12"), row("tel", "12"), row("tel", "call me"), row("tel", "+1 555 0100 ext")];
  v.url = [row("url", "example.org"), row("url", "https://example.org/a"), row("url", "http://"), row("url", "localhost:8080/x"), row("url", "mailto:a@example.org")];
  const e = errs(emptyFields(), v);
  const at = (field, i) => e.find((x) => x.field === field && x.row === i);
  assert.equal(at("email", 0), undefined);
  assert.equal(at("email", 1).key, "contact.err.email");
  assert.equal(at("email", 2).key, "contact.err.email");
  assert.equal(at("email", 1).testId, "field-email-value");
  assert.equal(at("tel", 0), undefined);
  assert.equal(at("tel", 1).key, "contact.err.phone");
  assert.equal(at("tel", 2).key, "contact.err.phone");
  assert.equal(at("tel", 3).key, "contact.err.phone", "letters other than p w x are refused");
  assert.equal(at("tel", 1).testId, "field-phone-value");
  assert.equal(at("url", 0).key, "contact.err.urlScheme");
  assert.deepEqual(at("url", 0).params, { scheme: "https" });
  assert.equal(at("url", 1), undefined);
  assert.equal(at("url", 2).key, "contact.err.url");
  assert.equal(at("url", 3).key, "contact.err.urlScheme");
  assert.equal(at("url", 4), undefined);
});

test("validation: only changed values are checked (an old odd phone does not block an unrelated edit)", () => {
  const src = "BEGIN:VCARD\nVERSION:3.0\nUID:v1\nFN:Odd\nTEL:call me\nEMAIL:broken\nEND:VCARD\n";
  const fields = openItem(src, "contact").fields();
  const v = toFormValues(fields);
  v.title = "Boss";
  assert.equal(validate(fields, v, { now: NOW }).ok, true);
  v.email[0].value = "still broken";
  assert.equal(validate(fields, v, { now: NOW }).errors[0].key, "contact.err.email");
});

test("validation: dates are real and a birthday is not in the future; lengths", () => {
  const v = fresh({ fn: "A" });
  v.bday.date = { year: 2023, month: 2, day: 29 };
  assert.equal(errs(emptyFields(), v)[0].key, "contact.err.date");
  v.bday.date = { year: 2026, month: 11, day: 14 };
  assert.equal(errs(emptyFields(), v)[0].key, "contact.err.bdayFuture");
  v.bday.date = { year: 2026, month: 11, day: 13 };
  assert.equal(validate(emptyFields(), v, { now: new Date(2026, 10, 13, 12) }).ok, true, "today is allowed");
  v.bday.date = { year: null, month: 12, day: 31 };
  assert.equal(validate(emptyFields(), v, { now: NOW }).ok, true, "year-less is never in the future");
  v.bday.date = { invalid: true };
  assert.equal(errs(emptyFields(), v)[0].key, "contact.err.date");
  const long = fresh({ fn: "x".repeat(1001), note: "n".repeat(10001), title: "t".repeat(1000) });
  const e = errs(emptyFields(), long);
  assert.deepEqual(e.map((x) => [x.field, x.params.max]).sort(), [["fn", 1000], ["note", 10000]]);
  assert.equal(errs(emptyFields(), fresh({ note: "n".repeat(10000), fn: "A" })).length, 0);
  assert.equal(cardSizeError("a".repeat(1024 * 1024)), null);
  assert.equal(cardSizeError("a".repeat(1024 * 1024 + 1)).key, "contact.err.cardTooLarge");
});

test("validation: a custom label must be filled; the error names the row and the field", () => {
  const v = fresh({ fn: "A" });
  const r = newRow("email", { typeSel: "custom" });
  r.value = "a@example.org";
  v.email = [r];
  assert.deepEqual(errs(emptyFields(), v).map((x) => [x.key, x.testId, x.row]), [["contact.err.label", "field-email-custom", 0]]);
  r.label = "Club";
  assert.equal(validate(emptyFields(), v).ok, true);
});

test("hostile text is plain text: huge strings, bidi and script payloads pass through unchanged", () => {
  const hostile = '<script>alert(1)</script> ‮evil‬ "><img src=x onerror=alert(1)>';
  const v = fresh({ fn: hostile, note: hostile + "\n" + "z".repeat(9000) });
  assert.equal(validate(emptyFields(), v).ok, true);
  const { fields } = newCardPatch(v, { uid: "h1" });
  assert.equal(fields.fn, hostile.trim());
  const item = createItem("contact", fields, { uid: "h1" });
  const text = item.save({ now: NOW }).text;
  const back = openItem(text, "contact").fields();
  assert.equal(back.fn, hostile.trim());
  assert.ok(back.note.startsWith(hostile));
});

// -- new contact --------------------------------------------------------------------------------------------------

test("newCardPatch builds a card with only the filled fields, in the given version", () => {
  const v = fresh({ given: "Ada", family: "Example", org: "Example Org", note: "hello", categories: ["Work", "Club, one"] });
  const tel = Object.assign(newRow("tel"), { value: "+1 555 0123", pref: true });
  const mail = Object.assign(newRow("email", { typeSel: "work" }), { value: "ada@example.org" });
  const home = Object.assign(newRow("adr"), {});
  home.value.street = "1 Example Road";
  home.value.locality = "Sampletown";
  const site = Object.assign(newRow("url"), { value: "https://example.org/ada" });
  v.tel = [tel, newRow("tel")];
  v.email = [mail];
  v.adr = [home];
  v.url = [site];
  v.bday.date = { year: 1990, month: 4, day: 1 };
  v.anniversary.date = { year: 2015, month: 5, day: 6 };
  v.photo = { action: "replace", data: { mime: "image/jpeg", base64: "QUJDRA==" }, present: false };
  const keys = (r) => Object.keys(r.fields).sort();
  const three = newCardPatch(v, { version: "3.0", uid: "n-1" });
  assert.deepEqual(keys(three), ["adr", "bday", "categories", "email", "fn", "n", "note", "org", "photo", "tel", "url"]);
  assert.equal(three.fields.fn, "Ada Example");
  assert.deepEqual(three.options, { version: "3.0", uid: "n-1" });
  assert.equal(validate(emptyFields(), v, { now: NOW }).errors.length, 1, "anniversary on 3.0 is reported");
  const four = newCardPatch(v, { version: "4.0", uid: "n-2" });
  assert.ok("anniversary" in four.fields);
  for (const r of [three, four]) {
    const item = createItem("contact", r.fields, r.options);
    const out = item.save({ now: NOW }).text;
    const back = openItem(out, "contact");
    assert.equal(back.ok, true);
    const f = back.fields();
    assert.equal(f.version, r.options.version);
    assert.deepEqual(f.tel.map((t) => [t.value, t.types, t.pref]), [["+1 555 0123", ["cell"], true]]);
    assert.deepEqual(f.email.map((t) => [t.value, t.types]), [["ada@example.org", ["work"]]]);
    assert.equal(f.adr[0].value.street, "1 Example Road");
    assert.deepEqual(f.categories, ["Work", "Club, one"]);
    assert.equal(f.org.name, "Example Org");
    assert.equal(toPatch(f, toFormValues(f)) && Object.keys(toPatch(f, toFormValues(f))).length, 0);
  }
});

test("newCardPatch: FN falls back to the organisation", () => {
  const r = newCardPatch(fresh({ org: "Example Org" }), { uid: "x" });
  assert.equal(r.fields.fn, "Example Org");
  assert.equal(ADR_PARTS.length, 7);
});

test("serverLossWarnings: a multi-value NICKNAME is reported (the server keeps only the first value)", () => {
  assert.deepEqual(serverLossWarnings(open("vcard30-multi-nickname.vcf").fields()), [{ code: "nickname-truncated", lost: ["Nicky", "Nine"] }]);
  assert.deepEqual(serverLossWarnings(open("vcard30-basic.vcf").fields()), [{ code: "nickname-truncated", lost: ["A"] }]);
  assert.deepEqual(serverLossWarnings(open("vcard30-types.vcf").fields()), []);
});

test("an Apple-labelled address: editing its label touches only the X-ABLabel line", () => {
  const src = "BEGIN:VCARD\nVERSION:3.0\nUID:a1\nFN:A\nitem1.ADR;type=HOME:;;1 Example Road;Sampletown;;00001;Exampleland\nitem1.X-ABLabel:Cabin\nEND:VCARD\n";
  const item = openItem(src, "contact");
  const f = item.fields();
  const v = toFormValues(f);
  assert.equal(v.adr[0].typeSel, "custom");
  v.adr[0].label = "Lake cabin";
  const patch = toPatch(f, v);
  assert.deepEqual(Object.keys(patch), ["adr"]);
  item.update(patch);
  assert.deepEqual(names(src, item.save({ now: NOW }).text), ["X-ABLABEL"]);
});

test("TEL TYPE=MAIN reads as 'main'; work replaces it; main on another row writes only the token", () => {
  const src = fixture("vcard30-tel-type-main.vcf");
  const item = openItem(src, "contact");
  const f = item.fields();
  const v = toFormValues(f);
  assert.deepEqual(v.tel.map((r) => r.typeSel), ["main", "work"]);
  assert.deepEqual(toPatch(f, v), {});
  v.tel[0].typeSel = "work";
  const p = toPatch(f, v);
  assert.deepEqual(p.tel[0].types, ["work", "voice"], "no TYPE=WORK,MAIN");
  assert.equal(p.tel[0].label, undefined);
  const w = toFormValues(f);
  w.tel[1].typeSel = "main";
  const q = toPatch(f, w);
  assert.deepEqual(q.tel[1].types, ["main"]);
  assert.equal(q.tel[1].label, undefined, "no Apple label next to TYPE=MAIN");
  const n = Object.assign(newRow("tel", { typeSel: "main" }), { value: "+1 555 0174" });
  const nv = toFormValues(f);
  nv.tel.push(n);
  assert.deepEqual(toPatch(f, nv).tel[2], { value: "+1 555 0174", types: ["main"], pref: false, label: undefined });
});

test("blank rows (M1): an empty ADR and an empty labelled TEL survive an untouched form and unrelated edits", () => {
  const src = fixture("vcard30-empty-rows.vcf");
  const item = openItem(src, "contact");
  const f = item.fields();
  assert.equal(f.adr.length, 2);
  const v = toFormValues(f);
  assert.deepEqual(toPatch(f, v), {});
  v.title = "Boss";
  v.note = "n";
  const p = toPatch(f, v);
  assert.deepEqual(Object.keys(p).sort(), ["note", "title"]);
  item.update(p);
  const out = item.save({ now: NOW }).text;
  assert.deepEqual(names(src, out), ["NOTE", "TITLE"], "no ADR, TEL or label line was removed");
  // a filled row cleared by the user is still removed; a blank row filled in is a change
  const w = toFormValues(f);
  w.adr[1].value = Object.fromEntries(ADR_PARTS.map((x) => [x.part, ""]));
  const pw = toPatch(f, w);
  assert.equal(pw.adr.length, 1);
  assert.equal(pw.adr[0].prop, f.adr[0].prop, "the blank row is echoed");
  assert.ok(!pw.adr.some((e) => e.prop === f.adr[1].prop), "the cleared row is removed");
  const x = toFormValues(f);
  x.tel[1].value = "+1 555 0175";
  const px = toPatch(f, x);
  assert.equal(px.tel[1].value, "+1 555 0175");
  const y = toFormValues(f);
  y.tel[1].value = "";
  y.tel.push(newRow("tel"));
  assert.deepEqual(toPatch(f, y), {}, "still blank: nothing; a new blank row is not written");
  const z = toFormValues(f);
  z.tel.splice(1, 1);
  assert.ok(toPatch(f, z).tel, "a row the form dropped is a removal");
});

test("a value with a newline is unchanged when equal (textarea round trip): ADR street, NOTE", () => {
  const src = "BEGIN:VCARD\nVERSION:3.0\nUID:nl1\nFN:Newline\nADR;TYPE=home:;;12 Main St\\nApt 3;Sampletown;;00001;Exampleland\nNOTE:line one\\nline two\nEND:VCARD\n";
  const item = openItem(src, "contact");
  const f = item.fields();
  assert.ok(f.adr[0].value.street.includes("\n"));
  const v = toFormValues(f);
  assert.deepEqual(toPatch(f, v), {});
  v.adr[0].value.street = "12 Main St\r\nApt 3"; // a textarea may hand back CRLF
  v.note = "line one\r\nline two";
  assert.deepEqual(toPatch(f, v), {}, "equal text is not a change");
  v.title = "Boss";
  item.update(toPatch(f, v));
  assert.deepEqual(names(src, item.save({ now: NOW }).text), ["TITLE"]);
  const w = toFormValues(f);
  w.adr[0].value.street = "12 Main St Apt 3"; // what a single-line input would hand back
  assert.ok(toPatch(f, w).adr, "a stripped newline IS a change: the view must use a textarea");
});
