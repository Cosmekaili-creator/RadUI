// SPDX-License-Identifier: AGPL-3.0-or-later
// conflict.js: diffOwned and the row-level three-way merge (RUN2 addendum B1).
import test from "node:test";
import assert from "node:assert/strict";
import { openItem } from "../../../src/js/model/item.js";
import { canSaveAsCopy, diffOwned, membershipDelta, rebaseMembership, rebasePatch } from "../../../src/js/model/conflict.js";
import { fixture } from "./helpers.mjs";

const NOW = new Date("2026-11-13T10:00:00Z");

const CARD = `BEGIN:VCARD
VERSION:3.0
PRODID:-//Example Contacts//Contacts 1.0//EN
UID:conflict-1
FN:Casey Base
N:Base;Casey;;;
NICKNAME:Cas
ORG:Example Org
TITLE:Analyst
TEL;TYPE=CELL:+1 555 0101
TEL;TYPE=WORK,VOICE:+1 555 0102
TEL;TYPE=HOME:+1 555 0103
EMAIL;TYPE=INTERNET,HOME:casey@example.org
ADR;TYPE=HOME:;;1 Example Road;Sampletown;;00001;Exampleland
URL:https://example.org/casey
NOTE:Base note
CATEGORIES:One,Two
END:VCARD
`;

/** An item with extra / replaced lines (a helper to build "their" version). */
function card({ drop = [], replace = {}, extra = [] } = {}) {
  let t = CARD;
  for (const d of drop) t = t.replace(new RegExp(`^${d.replace(/[+]/g, "\\+")}.*\\n`, "m"), "");
  for (const [from, to] of Object.entries(replace)) t = t.replace(from, to);
  t = t.replace("END:VCARD\n", extra.map((l) => l + "\n").join("") + "END:VCARD\n");
  return openItem(t, "contact");
}

const rows = (list, over = {}) => list.map((e) => ({ prop: e.prop, value: e.value, types: e.types, pref: undefined, label: undefined, ...over }));
const apply = (theirs, patch) => {
  theirs.update(patch);
  return theirs.save({ now: NOW }).text;
};
const flat = (t) => t.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);

// -- diffOwned ------------------------------------------------------------------------------------

test("diffOwned: only fields that changed on a side and now differ; both marks fields both sides changed", () => {
  const base = card();
  const mine = card({ replace: { "FN:Casey Base": "FN:Casey Mine", "TITLE:Analyst": "TITLE:Lead" } });
  const theirs = card({ replace: { "FN:Casey Base": "FN:Casey Theirs", "NOTE:Base note": "NOTE:Their note" } });
  const d = diffOwned(base, mine, theirs);
  assert.deepEqual(d.map((r) => r.field), ["fn", "title", "note"]);
  const fn = d.find((r) => r.field === "fn");
  assert.deepEqual([fn.mine, fn.theirs, fn.both], ["Casey Mine", "Casey Theirs", true]);
  assert.deepEqual([d[1].mine, d[1].theirs, d[1].both], ["Lead", "Analyst", false]);
  assert.deepEqual([d[2].mine, d[2].theirs, d[2].both], ["Base note", "Their note", false]);
});

test("diffOwned: identical changes are no conflict; no change gives no rows; accepts fields objects", () => {
  const base = card();
  const same = card({ replace: { "TITLE:Analyst": "TITLE:Lead" } });
  assert.deepEqual(diffOwned(base, same, same), []);
  assert.deepEqual(diffOwned(base, base, base), []);
  const m = card({ replace: { "TITLE:Analyst": "TITLE:Lead" } });
  assert.equal(diffOwned(base.fields(), m.fields(), base.fields()).length, 1);
});

test("diffOwned: lists show one line per row; the photo is only changed / unchanged", () => {
  const base = card();
  const mine = card({ extra: ["TEL;TYPE=CELL:+1 555 0188"] });
  const theirs = card({ extra: ["PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA=="] });
  const d = diffOwned(base, mine, theirs);
  const tel = d.find((r) => r.field === "tel");
  assert.equal(tel.kind, "list");
  assert.equal(tel.mine.length, 4);
  assert.ok(tel.mine.includes("+1 555 0188 (cell)"));
  assert.equal(tel.theirs.length, 3);
  const photo = d.find((r) => r.field === "photo");
  assert.deepEqual([photo.kind, photo.mine, photo.theirs, photo.both], ["photo", "unchanged", "changed", false]);
  // a different photo on both sides: both changed
  const a = card({ extra: ["PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA=="] });
  const b = card({ extra: ["PHOTO;ENCODING=b;TYPE=JPEG:RUZHSA=="] });
  const p = diffOwned(base, a, b).find((r) => r.field === "photo");
  assert.deepEqual([p.mine, p.theirs, p.both], ["changed", "changed", true]);
  assert.equal(diffOwned(base, a, a).length, 0);
});

