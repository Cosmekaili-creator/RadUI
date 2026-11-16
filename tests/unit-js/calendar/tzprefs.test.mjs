// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { loadDisplayZone, pushRecent, recentZones, saveDisplayZone, searchZones, wallInZone, instantInZone, wallStatus, zoneList, zoneOffsetLabel, MAX_RECENT } from "../../../src/js/calendar/tzprefs.js";

const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};
const brokenStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };

test("display zone: stored pref, then the configured default, then the browser zone", () => {
  const s = fakeStorage();
  assert.equal(loadDisplayZone("Alice", { storage: s, defaultZone: "Asia/Kathmandu", browserZone: "Europe/Paris" }), "Asia/Kathmandu");
  assert.equal(loadDisplayZone("alice", { storage: s, browserZone: "Europe/Paris" }), "Europe/Paris");
  assert.equal(saveDisplayZone("ALICE", "America/New_York", { storage: s }), true);
  assert.equal(loadDisplayZone("alice", { storage: s, defaultZone: "Asia/Kathmandu" }), "America/New_York", "per login, case-insensitive");
  assert.equal(loadDisplayZone("bob", { storage: s, defaultZone: "Asia/Kathmandu" }), "Asia/Kathmandu", "another login is not affected");
  assert.equal(saveDisplayZone("alice", "Not/AZone", { storage: s }), false);
  s.m.set("radui.tz.display.carol", "garbage");
  assert.equal(loadDisplayZone("carol", { storage: s, browserZone: "UTC" }), "UTC", "an invalid stored value is ignored");
});

test("storage failures are swallowed", () => {
  assert.equal(loadDisplayZone("a", { storage: brokenStorage, defaultZone: "Europe/Paris" }), "Europe/Paris");
  assert.equal(saveDisplayZone("a", "Europe/Paris", { storage: brokenStorage }), false);
  assert.deepEqual(recentZones("a", { storage: brokenStorage }), []);
  assert.equal(loadDisplayZone("a", { storage: null, browserZone: "UTC" }), "UTC");
});

test("recent zones: newest first, no duplicates, capped", () => {
  const s = fakeStorage();
  for (const z of ["Europe/Paris", "Asia/Kathmandu", "Europe/Paris", "UTC", "America/New_York", "Australia/Lord_Howe", "Africa/Casablanca", "Pacific/Chatham"]) pushRecent("a", z, { storage: s });
  const r = recentZones("a", { storage: s });
  assert.equal(r.length, MAX_RECENT);
  assert.equal(r[0], "Pacific/Chatham");
  assert.equal(new Set(r).size, r.length);
  assert.deepEqual(pushRecent("a", "Bogus", { storage: s }), []);
});

test("zoneList: recent, then seen, then all; each once; fallback without Intl list", () => {
  const list = zoneList({ supported: ["Europe/Paris", "Asia/Kathmandu", "UTC"], seen: ["Asia/Kathmandu", "Bogus"], recent: ["Europe/Paris"], browser: "Europe/Paris" });
  assert.deepEqual(list.map((z) => [z.id, z.group]), [["Europe/Paris", "recent"], ["Asia/Kathmandu", "seen"], ["UTC", "all"]]);
  const fb = zoneList({ supported: [], seen: ["America/New_York"], browser: "Europe/Paris" });
  assert.deepEqual(fb.map((z) => z.id), ["America/New_York", "UTC", "Europe/Paris"]);
});

test("zoneList: the runtime's old CLDR names are listed under the current IANA names (Katmandu -> Kathmandu)", () => {
  const list = zoneList({ supported: ["Asia/Katmandu", "Asia/Calcutta", "Europe/Kiev", "Europe/Paris"], extra: [] });
  assert.deepEqual(list.map((z) => z.id), ["Asia/Kathmandu", "Asia/Kolkata", "Europe/Kyiv", "Europe/Paris"]);
  assert.deepEqual(searchZones(list, "kathmandu").map((z) => z.id), ["Asia/Kathmandu"]);
  assert.deepEqual(zoneList({ supported: ["Asia/Katmandu", "Asia/Kathmandu"], extra: [] }).map((z) => z.id), ["Asia/Kathmandu"], "each id once");
});

test("searchZones: folded tokens over the id", () => {
  const list = zoneList({ supported: ["America/New_York", "America/Nuuk", "Europe/Paris", "Asia/Kathmandu"], extra: [] });
  assert.deepEqual(searchZones(list, "new york").map((z) => z.id), ["America/New_York"]);
  assert.deepEqual(searchZones(list, "AMERICA").map((z) => z.id), ["America/New_York", "America/Nuuk"]);
  assert.equal(searchZones(list, "").length, 4);
  assert.deepEqual(searchZones(list, "zzz"), []);
});

test("wall clock conversions and the offset label", () => {
  const i = Date.UTC(2026, 6, 1, 12, 0);
  assert.equal(wallInZone(i, "Asia/Kathmandu"), Date.UTC(2026, 6, 1, 17, 45));
  assert.equal(instantInZone(Date.UTC(2026, 6, 1, 17, 45), "Asia/Kathmandu"), i);
  assert.equal(zoneOffsetLabel("Asia/Kathmandu", i), "UTC+05:45");
  assert.equal(zoneOffsetLabel("UTC", i), "UTC");
});

test("wallStatus: a gap shows what the clock reads, an overlap is flagged, Lord Howe has a 30 minute change", () => {
  assert.deepEqual(wallStatus("2026-03-29T02:30:00", "Europe/Paris"), { status: "gap", resolvedIso: "2026-03-29T03:30:00" });
  assert.equal(wallStatus("2026-10-25T02:30:00", "Europe/Paris").status, "overlap");
  assert.equal(wallStatus("2026-06-01T12:00:00", "Europe/Paris").status, "ok");
  assert.equal(wallStatus("2026-10-04T02:15:00", "Australia/Lord_Howe").status, "gap");
  assert.equal(wallStatus("2026-04-05T01:45:00", "Australia/Lord_Howe").status, "overlap");
});
