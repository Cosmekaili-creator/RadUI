// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { fixtures } from "../model/helpers.mjs";
import {
  LETTERS,
  azIndex,
  buildList,
  compareRows,
  countContacts,
  filterByMembers,
  findDuplicates,
  foldText,
  keyFor,
  letterOf,
  makeCollator,
  matches,
  memberKey,
  parseQuery,
  resolveKey,
  search,
  splitBook,
  summarize,
  windowRows,
} from "../../../src/js/contacts/index.js";

const card = (lines, { href = "/u/book/x.vcf", version = "3.0" } = {}) => summarize(`BEGIN:VCARD\nVERSION:${version}\n${lines.join("\n")}\nEND:VCARD\n`, { href });
const person = (uid, fn, extra = [], n) => card([`UID:${uid}`, `FN:${fn}`, ...(n ? [`N:${n}`] : []), ...extra], { href: `/u/book/${uid}.vcf` });

test("summary of a full card: every field the list needs", () => {
  const s = card(
    ["UID:u-1", "FN:Dr. Alex Quinn", "N:Quinn;Alex;;Dr.;", "NICKNAME:Lex", "ORG:Example Org;Lab", "TITLE:Chief", "TEL;TYPE=CELL:+1 555 0101", "TEL;VALUE=uri:tel:+1-555-0102", "EMAIL:alex@example.org", "CATEGORIES:Work,Club", "NOTE:secret", "PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA=="],
    { href: "/u/book/a%20b.vcf" },
  );
  assert.equal(s.uid, "u-1");
  assert.equal(s.href, "/u/book/a%20b.vcf");
  assert.equal(s.name, "Dr. Alex Quinn");
  assert.equal(s.sortKey, "Quinn Alex");
  assert.equal(s.letter, "Q");
  assert.equal(s.org, "Example Org");
  assert.deepEqual(s.emails, ["alex@example.org"]);
  assert.deepEqual(s.phones, ["+1 555 0101", "+1-555-0102"]);
  assert.deepEqual(s.categories, ["Work", "Club"]);
  assert.equal(s.hasPhoto, true);
  assert.equal(s.isGroup, false);
  assert.equal(s.readOnly, false);
  assert.equal(s.reason, null);
});

test("sort key: N family + given, else FN; name falls back to N, organisation, e-mail", () => {
  assert.equal(card(["UID:a", "FN:Alex Quinn"]).sortKey, "Alex Quinn");
  assert.equal(card(["UID:a", "FN:Alex", "N:;Alex;;;"]).sortKey, "Alex");
  assert.equal(card(["UID:a", "FN:", "N:Quinn;Alex;;;"]).name, "Alex Quinn");
  assert.equal(card(["UID:a", "FN:", "ORG:Example Org"]).name, "Example Org");
  assert.equal(card(["UID:a", "FN:", "EMAIL:x@example.org"]).name, "x@example.org");
  assert.equal(card(["UID:a"]).name, "");
  assert.equal(card(["UID:a"]).letter, "#");
});

test("letters: NFD, marks stripped, upper-cased; anything outside A-Z is #", () => {
  assert.equal(letterOf("émile"), "E");
  assert.equal(letterOf("Émile"), "E");
  assert.equal(letterOf("ñandú"), "N");
  assert.equal(letterOf("zoë"), "Z");
  assert.equal(letterOf("  alex"), "A");
  assert.equal(letterOf("3M"), "#");
  assert.equal(letterOf("中文"), "#");
  assert.equal(letterOf("Ж"), "#");
  assert.equal(letterOf(""), "#");
  assert.equal(letterOf(null), "#");
  assert.equal(letterOf("‮evil"), "E", "bidi controls are ignored");
  assert.equal(letterOf("😀 smile"), "#");
  assert.equal(LETTERS.length, 27);
});

