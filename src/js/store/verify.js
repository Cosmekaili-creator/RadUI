// SPDX-License-Identifier: AGPL-3.0-or-later
// Write verification (D-R2-7, addendum M8). After a PUT the item is read back and the OWNED fields
// of what was sent are compared with what the server stores. The comparison is on a normalised
// PROJECTION, not on text, because Radicale re-serialises (property order, parameter-name case,
// folding, TYPE=a,b against repeated TYPE):
//
//   entries (tel, email, adr, url)  a multiset of (value, lower-case sorted types, pref, label)
//   group members                   a set of URIs without `urn:uuid:`, lower case
//   photo                           presence + the whitespace-stripped base64 payload
//   dates                           parsed ({year, month, day} or the raw text)
//   categories                      a set
//   text fields                     line endings normalised, trimmed
//
// NICKNAME is compared as a whole list and is part of EVERY check: Radicale cuts `NICKNAME:a,b` to `a` on any
// PUT of the card, even when only a phone number was edited (spike S2-3).
// A mismatch means the server stored something else than what was sent (for example a silently
// truncated unescaped comma). It is reported, never auto-fixed.
//
// Events and tasks (RUN3 D-R3-5.4) are compared the same way, as a projection per component (the master and
// each override by RECURRENCE-ID): text fields trimmed, categories sorted, times as {kind, tzid, at} (the
// INSTANT for UTC and zoned values, the wall clock for dates and floating ones, so a VTIMEZONE that the
// server added is never a mismatch), the RRULE as a sorted part map, the EXDATE instants as a sorted set,
// the modelled alarms as a sorted multiset. Only the components and keys the operations touched are compared
// (`touchedOfOps`). The module reads items through their public accessors (`fields()`, `overrideFields()`,
// `zones`) and never imports the calendar model, so the contacts path does not load ical.js.

import { parseRRule, parseTime, specWallMs } from '../model/contentlines.js';
import { ADR_FIELDS, N_FIELDS, partText, readPhotoData } from '../model/vcard.js';

/** Every contact key the projection covers. */
export const PROJECTED_KEYS = Object.freeze(['fn', 'n', 'nickname', 'org', 'title', 'tel', 'email', 'adr', 'url', 'bday', 'anniversary', 'note', 'categories', 'photo', 'kind', 'members']);

