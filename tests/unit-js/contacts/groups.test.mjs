// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { openItem } from "../../../src/js/model/item.js";
import { checkFidelity } from "../../../src/js/model/fidelity.js";
import { semdiff, changedNames } from "../../lib/semdiff.js";
import { fixture } from "../model/helpers.mjs";
import { summarize, filterByMembers } from "../../../src/js/contacts/index.js";
import {
  PICKER_LIMIT,
  addMemberPatch,
  affectedGroups,
  checkGroupName,
  groupsOf,
  memberCandidates,
  memberKeys,
  newGroup,
  readGroups,
  removeMemberPatch,
  renamePatch,
} from "../../../src/js/contacts/groups.js";

const NOW = new Date("2026-11-13T10:00:00Z");
const UID = (n) => `22222222-3333-4444-5555-${String(n).padStart(12, "0")}`;
const contact = (n, fn = `Contact ${n}`, uid = UID(n)) => summarize(`BEGIN:VCARD\nVERSION:3.0\nUID:${uid}\nFN:${fn}\nEND:VCARD\n`, { href: `/u/b/c${n}.vcf` });
const CONTACTS = [1, 2, 3, 4, 5].map((n) => contact(n));
const entry = (name, href) => ({ href, etag: '"e1"', text: fixture(name) });
const APPLE = entry("vcard30-group-apple-labels.vcf", "/u/b/apple.vcf");
const RFC = entry("vcard40-group-unknown-member.vcf", "/u/b/rfc.vcf");

test("readGroups: resolves members by UID, keeps unknown ones as unknown members", () => {
  const [apple, rfc] = readGroups([APPLE, RFC], CONTACTS);
  assert.deepEqual([apple.name, apple.form, apple.version, apple.href, apple.etag], ["Book club", "apple", "3.0", "/u/b/apple.vcf", '"e1"']);
  assert.deepEqual([apple.memberCount, apple.resolvedCount, apple.unknownCount], [4, 2, 2]);
  assert.deepEqual(apple.members.map((m) => [m.kind, m.uid || m.scheme]), [["contact", UID(1)], ["contact", UID(2)], ["unknown", "urn"], ["unknown", "mailto"]]);
  assert.equal(apple.members[0].summary, CONTACTS[0]);
  assert.equal(apple.members[2].uri, "urn:uuid:99999999-8888-7777-6666-555555555555");
  assert.deepEqual([rfc.name, rfc.form, rfc.version, rfc.resolvedCount, rfc.unknownCount], ["Project team", "rfc6350", "4.0", 2, 2]);
  assert.equal(apple.key, "urn:uuid:22222222-3333-4444-5555-000000000012");
  assert.equal(apple.uid, apple.key);
});

test("readGroups: skips contacts, unreadable cards and group cards that cannot be opened; duplicate member lines collapse", () => {
  const plain = { href: "/u/b/p.vcf", etag: null, text: fixture("vcard30-basic.vcf") };
  const bad = { href: "/u/b/bad.vcf", etag: null, text: "BEGIN:VCARD\nthis is not a card" };
  const L = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const dup = { href: "/u/b/d.vcf", etag: null, text: `BEGIN:VCARD\nVERSION:4.0\nUID:g\nKIND:group\nFN:Dup\nMEMBER:urn:uuid:${L}\nMEMBER:urn:uuid:${L.toUpperCase()}\nMEMBER:urn:uuid:${L}\nEND:VCARD\n` };
  const groups = readGroups([plain, bad, dup, null].filter(Boolean), [contact(1, "L", L)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].memberCount, 2, "the exact repeat collapses; the case variant is a line of its own");
  assert.equal(groups[0].resolvedCount, 2, "and it resolves to the same contact");
  assert.deepEqual(readGroups(undefined), []);
});

test("members resolve like memberMatches (prefix optional, UUID case-insensitive)", () => {
  const c = contact(9, "Nine", UID(9).toUpperCase());
  const g = readGroups([{ href: "/g", text: `BEGIN:VCARD\nVERSION:4.0\nUID:g\nKIND:group\nFN:G\nMEMBER:${UID(9)}\nEND:VCARD\n` }], [c])[0];
  assert.equal(g.members[0].kind, "contact");
});

