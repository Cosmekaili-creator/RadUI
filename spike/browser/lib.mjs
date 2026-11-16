// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers for the browser spikes. Configuration comes from the environment:
//   RADUI_PW_DIR           directory holding node_modules/playwright (outside the repository)
//   PLAYWRIGHT_BROWSERS_PATH  where the Chromium build lives (set by the caller)
//   RADUI_BROWSER_RUN      run dir created by env.sh (for the account file and nginx/stub logs)
//   RADUI_BROWSER_NGINX_PORT / RADUI_BROWSER_RADICALE_PORT (defaults 18080 / 15240)
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RUN = process.env.RADUI_BROWSER_RUN || path.join(process.env.TMPDIR || "/tmp", "radui-browser-spike");
export const NGINX_PORT = Number(process.env.RADUI_BROWSER_NGINX_PORT || 18080);
export const RADICALE_PORT = Number(process.env.RADUI_BROWSER_RADICALE_PORT || 15240);
export const HOST = "example.org"; // mapped to 127.0.0.1 inside Chromium only
export const ORIGIN = `http://${HOST}:${NGINX_PORT}`;

export async function loadPlaywright() {
  const dir = process.env.RADUI_PW_DIR;
  if (!dir) throw new Error("set RADUI_PW_DIR to the directory that holds node_modules/playwright");
  const entry = path.join(dir, "node_modules", "playwright", "index.mjs");
  if (!existsSync(entry)) throw new Error("playwright not found under " + dir);
  return import(pathToFileURL(entry).href);
}

/** Refuse to start a browser when less than 2000 MB of memory is available. */
export function assertMemory(minMb = 2000) {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  const mb = m ? Math.floor(Number(m[1]) / 1024) : 0;
  if (mb < minMb) throw new Error(`only ${mb} MB available (< ${minMb}); not starting a browser`);
  return mb;
}

/** Account passwords of the throwaway Radicale. They are never printed or written to results. */
export function accounts() {
  const out = {};
  for (const line of readFileSync(path.join(RUN, "radicale", "passwords"), "utf8").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export const basic = (user, pw) => "Basic " + Buffer.from(`${user}:${pw}`).toString("base64");

/** Chromium arguments: neutral host name mapped to loopback, treated as a secure context like https. */
export const CHROMIUM_ARGS = [
  `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
  `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
  "--no-first-run",
];

export async function launch(pw) {
  assertMemory();
  return pw.chromium.launch({ headless: true, args: CHROMIUM_ARGS });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function readLog(file) {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}
