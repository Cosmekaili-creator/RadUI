// SPDX-License-Identifier: AGPL-3.0-or-later
// Helpers of the UI-operations round trip (ui-ops.test.mjs): a counting DAV client (proves "no request"),
// the FORM edit registry (every edit goes through contacts/formmodel.js, never straight into the model),
// and the one-edit flow  form values -> toPatch -> fresh Item -> save -> PUT If-Match -> GET -> checks.
// No tests in here.
import { readFileSync } from "node:fs";
import { createClient } from "../../src/js/dav/client.js";
import { createTransport } from "../../src/js/dav/http.js";
import { isEmptyPatch, newRow, toFormValues, toPatch, validate, withPhoto } from "../../src/js/contacts/formmodel.js";
import { FidelityError } from "../../src/js/model/fidelity.js";
import { openItem } from "../../src/js/model/item.js";
import { keysOfPatch, verifyContact } from "../../src/js/store/verify.js";
import * as model from "../../src/js/model/item.js";
import { compareServer, flatDiff, hasLossy } from "./compare.mjs";
import { NOW, ORIGIN, TEXT_EDIT } from "./lib.mjs";

export { model };

const PW_FILE = process.env.RADUI_TEST_PASSWORDS_FILE || "";

/** A DAV client for the first account of the passwords file whose every request is counted by method. */
export function countingEnv({ timeoutMs = 30000 } = {}) {
  const first = readFileSync(PW_FILE, "utf8").trim().split("\n")[0];
  const i = first.indexOf(":");
  const user = first.slice(0, i);
  const auth = "Basic " + Buffer.from(`${user}:${first.slice(i + 1)}`).toString("base64");
  const log = [];
  const fetchImpl = (url, init) => {
    log.push({ method: init && init.method ? init.method : "GET", url });
    return fetch(url, init);
  };
  const transport = createTransport({ origin: ORIGIN, getAuth: () => auth, fetchImpl, timeoutMs });
  const env = {
    user,
    client: createClient(transport),
    log,
    /** Requests sent since `mark` (default: all), optionally of one method. */
    since: (mark = 0, method) => log.slice(mark).filter((r) => !method || r.method === method),
    mark: () => log.length,
  };
  return env;
}

let seq = 0;
/** A fresh address book (or calendar) of the account; returns its href. */
export async function newCollection(env, kind = "contact", tag = "u") {
  const href = `/${env.user}/${tag}${Date.now().toString(36)}${(seq++).toString(36)}/`;
  if (kind === "contact") await env.client.mkAddressbook(href, {});
  else await env.client.mkcalendar(href, {});
  return href;
}

/** PUT `text` as a new item and return {href, served: {text, etag}} as the server holds it. */
export async function putServed(env, col, text, name = "card") {
  const href = `${col}${name}.vcf`;
  await env.client.putItem(href, text, { create: true });
  const served = await env.client.getItem(href);
  return { href, served };
}

const itemOfFields = new WeakMap();
/** The Item a `fields` object was read from (the row handles in a patch belong to that very Item). */
export const itemOf = (fields) => itemOfFields.get(fields);

/** Form-level opening of a served text: {item, fields, values}. */
export function openForm(text) {
  const item = openItem(text, "contact");
  if (!item.ok || item.readOnly) return null;
  const fields = item.fields();
  itemOfFields.set(fields, item);
  return { item, fields, values: toFormValues(fields) };
}

/** A deep copy of form values that keeps the row handles (`prop`) by reference. */
export function cloneValues(v) {
  if (Array.isArray(v)) return v.map(cloneValues);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "prop" ? x : cloneValues(x)]));
  return v;
}

/**
 * The save flow of the contact form, as WP6 will run it against the store: nothing is sent when the patch is
 * empty or the card is unchanged. Returns {changed:false} or {changed:true, out, put, patch}.
 */
export async function formSave(env, href, base, fields, values) {
  const patch = toPatch(fields, values);
  const item = itemOf(fields);
  item.update(patch, { strict: true });
  const out = item.save({ now: NOW });
  if (!out.changed) return { changed: false, patch };
  const put = await env.client.putItem(href, out.text, { etag: base.etag });
  return { changed: true, out, put, patch };
}

// ---------------------------------------------------------------------------
// The form edit registry

const B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/";
const TYPE_CYCLE = ["cell", "home", "work", "fax", "pager"];
const nextType = (cur, list) => list.find((t) => t !== cur);
const filled = (kind, r) => (kind === "adr" ? Object.values(r.value).some((p) => String(p).trim()) : String(r.value).trim() !== "");
const ROW_PROPS = { tel: ["TEL", "X-ABLABEL"], email: ["EMAIL", "X-ABLABEL"], adr: ["ADR", "X-ABLABEL", "X-ABADR"], url: ["URL", "X-ABLABEL"] };

/**
 * One entry per form edit: {field, props, apply(values, fields), removal?}. `props` are the property names (upper
 * case, no group) allowed to differ between the served text before and after. `apply` returns false when the edit
 * does not apply to the card.
 */