test("diffOwned: group cards compare the member set", () => {
  const src = fixture("vcard40-group-unknown-member.vcf");
  const base = openItem(src, "contact");
  const mine = openItem(src, "contact");
  mine.update({ membersDelta: { add: ["urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"], remove: [] } });
  const theirs = openItem(src, "contact");
  theirs.update({ membersDelta: { add: [], remove: ["mailto:visitor@example.org"] } });
  const r = diffOwned(base, mine, theirs).find((x) => x.field === "members");
  assert.equal(r.mine.length, 5);
  assert.equal(r.theirs.length, 3);
  assert.equal(r.both, true, "both sides changed the member set");
});

// -- rebasePatch: entries ------------------------------------------------------------------------------

test("rebase: their added phone is preserved, my edit of another row is applied", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[0].value = "+1 555 0191";
  const theirs = card({ extra: ["TEL;TYPE=FAX:+1 555 0199"] });
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.unmappable, []);
  assert.equal(r.noop, false);
  const out = flat(apply(theirs, r.patch));
  assert.ok(out.includes("TEL;TYPE=CELL:+1 555 0191"));
  assert.ok(out.includes("TEL;TYPE=FAX:+1 555 0199"), "their added row stays");
  assert.ok(out.includes("TEL;TYPE=HOME:+1 555 0103"));
  assert.deepEqual(r.applied.map((a) => [a.field, a.op]), [["tel", "modify"]]);
});

test("rebase: their edit of a row I did not touch is preserved", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { email: rows(f.email), tel: rows(f.tel) };
  minePatch.tel[1].value = "+1 555 0192"; // I change row 2
  const theirs = card({ replace: { "+1 555 0103": "+1 555 0123" } }); // they change row 3
  const r = rebasePatch(f, minePatch, theirs.fields());
  // row 3 changed on their side: it was not touched by me, so nothing is unmappable
  assert.deepEqual(r.unmappable, []);
  const out = flat(apply(theirs, r.patch));
  assert.ok(out.includes("TEL;TYPE=WORK,VOICE:+1 555 0192") || out.some((l) => /^TEL;TYPE=WORK,VOICE:\+1 555 0192/.test(l)));
  assert.ok(out.includes("TEL;TYPE=HOME:+1 555 0123"), "their edit stays");
  assert.ok(!r.patch.email, "an untouched list is not part of the patch");
});

test("rebase: a row they deleted that I changed is unmappable and is listed, not guessed", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[2].value = "+1 555 0193";
  const theirs = card({ drop: ["TEL;TYPE=HOME"] });
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.equal(r.unmappable.length, 1);
  assert.deepEqual([r.unmappable[0].field, r.unmappable[0].op, r.unmappable[0].reason], ["tel", "modify", "row-not-found"]);
  assert.match(r.unmappable[0].base, /\+1 555 0103/);
  assert.match(r.unmappable[0].mine, /\+1 555 0193/);
  assert.equal(r.noop, true, "nothing else to apply");
  assert.equal(r.patch.tel, undefined);
});

test("rebase: a row they changed that I removed is unmappable; a row they also deleted too (cannot tell) is listed", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: rows(f.tel).slice(0, 2) }; // I removed row 3
  const changedByThem = card({ replace: { "+1 555 0103": "+1 555 0123" } });
  const r = rebasePatch(f, minePatch, changedByThem.fields());
  assert.deepEqual(r.unmappable.map((u) => [u.op, u.reason]), [["remove", "row-not-found"]]);
  const sameRow = card();
  const r2 = rebasePatch(f, minePatch, sameRow.fields());
  assert.deepEqual(r2.unmappable, []);
  const out = flat(apply(sameRow, r2.patch));
  assert.ok(!out.some((l) => l.startsWith("TEL") && l.includes("0103")));
  assert.equal(out.filter((l) => l.startsWith("TEL")).length, 2);
});