test("group keys: the UID, or the file name when the UID is shared", () => {
  const twin = { href: "/u/b/twin.vcf", text: APPLE.text };
  const [a, b, c] = readGroups([APPLE, twin, RFC], CONTACTS);
  assert.equal(a.key, "apple.vcf");
  assert.equal(b.key, "twin.vcf");
  assert.equal(c.key, RFC.text.match(/UID:(.*)/)[1]);
});

test("groupsOf and affectedGroups: the groups a contact is in, and the delete consequence data", () => {
  const groups = readGroups([APPLE, RFC], CONTACTS);
  assert.deepEqual(groupsOf(groups, UID(1)).map((g) => g.name), ["Book club"]);
  assert.deepEqual(groupsOf(groups, `urn:uuid:${UID(3)}`).map((g) => g.name), ["Project team"]);
  assert.deepEqual(groupsOf(groups, "nobody"), []);
  assert.deepEqual(groupsOf(groups, ""), []);
  const both = readGroups([APPLE, { ...RFC, text: RFC.text.replace(UID(3), UID(1)) }], CONTACTS);
  const a = affectedGroups(both, UID(1));
  assert.equal(a.count, 2);
  assert.deepEqual(a.names, ["Book club", "Project team"]);
  assert.deepEqual(a.groups[0], { href: "/u/b/apple.vcf", etag: '"e1"', uid: a.groups[0].uid, name: "Book club" });
  assert.deepEqual(affectedGroups(groups, "none"), { count: 0, names: [], groups: [] });
});

test("memberKeys feed the list's group filter", () => {
  const [apple] = readGroups([APPLE], CONTACTS);
  assert.deepEqual(filterByMembers(CONTACTS, memberKeys(apple)).map((c) => c.name), ["Contact 1", "Contact 2"]);
});

// -- patches, both forms ---------------------------------------------------------------------------------------------------------

for (const [label, e, member] of [["Apple form", APPLE, "X-ADDRESSBOOKSERVER-MEMBER"], ["RFC 6350 form", RFC, "MEMBER"]]) {
  test(`${label}: add ONE member = one membersDelta, only that member line changes`, () => {
    const [g] = readGroups([e], CONTACTS);
    const r = addMemberPatch(g, CONTACTS[4]);
    assert.deepEqual(r, { ok: true, noop: false, patch: { membersDelta: { add: [`urn:uuid:${UID(5)}`] } } });
    const item = openItem(e.text, "contact");
    assert.equal(item.update(r.patch), true);
    const out = item.save({ now: NOW }).text;
    const d = semdiff(e.text, out, { ignoreManaged: true }).diffs;
    assert.deepEqual(d.map((x) => [x.side, x.line]), [["b", `${member}:urn:uuid:${UID(5)}`]]);
    checkFidelity(e.text, out);
    const [after] = readGroups([{ ...e, text: out }], CONTACTS);
    assert.equal(after.memberCount, 5);
    assert.deepEqual(after.members.filter((m) => m.kind === "unknown").map((m) => m.uri), g.members.filter((m) => m.kind === "unknown").map((m) => m.uri), "unknown members passed through");
  });

  test(`${label}: remove ONE member, also an unknown one; nothing else is removed`, () => {
    const [g] = readGroups([e], CONTACTS);
    const first = g.members.find((m) => m.kind === "contact");
    const r = removeMemberPatch(g, first);
    assert.deepEqual(r.patch, { membersDelta: { remove: [first.uri] } });
    const byUid = removeMemberPatch(g, first.uid);
    assert.deepEqual(byUid.patch, r.patch);
    const item = openItem(e.text, "contact");
    item.update(r.patch);
    const d = semdiff(e.text, item.save({ now: NOW }).text, { ignoreManaged: true }).diffs;
    assert.deepEqual(d.map((x) => [x.side, x.line]), [["a", `${member}:${first.uri}`]]);
    const unknown = g.members.filter((m) => m.kind === "unknown");
    for (const u of unknown) {
      const it = openItem(e.text, "contact");
      const p = removeMemberPatch(g, u);
      it.update(p.patch);
      const dd = semdiff(e.text, it.save({ now: NOW }).text, { ignoreManaged: true }).diffs;
      assert.equal(dd.length, 1, u.uri);
      assert.ok(dd[0].line.endsWith(u.uri));
    }
  });
}

