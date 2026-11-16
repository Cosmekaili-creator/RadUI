// SPDX-License-Identifier: AGPL-3.0-or-later
// (f) The fidelity guard rejects deliberate tampering with lines RadUI does not
// own, and accepts changes to owned lines. Variants are generated per fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { FidelityError, checkFidelity } from "../../src/js/model/fidelity.js";
import { OWNED_PROPS as EVENT_OWNED } from "../../src/js/model/event.js";
import { OWNED_PROPS as TODO_OWNED } from "../../src/js/model/todo.js";
import { OWNED_PROPS as CARD_OWNED } from "../../src/js/model/vcard.js";
import { MANAGED_PROPS } from "../../src/js/model/writer.js";
import { Component, parse } from "../../src/js/model/contentlines.js";
import { openItem } from "../../src/js/model/item.js";
import { NOW, editsFor, lf, loadFixtures } from "./lib.mjs";

const OWNED = { event: new Set([...EVENT_OWNED, ...MANAGED_PROPS.VEVENT]), task: new Set([...TODO_OWNED, ...MANAGED_PROPS.VTODO]), contact: new Set([...CARD_OWNED, ...MANAGED_PROPS.VCARD, "X-ABLABEL"]) };
const crlf = (t) => t.replace(/\n/g, "\r\n");

const replaceOnce = (text, from, to) => {
  const i = text.indexOf(from);
  assert.ok(i >= 0, "tamper target found");
  return text.slice(0, i) + to + text.slice(i + from.length);
};
const alter = (p) => {
  const lines = p.folded.split("\n");
  lines[lines.length - 1] += "X";
  return lines.join("\n");
};

/** [{label, text}] tampered variants of the LF baseline; expectReject tells whether the guard must refuse. */
function variants(item) {
  const base = lf(item.baseline);
  const out = [];
  const owned = OWNED[item.kind];
  const main = item.main;
  const foreign = main.properties.filter((p) => !owned.has(p.key) && p.folded);
  const add = (label, text, reject = true) => out.push({ label, text: crlf(text), reject });

  if (foreign.length) {
    const p = foreign[0];
    add("drop-foreign-line", replaceOnce(base, p.folded + "\n", ""));
    add("alter-foreign-line", replaceOnce(base, p.folded, alter(p)));
    const last = foreign[foreign.length - 1];
    add("alter-last-foreign-line", replaceOnce(base, last.folded, alter(last)));
  }
  for (let i = 0; i + 1 < main.items.length; i++) {
    const a = main.items[i];
    const b = main.items[i + 1];
    if (a instanceof Component || b instanceof Component || owned.has(a.key) || owned.has(b.key) || a.raw === b.raw) continue;
    add("reorder-foreign-lines", replaceOnce(base, a.folded + "\n" + b.folded, b.folded + "\n" + a.folded));
    break;
  }
  add("add-foreign-line", replaceOnce(base, main.endRaw, "X-TAMPER:1\n" + main.endRaw));
  for (const name of ["UID", "PRODID", "VERSION"]) {
    const p = (item.kind === "contact" ? main : item.root).prop(name) || main.prop(name);
    if (p && p.folded) add(`alter-${name}`, replaceOnce(base, p.folded, alter(p)));
  }
  if (item.kind !== "contact") {
    const tz = item.root.comps("VTIMEZONE")[0];
    if (tz) {
      const sub = tz.components[0];
      const prop = sub && sub.properties.find((p) => p.key === "TZOFFSETTO");
      if (prop) add("alter-vtimezone", replaceOnce(base, prop.folded, alter(prop)));
    }
    add("add-foreign-component", replaceOnce(base, main.endRaw, "BEGIN:VALARM\nACTION:AUDIO\nTRIGGER:-PT5M\nEND:VALARM\n" + main.endRaw));
    const foreignAlarm = main.comps("VALARM").find((v) => v.properties.some((p) => p.key === "ACTION" && p.value.trim().toUpperCase() !== "DISPLAY"));
    if (foreignAlarm) {
      const p = foreignAlarm.properties.find((x) => x.key === "TRIGGER");
      add("alter-foreign-alarm", replaceOnce(base, p.folded, alter(p)));
    }
    if (item.root.comps("VTIMEZONE").length) add("drop-vtimezone-line", replaceOnce(base, item.root.comps("VTIMEZONE")[0].components[0].beginRaw + "\n", ""));
  }
  add("truncated", base.slice(0, base.lastIndexOf("END:")));
  add("not-an-item", "garbage\n");
  // controls that must pass: an owned line changes, and the unchanged text
  const ownedProp = main.properties.find((p) => owned.has(p.key) && p.folded && !MANAGED_PROPS.VEVENT.includes(p.key));
  if (ownedProp) add("control-owned-line-changed", replaceOnce(base, ownedProp.folded, alter(ownedProp)), false);
  add("control-unchanged", base, false);
  return out;
}

let rejected = 0;
const fixtures = loadFixtures().filter((f) => {
  const it = openItem(f.text, f.meta.kind);
  return it.ok && !it.readOnly;
});

for (const f of fixtures) {
  test(`fidelity guard: ${f.name}`, () => {
    const item = openItem(f.text, f.meta.kind);
    for (const v of variants(item)) {
      if (v.reject) {
        assert.throws(() => checkFidelity(item.baseline, v.text), FidelityError, `${v.label} must be rejected`);
        rejected++;
      } else {
        assert.equal(checkFidelity(item.baseline, v.text), true, `${v.label} must pass`);
      }
    }
    // the real writer output of an edit passes the guard (Item.save runs it; run it again explicitly)
    const edit = editsFor(item)[0];
    edit.apply(item);
    const out = item.save({ now: NOW });
    assert.equal(checkFidelity(item.baseline, out.text, { allowOverrides: item.kind === "event" }), true);
  });
}

test("the guard rejected a substantial number of tampered variants", () => {
  assert.ok(rejected >= 300, `only ${rejected} variants were exercised`);
});
