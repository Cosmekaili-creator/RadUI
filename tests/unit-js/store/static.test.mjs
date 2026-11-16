// SPDX-License-Identifier: AGPL-3.0-or-later
// The write path is the only way to write: views/, contacts/, calendar/ and tasks/ never call a client write method, and inside
// src/js only the write path, the importer and the DAV layer itself touch them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/js');

function files(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(m?js)$/.test(n)) out.push(p);
  }
  return out;
}

/** Strip comments and string-free noise is not needed: the patterns are specific call shapes. */
const FORBIDDEN = [
  [/\.\s*putItem\s*\(/, 'putItem'],
  [/(?<!writes|writes\(\))\s*\.\s*deleteItem\s*\(/, 'deleteItem'],
  [/(?<!writes|writes\(\))\s*\.\s*deleteCollection\s*\(/, 'deleteCollection'],
  [/(?<!writes|writes\(\))\s*\.\s*mkcalendar\s*\(/, 'mkcalendar'],
  [/\.\s*mkAddressbook\s*\(/, 'mkAddressbook'],
  [/(?<!writes|writes\(\))\s*\.\s*proppatch\s*\(/, 'proppatch'],
  [/\.\s*putGrant\s*\(/, 'putGrant'],
  [/\.\s*revokeGrant\s*\(/, 'revokeGrant'],
  [/\.\s*request\s*\(\s*['"`](?:PUT|DELETE|MKCOL|MKCALENDAR|PROPPATCH|POST|PATCH|MOVE|COPY)['"`]/, 'raw request'],
  [/\b(?:PUT|DELETE|MKCOL|MKCALENDAR|PROPPATCH)['"`]\s*,\s*[a-z]+\s*[,)]/, 'raw verb'],
];

test('views/, contacts/, calendar/ and tasks/ contain no direct call to a DAV or grant write method', () => {
  const targets = ['views', 'contacts', 'calendar', 'tasks'].flatMap((d) => files(path.join(SRC, d)));
  const bad = [];
  for (const f of targets) {
    const text = readFileSync(f, 'utf8');
    for (const [re, name] of FORBIDDEN) if (re.test(text)) bad.push(`${path.relative(SRC, f)}: ${name}`);
  }
  assert.deepEqual(bad, []);
});

test('the scan really detects each forbidden call shape (self-test)', () => {
  const samples = ['client.putItem(h, t, {})', 'dav\n  .deleteItem(h, e)', 'x.deleteCollection(h, e)', 'c.mkcalendar(h)', 'c.mkAddressbook(h)', 'c.proppatch(h, k, c)', 'api.putGrant({})', 'api.revokeGrant({})', "transport.request('PUT', h)", 'transport.request("DELETE", h)'];
  for (const s of samples) assert.ok(FORBIDDEN.some(([re]) => re.test(s)), s);
  assert.ok(!FORBIDDEN.some(([re]) => re.test('store.writes.saveItem({})')));
});

test('inside src/js only store/writes.js, store/importrun.js, store/grants.js, store/admin.js, the DAV layer and api.js call write methods', () => {
  const allowed = new Set(['store/writes.js', 'store/importrun.js', 'store/grants.js', 'store/admin.js', 'api.js']);
  const bad = [];
  for (const f of files(SRC)) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    if (rel.startsWith('dav/') || allowed.has(rel)) continue;
    const text = readFileSync(f, 'utf8');
    for (const [re, name] of FORBIDDEN.slice(0, 8)) if (re.test(text)) bad.push(`${rel}: ${name}`);
  }
  assert.deepEqual(bad, []);
});

test('every store module carries the SPDX header and no hard-coded host or path', () => {
  for (const f of files(path.join(SRC, 'store'))) {
    const text = readFileSync(f, 'utf8');
    assert.match(text.split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, f);
    assert.doesNotMatch(text, /https?:\/\/(?!example\.org)[a-z0-9.-]+\.[a-z]{2,}/i, f);
    assert.doesNotMatch(text, /\/home\/|innerHTML|insertAdjacentHTML|eval\(|new Function/, f);
  }
});