test("collation: base sensitivity, numeric, accents with their letter, # last", () => {
  const rows = ["zoe", "Émile", "emma", "Alex", "alex b", "10 Downing", "2 Rue", "中文", "Ada"].map((n) => person(`id-${n}`, n));
  const sorted = [...rows].sort(compareRows(makeCollator("fr"))).map((r) => r.name);
  assert.deepEqual(sorted, ["Ada", "Alex", "alex b", "Émile", "emma", "zoe", "2 Rue", "10 Downing", "中文"]);
  assert.equal(makeCollator("en").compare("a", "A"), 0);
  assert.equal(makeCollator("en").compare("e", "é"), 0);
  assert.ok(makeCollator("en").compare("a2", "a10") < 0);
  assert.ok(makeCollator("not a locale!!") instanceof Intl.Collator, "a bad locale falls back");
});

test("foldText: accents, case, ligatures, apostrophes, format characters", () => {
  assert.equal(foldText("ÉLODÎE"), "elodie");
  assert.equal(foldText("Cœur"), "coeur");
  assert.equal(foldText("Æsop"), "aesop");
  assert.equal(foldText("Straße"), "strasse");
  assert.equal(foldText("O’Brien"), "o'brien");
  assert.equal(foldText("OʼBrien"), "o'brien");
  assert.equal(foldText("a‮b​c"), "abc");
  assert.equal(foldText("Créme"), "creme");
  assert.equal(foldText(undefined), "");
});

const BOOK = [
  person("p1", "Élodie Dúpont", ["EMAIL:Elodie@Example.org", "TEL:+33 6 12 34 56 78", "CATEGORIES:Book club,Famille", "NOTE:likes sailing"], "Dúpont;Élodie;;;"),
  person("p2", "Jean O’Brien", ["ORG:Cœur Santé", "TITLE:Straße Manager", "NICKNAME:JB"], "O’Brien;Jean;;;"),
  person("p3", "Alex Quinn", ["TEL:+1 (555) 010-0199", "TEL:+1 555 0200"], "Quinn;Alex;;;"),
  person("p4", "Zoë Example", ["EMAIL:zoe@example.org"]),
  card(["UID:g1", "FN:Family", "KIND:group", "MEMBER:urn:uuid:p1"], { version: "4.0", href: "/u/book/g1.vcf" }),
];

test("search folds accents, case, ligatures and apostrophes (FR and EN)", () => {
  const find = (q) => search(BOOK, q).map((s) => s.uid);
  assert.deepEqual(find("elodie"), ["p1"]);
  assert.deepEqual(find("ÉLODIE"), ["p1"]);
  assert.deepEqual(find("dupont"), ["p1"]);
  assert.deepEqual(find("o'brien"), ["p2"]);
  assert.deepEqual(find("obrien"), [], "an apostrophe is not silently dropped");
  assert.deepEqual(find("coeur"), ["p2"], "oe ligature in the organisation");
  assert.deepEqual(find("strasse"), ["p2"], "ss for the sharp s in the title");
  assert.deepEqual(find("jb"), ["p2"], "nickname");
  assert.deepEqual(find("zoe"), ["p4"]);
  assert.deepEqual(find("famille"), ["p1"], "category");
  assert.deepEqual(find("book club"), ["p1"], "every token must match");
  assert.deepEqual(find("book quinn"), []);
  assert.deepEqual(find("example.org").sort(), ["p1", "p4"], "e-mail domain");
  assert.deepEqual(find("  "), ["p1", "p2", "p3", "p4"], "an empty query lists every contact, never the group");
  assert.deepEqual(find("family"), [], "group cards are not searched");
});

test("search: notes are not searched", () => {
  assert.deepEqual(search(BOOK, "sailing"), []);
  assert.deepEqual(search(BOOK, "secret"), []);
});

test("search: phones compare on digits once the query has at least 3 digits", () => {
  const find = (q) => search(BOOK, q).map((s) => s.uid);
  assert.deepEqual(find("555 0100"), ["p3"], "the whole query is compared on digits");
  assert.deepEqual(find("5550100199"), ["p3"], "digits across the formatting");
  assert.deepEqual(find("(555) 010"), ["p3"]);
  assert.deepEqual(find("+33 6 12"), ["p1"]);
  assert.deepEqual(find("0200"), ["p3"]);
  assert.deepEqual(find("555"), ["p3"]);
  assert.deepEqual(find("12"), [], "fewer than 3 digits do not search phones");
  assert.deepEqual(find("alex 0200"), ["p3"], "a name token and a phone token together");
  assert.deepEqual(find("alex 9999"), []);
});

