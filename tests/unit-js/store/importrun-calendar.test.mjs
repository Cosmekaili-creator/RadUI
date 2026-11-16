// SPDX-License-Identifier: AGPL-3.0-or-later
// store/importrun.js for calendars (RUN3): verification with ONE calendar-multiget per chunk, projection compare
// (a VTIMEZONE the server adds is not a mismatch), 412 on create = skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startImport } from '../../../src/js/store/importrun.js';
import { CAL_A, makeCalEnv, single, task } from './_cal.mjs';

const op = (i, text, uid) => ({ index: i, href: `${CAL_A}imp-${i}.ics`, uid, op: 'create', text });
const run = (env, operations, o = {}) =>
  startImport({
    client: env.server.client,
    collection: CAL_A,
    kind: 'calendar',
    plan: { rows: [] },
    resolve: () => ({ operations, skipped: [], problems: [] }),
    store: env.stores.get(CAL_A),
    scheduler: env.scheduler,
    reporter: env.reporter,
    gate: env.gate,
    ...o,
  });

test('calendar import: PUT with If-None-Match, ONE calendar-multiget per chunk, events and tasks verified, store updated', async () => {
  const env = await makeCalEnv({ items: {} });
  const operations = [op(1, single('i1@example.org', 'One'), 'i1@example.org'), op(2, single('i2@example.org', 'Two'), 'i2@example.org'), op(3, task('i3@example.org'), 'i3@example.org')];
  env.server.calls.length = 0;
  const rep = await run(env, operations, { chunkSize: 2 }).done;
  assert.equal(rep.created, 3);
  assert.equal(rep.ok, true);
  assert.equal(rep.verify.checked, 3);
  assert.equal(env.server.callsOf('MULTIGET').length, 2);
  assert.equal(env.server.callsOf('GET').length, 0);
  assert.equal(env.stores.get(CAL_A).size, 3);
});

test('a server that stores an event differently is reported as a verification mismatch; a VTIMEZONE it adds is not', async () => {
  const addTz = (t) => t.replace('BEGIN:VEVENT', 'BEGIN:VTIMEZONE\nTZID:America/New_York\nBEGIN:STANDARD\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nDTSTART:19701101T020000\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\nEND:STANDARD\nBEGIN:DAYLIGHT\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nDTSTART:19700308T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\nEND:DAYLIGHT\nEND:VTIMEZONE\nBEGIN:VEVENT');
  const ny = (uid, s) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Example//EN\nBEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20260101T000000Z\nDTSTART;TZID=America/New_York:20260610T090000\nDTEND;TZID=America/New_York:20260610T100000\nSUMMARY:${s}\nEND:VEVENT\nEND:VCALENDAR\n`;
  const env = await makeCalEnv({ items: {}, transform: (t, href) => (href.endsWith('imp-2.ics') ? t.replace('SUMMARY:Bad', 'SUMMARY:Worse') : addTz(t)) });
  const rep = await run(env, [op(1, ny('n1@example.org', 'Good'), 'n1@example.org'), op(2, ny('n2@example.org', 'Bad'), 'n2@example.org')]).done;
  assert.equal(rep.created, 2);
  assert.equal(rep.verify.mismatched.length, 1);
  assert.equal(rep.verify.mismatched[0].href, `${CAL_A}imp-2.ics`);
  assert.deepEqual(rep.verify.mismatched[0].fields, ['summary']);
  assert.equal(rep.ok, false);
});

test('an item that already exists (412 on create) counts as skipped: a re-run is a resume', async () => {
  const env = await makeCalEnv({ items: { [`${CAL_A}imp-1.ics`]: single('i1@example.org', 'One') } });
  const rep = await run(env, [op(1, single('i1@example.org', 'One'), 'i1@example.org'), op(2, single('i2@example.org', 'Two'), 'i2@example.org')]).done;
  assert.equal(rep.created, 1);
  assert.equal(rep.skipped, 1);
  assert.equal(rep.reasons.exists, 1);
});