test("rebase: rows are matched by (value, types); both sides changed the same row: mine wins per attribute", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[0] = { ...minePatch.tel[0], label: "Mine label" };
  minePatch.tel[1] = { ...minePatch.tel[1], types: ["home"] }; // I changed the types of row 2
  // they changed the label of row 1 and added a type token to row 2... but row 2's types changed: no (value,types) match
  const theirs = card({ replace: { "TEL;TYPE=CELL:+1 555 0101": "item1.TEL;TYPE=CELL:+1 555 0101\nitem1.X-ABLabel:Their label" } });
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.unmappable, []);
  const out = flat(apply(theirs, r.patch));
  assert.ok(out.some((l) => /^item1\.X-ABLabel:Mine label$/i.test(l)), "mine wins where both changed the label");
  assert.ok(!out.some((l) => l.includes("Their label")));
  assert.ok(out.some((l) => /^TEL;TYPE=home:\+1 555 0102$/i.test(l)), out.join("\n"));
});

test("rebase: adding a row appends it to theirs; the same row added on both sides is not duplicated", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: [...rows(f.tel), { value: "+1 555 0177", types: ["fax"], pref: false }] };
  const theirs = card();
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.applied.map((a) => a.op), ["add"]);
  assert.equal(flat(apply(theirs, r.patch)).filter((l) => l.startsWith("TEL")).length, 4);
  const both = card({ extra: ["TEL;TYPE=FAX:+1 555 0177"] });
  const r2 = rebasePatch(f, minePatch, both.fields());
  assert.equal(r2.noop, true);
  assert.deepEqual(r2.unmappable, []);
});

test("rebase: removing a row removes only that row from theirs and keeps their additions", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: rows(f.tel).filter((_, i) => i !== 1) };
  const theirs = card({ extra: ["TEL;TYPE=PAGER:+1 555 0166"] });
  const r = rebasePatch(f, minePatch, theirs.fields());
  const out = flat(apply(theirs, r.patch));
  assert.deepEqual(out.filter((l) => l.startsWith("TEL")).sort(), ["TEL;TYPE=CELL:+1 555 0101", "TEL;TYPE=HOME:+1 555 0103", "TEL;TYPE=PAGER:+1 555 0166"]);
});

test("rebase: multi-valued entries: identical rows are matched one by one; ADR parts merge", () => {
  const dup = openItem(CARD.replace("TEL;TYPE=HOME:+1 555 0103", "TEL;TYPE=CELL:+1 555 0101"), "contact");
  const f = dup.fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[2].label = "second";
  const theirsText = CARD.replace("TEL;TYPE=HOME:+1 555 0103", "TEL;TYPE=CELL:+1 555 0101");
  const theirs = openItem(theirsText, "contact");
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.unmappable, []);
  const out = flat(apply(theirs, r.patch));
  const i = out.findIndex((l) => /X-ABLabel:second$/i.test(l));
  assert.ok(i > 0 && out[i - 1].startsWith("item1.TEL") && out[i - 1].endsWith("+1 555 0101"), out.join("\n"));
  assert.equal(out.filter((l) => /^TEL;TYPE=CELL:\+1 555 0101$/.test(l)).length, 1, "the first of the identical rows is untouched");
  // ADR: I change the street, they change the city
  const base = card();
  const bf = base.fields();
  const adrPatch = { adr: bf.adr.map((e) => ({ prop: e.prop, value: { ...e.value, street: "9 New Road" }, types: e.types })) };
  const theirsAdr = card({ replace: { "Sampletown": "Theirtown" } });
  // their value changed, so the row's identity (value, types) no longer matches; the lists line up, so it is the same row:
  // my street over their city, no note (different parts)
  const r2 = rebasePatch(bf, adrPatch, theirsAdr.fields());
  assert.deepEqual(r2.unmappable, []);
  assert.deepEqual(r2.notes, []);
  const out2 = flat(apply(theirsAdr, r2.patch)).find((l) => l.startsWith("ADR"));
  assert.ok(out2.includes("9 New Road") && out2.includes("Theirtown"), out2);
  // same value on their side, only the label differs: the street change applies, parts merge
  const theirsLabel = card({ replace: { "ADR;TYPE=HOME:": "item2.ADR;TYPE=HOME:" }, extra: ["item2.X-ABLabel:Home base"] });
  const r3 = rebasePatch(bf, adrPatch, theirsLabel.fields());
  assert.deepEqual(r3.unmappable, []);
  const out3 = flat(apply(theirsLabel, r3.patch));
  assert.ok(out3.some((l) => l.includes("9 New Road") && l.startsWith("item2.ADR")), out3.join("\n"));
  assert.ok(out3.includes("item2.X-ABLabel:Home base"));
});