test("add and remove edge cases: already a member, not a member, no UID, read-only group", () => {
  const [g] = readGroups([APPLE], CONTACTS);
  assert.deepEqual(addMemberPatch(g, CONTACTS[0]), { ok: true, noop: true, patch: {} });
  assert.deepEqual(addMemberPatch(g, { uid: `urn:uuid:${UID(1).toUpperCase()}` }), { ok: true, noop: true, patch: {} });
  assert.deepEqual(addMemberPatch(g, { uid: null }), { ok: false, reason: "no-uid", key: "groups.err.no-uid" });
  assert.equal(addMemberPatch(g, { uid: "  " }).reason, "no-uid");
  assert.equal(addMemberPatch(g, undefined).reason, "no-uid");
  assert.equal(addMemberPatch(g, { uid: "plain-uid" }).patch.membersDelta.add[0], "urn:uuid:plain-uid");
  assert.equal(addMemberPatch(g, { uid: "urn:uuid:abc" }).patch.membersDelta.add[0], "urn:uuid:abc");
  assert.deepEqual(removeMemberPatch(g, CONTACTS[4].uid), { ok: true, noop: true, patch: {} });
  assert.deepEqual(removeMemberPatch(g, { uri: "x" }), { ok: true, noop: true, patch: {} });
  assert.equal(addMemberPatch({ ...g, readOnly: true }, CONTACTS[4]).reason, "group-read-only");
  assert.equal(removeMemberPatch({ ...g, readOnly: true }, UID(1)).key, "groups.err.group-read-only");
});

test("a contact without a UID is listed in the picker but cannot be added", () => {
  const [g] = readGroups([APPLE], CONTACTS);
  const nouid = summarize("BEGIN:VCARD\nVERSION:3.0\nFN:No Uid\nEND:VCARD\n", { href: "/u/b/nouid.vcf" });
  assert.equal(nouid.uid, null);
  const r = memberCandidates([nouid], g, "uid");
  assert.deepEqual(r.map((x) => [x.canAdd, x.reason]), [[false, "no-uid"]]);
});

test("memberCandidates: not members, matching the query, at most 50, never groups or read-only cards", () => {
  const [g] = readGroups([APPLE], CONTACTS);
  const names = memberCandidates(CONTACTS, g, "").map((x) => x.summary.name);
  assert.deepEqual(names, ["Contact 3", "Contact 4", "Contact 5"], "members 1 and 2 are left out");
  assert.deepEqual(memberCandidates(CONTACTS, g, "contact 4").map((x) => x.summary.name), ["Contact 4"]);
  const many = Array.from({ length: 300 }, (_, i) => contact(100 + i, `Person ${i}`));
  assert.equal(memberCandidates(many, g, "person").length, PICKER_LIMIT);
  assert.equal(memberCandidates(many, g, "person", { limit: 5 }).length, 5);
  assert.equal(memberCandidates(many, g, "person", { limit: 500 }).length, 50);
  const grp = summarize(APPLE.text, { href: "/u/b/apple.vcf" });
  const ro = summarize("BEGIN:VCARD\nVERSION:2.1\nFN:Old\nUID:x\nEND:VCARD\n", { href: "/u/b/old.vcf" });
  assert.deepEqual(memberCandidates([grp, ro], g, ""), []);
});

// -- rename and create --------------------------------------------------------------------------------------------------------------------

