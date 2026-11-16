// SPDX-License-Identifier: AGPL-3.0-or-later
// Display time zone preference and the zone list (RUN3 D-R3-6). No DOM.
//
//   displayZone(tz)                       the zone object of icalview (Intl based) for one IANA name
//   wallInZone(instantMs, tz)             the wall clock (ms, as if UTC) an instant has in that zone
//   loadDisplayZone(login, {...})         stored pref -> configured default -> browser zone
//   saveDisplayZone(login, tz, {...})     also pushes the zone onto the recents list
//   zoneList({...}) / searchZones(list, query)   the searchable switcher list
//
// Changing the display zone never writes anything to the server: it only redraws.
// localStorage is always used inside try/catch and may be missing (private window).

import { Component } from "../model/contentlines.js";
import { createZones } from "../model/icalview.js";
import { foldText } from "../widgets/fold.js";
import { isValidTimeZone, resolveTimeZone } from "../i18n.js";

export const DISPLAY_KEY = "radui.tz.display.";
export const RECENT_KEY = "radui.tz.recent.";
export const MAX_RECENT = 6;

const cache = new Map();
const emptyZones = () => createZones(new Component("VCALENDAR"));
let shared = null;

/** The Intl based zone ({offsetAtInstant, instantFromWall, wallFromInstant}) of an IANA name, or null. */
export function displayZone(tz) {
  if (!cache.has(tz)) {
    shared = shared || emptyZones();
    cache.set(tz, isValidTimeZone(tz) || tz === "UTC" ? shared.get(tz) : null);
  }
  return cache.get(tz);
}

/** Wall clock (ms as if UTC) of an instant in zone `tz`. An unknown zone falls back to UTC. */
export function wallInZone(instantMs, tz) {
  const z = displayZone(tz);
  return z ? z.wallFromInstant(instantMs) : instantMs;
}

/** The instant of a wall clock (ms as if UTC) in zone `tz` (gap: offset before the gap; overlap: first). */
export function instantInZone(wallMs, tz) {
  const z = displayZone(tz);
  return z ? z.instantFromWall(wallMs) : wallMs;
}

const loginKey = (login) => String(login || "").trim().toLowerCase();

function getStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(storage, key) {
  try {
    const s = getStorage(storage);
    return s ? s.getItem(key) : null;
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    const s = getStorage(storage);
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The zone the grid is drawn in: the stored pref of this login, else `defaultZone` (config), else the browser's. */
export function loadDisplayZone(login, { storage, defaultZone = null, browserZone } = {}) {
  const stored = read(storage, DISPLAY_KEY + loginKey(login));
  if (stored && isValidTimeZone(stored)) return stored;
  if (defaultZone && isValidTimeZone(defaultZone)) return defaultZone;
  if (browserZone && isValidTimeZone(browserZone)) return browserZone;
  return resolveTimeZone(null);
}

/** Store the display zone (false when the name is not a zone or storage is unavailable). */
export function saveDisplayZone(login, tz, { storage } = {}) {
  if (!isValidTimeZone(tz)) return false;
  const ok = write(storage, DISPLAY_KEY + loginKey(login), tz);
  pushRecent(login, tz, { storage });
  return ok;
}

/** Recent zones, newest first (invalid names dropped). */
export function recentZones(login, { storage } = {}) {
  const raw = read(storage, RECENT_KEY + loginKey(login));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((z) => typeof z === "string" && isValidTimeZone(z)).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function pushRecent(login, tz, { storage } = {}) {
  if (!isValidTimeZone(tz)) return [];
  const next = [tz, ...recentZones(login, { storage }).filter((z) => z !== tz)].slice(0, MAX_RECENT);
  write(storage, RECENT_KEY + loginKey(login), JSON.stringify(next));
  return next;
}

/** Every zone Intl supports; falls back to nothing when the runtime has no list. */
export function supportedZones() {
  try {
    if (typeof Intl.supportedValuesOf === "function") return Intl.supportedValuesOf("timeZone");
  } catch {
    /* fall through */
  }
  return [];
}

/**
 * V8/ICU lists a few zones under their old CLDR names ("Asia/Katmandu"); calendars and the IANA database use the current
 * ones ("Asia/Kathmandu"), and people search for those. The zone list shows the current name when the runtime knows it.
 */
export const IANA_NAMES = Object.freeze({
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Africa/Asmera": "Africa/Asmara",
});

/**
 * The list the switcher shows: [{id, group}] with group 'recent' | 'seen' | 'all'. Recent zones come
 * first, then the zones seen in the loaded items, then the rest. When the runtime has no zone
 * list the fallback is the zones seen + UTC + the browser zone. Each id appears once.
 */
export function zoneList({ supported = supportedZones(), seen = [], recent = [], browser, extra = ["UTC"] } = {}) {
  const out = [];
  const used = new Set();
  const add = (id, group) => {
    if (typeof id !== "string" || !id || used.has(id) || !(isValidTimeZone(id) || id === "UTC")) return;
    used.add(id);
    out.push({ id, group });
  };
  for (const z of recent) add(z, "recent");
  for (const z of seen) add(z, "seen");
  if (supported.length) {
    for (const z of supported) add(IANA_NAMES[z] && isValidTimeZone(IANA_NAMES[z]) ? IANA_NAMES[z] : z, "all");
    for (const z of extra) add(z, "all");
  } else {
    for (const z of extra) add(z, "all");
    add(browser, "all");
  }
  return out;
}

/** Folded token search over the zone id ("new york" finds the New_York zone); an empty query keeps the list. */
export function searchZones(list, query) {
  const tokens = foldText(query).split(/\s+/u).filter(Boolean);
  if (!tokens.length) return list.slice();
  return list.filter((z) => {
    const hay = foldText(z.id.replace(/[_/]/g, " "));
    return tokens.every((t) => hay.includes(t));
  });
}

/** "UTC+05:45" style label of a zone at an instant; '' when Intl cannot say. */
export function zoneOffsetLabel(tz, atMs = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(atMs));
    const name = (parts.find((p) => p.type === "timeZoneName") || {}).value || "";
    return name === "GMT" ? "UTC" : name.replace(/^GMT/, "UTC");
  } catch {
    return "";
  }
}

/**
 * Status of a wall clock in a zone object (icalview zone): {status:'ok'|'gap'|'overlap', resolvedIso?}.
 * A time inside a DST gap does not exist: it is stored as written but means the offset before the gap
 * (RFC 5545 3.3.5); `resolvedIso` is what the clock shows then ("14:30 does not exist ... stored as 03:30").
 */
export function zoneWallStatus(zone, wallIso) {
  if (!zone) return { status: "ok" };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(wallIso || "");
  if (!m) return { status: "ok" };
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const instant = zone.instantFromWall(wall);
  const back = zone.wallFromInstant(instant);
  if (back !== wall) return { status: "gap", resolvedIso: new Date(back).toISOString().slice(0, 19) };
  for (const d of [1800000, 3600000, 7200000]) if (zone.wallFromInstant(instant + d) === wall) return { status: "overlap" };
  return { status: "ok" };
}

/** zoneWallStatus for an IANA name (Intl based). */
export const wallStatus = (wallIso, tz) => zoneWallStatus(displayZone(tz), wallIso);