const text = (v) => String(v === undefined || v === null ? '' : v).replace(/\r\n?/g, '\n').trim();
const typeKey = (types) => [...new Set((types || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort().join(',');
const memberKey = (m) => String(m).trim().replace(/^urn:uuid:/i, '').toLowerCase();

function entryKey(name, e) {
  let value;
  if (name === 'adr') value = JSON.stringify(ADR_FIELDS.map((f) => partText(e.value ? e.value[f] : '')));
  else value = text(e.value);
  return JSON.stringify([value, typeKey(e.types), e.pref ? 1 : 0, text(e.label)]);
}

function dateKey(d) {
  if (!d) return '';
  if (d.text) return `text:${text(d.raw)}`;
  return `${d.year || ''}-${d.month}-${d.day}`;
}

/** Contact keys a patch (or a created fields object) touches, mapped to projection keys. */
export function keysOfPatch(patch) {
  const out = new Set();
  for (const k of Object.keys(patch || {})) {
    if (k === 'members' || k === 'membersDelta') out.add('members');
    else if (PROJECTED_KEYS.includes(k)) out.add(k);
  }
  return [...out];
}

/**
 * Normalised projection of an open contact `Item`.
 * @param {object} item an Item (kind 'contact')
 * @param {string[]} [keys] default: all projected keys
 */
export function projectContact(item, keys = PROJECTED_KEYS) {
  const f = item.fields();
  const out = {};
  for (const k of keys) {
    switch (k) {
      case 'fn':
      case 'title':
      case 'note':
        out[k] = text(f[k]);
        break;
      case 'n':
        out.n = N_FIELDS.map((p) => partText(f.n ? f.n[p] : ''));
        break;
      case 'nickname':
        // the whole list: the server truncates NICKNAME:a,b to a, which must show up as a mismatch
        out.nickname = (f.nickname || []).map(text);
        break;
      case 'org':
        out.org = f.org ? [text(f.org.name), ...(f.org.units || []).map(text)] : [];
        break;
      case 'tel':
      case 'email':
      case 'adr':
      case 'url':
        out[k] = (f[k] || []).map((e) => entryKey(k, e)).sort();
        break;
      case 'bday':
      case 'anniversary':
        out[k] = dateKey(f[k]);
        break;
      case 'categories':
        out.categories = [...new Set((f.categories || []).map(text))].sort();
        break;
      case 'photo': {
        if (!f.photo || !f.photo.present) {
          out.photo = null;
          break;
        }
        const p = readPhotoData(item.main, { maxBytes: Infinity });
        out.photo = p.ok ? { b64: String(p.base64).replace(/\s+/g, '') } : { unreadable: p.reason };
        break;
      }
      case 'kind':
        out.kind = f.kind || '';
        break;
      case 'members':
        out.members = [...new Set(((f.group && f.group.isGroup ? f.group.members : []) || []).map(memberKey))].sort();
        break;
      default:
        break;
    }
  }
  return out;
}

/** Keys whose projections differ. */
export function diffProjections(sent, got) {
  const bad = [];
  for (const k of Object.keys(sent)) if (JSON.stringify(sent[k]) !== JSON.stringify(got[k])) bad.push(k);
  return bad;
}

/**
 * Compare what was sent with what the server returned.
 * @param {{openItem: Function}} model
 * @param {{sentText: string, gotText: string, keys?: string[], acceptedNicknames?: string[]}} o
 * @returns {{ok: boolean, skipped?: boolean, mismatched: string[], unreadable?: boolean}}
 */
export function verifyContact(model, { sentText, gotText, keys, acceptedNicknames = [] }) {
  const sent = model.openItem(sentText, 'contact');
  const got = model.openItem(gotText, 'contact');
  if (!sent.ok) return { ok: true, skipped: true, mismatched: [] };
  if (!got.ok) return { ok: false, mismatched: [], unreadable: true };
  const use = keys && keys.length ? [...new Set([...keys, 'nickname'])] : PROJECTED_KEYS;
  return (() => {
    const sentProj = projectContact(sent, use);
    // nickname values the caller accepted to lose (the server keeps the first of a list) are not a mismatch
    if (acceptedNicknames.length && Array.isArray(sentProj.nickname)) sentProj.nickname = sentProj.nickname.filter((n) => !acceptedNicknames.includes(n));
    const bad = diffProjections(sentProj, projectContact(got, use));
    return { ok: bad.length === 0, mismatched: bad };
  })();
}

const splitUnescapedCommas = (v) => {
  const parts = [];
  let cur = '';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '\\' && i + 1 < v.length) {
      cur += ch + v[++i];
    } else if (ch === ',') {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
};

/**
 * The NICKNAME values the server would drop from an outgoing vCard text: every value after the first of
 * an unescaped comma list (`NICKNAME:a,b` is stored as `a`; `NICKNAME:a\\,b` survives). Empty for other texts.
 */
export function lostNicknames(cardText) {
  const lost = [];
  const unfolded = String(cardText).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  for (const line of unfolded.split('\n')) {
    const m = /^(?:[A-Za-z0-9-]+\.)?NICKNAME(?:;[^:]*)?:(.*)$/i.exec(line);
    if (!m) continue;
    const parts = splitUnescapedCommas(m[1]).map((x) => x.trim());
    lost.push(...parts.slice(1).filter(Boolean));
  }
  return lost;
}

// ------------------------------------------------------------------------------------------------ events and tasks

export const EVENT_KEYS = Object.freeze(['summary', 'description', 'location', 'url', 'categories', 'status', 'transp', 'start', 'end', 'rrule', 'exdates', 'alarms']);
export const TASK_KEYS = Object.freeze(['summary', 'description', 'due', 'start', 'priority', 'status', 'percent', 'completed', 'categories', 'rrule']);

const SET_PARTS = new Set(['BYDAY', 'BYMONTH', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYSETPOS']);

/** An RRULE as a sorted part map text (`BYDAY=MO,TH;FREQ=WEEKLY`): part order and list order are not significant. */
export function rruleProjection(raw) {
  if (!raw) return null;
  try {
    return parseRRule(String(raw).trim())
      .map(([k, v]) => `${k}=${SET_PARTS.has(k) ? v.split(',').map((x) => x.trim().toUpperCase()).sort().join(',') : v.trim()}`)
      .sort()
      .join(';');
  } catch {
    return `raw:${String(raw).trim()}`;
  }
}

const isoOf = (ms, date) => new Date(ms).toISOString().slice(0, date ? 10 : 19);

/** A TimeSpec as {kind, tzid, at, wall}: `at` is the instant for utc/zoned values (when the zone is known), else the wall clock text. */
export function timeProjection(spec, zones) {
  if (!spec) return null;
  const wallMs = specWallMs(spec);
  let at = spec.iso;
  if (spec.kind === 'utc') at = wallMs;
  else if (spec.kind === 'zoned') {
    const z = zones && zones.get ? zones.get(spec.tzid) : null;
    if (z) at = z.instantFromWall(wallMs);
  }
  return { kind: spec.kind, tzid: spec.tzid || null, at, wall: spec.iso };
}

/** The effective end of an event component (DTEND, or start + DURATION, or the default length). */
function endProjection(f, zones) {
  if (!f.start) return null;
  if (f.end) return timeProjection(f.end, zones);
  const sec = f.duration !== null && f.duration !== undefined ? f.duration : f.start.kind === 'date' ? 86400 : 0;
  const s = timeProjection(f.start, zones);
  if (typeof s.at === 'number') return { ...s, at: s.at + sec * 1000, wall: s.wall };
  const wall = specWallMs(f.start) + sec * 1000;
  const iso = isoOf(wall, f.start.kind === 'date');
  return { kind: f.start.kind, tzid: s.tzid, at: iso, wall: iso };
}

/** The identity of an occurrence (RECURRENCE-ID, EXDATE): the instant, else the wall clock. */
export function occurrenceKey(spec, zones) {
  const t = timeProjection(spec, zones);
  return typeof t.at === 'number' ? `i${t.at}` : `w${t.at}`;
}

const sortedText = (list) => [...new Set((list || []).map(text).filter(Boolean))].sort();

function eventComponentProjection(f, zones) {
  return {
    summary: text(f.summary),
    description: text(f.description),
    location: text(f.location),
    url: text(f.url),
    categories: sortedText(f.categories),
    status: f.status || '',
    transp: f.transp || '',
    start: timeProjection(f.start, zones),
    end: endProjection(f, zones),
    rrule: rruleProjection(f.rrule),
    exdates: [...new Set((f.exdates || []).map((x) => occurrenceKey(x, zones)))].sort(),
    alarms: (f.alarms || []).map((a) => `${a.seconds}|${a.related || 'START'}`).sort(),
  };
}

/**
 * Normalised projection of an open event `Item`: `{kind: 'event', master, overrides: {<occurrenceKey>: {...}}}`.
 * Every key of EVENT_KEYS is present on every component (callers compare only the keys they touched).
 */
export function projectEvent(item) {
  const zones = item.zones;
  const out = { kind: 'event', master: eventComponentProjection(item.fields(), zones), overrides: {} };
  const comps = item.overrides;
  item.overrideFields().forEach((o, i) => {
    const p = comps[i].prop('RECURRENCE-ID');
    const spec = parseTime(p.value, p.params);
    const { recurrenceId: _raw, ...f } = o;
    out.overrides[occurrenceKey(spec, zones)] = { ...eventComponentProjection(f, zones), rid: spec.iso };
  });
  return out;
}

/** Normalised projection of an open task `Item`. */
export function projectTask(item) {
  const f = item.fields();
  const zones = item.zones;
  return {
    kind: 'task',
    master: {
      summary: text(f.summary),
      description: text(f.description),
      due: timeProjection(f.due, zones),
      start: timeProjection(f.start, zones),
      priority: f.priority === null || f.priority === undefined ? 0 : f.priority,
      status: f.status || '',
      percent: f.percent === null || f.percent === undefined ? null : f.percent,
      completed: Boolean(f.completed),
      categories: sortedText(f.categories),
      rrule: rruleProjection(f.rrule),
    },
    overrides: {},
  };
}

/** Projection of any open calendar `Item` (event or task). */
export const projectCalendarItem = (item) => (item.kind === 'task' ? projectTask(item) : projectEvent(item));

const FIELD_KEYS = {
  start: ['start', 'end'],
  end: ['end'],
  duration: ['end'],
  rdates: ['exdates'],
};
const mapKeys = (fields, valid) => {
  const out = new Set();
  for (const k of Object.keys(fields || {})) for (const m of FIELD_KEYS[k] || [k]) if (valid.includes(m)) out.add(m);
  return out;
};

/**
 * What a list of operations touches (so only that is verified):
 * `{master: string[] | 'all', occurrences: [{rid, keys: string[] | 'all'}], overrideSet: boolean, allOverrides: boolean}`.
 */
export function touchedOfOps(ops, kind = 'event') {
  const valid = kind === 'task' ? TASK_KEYS : EVENT_KEYS;
  const master = new Set();
  const occurrences = [];
  let overrideSet = false;
  let allOverrides = false;
  for (const op of ops || []) {
    switch (op.type) {
      case 'patch':
        for (const k of mapKeys(op.fields, valid)) master.add(k);
        break;
      case 'override':
        occurrences.push({ rid: op.rid, keys: [...mapKeys(op.fields, EVENT_KEYS)] });
        overrideSet = true;
        break;
      case 'deleteOccurrence':
        master.add('exdates');
        overrideSet = true;
        break;
      case 'removeExdate':
        master.add('exdates');
        break;
      case 'removeOverride':
        overrideSet = true;
        break;
      case 'truncate':
        master.add('rrule');
        master.add('exdates');
        overrideSet = true;
        break;
      case 'shiftExceptions':
        master.add('exdates');
        master.add('rrule');
        overrideSet = true;
        allOverrides = true;
        break;
      case 'complete':
      case 'reopen':
        for (const k of ['status', 'percent', 'completed']) master.add(k);
        break;
      default:
        break;
    }
  }
  return { master: [...master], occurrences, overrideSet, allOverrides };
}

/** Compare everything (a new item, the tail of a split, a moved copy). */
export const TOUCH_ALL = Object.freeze({ master: 'all', occurrences: [], overrideSet: true, allOverrides: true });

const jsonKey = (v) => JSON.stringify(v, (k, x) => (k === 'wall' || k === 'rid' ? undefined : x));

/**
 * Keys whose projections differ between `sent` and `got` (both from projectCalendarItem), limited to `touched`.
 * Names: `summary`, `override:<key>`, `override:<key>:summary`.
 */
export function diffCalendarProjections(sent, got, touched = TOUCH_ALL) {
  const bad = [];
  const keys = touched.master === 'all' ? Object.keys(sent.master) : touched.master;
  for (const k of keys) if (jsonKey(sent.master[k]) !== jsonKey(got.master[k])) bad.push(k);
  const sKeys = Object.keys(sent.overrides).sort();
  const gKeys = Object.keys(got.overrides).sort();
  if (touched.overrideSet && jsonKey(sKeys) !== jsonKey(gKeys)) bad.push('overrides');
  const compareOverride = (key, which) => {
    const a = sent.overrides[key];
    const b = got.overrides[key];
    if (!a || !b) return;
    const ks = which === 'all' ? EVENT_KEYS : which;
    for (const k of ks) if (jsonKey(a[k]) !== jsonKey(b[k])) bad.push(`override:${key}:${k}`);
  };
  if (touched.allOverrides) for (const key of sKeys) compareOverride(key, 'all');
  else for (const o of touched.occurrences || []) compareOverride(o.__key || o.key, o.keys === 'all' ? 'all' : o.keys);
  return [...new Set(bad)];
}

/**
 * Compare what was sent with what the server returned, for an event or a task.
 * `touched` is the result of touchedOfOps (or TOUCH_ALL).
 * @returns {{ok: boolean, skipped?: boolean, mismatched: string[], unreadable?: boolean}}
 */
export function verifyCalendar(model, { sentText, gotText, touched = TOUCH_ALL }) {
  const sent = model.openItem(sentText);
  const got = model.openItem(gotText);
  if (!sent.ok) return { ok: true, skipped: true, mismatched: [] };
  if (!got.ok) return { ok: false, mismatched: [], unreadable: true };
  if (sent.kind !== got.kind) return { ok: false, mismatched: ['kind'] };
  const a = projectCalendarItem(sent);
  const b = projectCalendarItem(got);
  const resolved = resolveOccurrences(touched, sent.zones);
  const bad = diffCalendarProjections(a, b, resolved);
  return { ok: bad.length === 0, mismatched: bad };
}

/** Add the occurrence key to each touched occurrence (needs the zones of the item the rid is read against). */
export function resolveOccurrences(touched, zones) {
  return { ...touched, occurrences: (touched.occurrences || []).map((o) => ({ ...o, key: occurrenceKey(o.rid, zones) })) };
}