test("rebase: an echo of the base list changes nothing and leaves their list alone", () => {
  const base = card();
  const f = base.fields();
  const theirs = card({ extra: ["TEL;TYPE=FAX:+1 555 0199"] });
  const r = rebasePatch(f, { tel: rows(f.tel), email: rows(f.email), adr: rows(f.adr), url: rows(f.url) }, theirs.fields());
  assert.deepEqual(r, { patch: {}, unmappable: [], applied: [], notes: [], noop: true });
});

// -- scalars -------------------------------------------------------------------------------------------

test("rebase: scalar fields: mine wins when both changed; untouched fields follow theirs; equal results drop out", () => {
  const base = card();
  const f = base.fields();
  const theirs = card({ replace: { "FN:Casey Base": "FN:Casey Theirs", "NOTE:Base note": "NOTE:Their note", "TITLE:Analyst": "TITLE:Lead" } });
  const r = rebasePatch(f, { fn: "Casey Mine", note: "Base note", title: "Lead", nickname: ["Cas"] }, theirs.fields());
  assert.deepEqual(r.patch, { fn: "Casey Mine" }, "note unchanged by me follows theirs; title already says it");
  const out = flat(apply(theirs, r.patch));
  assert.ok(out.includes("FN:Casey Mine") && out.includes("NOTE:Their note") && out.includes("TITLE:Lead"));
});

test("rebase: N parts, ORG, nickname, dates and categories", () => {
  const base = card();
  const f = base.fields();
  const theirs = card({ replace: { "N:Base;Casey;;;": "N:Base;Cassandra;;;", "ORG:Example Org": "ORG:Their Org;Unit", "CATEGORIES:One,Two": "CATEGORIES:One,Two,Theirs" } });
  const minePatch = {
    n: { ...f.n, family: "Mine" },
    org: { name: "Example Org", units: ["My unit"] },
    nickname: ["Case"],
    bday: { year: 1990, month: 5, day: 6 },
    categories: ["One", "Mine"],
  };
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.patch.n, { family: "Mine", given: "Cassandra", additional: "", prefix: "", suffix: "" });
  assert.deepEqual(r.patch.org, { name: "Their Org", units: ["My unit"] });
  assert.deepEqual(r.patch.nickname, ["Case"]);
  assert.deepEqual(r.patch.bday, { year: 1990, month: 5, day: 6 });
  assert.deepEqual(r.patch.categories, ["One", "Theirs", "Mine"], "their category stays, my removal of Two and my new one apply");
  const out = flat(apply(theirs, r.patch));
  assert.ok(out.includes("N:Mine;Cassandra;;;"));
  assert.ok(out.includes("BDAY:1990-05-06"));
});

test("rebase: photo: set wins; removal only when they still have one", () => {
  const withPhoto = (extra) => card({ extra: extra ? ["PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA=="] : [] });
  const f = withPhoto(true).fields();
  const set = rebasePatch(f, { photo: { mime: "image/jpeg", base64: "RUZHSA==" } }, withPhoto(true).fields());
  assert.deepEqual(set.patch.photo, { mime: "image/jpeg", base64: "RUZHSA==" });
  assert.deepEqual(rebasePatch(f, { photo: null }, withPhoto(true).fields()).patch, { photo: null });
  assert.equal(rebasePatch(f, { photo: null }, withPhoto(false).fields()).noop, true);
  const t = withPhoto(true);
  const out = flat(apply(t, set.patch));
  assert.ok(out.some((l) => l.startsWith("PHOTO") && l.endsWith("RUZHSA==")));
});

// -- groups ---------------------------------------------------------------------------------------------