test("matches and parseQuery: a query is parsed once", () => {
  const pq = parseQuery("  Alex  ");
  assert.deepEqual(pq.tokens, ["alex"]);
  assert.equal(parseQuery("").empty, true);
  assert.equal(matches(BOOK[2], pq), true);
  assert.equal(matches(BOOK[0], pq), false);
});

test("groups are excluded from the list, the count and the split", () => {
  assert.equal(countContacts(BOOK), 4);
  const { contacts, groups } = splitBook(BOOK);
  assert.equal(contacts.length, 4);
  assert.deepEqual(groups.map((g) => g.uid), ["g1"]);
  const { rows, total } = buildList(BOOK, { lang: "en" });
  assert.equal(total, 4);
  assert.deepEqual(rows.map((r) => r.uid), ["p1", "p2", "p3", "p4"]);
  assert.ok(!rows.some((r) => r.isGroup));
  assert.equal(rows.map((r) => r.letter).join(""), "DOQZ");
});

test("group filter keeps the members of a group (UUID case and urn prefix do not matter)", () => {
  const u = "11111111-2222-3333-4444-555555555501";
  const rows = [person(u.toUpperCase(), "A"), person("other", "B")];
  assert.deepEqual(filterByMembers(rows, new Set([memberKey(`urn:uuid:${u}`)])).map((r) => r.name), ["A"]);
  assert.equal(memberKey("urn:uuid:ABC"), "ABC");
  assert.equal(memberKey(undefined), "");
});

test("buildList filters by query and sorts", () => {
  const r = buildList(BOOK, { query: "example.org", lang: "fr" });
  assert.equal(r.rows.length, 2);
  assert.equal(r.total, 4);
});

// -- windowing --------------------------------------------------------------------------------------------

const many = (n) => Array.from({ length: n }, (_, i) => ({ uid: `u${i}`, letter: LETTERS[Math.min(26, Math.floor(i / 80))], name: `n${i}` }));

test("windowRows: 250 rows, counts for 'showing 1-250 of 2,000', show more / earlier data", () => {
  const rows = many(2000);
  const w = windowRows(rows);
  assert.equal(w.rows.length, 250);
  assert.deepEqual([w.from, w.to, w.total], [1, 250, 2000]);
  assert.deepEqual(w.showMore, { testId: "btn-show-more", count: 250, hidden: 1750, nextSize: 500 });
  assert.equal(w.showEarlier, null);
  const w2 = windowRows(rows, { size: w.showMore.nextSize });
  assert.deepEqual([w2.from, w2.to], [1, 500]);
  const last = windowRows(rows, { from: 1900 });
  assert.deepEqual([last.from, last.to, last.hiddenAfter], [1901, 2000, 0]);
  assert.equal(last.showMore, null);
  assert.deepEqual(last.showEarlier, { testId: "btn-show-earlier", count: 250, hidden: 1900, from: 1650 });
  const mid = windowRows(rows, { from: 100, size: 50 });
  assert.equal(mid.showMore.count, 50);
  assert.equal(mid.showEarlier.from, 50);
  assert.equal(windowRows(rows, { from: 10, size: 50 }).showEarlier.count, 10);
  assert.equal(windowRows(rows, { from: 1990 }).rows.length, 10);
});

