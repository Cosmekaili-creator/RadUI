// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests against a throwaway Radicale (tests/roundtrip/run.sh starts one):
//  (c) PUT every fixture, GET it back, compare semantically with the input;
//      anything not in the allowlist of compare.mjs is a failure;
//  (d) multiget REPORT text equals GET text (after LF normalisation);
//  (e) the writer's output for every owned-field edit, built from the served
//      text, survives PUT -> GET -> open without becoming read-only, and the
//      comparison uses the NON-lossy rules only.
import test from "node:test";
import assert from "node:assert/strict";
import { openItem, createItem, createGroupItem } from "../../src/js/model/item.js";
import { compareServer, hasLossy, tally } from "./compare.mjs";
import { NOW, PRIMARY, SKIP, editsFor, freshCollection, lf, loadFixtures, makeClient } from "./lib.mjs";

const env = SKIP ? null : makeClient();
const it = (name, opts, fn) => (typeof opts === "function" ? test(name, { skip: SKIP }, opts) : test(name, { skip: SKIP, ...opts }, fn));

// Fixtures Radicale is expected to refuse (the model refuses them too).
const REFUSED_BY_SERVER = new Set(["parse-error", "multiple-uids", "invalid-value", "unsupported-version", "multiple-vcards"]);
const isV = (f) => f.name.startsWith("vcf/");
const itemHref = (col, f) => `${col}item${isV(f) ? ".vcf" : ".ics"}`;
const tallies = {};
const addTally = (explained) => {
  for (const [k, n] of Object.entries(tally(explained))) tallies[k] = (tallies[k] || 0) + n;
};

async function put(f, text = f.text) {
  const col = await freshCollection(env, isV(f) ? "contact" : "event", "c");
  const href = itemHref(col, f);
  try {
    await env.client.putItem(href, text, { create: true });
  } catch (e) {
    return { col, href, rejected: e.status || e.kind };
  }
  const got = await env.client.getItem(href);
  return { col, href, got };
}

for (const f of loadFixtures()) {
  it(`PUT -> GET semantic comparison (c) and multiget (d): ${f.name}`, async (t) => {
    const r = await put(f);
    const expectRefused = REFUSED_BY_SERVER.has(f.meta.expect);
    if (r.rejected) {
      assert.ok(expectRefused, `the server refused a fixture that is expected to be accepted (${r.rejected})`);
      t.diagnostic(`server verdict: refused (${r.rejected})`);
      return;
    }
    let result;
    try {
      result = compareServer(f.text, r.got.text);
    } catch (e) {
      assert.ok(expectRefused || f.meta.expect === "parse-error", `input not parseable: ${e.message}`);
      t.diagnostic("server accepted an item the model cannot parse; comparison skipped");
      return;
    }
    assert.deepEqual(result.unexplained, [], "differences that are not in the allowlist");
    addTally(result.explained);
    if (result.explained.length) t.diagnostic("allowlisted: " + JSON.stringify(tally(result.explained)));

    // the text served back is stable: PUT again, GET again
    await env.client.putItem(r.href, r.got.text, { etag: r.got.etag });
    const again = await env.client.getItem(r.href);
    assert.equal(again.text, r.got.text, "re-PUT of the served text is idempotent");

    // (d) multiget REPORT == GET after LF normalisation
    const mg = isV(f) ? await env.client.addressbookMultiget(r.col, [r.href]) : await env.client.calendarMultiget(r.col, [r.href]);
    assert.equal(mg.items.length, 1);
    assert.equal(lf(mg.items[0].text), lf(again.text));
    assert.equal(mg.items[0].etag, again.etag);

    // the model opens what the server serves, unless it was expected to refuse the input
    const opened = openItem(again.text, f.meta.kind);
    if (!f.meta.expect || f.meta.expect === "readonly-tz") assert.equal(opened.ok, true, opened.reason);
    if (f.meta.expect === "readonly-tz") assert.equal(opened.readOnly, true);
    else if (opened.ok && !f.meta.expect) assert.equal(opened.readOnly, false);
  });
}

for (const f of loadFixtures()) {
  const probe = openItem(f.text, f.meta.kind);
  if (!probe.ok || probe.readOnly) continue;
  it(`writer output survives PUT -> GET -> open (e): ${f.name}`, async () => {
    const col = await freshCollection(env, isV(f) ? "contact" : "event", "e");
    const href = itemHref(col, f);
    await env.client.putItem(href, f.text, { create: true });
    const served = (await env.client.getItem(href)).text; // RadUI only ever edits served text
    const start = openItem(served, f.meta.kind);
    if (!start.ok || start.readOnly) return;
    const failures = [];
    let n = 0;
    for (const edit of editsFor(start)) {
      const item = openItem(served, f.meta.kind);
      if (edit.apply(item) === false) continue;
      const out = item.save({ now: NOW });
      const cur = await env.client.getItem(href);
      await env.client.putItem(href, out.text, { etag: cur.etag });
      const back = await env.client.getItem(href);
      const cmp = compareServer(out.text, back.text);
      const reopened = openItem(back.text, f.meta.kind);
      const bad = [];
      if (cmp.unexplained.length) bad.push(`unexplained difference in ${[...new Set(cmp.unexplained.map((u) => u.name))].join(",")}`);
      if (hasLossy(cmp.explained)) bad.push("the server changed the value of writer output");
      if (!reopened.ok || reopened.readOnly) bad.push("the served text opens read-only");
      else if (reopened.save().changed !== false) bad.push("the served text is not stable");
      if (bad.length) failures.push(`${edit.field}: ${bad.join("; ")}`);
      addTally(cmp.explained);
      n++;
    }
    assert.ok(n > 0);
    assert.deepEqual(failures, []);
  });
}