test("membershipDelta / rebaseMembership: add and remove ONE member, never the full list", () => {
  const d = membershipDelta(["urn:uuid:a", "urn:uuid:b"], ["urn:uuid:b", "urn:uuid:c"]);
  assert.deepEqual(d, { add: ["urn:uuid:c"], remove: ["urn:uuid:a"] });
  const r = rebaseMembership(d, ["urn:uuid:a", "urn:uuid:b", "urn:uuid:x", "mailto:o@example.org"]);
  assert.deepEqual(r.delta, { add: ["urn:uuid:c"], remove: ["urn:uuid:a"] });
  assert.deepEqual(r.members, ["urn:uuid:b", "urn:uuid:x", "mailto:o@example.org", "urn:uuid:c"], "their additions and unknown members stay");
  // already done on their side
  const done = rebaseMembership(d, ["urn:uuid:b", "urn:uuid:c"]);
  assert.deepEqual(done.delta, { add: [], remove: [] });
  assert.equal(done.changed, false);
  assert.equal(rebaseMembership({ add: ["urn:uuid:AAAAAAAA-0000-4000-8000-000000000001"], remove: [] }, ["urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"]).changed, false, "case-insensitive for the same member");
});

for (const [name, unknown] of [["vcard30-group-apple-labels.vcf", "mailto:outsider@example.org"], ["vcard40-group-unknown-member.vcf", "mailto:visitor@example.org"]]) {
  test(`rebase: group card ${name}: my one-member delta is replayed on their member list`, () => {
    const src = fixture(name);
    const base = openItem(src, "contact");
    const bf = base.fields();
    const mine = [...bf.group.members, "urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"].filter((m) => m !== unknown);
    const theirs = openItem(src, "contact");
    theirs.update({ membersDelta: { add: ["urn:uuid:aaaaaaaa-0000-4000-8000-000000000009"], remove: [] } });
    const r = rebasePatch(bf, { members: mine }, theirs.fields());
    assert.deepEqual(r.patch, { membersDelta: { add: ["urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"], remove: [unknown] } });
    assert.equal(r.patch.members, undefined, "never the full list");
    theirs.update(r.patch);
    const members = theirs.fields().group.members;
    assert.ok(members.includes("urn:uuid:aaaaaaaa-0000-4000-8000-000000000009"), "their added member stays");
    assert.ok(members.includes("urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"));
    assert.ok(!members.includes(unknown));
    assert.equal(members.length, bf.group.members.length + 1);
    // the delta form is accepted as input too
    const r2 = rebasePatch(bf, { membersDelta: { add: ["urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"], remove: [] } }, base.fields());
    assert.deepEqual(r2.patch.membersDelta.add, ["urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"]);
  });
}

test("canSaveAsCopy: group cards cannot be copied", () => {
  assert.equal(canSaveAsCopy(openItem(fixture("vcard40-group-unknown-member.vcf"), "contact")), false);
  assert.equal(canSaveAsCopy(openItem(fixture("vcard30-group-apple-labels.vcf"), "contact").fields()), false);
  assert.equal(canSaveAsCopy(card()), true);
  assert.equal(canSaveAsCopy(card().fields()), true);
});

// -- one preferred row, notes -------------------------------------------------------------------------

test("rebase: each side marked a different row preferred: mine wins, theirs is cleared and noted", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[0] = { ...minePatch.tel[0], pref: true }; // I prefer the cell
  const theirs = card({ replace: { "TEL;TYPE=HOME:+1 555 0103": "TEL;TYPE=HOME,pref:+1 555 0103" } }); // they prefer home
  assert.deepEqual(theirs.fields().tel.map((t) => t.pref), [false, false, true]);
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.notes, [{ field: "tel", code: "pref-moved", row: "+1 555 0103 (home, pref)" }]);
  assert.ok(r.applied.some((a) => a.op === "unpref"));
  const out = flat(apply(theirs, r.patch));
  assert.equal(out.filter((l) => l.startsWith("TEL") && /pref/i.test(l)).length, 1, out.join("\n"));
  assert.ok(out.some((l) => /^TEL;TYPE=CELL,pref:\+1 555 0101$/i.test(l)));
});

test("rebase: a row that was already preferred in the base, or a row I did not mark, keeps its preference", () => {
  const prefBase = openItem(CARD.replace("TEL;TYPE=HOME:+1 555 0103", "TEL;TYPE=HOME,pref:+1 555 0103"), "contact");
  const f = prefBase.fields();
  const mine = { tel: rows(f.tel) };
  mine.tel[0] = { ...mine.tel[0], pref: true };
  const r = rebasePatch(f, mine, prefBase.fields());
  assert.deepEqual(r.notes, [], "two preferred rows existed before: not touched");
  // they marked a row, I changed something else
  const base = card();
  const f2 = base.fields();
  const theirs = card({ replace: { "TEL;TYPE=HOME:+1 555 0103": "TEL;TYPE=HOME,pref:+1 555 0103" } });
  const m2 = { tel: rows(f2.tel) };
  m2.tel[0].value = "+1 555 0191";
  assert.deepEqual(rebasePatch(f2, m2, theirs.fields()).notes, []);
});

