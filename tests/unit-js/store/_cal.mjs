// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared fakes for the event/task store tests (RUN3 B2): one fake DAV server holding several calendars, a session with a
// real write path over it, and small .ics builders (fictional data, zones Europe/Paris and America/New_York).
// No tests in here.
import { ConflictError, DavError } from '../../../src/js/dav/http.js';
import { createSession } from '../../../src/js/session.js';
import { createActivityLog, createFeedback, createWriteGate } from '../../../src/js/ui.js';
import { createAccess } from '../../../src/js/store/access.js';
import { createStores } from '../../../src/js/store/itemstore.js';
import { createReporter } from '../../../src/js/store/report.js';
import { createScheduler } from '../../../src/js/store/scheduler.js';
import { createWrites } from '../../../src/js/store/writes.js';
import { FakeApi, FakeServer, createClock, fakeDoc, fakeStorage, fakeTarget, lf, model } from './_helpers.mjs';

export { ConflictError, DavError, lf, model };

export const CAL_A = '/alice/cal-a/';
export const CAL_B = '/alice/cal-b/';
export const CAL_TASKS = '/alice/tasks-only/';
export const CAL_RO = '/bob/shared/';
export const ALL = [CAL_A, CAL_B, CAL_TASKS, CAL_RO];

// ------------------------------------------------------------------ .ics builders

const PARIS_TZ = `BEGIN:VTIMEZONE
TZID:Europe/Paris
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
`;