it("new items written by the model survive PUT -> GET -> open (events, tasks, contacts, both group forms)", async () => {
  const cases = [
    ["event", () => createItem("event", { summary: "New, event; with \\ specials", start: { kind: "utc", iso: "2026-12-01T09:00:00" }, end: { kind: "utc", iso: "2026-12-01T10:00:00" }, categories: ["a, b", "c"], alarms: [{ seconds: -900 }] }, { uid: "new-event@example.org" })],
    ["event", () => createItem("event", { summary: "All day", start: { kind: "date", iso: "2026-12-24" }, end: { kind: "date", iso: "2026-12-25" }, rrule: "FREQ=YEARLY;COUNT=3" }, { uid: "new-allday@example.org" })],
    ["event", () => createItem("event", { summary: "Zoned", start: { kind: "zoned", iso: "2026-12-01T09:00:00", tzid: "Europe/Paris" }, end: { kind: "zoned", iso: "2026-12-01T10:00:00", tzid: "Europe/Paris" } }, { uid: "new-zoned@example.org" })],
    ["task", () => createItem("task", { summary: "New task", due: { kind: "date", iso: "2026-12-31" }, priority: 3, status: "NEEDS-ACTION" }, { uid: "new-task@example.org" })],
    ["contact", () => createItem("contact", { fn: "New Contact", n: { family: "Contact", given: "New", additional: "", prefix: "", suffix: "" }, tel: [{ value: "+1 555 0100", types: ["cell"], pref: true }], email: [{ value: "new@example.org", types: ["work"] }], adr: [{ value: { street: "1 Example Road, Apt 2", locality: "Sampletown", code: "00001", country: "Exampleland" }, types: ["home"] }], note: "Line one\nLine two; with, separators" }, { uid: "urn:uuid:aaaaaaaa-0000-4000-8000-000000000001" })],
    ["contact", () => createItem("contact", { fn: "New Four" }, { uid: "urn:uuid:aaaaaaaa-0000-4000-8000-000000000002", version: "4.0" })],
    ["contact", () => createGroupItem("New Group", ["urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"], { uid: "urn:uuid:aaaaaaaa-0000-4000-8000-000000000003" })],
    ["contact", () => createGroupItem("New Apple Group", ["urn:uuid:aaaaaaaa-0000-4000-8000-000000000001"], { uid: "urn:uuid:aaaaaaaa-0000-4000-8000-000000000004", form: "apple" })],
  ];
  for (const [kind, make] of cases) {
    const col = await freshCollection(env, kind, "n");
    const href = `${col}new.${kind === "contact" ? "vcf" : "ics"}`;
    const out = make().save({ now: NOW });
    await env.client.putItem(href, out.text, { create: true });
    const back = await env.client.getItem(href);
    const cmp = compareServer(out.text, back.text);
    assert.deepEqual(cmp.unexplained, [], `${kind}`);
    assert.equal(hasLossy(cmp.explained), false, `${kind}: value changed by the server`);
    const opened = openItem(back.text, kind);
    assert.equal(opened.ok && !opened.readOnly, true, `${kind} opens editable`);
    assert.equal(opened.save().changed, false);
  }
});

it("a new photo keeps its payload through Radicale, for 3.0 and 4.0 cards", async () => {
  const b64 = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7 + 3) % 256)).toString("base64");
  for (const version of ["3.0", "4.0"]) {
    const col = await freshCollection(env, "contact", "p");
    const href = `${col}photo.vcf`;
    const item = createItem("contact", { fn: "Photo Test", photo: { mime: "image/jpeg", base64: b64 } }, { uid: `urn:uuid:aaaaaaaa-0000-4000-8000-00000000009${version[0]}`, version });
    const out = item.save({ now: NOW });
    await env.client.putItem(href, out.text, { create: true });
    const back = await env.client.getItem(href);
    const line = back.text.replace(/\n /g, "").split("\n").find((l) => l.startsWith("PHOTO"));
    assert.ok(line.startsWith(version === "4.0" ? "PHOTO;ENCODING=b;MEDIATYPE=image/jpeg:" : "PHOTO;ENCODING=b;TYPE=JPEG:"), `${version}: ${line.slice(0, 40)}`);
    assert.equal(line.slice(line.indexOf(":") + 1), b64);
    assert.equal(openItem(back.text, "contact").fields().photo.present, true);
  }
});

it("the update path: If-Match with the served ETag, a stale ETag is refused with 412", async () => {
  const f = loadFixtures().find((x) => x.name === "ics/event-utc-basic.ics");
  const r = await put(f);
  const item = openItem(r.got.text, "event");
  item.update({ summary: "Edited" });
  const out = item.save({ now: NOW });
  await env.client.putItem(r.href, out.text, { etag: r.got.etag });
  await assert.rejects(env.client.putItem(r.href, out.text, { etag: r.got.etag }), (e) => e.kind === "precondition");
});

test("summary of the allowlist hits", { skip: SKIP }, (t) => {
  t.diagnostic("allowlisted differences seen: " + JSON.stringify(tallies));
});
