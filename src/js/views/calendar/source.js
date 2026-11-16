// SPDX-License-Identifier: AGPL-3.0-or-later
// The data layer of the calendar screens (RUN3 WP B3a, no DOM): which calendars exist for the account, which
// are loaded (enabled in ctx.calendars: one polled store each), the occurrence records of a period, the
// Birthdays virtual calendar built from the address books, and the lookup of one event by route key.
//
// The stores hold server text only; this module parses for READING (calendars.parse, cached per ETag).
// Nothing here writes. A calendar becomes "loaded" when it is first switched on: only then it is fetched and
// polled. Hidden calendars stay loaded while the screen is open (so showing them again is instant and keeps the
// nodes); they are released when the screen is disposed.

import { collectionForParam } from '../../router.js';
import { summarizeItem, keyFor } from '../../contacts/index.js';
import { bdayOfCardDate, birthdayOccurrences, yearlyAllDayKeys } from '../../calendar/birthdays.js';
import { findOccurrence } from '../../calendar/scope.js';
import { BIRTHDAYS_HREF, FALLBACK_COLOUR, COLOUR_ALLOW, describeOccurrence, sameHref } from './common.js';

const norm = (href) => (String(href).endsWith('/') ? String(href) : `${href}/`);
const leaf = (href) => {
  const s = String(href).split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const MAX_KEY = 255;
const RESERVED_KEYS = new Set(['new']);

/** Calendars of the account that hold events. */
export function eventCalendars(access) {
  return access.calendars().filter((c) => !Array.isArray(c.components) || c.components.length === 0 || c.components.includes('VEVENT'));
}

/**
 * @param {object} o
 * @param {object} o.storeCtx store context (access, stores, calendars, writes)
 * @param {object} o.app screen app facade (session, openItem)
 * @param {Function} o.t translator
 */
export function createCalendarSource({ storeCtx, app, t }) {
  const { access, calendars: cals } = storeCtx;
  const enabledHere = new Set(); // hrefs this screen enabled (released on dispose)
  const loading = new Set();
  const failed = new Map(); // href -> error kind of the last failed first sync
  const listeners = new Set();
  let disposed = false;
  let bdayBooks = new Map(); // book href -> {sig, contacts}
  let bdayLoaded = false;
  let bdayLoading = null;
  const emit = (ev) => {
    for (const fn of [...listeners]) {
      try {
        fn(ev);
      } catch {
        /* a failing subscriber must not break the others */
      }
    }
  };
  const off = [cals.subscribe((ev) => emit(ev))];

  const list = () => eventCalendars(access);
  const entryOf = (href) => list().find((c) => sameHref(c.href, href)) || null;

  const source = {
    /** The calendars shown in the list: [{href, name, color, level, canWrite, ownerIsMe, owner, loaded, loading, failed}]. */
    calendars() {
      return list().map((c) => ({
        href: norm(c.href),
        name: c.label || c.displayName || c.name || c.href,
        color: typeof c.color === 'string' && COLOUR_ALLOW.test(c.color.trim()) ? c.color.trim() : FALLBACK_COLOUR,
        level: c.level,
        canWrite: access.canWrite(c),
        ownerIsMe: Boolean(c.ownerIsMe),
        owner: c.owner || null,
        loaded: cals.isEnabled(c.href),
        loading: loading.has(norm(c.href)),
        failed: failed.get(norm(c.href)) || null,
      }));
    },
    calendarMap() {
      const m = new Map();
      for (const c of source.calendars()) m.set(c.href, { name: c.name, color: c.color });
      m.set(BIRTHDAYS_HREF, { name: t('cal.birthdays'), color: '#a64a85' });
      return m;
    },
    isReadOnly: (href) => href === BIRTHDAYS_HREF || !access.canWrite(href),
    /** Writable calendars that accept events (targets for new events and moves). */
    writable: () => list().filter((c) => access.canWrite(c)),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Switch a calendar on: enable, fetch it once. Resolves `{ok}`; a failure is remembered on the row. */
    async load(href) {
      const key = norm(href);
      if (disposed) return { ok: false };
      if (cals.isEnabled(key)) {
        const st = cals.store(key);
        if (st && st.loaded) return { ok: true };
      }
      loading.add(key);
      failed.delete(key);
      emit({ type: 'loading', collection: key });
      const store = cals.enable({ href: key, kind: 'calendar' });
      enabledHere.add(key);
      let res = { ok: false };
      try {
        await cals.ready();
        res = store ? await store.sync({ reason: 'load' }) : { ok: false };
      } catch (e) {
        res = { ok: false, kind: (e && e.kind) || 'unknown' };
      }
      loading.delete(key);
      if (!res.ok && !res.skipped) failed.set(key, res.kind || 'unknown');
      emit({ type: 'loaded', collection: key, ok: Boolean(res.ok) });
      return res;
    },

    /** Occurrence records of the loaded calendars (and Birthdays) for a window: layout.js ready. */
    records({ from, to, range, tz, use24h, lang, birthdays = null, search = null }) {
      const res = cals.occurrences(from, to);
      const entries = cals.entries({ kind: 'event' }).entries;
      const keyOf = makeKeyOf(entries);
      const cx = { t, lang, tz, use24h, calendars: source.calendarMap(), keyOf, readOnly: source.isReadOnly };
      const out = res.occurrences.map((o) => describeOccurrence(o, cx));
      let hiddenDuplicates = 0;
      if (birthdays && birthdays.show) {
        const keys = birthdays.hideDup ? yearlyAllDayKeys(entries.map((e) => e.item)) : null;
        const all = birthdayOccurrences(source.birthdayContacts(), { from: range.start, to: range.end, hideKeys: null });
        const kept = keys ? birthdayOccurrences(source.birthdayContacts(), { from: range.start, to: range.end, hideKeys: keys }) : all;
        hiddenDuplicates = all.length - kept.length;
        for (const o of kept) out.push(describeOccurrence(o, cx));
      }
      out.sort((a, b) => a.sort - b.sort || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return { records: out, truncated: res.truncated, unreadable: res.unreadable, loadingModel: res.loading, hiddenDuplicates };
    },

    // ---------------------------------------------------------------- birthdays

    /** Load the address books once (for the Birthdays calendar). Resolves when the cards are in. */
    loadBirthdays() {
      if (bdayLoaded) return Promise.resolve({ ok: true });
      if (bdayLoading) return bdayLoading;
      emit({ type: 'loading', collection: BIRTHDAYS_HREF });
      bdayLoading = (async () => {
        const books = access.addressbooks();
        let ok = true;
        await Promise.all(
          books.map(async (b) => {
            const st = storeCtx.stores.open({ href: b.href, kind: 'addressbook' });
            if (!st.loaded) {
              const r = await st.sync({ reason: 'load' });
              if (!r.ok && !r.skipped) ok = false;
            }
          }),
        );
        bdayLoaded = true;
        bdayLoading = null;
        emit({ type: 'loaded', collection: BIRTHDAYS_HREF, ok });
        return { ok };
      })();
      return bdayLoading;
    },
    hasAddressBooks: () => access.addressbooks().length > 0,
    isBirthdaysLoaded: () => bdayLoaded,
    isBirthdaysLoading: () => Boolean(bdayLoading),
    /** Contact summaries `{uid, key, ab, fn, bday}` of every readable card with a birthday (cached per ETag). */
    birthdayContacts() {
      const out = [];
      for (const b of access.addressbooks()) {
        const st = storeCtx.stores.get(b.href);
        if (!st) continue;
        const entries = st.list();
        const sig = entries.map((e) => `${e.href}\n${e.etag}`).join('\u0000');
        let rec = bdayBooks.get(b.href);
        if (!rec || rec.sig !== sig) {
          const summaries = [];
          const withBday = [];
          for (const e of entries) {
            let r = null;
            try {
              r = app.openItem(e.text, 'contact');
            } catch {
              r = null;
            }
            if (!r || !r.ok) continue;
            const s = summarizeItem(r, { href: e.href, etag: e.etag });
            summaries.push(s);
            if (s.isGroup) continue;
            const bday = bdayOfCardDate(r.fields().bday);
            if (bday) withBday.push({ s, bday });
          }
          const contacts = withBday.map(({ s, bday }) => ({ uid: s.uid, key: keyFor(s, summaries), ab: norm(b.href), fn: s.name, bday }));
          rec = { sig, contacts };
          bdayBooks.set(b.href, rec);
        }
        out.push(...rec.contacts);
      }
      return out;
    },

    // ---------------------------------------------------------------- one event

    /**
     * Find an event by route key in a calendar: `{state: 'ok', entry, item, occ}` or `{state: 'notfound'|'nocalendar'|
     * 'occurrence'|'unreadable'|'error', ...}`. The calendar is loaded first when needed. `occParam` is the `occ`
     * URL parameter ('single' or absent: the only/first occurrence).
     */
    async resolveEvent({ key, cal, occParam }) {
      const coll = collectionForParam(cal, list());
      if (!coll) return { state: 'nocalendar' };
      if (typeof key !== 'string' || key === '' || key.length > MAX_KEY) return { state: 'notfound', collection: coll };
      const res = await source.load(coll.href);
      if (!res.ok && !res.skipped && !cals.store(coll.href)?.size) return { state: 'error', collection: coll, kind: res.kind || 'unknown' };
      await cals.ready();
      const store = cals.store(coll.href);
      const entries = store ? store.list() : [];
      const parsed = entries.map((e) => ({ entry: e, p: cals.parse(e) }));
      const uidHits = parsed.filter((x) => x.p.ok && x.p.kind === 'event' && x.p.uid === key);
      let hit = uidHits.length === 1 ? uidHits[0] : parsed.find((x) => leaf(x.entry.href) === key) || null;
      if (!hit) return { state: 'notfound', collection: coll };
      const { entry, p } = hit;
      if (!p.ok) return { state: 'unreadable', collection: coll, entry, reason: p.reason || 'parse-error' };
      if (p.kind !== 'event') return { state: 'notfound', collection: coll };
      let occ = null;
      if (occParam && occParam !== 'single') {
        occ = findOccurrence(p, occParam);
        if (!occ) return { state: 'occurrence', collection: coll, entry, item: p };
      } else {
        occ = safeExpand(p).occurrences[0] || null;
      }
      return { state: 'ok', collection: coll, entry, item: p, occ, key };
    },

    isLoaded: (href) => cals.isEnabled(href) && Boolean(cals.store(href) && cals.store(href).loaded),
    dispose() {
      disposed = true;
      for (const o of off) o();
      listeners.clear();
      for (const key of enabledHere) cals.disable(key);
      enabledHere.clear();
      bdayBooks = new Map();
    },
  };
  return source;
}

function safeExpand(item) {
  try {
    return item.expand({ limit: 1 });
  } catch {
    return { occurrences: [] };
  }
}

/** href -> route key: the UID when it is unique inside its calendar (and usable in a URL), else the file name. */
export function makeKeyOf(entries) {
  const counts = new Map();
  for (const e of entries) {
    const uid = e.item && e.item.uid;
    if (uid) counts.set(`${e.collection}|${uid}`, (counts.get(`${e.collection}|${uid}`) || 0) + 1);
  }
  const byHref = new Map(entries.map((e) => [e.href, e]));
  return (href) => {
    const e = byHref.get(href);
    if (!e) return leaf(href);
    const uid = e.item && e.item.uid;
    if (uid && uid.length <= MAX_KEY && !RESERVED_KEYS.has(uid) && counts.get(`${e.collection}|${uid}`) === 1) return uid;
    return leaf(href);
  };
}
