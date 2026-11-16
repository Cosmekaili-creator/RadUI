// SPDX-License-Identifier: AGPL-3.0-or-later
// openItem(): what opens read-only and why.
import test from "node:test";
import assert from "node:assert/strict";
import { createItem, openItem, ReadOnlyError } from "../../../src/js/model/item.js";
import { fixture } from "./helpers.mjs";

const cal = (inner, head = "VERSION:2.0\r\nPRODID:-//X//EN\r\n") => `BEGIN:VCALENDAR\r\n${head}${inner}END:VCALENDAR\r\n`;
const vev = (uid, extra = "DTSTART:20260401T100000Z\r\n") => `BEGIN:VEVENT\r\nUID:${uid}\r\n${extra}END:VEVENT\r\n`;
const refused = (text, kind, reason) => {
  const r = openItem(text, kind);
  assert.equal(r.ok, false, `expected refusal ${reason}`);
  assert.equal(r.readOnly, true);
  assert.equal(r.reason, reason, r.message);
  assert.equal(r.raw, text);
  assert.ok(r.message);
  return r;
};

test("parse failures open read-only with the raw text", () => {
  refused("", "event", "empty");
  refused("   \r\n", "event", "empty");
  refused(null, "event", "empty");
  refused("garbage, not an item", "event", "parse-error");
  refused("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n", "event", "parse-error");
  refused(cal(vev("a") + "no colon\r\n"), "event", "parse-error");
});

test("multiple UIDs in one resource", () => {
  refused(cal(vev("a") + vev("b")), "event", "multiple-uids");
});

test("a component without a UID", () => {
  refused(cal("BEGIN:VEVENT\r\nDTSTART:20260401T100000Z\r\nEND:VEVENT\r\n"), "event", "no-uid");
});