test("windowRows: from a letter, from a letter without rows, small and empty lists, bad input", () => {
  const rows = many(2000); // A: 0-79, B: 80-159 ...
  assert.equal(windowRows(rows, { from: "C" }).start, 160);
  const gaps = [{ letter: "A" }, { letter: "A" }, { letter: "D" }, { letter: "#" }];
  assert.equal(windowRows(gaps, { from: "B" }).start, 2, "next letter that has rows");
  assert.equal(windowRows(gaps, { from: "#" }).start, 3);
  assert.equal(windowRows([{ letter: "A" }], { from: "Z" }).start, 0, "past the end: last window");
  const e = windowRows([]);
  assert.deepEqual([e.from, e.to, e.total, e.showMore, e.showEarlier], [0, 0, 0, null, null]);
  const small = windowRows(many(3));
  assert.deepEqual([small.from, small.to, small.showMore], [1, 3, null]);
  assert.equal(windowRows(rows, { from: -5 }).start, 0);
  assert.equal(windowRows(rows, { from: 99999 }).start, 1999);
  assert.equal(windowRows(rows, { from: "??" }).start, 0);
  assert.equal(windowRows(rows, { size: 0 }).rows.length, 250);
  assert.equal(windowRows(rows, { size: NaN }).rows.length, 250);
});

test("azIndex: one entry per letter with counts and the first index; test ids", () => {
  const rows = [{ letter: "A" }, { letter: "A" }, { letter: "C" }, { letter: "#" }];
  const idx = azIndex(rows);
  assert.equal(idx.length, 27);
  assert.deepEqual(idx[0], { letter: "A", testId: "az-A", count: 2, index: 0, present: true });
  assert.deepEqual(idx[1], { letter: "B", testId: "az-B", count: 0, index: -1, present: false });
  assert.deepEqual(idx[2], { letter: "C", testId: "az-C", count: 1, index: 2, present: true });
  assert.deepEqual(idx[26], { letter: "#", testId: "az-hash", count: 1, index: 3, present: true });
});

// -- duplicates and keys -------------------------------------------------------------------------------------------

test("findDuplicates: same name, e-mail or phone; informational; never the card itself or a group", () => {
  const a = person("d1", "Jane Doe", ["EMAIL:jane@example.org", "TEL:+1 555 0100"]);
  const same = person("d2", "jane  doe".replace("  ", " "), []);
  const mail = person("d3", "J. Doe", ["EMAIL:JANE@example.org"]);
  const tel = person("d4", "Other", ["TEL:+1-555-0100"]);
  const short = person("d5", "Short", ["TEL:123"]);
  const none = person("d6", "Nobody", ["EMAIL:n@example.org"]);
  const grp = card(["UID:d7", "FN:Jane Doe", "KIND:group"], { version: "4.0" });
  const r = findDuplicates(a, [a, same, mail, tel, short, none, grp]);
  assert.deepEqual(r.map((x) => [x.summary.uid, x.reasons]), [["d2", ["name"]], ["d3", ["email"]], ["d4", ["phone"]]]);
  assert.deepEqual(findDuplicates(person("x", "Short", ["TEL:123"]), [short]).map((x) => x.reasons), [["name"]], "a short number is not a phone match");
  assert.deepEqual(findDuplicates(person("y", "", []), [person("z", "", [])]), [], "an empty name matches nothing");
});

test("route keys: the UID when unique, else the file name; new and groups are never keys", () => {
  const a = person("uid-a", "A");
  const b = card(["UID:dup", "FN:B"], { href: "/u/book/b%201.vcf" });
  const c = card(["UID:dup", "FN:C"], { href: "/u/book/c.vcf" });
  const n = card(["UID:new", "FN:N"], { href: "/u/book/n.vcf" });
  const g = card(["UID:groups", "FN:G"], { href: "/u/book/g.vcf" });
  const all = [a, b, c, n, g];
  assert.equal(keyFor(a, all), "uid-a");
  assert.equal(keyFor(b, all), "b 1.vcf");
  assert.equal(keyFor(c, all), "c.vcf");
  assert.equal(keyFor(n, all), "n.vcf");
  assert.equal(keyFor(g, all), "g.vcf");
  for (const s of all) assert.equal(resolveKey(keyFor(s, all), all), s);
  assert.equal(resolveKey("dup", all), null, "an ambiguous UID resolves to nothing");
  assert.equal(resolveKey("missing", all), null);
  assert.equal(resolveKey("", all), null);
  assert.equal(resolveKey("x".repeat(300), all), null, "over-long keys are refused");
  assert.equal(resolveKey(undefined, all), null);
  const long = person("u".repeat(300), "L");
  assert.ok(keyFor(long, [long]).endsWith(".vcf"), "a UID too long for a key falls back to the file name");
  const nouid = { uid: null, href: "/u/book/x%2Fy.vcf" };
  assert.equal(keyFor(nouid, [nouid]), "x/y.vcf");
  assert.equal(resolveKey("x/y.vcf", [nouid]), nouid);
  assert.equal(keyFor({ uid: null, href: "/u/book/%E0%A4%A.vcf" }, []), "%E0%A4%A.vcf", "undecodable names stay as they are");
});