test("rename: FN, and N too in the Apple form when N is the old name", () => {
  const apple = openItem(APPLE.text, "contact");
  const p = renamePatch(apple.fields(), "Reading circle");
  assert.deepEqual(Object.keys(p).sort(), ["fn", "n"]);
  apple.update(p);
  const out = apple.save({ now: NOW }).text;
  assert.deepEqual([...new Set(changedNames(semdiff(APPLE.text, out, { ignoreManaged: true })))].sort(), ["FN", "N"]);
  assert.equal(apple.fields().n.family, "Reading circle");
  assert.equal(apple.fields().group.members.length, 4);
  assert.deepEqual(renamePatch(openItem(APPLE.text, "contact").fields(), "Book club"), {});
  assert.deepEqual(renamePatch(openItem(APPLE.text, "contact").fields(), "  "), {});
  const rfc = openItem(RFC.text, "contact");
  assert.deepEqual(renamePatch(rfc.fields(), "Crew"), { fn: "Crew" });
  const custom = { fn: "Old", n: { family: "Something else", given: "", additional: "", prefix: "", suffix: "" }, group: { form: "apple" } };
  assert.deepEqual(renamePatch(custom, "New"), { fn: "New" }, "N is left alone when it differs from the old name");
  const withGiven = { fn: "Old", n: { family: "Old", given: "X" }, group: { form: "apple" } };
  assert.deepEqual(renamePatch(withGiven, "New"), { fn: "New" });
});

test("checkGroupName", () => {
  assert.deepEqual(checkGroupName("  Family "), { ok: true, name: "Family", duplicate: false });
  assert.equal(checkGroupName("").key, "groups.err.nameRequired");
  assert.equal(checkGroupName(undefined).ok, false);
  assert.equal(checkGroupName("x".repeat(1001)).key, "groups.err.nameTooLong");
  const groups = readGroups([APPLE], CONTACTS);
  assert.equal(checkGroupName("book CLUB", groups).duplicate, true);
  assert.equal(checkGroupName("book CLUB", groups, { except: groups[0] }).duplicate, false);
});

test("newGroup: the form the book uses (existing groups, then the majority version, empty book = Apple)", () => {
  const form = (cards) => newGroup("Family", { cards, uid: "g-new" }).form;
  const c3 = openItem(fixture("vcard30-basic.vcf"), "contact");
  const c4 = openItem(fixture("vcard40-anniversary.vcf"), "contact");
  assert.equal(form([]), "apple");
  assert.equal(form([c3, c3, c4]), "apple");
  assert.equal(form([c4, c4, c3]), "rfc6350");
  assert.equal(form([openItem(RFC.text, "contact"), openItem(RFC.text, "contact"), openItem(APPLE.text, "contact"), c3, c3, c3]), "rfc6350", "existing group cards win");
  assert.equal(newGroup("F", { cards: [c3], form: "rfc6350" }).form, "rfc6350", "explicit form");
  for (const f of ["apple", "rfc6350"]) {
    const r = newGroup("  Family  ", { form: f, uid: "g-new", memberUids: [UID(1), `urn:uuid:${UID(2)}`] });
    assert.equal(r.ok, true);
    const text = r.item.save({ now: NOW }).text;
    const [g] = readGroups([{ href: "/g", text }], CONTACTS);
    assert.deepEqual([g.name, g.form, g.version, g.uid, g.resolvedCount], ["Family", f, f === "apple" ? "3.0" : "4.0", "g-new", 2]);
    assert.equal(g.members.length, 2);
  }
  assert.equal(newGroup("   ").ok, false);
  assert.equal(newGroup("   ").key, "groups.err.nameRequired");
  const empty = newGroup("Solo", { uid: "solo" });
  assert.equal(readGroups([{ href: "/s", text: empty.item.save({ now: NOW }).text }], [])[0].memberCount, 0);
});

test("hostile group names and members are plain text", () => {
  const name = '<img src=x onerror=alert(1)> ‮evil';
  const r = newGroup(name, { form: "rfc6350", uid: "h", memberUids: ["javascript:alert(1)", "mailto:x@example.org"] });
  const [g] = readGroups([{ href: "/h", text: r.item.save({ now: NOW }).text }], CONTACTS);
  assert.equal(g.name, name.trim());
  assert.ok(g.members.every((m) => m.kind === "unknown"));
});