export function formEdits(f) {
  const E = [];
  const add = (field, props, apply, extra = {}) => E.push({ field, props, apply, ...extra });
  add("fn", ["FN"], (v) => {
    v.fn = TEXT_EDIT;
    v.fnEdited = true;
  });
  add("given", ["N", "FN"], (v) => {
    v.given = "Edited, Given";
  });
  add("family", ["N", "FN"], (v) => {
    v.family = "Edited; Family";
  });
  add("org", ["ORG", "FN"], (v) => {
    v.org = "Edited, Org; Inc";
  });
  add("department", ["ORG"], (v) => {
    v.department = "Edited, Dept";
  });
  add("title", ["TITLE"], (v) => {
    v.title = "Edited, Title; Lead";
  });
  add("note", ["NOTE"], (v) => {
    v.note = TEXT_EDIT;
  });
  add("nickname", ["NICKNAME"], (v) => {
    v.nickname = "Edited";
  });
  for (const kind of ["tel", "email", "url", "adr"]) {
    const props = ROW_PROPS[kind];
    const value = { tel: "+1 555 0199", email: "edited@example.org", url: "https://example.org/edited", adr: null }[kind];
    const rows = f[kind] || [];
    if (rows.length) {
      add(`${kind}-value`, props, (v) => {
        const r = v[kind].find((x) => x.prop && filled(kind, x));
        if (!r) return false;
        if (kind === "adr") r.value = { ...r.value, street: "Edited Street, 9" };
        else r.value = value;
      });
      add(`${kind}-type`, props, (v) => {
        const r = v[kind].find((x) => x.prop && filled(kind, x) && x.typeSel !== "custom");
        if (!r) return false;
        r.typeSel = nextType(r.typeSel, kind === "tel" ? TYPE_CYCLE : ["home", "work", "other"]);
      });
      add(`${kind}-remove`, props, (v) => {
        const i = v[kind].findIndex((x) => x.prop && filled(kind, x));
        if (i < 0) return false;
        v[kind].splice(i, 1);
      }, { removal: true });
    }
    add(`${kind}-add`, props, (v) => {
      const r = newRow(kind, { typeSel: kind === "tel" ? "work" : "other" });
      if (kind === "adr") r.value = { ...r.value, street: "7 Added Lane, Unit 2", city: "Sampletown" };
      else r.value = value;
      v[kind].push(r);
    });
  }
  add("tel-custom-label", ["TEL", "X-ABLABEL"], (v) => {
    const r = newRow("tel", { typeSel: "custom" });
    r.value = "+1 555 0123";
    r.label = "Beach house, north";
    v.tel.push(r);
  });
  const day = (d) => ({ year: 1985, month: 5, day: d });
  add("bday", ["BDAY"], (v, fields) => {
    const cur = fields.bday;
    const d = cur && !cur.text && cur.year === 1985 && cur.month === 5 && cur.day === 17 ? day(18) : day(17);
    v.bday = { ...v.bday, date: d, replace: true };
  });
  if (f.version === "4.0") {
    add("anniversary", ["ANNIVERSARY"], (v, fields) => {
      const cur = fields.anniversary;
      const d = cur && !cur.text && cur.year === 2001 && cur.month === 6 && cur.day === 9 ? { year: 2001, month: 6, day: 10 } : { year: 2001, month: 6, day: 9 };
      v.anniversary = { ...v.anniversary, date: d, replace: true };
    });
  }
  add("categories-add", ["CATEGORIES"], (v) => {
    v.categories = [...v.categories, "Edited, one", "two;three"];
  });
  if ((f.categories || []).length) {
    add("categories-remove", ["CATEGORIES"], (v) => {
      v.categories = v.categories.slice(1);
    });
  }
  add("photo-new", ["PHOTO"], (v) => {
    Object.assign(v, withPhoto(v, { mime: "image/jpeg", base64: B64 }));
  });
  if (f.photo && f.photo.present) {
    add("photo-remove", ["PHOTO"], (v) => {
      Object.assign(v, withPhoto(v, null));
    });
  }
  return E;
}

/**
 * Run one form edit against the server: returns {skipped} or {problems: [...], out, back}. A problem list is empty
 * when the edit is clean: the patch is not empty, the form validates, the diff between the served text before and
 * after shows only the edited property (managed ones ignored), no allowlisted LOSSY rule fires on writer output,
 * the store's write-verification projection passes on the GET result, and the served text re-opens as a stable form.
 */
export async function runFormEdit(env, href, served, edit) {
  const form = openForm(served.text);
  if (!form) return { skipped: "not editable" };
  const { fields, values } = form;
  if (edit.apply(values, fields) === false) return { skipped: "not applicable" };
  const problems = [];
  const v = validate(fields, values, { now: NOW });
  if (!v.ok) problems.push(`invalid:${v.errors.map((e) => e.key).join(",")}`);
  const patch = toPatch(fields, values);
  if (isEmptyPatch(patch)) return { problems: ["empty-patch"] };
  let saved;
  try {
    saved = await formSave(env, href, served, fields, values);
  } catch (e) {
    if (e instanceof FidelityError && edit.removal) return { skipped: `refused by the guard (${e.problems.map((p) => p.code).join(",")})`, refused: true };
    return { problems: [`threw:${e.name}${e.message ? " " + e.message : ""}`] };
  }
  if (!saved.changed) return { problems: ["save-unchanged"] };
  const back = await env.client.getItem(href);
  const cmp = compareServer(saved.out.text, back.text);
  if (cmp.unexplained.length) problems.push(`unexplained:${[...new Set(cmp.unexplained.map((u) => u.name))].join(",")}`);
  if (hasLossy(cmp.explained)) problems.push("server-changed-a-value");
  const d = flatDiff(served.text, back.text, { ignoreManaged: true });
  const names = new Set([...d.onlyA, ...d.onlyB].map((e) => e.name));
  for (const n of names) if (!edit.props.includes(n)) problems.push(`outside-edit:${n}`);
  if (!names.size) problems.push("no-diff");
  const ver = verifyContact(model, { sentText: saved.out.text, gotText: back.text, keys: keysOfPatch(patch) });
  if (!ver.ok) problems.push(`verify:${ver.mismatched.join(",")}`);
  const again = openForm(back.text);
  if (!again) problems.push("reopen-failed");
  else if (!isEmptyPatch(toPatch(again.fields, again.values))) problems.push("form-not-stable");
  return { problems: [...new Set(problems)], out: saved.out, back, patch };
}