test("rebase: a preferred row I add also takes the preference from a row they newly marked", () => {
  const base = card();
  const f = base.fields();
  const theirs = card({ replace: { "TEL;TYPE=HOME:+1 555 0103": "TEL;TYPE=HOME,pref:+1 555 0103" } });
  const r = rebasePatch(f, { tel: [...rows(f.tel), { value: "+1 555 0177", types: ["fax"], pref: true }] }, theirs.fields());
  assert.equal(r.notes.length, 1);
  const out = flat(apply(theirs, r.patch));
  assert.equal(out.filter((l) => l.startsWith("TEL") && /pref/i.test(l)).length, 1);
});

test("rebase: ORG units edited on both sides: mine wins and a note says so", () => {
  const base = openItem(CARD.replace("ORG:Example Org", "ORG:Example Org;Sales"), "contact");
  const f = base.fields();
  const theirs = openItem(CARD.replace("ORG:Example Org", "ORG:Example Org;Support"), "contact");
  const r = rebasePatch(f, { org: { name: "Example Org", units: ["Marketing"] } }, theirs.fields());
  assert.deepEqual(r.patch.org, { name: "Example Org", units: ["Marketing"] });
  assert.deepEqual(r.notes, [{ field: "org", code: "both-edited", parts: ["units"] }]);
  const one = rebasePatch(f, { org: { name: "Example Org", units: ["Marketing"] } }, base.fields());
  assert.deepEqual(one.notes, [], "only I edited it");
});

test("rebase: they removed ORG or N while I edited a part: my version is kept and noted", () => {
  const base = card();
  const f = base.fields();
  const theirs = card({ drop: ["ORG:", "N:"] });
  assert.equal(theirs.fields().org, null);
  const r = rebasePatch(f, { org: { name: "Mine Org", units: [] }, n: { ...f.n, given: "Mine" } }, theirs.fields());
  assert.deepEqual(r.patch.org, { name: "Mine Org", units: [] });
  assert.deepEqual(r.patch.n, { ...f.n, given: "Mine" });
  assert.equal(r.notes.length, 2);
  assert.ok(r.notes.some((n) => n.field === "org" && n.code === "theirs-removed" && n.parts.includes("name")));
  assert.ok(r.notes.some((n) => n.field === "n" && n.code === "theirs-removed" && n.parts.includes("given")));
  const out = flat(apply(theirs, r.patch));
  assert.ok(out.includes("ORG:Mine Org") && out.some((l) => l.startsWith("N:Base;Mine")));
  // nothing edited: nothing noted
  assert.deepEqual(rebasePatch(f, { org: f.org, n: f.n }, theirs.fields()).notes, []);
});

// -- both sides edited the same phone value (RUN4 WP C) ------------------------------------------------

function samePhoneCase(theirsValue) {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[0].value = "+1 555 0191"; // I change row 1 to B
  const theirs = card({ replace: { "+1 555 0101": theirsValue } }); // they change row 1 too
  return { f, theirs, r: rebasePatch(f, minePatch, theirs.fields()) };
}

test("rebase: both sides changed the same phone to the SAME value: nothing to send and nothing to confirm", () => {
  const { r } = samePhoneCase("+1 555 0191");
  assert.deepEqual(r.unmappable, [], "their row already says it: nothing is left out");
  assert.equal(r.noop, true);
  assert.equal(r.patch.tel, undefined);
  assert.deepEqual(r.notes, []);
});

test("rebase: both sides changed the same phone to DIFFERENT values: mine wins on that row (it is not lost), and a note says so", () => {
  const { theirs, r } = samePhoneCase("+1 555 0192");
  assert.deepEqual(r.unmappable, []);
  assert.equal(r.noop, false);
  assert.deepEqual(r.notes, [{ field: "tel", code: "both-edited", parts: ["value"] }]);
  const out = flat(apply(theirs, r.patch)).filter((l) => l.startsWith("TEL"));
  assert.deepEqual(out, ["TEL;TYPE=CELL:+1 555 0191", "TEL;TYPE=WORK,VOICE:+1 555 0102", "TEL;TYPE=HOME:+1 555 0103"]);
});