const wrap = (body, { tz = false, prodid = '-//Example Corp//Calendar 1.0//EN' } = {}) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:${prodid}\n${tz ? PARIS_TZ : ''}${body}END:VCALENDAR\n`;

/** One non-recurring timed event in Paris. */
export const single = (uid, summary = 'Lunch', { start = '20260604T120000', end = '20260604T130000', extra = '' } = {}) =>
  wrap(`BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART;TZID=Europe/Paris:${start}\nDTEND;TZID=Europe/Paris:${end}\nSUMMARY:${summary}\n${extra}END:VEVENT\n`, { tz: true });

/** A weekly (Mondays 09:30 Paris) series, `count` occurrences from 2026-03-02, with optional EXDATE lines and override components. */
export const weekly = (uid, { summary = 'Weekly sync', count = 8, rrule = null, exdates = [], overrides = '', extra = '' } = {}) =>
  wrap(
    `BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART;TZID=Europe/Paris:20260302T093000\nDTEND;TZID=Europe/Paris:20260302T103000\nRRULE:${rrule || `FREQ=WEEKLY;COUNT=${count};BYDAY=MO`}\n${exdates.map((d) => `EXDATE;TZID=Europe/Paris:${d}\n`).join('')}SUMMARY:${summary}\n${extra}END:VEVENT\n${overrides}`,
    { tz: true },
  );

/** An override VEVENT for the occurrence at `rid` (Paris wall time), moved to `start`..`end`. */
export const override = (uid, rid, { start = rid, end = null, summary = 'Weekly sync (changed)' } = {}) =>
  `BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nRECURRENCE-ID;TZID=Europe/Paris:${rid}\nDTSTART;TZID=Europe/Paris:${start}\n${end ? `DTEND;TZID=Europe/Paris:${end}\n` : ''}SUMMARY:${summary}\nEND:VEVENT\n`;

export const task = (uid, summary = 'Write report', extra = '') => wrap(`BEGIN:VTODO\nUID:${uid}\nDTSTAMP:20260101T000000Z\nSUMMARY:${summary}\nSTATUS:NEEDS-ACTION\n${extra}END:VTODO\n`);

/** An event whose zone no VTIMEZONE defines and Intl does not know: read-only. */
export const unknownZone = (uid) => wrap(`BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART;TZID=Mars/Olympus:20260604T120000\nDTEND;TZID=Mars/Olympus:20260604T130000\nSUMMARY:Mars call\nEND:VEVENT\n`);

/** A TimeSpec in Paris. */
export const paris = (iso) => ({ kind: 'zoned', iso, tzid: 'Europe/Paris' });

// ------------------------------------------------------------------ server

/** A fake DAV server with several calendars (items live in one map, keyed by absolute href). */
export class CalServer extends FakeServer {
  constructor() {
    super({ collection: CAL_A, kind: 'calendar' });
    const s = this;
    const c = this.client;
    const inColl = (coll) => [...s.items].filter(([h]) => h.startsWith(coll));
    c.listItemEtags = async (href) => {
      s._hit('PROPFIND1', href);
      return inColl(href).map(([h, it]) => ({ href: h, etag: it.etag }));
    };
    c.syncCollection = async (href, token) => {
      s._hit('SYNC', href);
      const from = token ? Number(String(token).replace('tok:', '')) : 0;
      const changed = inColl(href).filter(([, it]) => it.v > from).map(([h, it]) => ({ href: h, etag: it.etag }));
      const removed = token ? s.tombstones.filter((t) => t.href.startsWith(href) && t.v > from).map((t) => t.href) : [];
      return { token: `tok:${s.v}`, changed, removed };
    };
    c.calendarMultiget = async (href, hrefs) => {
      s._hit('MULTIGET', href);
      const items = [];
      const missing = [];
      for (const h of hrefs) {
        const it = s.items.get(h);
        if (it) items.push({ href: h, etag: it.etag, text: it.text });
        else missing.push(h);
      }
      return { items, missing };
    };
    c.getCollection = async (href) => {
      s._hit('PROPFIND0', href);
      if (!ALL.includes(href)) throw new DavError('notfound', { status: 404 });
      return { href, kind: 'calendar', etag: `"c${s.v}"`, ctag: `"c${s.v}"`, displayName: href, components: [] };
    };
  }
  /** Seed or replace an item at an absolute href. */
  put(href, text) {
    this.items.set(href, { text: lf(text), etag: `"e${++this.e}"`, v: ++this.v });
    return href;
  }
  at(href) {
    return this.items.get(href);
  }
  /** Another client edits an item (replaces its text). */
  outside(href, text) {
    return this.put(href, text);
  }
  hrefsIn(coll) {
    return [...this.items.keys()].filter((h) => h.startsWith(coll)).sort();
  }
  /** The next PUT to a matching href is APPLIED and the client then sees a network error (a lost response). */
  loseResponse(match, error = () => new DavError('network', { message: 'response lost' })) {
    const orig = this.client.putItem;
    let armed = true;
    const s = this;
    this.client.putItem = async function (href, text, opts) {
      const r = await orig.call(s.client, href, text, opts);
      if (armed && match(href, opts)) {
        armed = false;
        s.client.putItem = orig;
        throw error();
      }
      return r;
    };
  }
  /** Run `fn` right after the first PUT to a matching href succeeded (another client acting in between). */
  afterPut(match, fn) {
    const orig = this.client.putItem;
    let armed = true;
    const s = this;
    this.client.putItem = async function (href, text, opts) {
      const r = await orig.call(s.client, href, text, opts);
      if (armed && match(href, opts)) {
        armed = false;
        fn();
      }
      return r;
    };
  }
}

// ------------------------------------------------------------------ environment

let uuidSeq = 0;

/**
 * Session + stores of every calendar + the real write path over a CalServer.
 * opts: items {href: text}, transform, load (sync the stores), levels override.
 */
export async function makeCalEnv({ items = {}, transform = null, load = true } = {}) {
  const clock = createClock();
  const server = new CalServer();
  if (transform) server.transform = transform;
  for (const [href, text] of Object.entries(items)) server.put(href, text);
  const session = createSession({ login: 'alice', storage: fakeStorage(), timers: clock });
  const activity = createActivityLog({ now: () => new Date(clock.now()) });
  const feedback = createFeedback();
  const reporter = createReporter({ activity, feedback, t: (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k) });
  const gate = createWriteGate();
  const entry = (href, comps, source = 'own', level = undefined) => ({ href, kind: 'calendar', name: href.split('/').filter(Boolean).pop(), displayName: href, source, level, owner: href.split('/')[1], status: 'ok', components: comps });
  const discover = async () => ({
    collections: [entry(CAL_A, ['VEVENT', 'VTODO']), entry(CAL_B, ['VEVENT', 'VTODO']), entry(CAL_TASKS, ['VTODO']), entry(CAL_RO, ['VEVENT'], 'grant', 'read')],
    apiError: null,
    ownError: null,
  });
  const api = new FakeApi();
  const access = createAccess({ api, client: server.client, session, discover });
  await access.refetch({ reason: 'test' });
  const stores = createStores({ client: server.client, session, now: clock.now, reporter });
  for (const href of ALL) stores.open({ href, kind: 'calendar' });
  const scheduler = createScheduler({ session, doc: fakeDoc(), win: fakeTarget(), now: clock.now });
  const writes = createWrites({
    client: server.client,
    api,
    stores,
    access,
    scheduler,
    reporter,
    gate,
    login: 'alice',
    model,
    now: () => new Date('2026-06-01T10:00:00Z'),
    random: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`,
    sleep: () => Promise.resolve(),
    isDisposed: () => session.disposed,
  });
  if (load) for (const href of ALL) await stores.get(href).sync({ reason: 'load' });
  return { clock, server, session, activity, feedback, reporter, gate, access, stores, scheduler, writes, api };
}

export const baseOf = (env, href) => {
  const e = env.stores.get(href.slice(0, href.lastIndexOf('/') + 1)).get(href);
  return e ? { text: e.text, etag: e.etag } : null;
};
export const opsLog = (env) => env.activity.entries().map((e) => `${e.op}:${e.result}`);
export const calls = (env, method) => env.server.callsOf(method);
export const openText = (text) => model.openItem(text);
