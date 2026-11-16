// SPDX-License-Identifier: AGPL-3.0-or-later
// The browser suite runner. Started by tests/e2e/run.py, which brings up nginx + Radicale + the backend and writes the
// stack description to $RADUI_E2E_SPEC. One suite per run: --suite=<name> loads tests/e2e/scenarios/<name>.mjs
// (the `agent` suite is tests/e2e/agent/flows.mjs) and runs its scenarios in order. Anything else on the command line
// is a scenario name (run only those) or --fast (light scheme only, for suites that honour it).
//
// ONE Chromium, one context at a time, everything sequential. Output: PASS / FAIL / TODO / INFO lines; exit
// status 1 when anything failed. TODO is a known, reproduced defect in src/ (a finding), not counted as a failure.
// Screenshots go to $RADUI_E2E_SHOTS (git-ignored).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHROMIUM_ARGS, E2E_DIR, SHOTS, check, info, mem, pw, results, spec, todos } from './lib/common.mjs';

const argv = process.argv.slice(2);
const suiteArg = argv.find((a) => a.startsWith('--suite='));
const SUITE = suiteArg ? suiteArg.slice('--suite='.length) : 'shell';
const ONLY = argv.filter((a) => !a.startsWith('--'));
const FILES = { agent: path.join(E2E_DIR, 'agent', 'flows.mjs') };
const file = FILES[SUITE] || path.join(E2E_DIR, 'scenarios', `${SUITE}.mjs`);
if (!existsSync(file)) {
  console.error(`no such suite: ${SUITE} (${file})`);
  process.exit(2);
}
const mod = await import(pathToFileURL(file).href);

function logsClean() {
  const bad = [];
  for (const [name, f] of Object.entries(spec.logs)) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (name === 'nginx_access') continue;
    for (const secret of Object.values(spec.users)) if (text.includes(secret)) bad.push(`${name} contains a password`);
    if (/Authorization:\s*Basic/i.test(text) || text.includes('$2b$')) bad.push(`${name} contains an Authorization value or a hash`);
  }
  return bad;
}

const free = mem();
console.log(`memory available: ${Math.round(free)} MB`);
if (free < 2000) { console.error('less than 2000 MB available: not starting a browser'); process.exit(3); }
const t0 = Date.now();
// `channel: 'chromium'` is the full Chromium in its new headless mode: only that build honours
// --unsafely-treat-insecure-origin-as-secure (the headless shell ignores it, so the page would not be a secure context:
// no service worker, no crypto.randomUUID).
const browser = await pw.chromium.launch({ headless: true, args: CHROMIUM_ARGS, channel: process.env.RADUI_E2E_CHANNEL || 'chromium' });
info(`chromium ${browser.version()} suite ${SUITE}`);
let exit = 1;
let minFree = free;
try {
  const names = Object.keys(mod.scenarios).filter((n) => ONLY.length === 0 || ONLY.includes(n));
  for (const n of names) {
    console.log(`\n== scenario: ${n}`);
    const t1 = Date.now();
    try {
      await mod.scenarios[n](browser);
    } catch (e) {
      check(false, `scenario ${n} threw`, String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
    }
    minFree = Math.min(minFree, mem());
    info(`scenario ${n}: ${Math.round((Date.now() - t1) / 1000)} s, ${Math.round(mem())} MB available`);
  }
  if (typeof mod.finish === 'function') await mod.finish(browser, { only: ONLY });
  const leaked = logsClean();
  check(leaked.length === 0, 'nginx, backend and Radicale logs of the whole run hold no password, hash or Authorization value', leaked.join('; '));
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length} checks, ${failed} failed, ${todos.length} todo (known findings), ${Math.round((Date.now() - t0) / 1000)} s, available memory: start ${Math.round(free)} MB, lowest seen ${Math.round(minFree)} MB, end ${Math.round(mem())} MB`);
  for (const x of todos) console.log(`TODO  ${x}`);
  writeFileSync(path.join(SHOTS, `results-${SUITE}.json`), JSON.stringify({ suite: SUITE, checks: results.length, failed, todo: todos.length }, null, 1));
  exit = failed ? 1 : 0;
} finally {
  await browser.close().catch(() => {});
}
process.exit(exit);