test("rebase: two different phones edited, one on each side: both edits are kept", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[0].value = "+1 555 0191";
  const theirs = card({ replace: { "+1 555 0103": "+1 555 0123" } });
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.unmappable, []);
  assert.deepEqual(r.notes, []);
  const out = flat(apply(theirs, r.patch)).filter((l) => l.startsWith("TEL"));
  assert.deepEqual(out, ["TEL;TYPE=CELL:+1 555 0191", "TEL;TYPE=WORK,VOICE:+1 555 0102", "TEL;TYPE=HOME:+1 555 0123"]);
});

test("rebase: a row is never paired by position when the lists differ in length (they deleted one row and edited another)", () => {
  const base = card();
  const f = base.fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[0].value = "+1 555 0191"; // I edit row 1
  // they deleted row 1 and edited row 2: their first row is NOT the row I edited
  const theirs = card({ drop: ["TEL;TYPE=CELL"], replace: { "+1 555 0102": "+1 555 0122" } });
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.unmappable.map((u) => [u.field, u.op, u.reason]), [["tel", "modify", "row-not-found"]]);
  assert.equal(r.noop, true);
});

// -- pairing by position needs a shared identity (row kept: same value or same types) -------------------

function cardText(telLines) {
  return openItem(CARD.replace(/^TEL.*\n/gm, "").replace("EMAIL;", telLines.map((l) => l + "\n").join("") + "EMAIL;"), "contact");
}

test("rebase: a reordered list whose rows were all re-typed on their side is not paired by position: unmappable, nothing patched", () => {
  const f = card().fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[0].value = "+1 555 0199"; // I edit the cell number
  // they reordered the rows and added VOICE to every row: no row matches by value + types, the lengths are equal
  const theirs = cardText(["TEL;TYPE=WORK,VOICE,MSG:+1 555 0102", "TEL;TYPE=CELL,VOICE:+1 555 0101", "TEL;TYPE=HOME,VOICE:+1 555 0103"]);
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.unmappable.map((u) => [u.field, u.op, u.reason]), [["tel", "modify", "row-not-found"]]);
  assert.equal(r.patch.tel, undefined, "no patch: their work number is not overwritten");
  assert.deepEqual(r.notes, []);
  assert.equal(r.noop, true);
});

test("rebase: their last row deleted and another one added (same length, other value and types) is not my row", () => {
  const f = card().fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[2].value = "+1 555 0193"; // I edit the home number
  const theirs = card({ drop: ["TEL;TYPE=HOME"], extra: ["TEL;TYPE=FAX:+1 555 0177"] });
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.unmappable.map((u) => [u.field, u.op, u.reason]), [["tel", "modify", "row-not-found"]]);
  assert.equal(r.patch.tel, undefined);
  assert.equal(r.noop, true);
});

test("rebase: a type-only edit on their side keeps the row paired by position (same value)", () => {
  const f = card().fields();
  const minePatch = { tel: rows(f.tel) };
  minePatch.tel[0].value = "+1 555 0191";
  const theirs = card({ replace: { "TEL;TYPE=CELL:": "TEL;TYPE=CELL,VOICE:" } });
  const r = rebasePatch(f, minePatch, theirs.fields());
  assert.deepEqual(r.unmappable, []);
  const out = flat(apply(theirs, r.patch)).filter((l) => l.startsWith("TEL"));
  assert.equal(out[0], "TEL;TYPE=CELL,VOICE:+1 555 0191");
});

test("rebase: the both-edited note names the parts that overlapped (types, value)", () => {
  const f = card().fields();
  // types: I set WORK on the cell row, they set HOME on it (same value)
  const mt = { tel: rows(f.tel) };
  mt.tel[0].types = ["WORK"];
  let r = rebasePatch(f, mt, card({ replace: { "TEL;TYPE=CELL:": "TEL;TYPE=HOME:" } }).fields());
  assert.deepEqual(r.notes, [{ field: "tel", code: "both-edited", parts: ["types"] }]);
  // value: the existing case stays value-only
  const mv = { tel: rows(f.tel) };
  mv.tel[0].value = "+1 555 0191";
  r = rebasePatch(f, mv, card({ replace: { "+1 555 0101": "+1 555 0192" } }).fields());
  assert.deepEqual(r.notes, [{ field: "tel", code: "both-edited", parts: ["value"] }]);
});
