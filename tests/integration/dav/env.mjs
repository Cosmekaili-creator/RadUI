// SPDX-License-Identifier: AGPL-3.0-or-later
// Environment and helpers for the DAV integration tests (throwaway Radicale only).
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createTransport } from '../../../src/js/dav/http.js';
import { createClient } from '../../../src/js/dav/client.js';

export const ORIGIN = process.env.RADUI_TEST_RADICALE || '';
const PW_FILE = process.env.RADUI_TEST_PASSWORDS_FILE || '';
export const SKIP = ORIGIN && PW_FILE
  ? false
  : 'skipped: set RADUI_TEST_RADICALE and RADUI_TEST_PASSWORDS_FILE (throwaway instance), or run tests/integration/dav/run.sh';

/** test() that is skipped, with a clear message, when no throwaway instance is configured. */
export const it = (name, fn) => test(name, { skip: SKIP }, fn);

let passwords = null;
function password(user) {
  if (!passwords) {
    passwords = Object.fromEntries(
      readFileSync(PW_FILE, 'utf8').trim().split('\n').map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
  }
  return passwords[user];
}

export const basic = (user, pw = password(user)) => 'Basic ' + btoa(user + ':' + pw);

export function clientFor(user, { pw, onUnauthorized, calls } = {}) {
  const fetchImpl = async (url, init) => {
    if (calls) calls.push({ url, method: init && init.method });
    return fetch(url, init);
  };
  const transport = createTransport({ origin: ORIGIN, getAuth: () => basic(user, pw), fetchImpl, timeoutMs: 15000, onUnauthorized });
  return createClient(transport);
}

/** Raw authenticated request that bypasses the DAV layer. */
export function rawFetch(user, path, init = {}) {
  return fetch(ORIGIN + path, { ...init, headers: { Authorization: basic(user), ...(init.headers || {}) }, credentials: 'omit', cache: 'no-store' });
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const ics = (id, summary, start = '20260601T090000Z', extra = []) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RadUI Test//EN', 'BEGIN:VEVENT', 'UID:' + id, 'DTSTAMP:20260101T000000Z',
  'DTSTART:' + start, 'DTEND:' + start.replace(/T(\d\d)/, (m, h) => 'T' + String((Number(h) + 1) % 24).padStart(2, '0')),
  'SUMMARY:' + summary, ...extra, 'END:VEVENT', 'END:VCALENDAR', '',
].join('\n');

export const todo = (id, summary) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RadUI Test//EN', 'BEGIN:VTODO', 'UID:' + id, 'DTSTAMP:20260101T000000Z',
  'SUMMARY:' + summary, 'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR', '',
].join('\n');

export const vcard = (id, name, extra = []) => [
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:' + id, 'FN:' + name, 'N:' + name.split(' ').reverse().join(';') + ';;;',
  'EMAIL;TYPE=INTERNET:' + name.split(' ')[0].toLowerCase() + '@example.org', ...extra, 'END:VCARD', '',
].join('\n');

export const lf = (s) => s.replace(/\r\n?/g, '\n');
/** Unfolded, sorted, non-empty content lines: equality ignores property order and folding. */
export const semantic = (s) => lf(s).replace(/\n[ \t]/g, '').split('\n').filter(Boolean).sort();
export const unfold = (s) => lf(s).replace(/\n[ \t]/g, '');
