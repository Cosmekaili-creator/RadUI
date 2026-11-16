// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the shared S12 probe in the browser and publishes the result on window.__s12.
import ICAL from "./ical.min.js";
import { probe, FIXTURES } from "./s12-probe.mjs";

async function readText(name) {
  const r = await fetch("fixtures/" + name, { cache: "no-store", credentials: "omit" });
  if (!r.ok) throw new Error("fixture " + name + ": HTTP " + r.status);
  return r.text();
}
const texts = {};
for (const f of FIXTURES) texts[f] = await readText(f);
try {
  window.__s12 = { ok: true, result: probe(ICAL, texts) };
} catch (e) {
  window.__s12 = { ok: false, error: String(e && e.stack || e) };
}
document.querySelector("[data-testid=status]").textContent = "done";
document.documentElement.dataset.state = "ready";
