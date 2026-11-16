// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers of the round-trip harness: fixture loading, the throwaway
// Radicale client, and the per-field edit registry used by the harness and by
// the snapshot runner. No tests in here.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTransport } from "../../src/js/dav/http.js";
import { createClient } from "../../src/js/dav/client.js";
import { readEntries } from "../../src/js/model/vcard.js";
import { STATUSES as EVENT_STATUSES, TRANSPARENCIES } from "../../src/js/model/event.js";
import { STATUSES as TODO_STATUSES } from "../../src/js/model/todo.js";
import { specFromWallMs, specWallMs } from "../../src/js/model/contentlines.js";
import { openItem } from "../../src/js/model/item.js";
import { flatDiff } from "./compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "../fixtures");
export const BS = String.fromCharCode(92);

export const lf = (t) => t.replace(/\r\n?/g, "\n");
/** LF-normalised text re-emitted with CRLF and a final CRLF, blank lines dropped. */
export const crlf = (t) => lf(t).split("\n").filter((l) => l !== "").join("\r\n") + "\r\n";

const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8"));

/** [{name, file, text, meta}] for every fixture. */
export function loadFixtures() {
  const out = [];
  for (const dir of ["ics", "vcf"]) {
    for (const f of readdirSync(path.join(FIXTURES, dir)).filter((n) => n.endsWith("." + dir)).sort()) {
      const key = `${dir}/${f}`;
      out.push({ name: key, file: f, text: readFileSync(path.join(FIXTURES, key), "utf8"), meta: manifest[key] || {} });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Throwaway Radicale

export const ORIGIN = process.env.RADUI_TEST_RADICALE || "";
const PW_FILE = process.env.RADUI_TEST_PASSWORDS_FILE || "";
export const SKIP =
  ORIGIN && PW_FILE ? false : "skipped: no throwaway Radicale (run tests/roundtrip/run.sh, or set RADUI_TEST_RADICALE and RADUI_TEST_PASSWORDS_FILE)";

/** Client for the throwaway instance. user/password default to the first account of the passwords file. */
export function makeClient({ origin = ORIGIN, user, password, timeoutMs = 30000 } = {}) {
  let u = user;
  let p = password;
  if (!u || p === undefined) {
    const first = readFileSync(PW_FILE, "utf8").trim().split("\n")[0];
    const i = first.indexOf(":");
    u = first.slice(0, i);
    p = first.slice(i + 1);
  }
  const auth = "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
  const transport = createTransport({ origin, getAuth: () => auth, fetchImpl: fetch, timeoutMs });
  return { user: u, client: createClient(transport) };
}

let counter = 0;
/** A fresh collection for one test; returns its href. */
export async function freshCollection(env, kind, tag = "t") {
  const href = `/${env.user}/${tag}${Date.now().toString(36)}${(counter++).toString(36)}/`;
  if (kind === "contact") await env.client.mkAddressbook(href, {});
  else await env.client.mkcalendar(href, {});
  return href;
}

// ---------------------------------------------------------------------------
// Edit registry: one entry per owned field. apply(item, fields) mutates the item;
// props are the property names (upper case, no group) that may differ afterwards.

export const TEXT_EDIT = `Changed, text; with ${BS}backslash and\nnewline é 日本 😀`;
const B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/";

const shift = (spec, seconds) => {
  if (spec.kind === "date") return specFromWallMs(specWallMs(spec) + Math.round(seconds / 86400) * 86400000, "date");
  return specFromWallMs(specWallMs(spec) + seconds * 1000, spec.kind, spec.tzid);
};
const firstTrue = (list, fn) => list.some((x) => fn(x));
const other = (cur, list) => list.find((x) => x !== cur);

function eventEdits(item, f) {
  const edits = [];
  const text = (field, prop) => edits.push({ field, props: [prop], apply: (it) => it.update({ [field]: TEXT_EDIT }) });
  text("summary", "SUMMARY");
  text("description", "DESCRIPTION");
  text("location", "LOCATION");
  edits.push({ field: "url", props: ["URL"], apply: (it) => it.update({ url: "https://example.org/edited?a=1&b=2" }) });
  edits.push({ field: "categories", props: ["CATEGORIES"], apply: (it) => it.update({ categories: [...f.categories, "Edited, one", "two;three"] }) });
  edits.push({ field: "status", props: ["STATUS"], apply: (it) => it.update({ status: other(f.status, EVENT_STATUSES) }) });
  edits.push({ field: "transp", props: ["TRANSP"], apply: (it) => it.update({ transp: other(f.transp, TRANSPARENCIES) }) });
  if (f.start) {
    edits.push({ field: "start", props: ["DTSTART"], apply: (it) => it.update({ start: shift(f.start, 86400) }) });
    const endSpec = f.end || (f.duration !== null ? shift(f.start, f.duration + (f.start.kind === "date" ? 86400 : 3600)) : shift(f.start, f.start.kind === "date" ? 86400 : 3600));
    edits.push({ field: "end", props: ["DTEND", "DURATION"], apply: (it) => it.update({ end: f.end ? shift(f.end, f.start.kind === "date" ? 86400 : 3600) : endSpec }) });
    edits.push({ field: "duration", props: ["DTEND", "DURATION"], apply: (it) => it.update({ duration: (f.duration ?? (f.end ? Math.max(0, (specWallMs(f.end) - specWallMs(f.start)) / 1000) : 3600)) + 86400 }) });
    edits.push({ field: "exdates", props: ["EXDATE"], apply: (it) => firstTrue([7, 21, 35, 49, 63], (d) => it.addExdate(shift(f.start, d * 86400))) });
    edits.push({ field: "rdates", props: ["RDATE"], apply: (it) => firstTrue([10, 24, 38, 52, 66], (d) => it.addRdate(shift(f.start, d * 86400))) });
  }
  edits.push({
    field: "rrule",
    props: ["RRULE"],
    apply: (it) => it.update({ rrule: f.rrule === "FREQ=DAILY;COUNT=3" ? "FREQ=WEEKLY;COUNT=5" : "FREQ=DAILY;COUNT=3" }),
  });
  edits.push({ field: "alarms", props: ["ACTION", "TRIGGER", "DESCRIPTION"], alarm: true, apply: (it) => it.update({ alarms: [...f.alarms, { seconds: -1234 * 60, related: "START" }] }) });
  return edits;
}

function todoEdits(item, f) {
  const edits = [];
  const text = (field, prop) => edits.push({ field, props: [prop], apply: (it) => it.update({ [field]: TEXT_EDIT }) });
  text("summary", "SUMMARY");
  text("description", "DESCRIPTION");
  const day = { kind: "date", iso: "2026-12-01" };
  edits.push({ field: "due", props: ["DUE"], apply: (it) => it.update({ due: f.due ? shift(f.due, 86400) : day }) });
  edits.push({ field: "start", props: ["DTSTART"], apply: (it) => it.update({ start: f.start ? shift(f.start, 86400) : day }) });
  edits.push({ field: "priority", props: ["PRIORITY"], apply: (it) => it.update({ priority: f.priority === 5 ? 3 : 5 }) });
  edits.push({ field: "status", props: ["STATUS"], apply: (it) => it.update({ status: other(f.status, TODO_STATUSES) }) });
  edits.push({ field: "percent", props: ["PERCENT-COMPLETE"], apply: (it) => it.update({ percent: f.percent === 50 ? 60 : 50 }) });
  edits.push({
    field: "completed",
    props: ["COMPLETED"],
    apply: (it) => it.update({ completed: { kind: "utc", iso: f.completed && f.completed.iso === "2026-11-01T10:00:00" ? "2026-11-02T10:00:00" : "2026-11-01T10:00:00" } }),
  });
  edits.push({ field: "categories", props: ["CATEGORIES"], apply: (it) => it.update({ categories: [...f.categories, "Edited, one", "two;three"] }) });
  edits.push({ field: "rrule", props: ["RRULE"], apply: (it) => it.update({ rrule: f.rrule === "FREQ=DAILY;COUNT=3" ? "FREQ=WEEKLY;COUNT=5" : "FREQ=DAILY;COUNT=3" }) });
  return edits;
}

function cardEdits(item, f) {
  const edits = [];
  const text = (field, prop) => edits.push({ field, props: [prop], apply: (it) => it.update({ [field]: TEXT_EDIT }) });
  text("fn", "FN");
  text("title", "TITLE");
  text("note", "NOTE");
  edits.push({ field: "n", props: ["N"], apply: (it) => it.update({ n: { family: "Edited, Family", given: "Given;X", additional: "", prefix: "", suffix: "" } }) });
  edits.push({ field: "nickname", props: ["NICKNAME"], apply: (it) => it.update({ nickname: ["Edited"] }) });
  edits.push({ field: "org", props: ["ORG"], apply: (it) => it.update({ org: { name: "Edited; Org", units: ["Unit, One"] } }) });
  edits.push({ field: "categories", props: ["CATEGORIES"], apply: (it) => it.update({ categories: [...f.categories, "Edited, one", "two;three"] }) });
  const entryEdit = (name, newValue, blank) => {
    edits.push({
      field: name,
      props: [name.toUpperCase()],
      apply: (it) => {
        const cur = readEntries(it.main, name.toUpperCase());
        const list = cur.map((e) => ({ prop: e.prop, value: e.value, types: e.types, pref: e.pref, label: e.label }));
        if (list.length) list[0] = { ...list[0], value: newValue(list[0].value) };
        else list.push({ value: blank, types: ["home"] });
        return it.update({ [name]: list });
      },
    });
  };
  entryEdit("tel", () => "+1 555 0199", "+1 555 0199");
  entryEdit("email", () => "edited@example.org", "edited@example.org");
  entryEdit("url", () => "https://example.org/edited", "https://example.org/edited");
  entryEdit("adr", (v) => ({ ...v, street: "Edited Street, 9" }), { street: "Edited Street, 9", locality: "Sampletown" });
  const date = (cur) => {
    const d = { year: 1985, month: 5, day: 17 };
    if (cur && !cur.text && cur.year === d.year && cur.month === d.month && cur.day === d.day) d.day = 18;
    return d;
  };
  edits.push({ field: "bday", props: ["BDAY"], apply: (it) => it.update({ bday: date(f.bday) }) });
  edits.push({ field: "anniversary", props: ["ANNIVERSARY"], apply: (it) => it.update({ anniversary: date(f.anniversary) }) });
  edits.push({ field: "photo", props: ["PHOTO"], apply: (it) => it.update({ photo: { mime: "image/jpeg", base64: B64 } }) });
  if (f.photo && f.photo.present) edits.push({ field: "photo-remove", props: ["PHOTO"], apply: (it) => it.update({ photo: null }) });
  edits.push({ field: "kind", props: ["KIND"], apply: (it) => it.update({ kind: f.kind === "org" ? "location" : "org" }) });
  if (f.group && f.group.isGroup) {
    edits.push({
      field: "members",
      props: ["MEMBER", "X-ADDRESSBOOKSERVER-MEMBER"],
      apply: (it) => it.update({ members: [...f.group.members, "urn:uuid:aaaaaaaa-0000-4000-8000-999999999999"] }),
    });
  }
  return edits;
}

/** The edit registry for an opened item (editable ones only). */
export function editsFor(item) {
  const f = item.fields();
  if (item.kind === "event") return eventEdits(item, f);
  if (item.kind === "task") return todoEdits(item, f);
  return cardEdits(item, f);
}

/** Field edited by the single "primary" edit used for the server round trips. */
export const PRIMARY = { event: "summary", task: "summary", contact: "fn" };

export const NOW = new Date("2026-11-12T10:00:00Z");

// ---------------------------------------------------------------------------
// The one-owned-field check shared by the harness and the snapshot runner

const MAIN_PATH = { event: "VCALENDAR/VEVENT[]", task: "VCALENDAR/VTODO[]", contact: "VCARD" };
const octets = (s) => new TextEncoder().encode(s).length;

/**
 * Apply `edit` to a fresh item opened from `text` and check the semantic diff.
 * Returns {problems: [reason codes], out} where problems is empty when the edit is clean.
 * Codes: threw:<name>, no-op, save-unchanged, not-crlf, long-line, no-diff,
 * unexpected:<PROP>, wrong-component:<PROP>, reopen-failed, not-stable.
 */
export function checkEdit(text, kind, edit) {
  const item = openItem(text, kind);
  const problems = [];
  let changed;
  try {
    changed = edit.apply(item);
  } catch (e) {
    return { problems: [`threw:${e.name}`], message: e.message };
  }
  if (changed === false) return { problems: ["no-op"] };
  const out = item.save({ now: NOW });
  if (!out.changed) return { problems: ["save-unchanged"] };
  if (!out.text.endsWith("\r\n") || /[^\r]\n/.test(out.text)) problems.push("not-crlf");
  const known = new Set(lf(text).split("\n"));
  for (const l of out.text.split("\r\n")) if (octets(l) > 75 && !known.has(l)) problems.push("long-line");
  const d = flatDiff(text, out.text, { ignoreManaged: true });
  const all = [...d.onlyA, ...d.onlyB];
  if (!all.length) problems.push("no-diff");
  const main = MAIN_PATH[item.kind];
  const okPath = (p) => (edit.alarm ? p === `${main}/VALARM` : p === main);
  for (const e of all) {
    const label = e.name.startsWith("X-") ? "X-*" : e.name;
    if (!edit.props.includes(e.name)) problems.push(`unexpected:${label}`);
    else if (!okPath(e.path)) problems.push(`wrong-component:${label}`);
  }
  const back = openItem(out.text, kind);
  if (!back.ok || back.readOnly) problems.push("reopen-failed");
  else if (back.save().changed !== false) problems.push("not-stable");
  return { problems: [...new Set(problems)], out };
}