test("multiple vCards in one resource", () => {
  const card = (n) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${n}\r\nEND:VCARD\r\n`;
  refused(card("a") + card("b"), "contact", "multiple-vcards");
});

test("unsupported versions and constructs it cannot round-trip", () => {
  refused("BEGIN:VCARD\r\nVERSION:2.1\r\nFN:a\r\nEND:VCARD\r\n", "contact", "unsupported-version");
  refused("BEGIN:VCARD\r\nFN:a\r\nEND:VCARD\r\n", "contact", "unsupported-version");
  refused(cal(vev("a"), "VERSION:1.0\r\nPRODID:-//X//EN\r\n"), "event", "unsupported-version");
  refused(cal("BEGIN:VJOURNAL\r\nUID:j\r\nEND:VJOURNAL\r\n"), "event", "unsupported-component");
  refused(cal("BEGIN:VFREEBUSY\r\nUID:j\r\nEND:VFREEBUSY\r\n"), "event", "unsupported-component");
  refused("BEGIN:VNOTE\r\nEND:VNOTE\r\n", undefined, "unsupported-component");
  refused(cal(vev("a") + "BEGIN:VTODO\r\nUID:a\r\nEND:VTODO\r\n"), undefined, "mixed-components");
  refused(cal("BEGIN:VTIMEZONE\r\nTZID:X\r\nEND:VTIMEZONE\r\n"), "event", "empty");
  refused(cal("BEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID:20260401T100000Z\r\nDTSTART:20260401T110000Z\r\nEND:VEVENT\r\n"), "event", "no-master");
  refused(cal(vev("a") + vev("a")), "event", "multiple-masters");
  refused(cal("BEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\nBEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\n"), "task", "multiple-tasks");
});

test("invalid values the readers would trip over", () => {
  refused(cal(vev("a", "DTSTART:20261301T100000Z\r\n")), "event", "invalid-value");
  refused(cal(vev("a", "DTSTART:20260401T100000Z\r\nDURATION:garbage\r\n")), "event", "invalid-value");
  refused(cal("BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:no start\r\nEND:VEVENT\r\n"), "event", "invalid-value");
  refused(cal(vev("a", "DTSTART:20260401T100000Z\r\nEXDATE:xyz\r\n")), "event", "invalid-value");
});

test("the requested kind must match the content", () => {
  refused(fixture("todo-open.ics"), "event", "wrong-kind");
  refused(fixture("event-utc-basic.ics"), "task", "wrong-kind");
  refused(fixture("vcard30-basic.vcf"), "event", "wrong-kind");
  assert.equal(openItem(fixture("vcard30-basic.vcf"), "event").ok, false);
});

test("when no kind is given it is inferred", () => {
  assert.equal(openItem(fixture("event-utc-basic.ics")).kind, "event");
  assert.equal(openItem(fixture("todo-open.ics")).kind, "task");
  assert.equal(openItem(fixture("vcard30-basic.vcf")).kind, "contact");
});

test("an item that opens exposes its structure", () => {
  const item = openItem(fixture("event-recur-exdate-override-moved.ics"), "event");
  assert.equal(item.ok, true);
  assert.equal(item.readOnly, false);
  assert.equal(item.readOnlyReason, null);
  assert.equal(item.uid, "override-moved@example.org");
  assert.equal(item.overrides.length, 1);
  assert.equal(item.overrideFields()[0].summary, "Weekly sync (moved)");
  assert.equal(item.main.prop("SUMMARY").value, "Weekly sync");
  assert.deepEqual(item.tz, { "Europe/Paris": "embedded" });
  assert.deepEqual(item.warnings, []);
});

test("a read-only (unknown TZID) item refuses every mutator and save", () => {
  const item = openItem(fixture("event-tzid-quoted-unknown.ics"), "event");
  assert.equal(item.readOnly, true);
  for (const f of [() => item.update({ summary: "x" }), () => item.save(), () => item.addExdate({ kind: "utc", iso: "2026-03-10T07:00:00" }), () => item.upsertOverride({ kind: "utc", iso: "2026-03-10T07:00:00" }, {}), () => item.splitSeries({ kind: "utc", iso: "2026-03-10T07:00:00" })]) {
    assert.throws(f, ReadOnlyError);
  }
  assert.equal(item.raw, fixture("event-tzid-quoted-unknown.ics"));
});

test("only events expand", () => {
  assert.throws(() => openItem(fixture("todo-open.ics"), "task").expand({}), /only events/);
});

test("createItem rejects an unknown kind", () => {
  assert.throws(() => createItem("note", {}), /unknown item kind/);
});

test("the item raw text is kept for the raw viewer", () => {
  const text = fixture("event-lf.ics");
  assert.equal(openItem(text, "event").raw, text);
});

test("sending back what fields() returned is a no-op, also for events with DURATION", () => {
  for (const name of ["event-duration.ics", "event-allday-duration.ics", "event-utc-basic.ics", "event-recur-allday.ics", "event-alarms.ics"]) {
    const item = openItem(fixture(name), "event");
    const f = item.fields();
    const patch = { ...f };
    delete patch.allDay;
    delete patch.foreignAlarms;
    delete patch.exdates;
    delete patch.rdates;
    assert.equal(item.update(patch), false, name);
    assert.deepEqual(item.save(), { changed: false }, name);
  }
});

test("a VTIMEZONE that cannot be interpreted counts as absent (unknown unless Intl knows the name)", () => {
  const bad = cal("BEGIN:VTIMEZONE\r\nTZID:Broken/Zone\r\nEND:VTIMEZONE\r\n" + vev("a", "DTSTART;TZID=Broken/Zone:20260401T100000\r\n"));
  const r = openItem(bad, "event");
  assert.equal(r.readOnly, true);
  assert.equal(r.tz["Broken/Zone"], "unknown");
  const iana = cal("BEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nEND:VTIMEZONE\r\n" + vev("a", "DTSTART;TZID=Europe/Paris:20260401T100000\r\n"));
  assert.equal(openItem(iana, "event").tz["Europe/Paris"], "intl");
});

test("structure: ical.js is imported by icalview.js only; no Node-only or DOM APIs in the model", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL("../../../src/js/model/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.deepEqual(files.sort(), ["conflict.js", "contentlines.js", "event.js", "fidelity.js", "icalview.js", "importics.js", "importplan.js", "item.js", "todo.js", "vcard.js", "writer.js"]);
  for (const f of files) {
    const src = readFileSync(dir + f, "utf8");
    assert.ok(src.split("\n").slice(0, 5).some((l) => l.includes("SPDX-License-Identifier: AGPL-3.0-or-later")), `${f}: SPDX header`);
    assert.equal(/ical\.min\.js/.test(src), f === "icalview.js", `${f}: ical.js import`);
    assert.doesNotMatch(src, /from "node:|require\(|\bwindow\.|\bdocument\.|\bDOMParser\b|\bBuffer\./, `${f}: portable code`);
  }
});

test("echoing fields() back is a no-op for every event and task in the corpus", async () => {
  const { fixtures } = await import("./helpers.mjs");
  let n = 0;
  for (const f of fixtures().filter((x) => (x.meta.kind === "event" || x.meta.kind === "task") && !x.meta.expect)) {
    const item = openItem(f.text, f.meta.kind);
    const patch = { ...item.fields() };
    for (const k of ["allDay", "foreignAlarms", "exdates", "rdates"]) delete patch[k];
    assert.equal(item.update(patch), false, f.name);
    assert.deepEqual(item.save(), { changed: false }, f.name);
    n++;
  }
  assert.ok(n >= 30);
});
