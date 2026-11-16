// SPDX-License-Identifier: AGPL-3.0-or-later
// The .ics plan run by store/importrun.js over the fake calendar server (RUN3 C2): PUT with If-None-Match / If-Match,
// one calendar-multiget per chunk, the verification of series with overrides and of items the server stores with an
// added VTIMEZONE, replace and keep-both against an existing item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { planIcsImport, resolveImport } from '../../../src/js/model/importplan.js';
import { calendarUidOf } from '../../../src/js/model/importics.js';
import { startImport } from '../../../src/js/store/importrun.js';
import { CAL_A, makeCalEnv, single } from './_cal.mjs';

const FIX = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../fixtures/ics/import');
const fx = (name) => readFileSync(path.join(FIX, `import-${name}.ics`), 'utf8');
const knownOf = (env) => env.stores.get(CAL_A).list().map((e) => ({ href: e.href, etag: e.etag, uid: calendarUidOf(e.text) }));
const run = (env, plan, policy = 'skip', o = {}) => startImport({ client: env.server.client, collection: CAL_A, kind: 'calendar', plan, policy, store: env.stores.get(CAL_A), scheduler: env.scheduler, reporter: env.reporter, gate: env.gate, ...o });

test('a file with a series, overrides, zones and a METHOD is imported, verified with one multiget, and the store holds the texts', async () => {
  const env = await makeCalEnv({ items: {} });
  const plan = planIcsImport(fx('recurring-overrides') + fx('method-request'), [], { collectionHref: CAL_A });
  assert.equal(plan.rows.length, 5);
  env.server.calls.length = 0;
  const rep = await run(env, plan).done;
  assert.equal(rep.created, 5);
  assert.equal(rep.ok, true, JSON.stringify(rep.verify));
  assert.equal(rep.verify.checked, 5);
  assert.equal(env.server.callsOf('MULTIGET').length, 1);
  assert.equal(env.stores.get(CAL_A).size, 5);
  const served = env.server.at(`${CAL_A}series-a%40example.org.ics`);
  assert.equal((served.text.match(/^BEGIN:VEVENT$/gm) || []).length, 3, 'master and overrides in ONE resource');
  assert.ok(!/METHOD/.test(env.server.at(`${CAL_A}invite-1%40example.org.ics`).text));
});

test('a server that adds a VTIMEZONE to an IANA-zoned import is not a mismatch; a server that changes the title is', async () => {
  const tz = (t) => t.replace('BEGIN:VEVENT', 'BEGIN:VTIMEZONE\nTZID:Europe/Paris\nBEGIN:STANDARD\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0100\nDTSTART:19701025T030000\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\nEND:STANDARD\nBEGIN:DAYLIGHT\nTZOFFSETFROM:+0100\nTZOFFSETTO:+0200\nDTSTART:19700329T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\nEND:DAYLIGHT\nEND:VTIMEZONE\nBEGIN:VEVENT');
  const env = await makeCalEnv({ items: {}, transform: (t, href) => (href.includes('custom-zone') ? t.replace('SUMMARY:Zone defined in the file', 'SUMMARY:Changed') : href.includes('iana-no') ? tz(t) : t) });
  const plan = planIcsImport(fx('unknown-tzid'), [], { collectionHref: CAL_A });
  const rep = await run(env, plan).done;
  assert.equal(rep.created, 3);
  assert.deepEqual(rep.verify.mismatched.map((m) => m.href), [`${CAL_A}custom-zone%40example.org.ics`]);
});

test('re-running with skip is a resume; replace overwrites the series with If-Match; keep both adds a second series', async () => {
  const env = await makeCalEnv({ items: {} });
  const first = planIcsImport(fx('recurring-overrides'), [], { collectionHref: CAL_A });
  assert.equal((await run(env, first).done).created, 3);

  const again = planIcsImport(fx('recurring-overrides'), knownOf(env), { collectionHref: CAL_A });
  assert.deepEqual(again.rows.map((r) => r.state), ['duplicate', 'duplicate', 'duplicate']);
  const skipped = await run(env, again, 'skip').done;
  assert.equal(skipped.created + skipped.replaced, 0);
  assert.equal(skipped.skipped, 3);

  const repl = await run(env, again, 'replace').done;
  assert.equal(repl.replaced, 3);
  assert.equal(repl.ok, true);
  assert.equal(env.stores.get(CAL_A).size, 3);

  const both = await run(env, planIcsImport(fx('recurring-overrides'), knownOf(env), { collectionHref: CAL_A }), 'keep-both', { random: undefined }).done;
  assert.equal(both.created, 3);
  assert.equal(both.ok, true);
  assert.equal(env.stores.get(CAL_A).size, 6);
  const uids = new Set(env.stores.get(CAL_A).list().map((e) => calendarUidOf(e.text)));
  assert.equal(uids.size, 6);
});

test('an item that exists already (412 on create) is skipped, the rest of the file goes on', async () => {
  const env = await makeCalEnv({ items: { [`${CAL_A}single-utc%40example.org.ics`]: single('someone-else@example.org', 'Other') } });
  const plan = planIcsImport(fx('recurring-overrides'), [], { collectionHref: CAL_A });
  const rep = await run(env, plan).done;
  assert.equal(rep.created, 2);
  assert.equal(rep.skipped, 1);
  assert.equal(rep.reasons.exists, 1);
  assert.equal(resolveImport(plan, 'skip', { collectionHref: CAL_A }).operations.length, 3);
});