// -- unreadable items, corpus, hostile ----------------------------------------------------------------------------------

test("items that do not open give a read-only summary with a reason, a best-effort name and no throw", () => {
  const byName = Object.fromEntries(fixtures().filter((f) => f.name.startsWith("vcf/")).map((f) => [f.file, f]));
  for (const [file, reason] of [["vcard21-basic.vcf", "unsupported-version"], ["vcard-multiple.vcf", "multiple-vcards"], ["vcard-malformed.vcf", "parse-error"]]) {
    const s = summarize(byName[file].text, { href: `/u/b/${file}`, etag: '"e"' });
    assert.equal(s.readOnly, true, file);
    assert.equal(s.reason, reason, file);
    assert.equal(s.href, `/u/b/${file}`);
    assert.equal(s.etag, '"e"');
    assert.equal(typeof s.name, "string");
  }
  assert.ok(summarize(byName["vcard21-basic.vcf"].text).name.length > 0);
  const g = summarize("BEGIN:VCARD\nVERSION:2.1\nUID:x\nX-ADDRESSBOOKSERVER-KIND:group\nFN:Old group\nEND:VCARD\n");
  assert.equal(g.isGroup, true, "an unreadable group card is still excluded from the list");
  assert.equal(summarize("").readOnly, true);
  assert.equal(summarize(undefined).readOnly, true);
});

test("every vcf fixture summarises without throwing; group fixtures are flagged", () => {
  let groups = 0;
  for (const f of fixtures().filter((x) => x.name.startsWith("vcf/"))) {
    const s = summarize(f.text, { href: `/u/b/${f.file}` });
    assert.equal(typeof s.name, "string", f.name);
    assert.ok(/^[A-Z#]$/.test(s.letter), f.name);
    if (s.isGroup) groups++;
  }
  assert.ok(groups >= 5, String(groups));
});

test("hostile input is plain text: script payloads, bidi, huge strings", () => {
  const h = summarize(fixtures().find((f) => f.file === "vcard40-hostile.vcf").text, { href: "/u/b/h.vcf" });
  assert.equal(h.name, "<script>alert(1)</script> Hostile");
  assert.equal(h.letter, "H");
  assert.equal(search([h], "script").length, 1);
  const bidi = summarize(fixtures().find((f) => f.file === "vcard30-bidi.vcf").text, { href: "/u/b/i.vcf" });
  assert.equal(search([bidi], "evil").length, 1, "bidi controls do not break matching");
  const huge = person("big", "x".repeat(1_000_000) + " needle", ["NOTE:" + "n".repeat(500_000)]);
  assert.equal(huge.name.length, 1_000_007);
  const t0 = Date.now();
  assert.equal(search([huge], "needle").length, 0, "only the first 1,000 characters of a field are searched");
  assert.equal(search([huge], "xxxx").length, 1);
  assert.ok(Date.now() - t0 < 500);
});

test("a book of 2,000 contacts is listed, searched and windowed quickly", () => {
  const book = Array.from({ length: 2000 }, (_, i) => person(`id-${i}`, `Name${i} Sample${i % 37}`, [`EMAIL:n${i}@example.org`]));
  const t0 = Date.now();
  const { rows } = buildList(book, { query: "sample7", lang: "en" });
  assert.ok(rows.length > 0 && rows.length < 2000);
  assert.equal(buildList(book, { lang: "en" }).rows.length, 2000);
  assert.ok(Date.now() - t0 < 2000);
});
