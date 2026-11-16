// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S11: coexistence of /ui/, /ui/api/ and / (Radicale) behind one unprivileged nginx.
// Needs env.sh up. Run through the capped wrapper:
//   node spike/browser/s11-nginx.mjs > spike/browser/results/s11-results.json
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ORIGIN, HOST, NGINX_PORT, RUN, loadPlaywright, launch, accounts, basic, sleep, readLog } from "./lib.mjs";
import { probe, FIXTURES } from "./s12-probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const acc = accounts();
const GOOD = basic("alice", acc.alice);
const SEC = ["strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy"];
const results = { origin: ORIGIN, headers: {}, routing: {}, xff: {}, bodyLimits: {}, browser: {} };

/** Plain HTTP request to nginx (any method). Resolves with status, selected headers, body text. */
function req(method, p, { headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: NGINX_PORT, method, path: p, headers: { Host: `${HOST}:${NGINX_PORT}`, ...headers }, timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", (e) => resolve({ error: e.code || String(e) }));
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    if (body) r.write(body);
    r.end();
  });
}
const pick = (h, names) => { const low = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v])); return Object.fromEntries(names.map((n) => [n, low[n] ?? null])); };
const sum = (r) => r.error ? { error: r.error } : { status: r.status, contentType: r.headers["content-type"] ?? null, security: SEC.every((n) => r.headers[n]) ? "all 4 present" : "MISSING: " + SEC.filter((n) => !r.headers[n]).join(","), csp: r.headers["content-security-policy"] ?? null, cacheControl: r.headers["cache-control"] ?? null, wwwAuthenticate: r.headers["www-authenticate"] ?? null, location: r.headers["location"] ?? null };

// ---------- routing and per-location headers ----------
const R = results.routing;
R["GET /ui/"] = sum(await req("GET", "/ui/"));
R["GET /ui (no slash)"] = sum(await req("GET", "/ui"));
R["GET /ui/app.js"] = sum(await req("GET", "/ui/app.js"));
R["GET /ui/app.css"] = sum(await req("GET", "/ui/app.css"));
R["GET /ui/index.html"] = sum(await req("GET", "/ui/index.html"));
R["GET /ui/sw.js"] = sum(await req("GET", "/ui/sw.js"));
R["GET /ui/manifest.webmanifest"] = sum(await req("GET", "/ui/manifest.webmanifest"));
R["GET /ui/nonexistent.js (404)"] = sum(await req("GET", "/ui/nonexistent.js"));
R["GET /ui/api/health"] = { ...sum(await req("GET", "/ui/api/health")), body: (await req("GET", "/ui/api/health")).body };
R["GET /ui/api/whoami (anonymous, backend 401)"] = sum(await req("GET", "/ui/api/whoami"));
R["PROPFIND / (anonymous)"] = sum(await req("PROPFIND", "/", { headers: { Depth: "0" } }));
R["PROPFIND /alice/ (authenticated)"] = sum(await req("PROPFIND", "/alice/", { headers: { Depth: "0", Authorization: GOOD } }));
R["GET /.web/"] = sum(await req("GET", "/.web/"));
R["GET /.web/js/main.js"] = sum(await req("GET", "/.web/js/main.js"));
R["GET /demo/inherit (no add_header in the location)"] = sum(await req("GET", "/demo/inherit"));
R["GET /demo/replace (one add_header in the location)"] = { ...sum(await req("GET", "/demo/replace")), xDemo: (await req("GET", "/demo/replace")).headers["x-demo"] };

// ---------- X-Forwarded-For overwrite ----------
const probeId = "xff-probe-" + Date.now();
const spoof = { "X-Forwarded-For": "203.0.113.9", "X-Real-IP": "203.0.113.10", "X-Forwarded-Host": "evil.example.org" };
const viaStub = await req("GET", "/ui/api/echo-headers", { headers: spoof });
const seen = JSON.parse(viaStub.body).headers;
results.xff.sentByClient = spoof;
results.xff.backendReceived = pick(seen, ["x-forwarded-for", "x-real-ip", "x-forwarded-proto", "x-forwarded-host", "host"]);
await req("PROPFIND", "/" + probeId, { headers: { ...spoof, Authorization: GOOD, Depth: "0" } });
await req("PROPFIND", "/alice/", { headers: { ...spoof, Authorization: basic("alice", "wrong-" + Date.now()), Depth: "0" } });
await sleep(1500); // Radicale delays a failed login by about a second
const radLog = readLog(path.join(RUN, "radicale", "radicale.log")).split("\n");
const forLines = radLog.filter((l) => /forwarded for/.test(l));
results.xff.radicaleLogLinesWithForwardedFor = forLines.length;
results.xff.radicaleLogMentionsSpoofedAddress = radLog.some((l) => /203\.0\.113\.9/.test(l));
results.xff.radicaleLogSample = forLines.filter((l) => /Failed login|received from/.test(l)).slice(-4).map((l) => l.replace(/^.*?\]\s*/, "").slice(0, 200));
const failed = radLog.filter((l) => /Failed login attempt/.test(l)).slice(-1);
results.xff.radicaleFailedLoginLine = failed.map((l) => l.replace(/^.*?\]\s*/, "").slice(0, 200));
const probeLine = radLog.filter((l) => l.includes(probeId));
results.xff.radicaleLogLineForProbeRequest = probeLine.slice(0, 2).map((l) => l.replace(/^.*?\]\s*/, "").slice(0, 200));
results.xff.radicaleSawXForwardedHostFromClient = radLog.some((l) => /evil\.example\.org/.test(l));

// ---------- client_max_body_size ----------
const B = results.bodyLimits;
const buf = (n) => Buffer.alloc(n, 0x61);
const post = (p, n, extra = {}) => req("POST", p, { headers: { "Content-Length": String(n), ...extra }, body: buf(n), timeout: 60000 });
const sb = (r) => r.error ? { error: r.error } : { status: r.status, body: r.body.slice(0, 60).replace(/\s+/g, " ") };
B["/ui/api/upload 50 KiB (limit 64k)"] = sb(await post("/ui/api/upload", 50 * 1024));
B["/ui/api/upload 100 KiB (limit 64k)"] = sb(await post("/ui/api/upload", 100 * 1024));
B["/ui/api/upload 2 MiB, chunked-free (limit 64k)"] = sb(await post("/ui/api/upload", 2 * 1024 * 1024));
B["PUT / (Radicale) 49 MiB (limit 50M)"] = sb(await req("PUT", "/alice/size-probe-a.ics", { headers: { Authorization: GOOD, "Content-Type": "text/calendar", "Content-Length": String(49 * 1024 * 1024) }, body: buf(49 * 1024 * 1024), timeout: 60000 }));
B["PUT / (Radicale) 51 MiB (limit 50M)"] = sb(await req("PUT", "/alice/size-probe-b.ics", { headers: { Authorization: GOOD, "Content-Type": "text/calendar", "Content-Length": String(51 * 1024 * 1024) }, body: buf(51 * 1024 * 1024), timeout: 60000 }));

// ---------- browser: CSP, ical.js in Chromium, body-limit view from fetch ----------
const pw = await loadPlaywright();
const browser = await launch(pw);
try {
  const ctx = await browser.newContext();
  const collect = async (url, { waitSel = null, settle = 800 } = {}) => {
    const page = await ctx.newPage();
    const consoleMsgs = [];
    page.on("console", (m) => { if (["error", "warning"].includes(m.type())) consoleMsgs.push(m.type() + ": " + m.text().slice(0, 260)); });
    page.on("pageerror", (e) => consoleMsgs.push("pageerror: " + String(e).slice(0, 200)));
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 80), sample: (e.sample || "").slice(0, 60) }));
    });
    const resp = await page.goto(url);
    if (waitSel) await page.waitForSelector(waitSel, { timeout: 8000 }).catch(() => {});
    await sleep(settle);
    const csp = await page.evaluate(() => window.__csp);
    return { page, status: resp.status(), csp, console: consoleMsgs };
  };

  // stub page: module script + stylesheet, zero violations expected
  {
    const c = await collect(ORIGIN + "/ui/", { waitSel: "#root[data-state=ready]" });
    const st = await c.page.evaluate(() => ({ state: document.getElementById("root").dataset.state, ical: document.getElementById("root").dataset.ical, h1Color: getComputedStyle(document.querySelector("h1")).color }));
    results.browser.stubPage = { status: c.status, cspViolations: c.csp.length, violations: c.csp, consoleErrors: c.console, ...st, moduleScriptRanAndImportedIcal: st.state === "ready" && st.ical === "2.0", stylesheetApplied: st.h1Color === "rgb(1, 2, 3)" };
    await c.page.close();
  }
  // positive control: inline script, style attribute, external image, inline handler -> violations expected
  {
    const c = await collect(ORIGIN + "/ui/inline.html");
    const title = await c.page.title();
    await c.page.click("[data-testid=b]").catch(() => {});
    const title2 = await c.page.title();
    const csp = await c.page.evaluate(() => window.__csp);
    results.browser.positiveControlInlinePage = { cspViolations: csp.length, directives: [...new Set(csp.map((v) => v.directive))], inlineScriptRan: title === "inline script ran", inlineHandlerRan: title2 === "handler ran", consoleErrors: c.console.length };
    await c.page.close();
  }
  // Radicale's own UI under the same strict CSP (informational: a deployment may whitelist an inline hash)
  {
    const c = await collect(ORIGIN + "/.web/", { settle: 1500 });
    const vis = await c.page.evaluate(() => ({ loadingVisible: !document.getElementById("loadingscene")?.classList.contains("hidden"), loginVisible: !!document.getElementById("loginscene") && !document.getElementById("loginscene").classList.contains("hidden") }));
    results.browser.radicaleWebUiUnderStrictCsp = { status: c.status, cspViolations: c.csp.length, directives: [...new Set(c.csp.map((v) => v.directive))], sampleViolations: c.csp.slice(0, 4), ...vis };
    await c.page.close();
  }
  // S12 in Chromium: same probe as Node, compare
  {
    const c = await collect(ORIGIN + "/ui/s12.html", { waitSel: "html[data-state=ready]", settle: 300 });
    const r = await c.page.evaluate(() => window.__s12);
    const nodeICAL = (await import(new URL("../../src/vendor/ical.js/2.2.1/ical.min.js", import.meta.url).href)).default;
    const texts = Object.fromEntries(FIXTURES.map((f) => [f, readFileSync(path.join(here, "fixtures", f), "utf8")]));
    const nodeRes = probe(nodeICAL, texts);
    const same = r && r.ok && JSON.stringify(r.result) === JSON.stringify(nodeRes);
    results.browser.s12ichalInChromium = { importWorkedUnderCsp: !!(r && r.ok), error: r && r.error, cspViolations: c.csp.length, identicalToNodeResult: same, tzidQuoted: r && r.ok ? r.result.tzidQuoted : null, occurrences: r && r.ok ? r.result.recurrence.length : null };
    if (r && r.ok && !same) results.browser.s12ichalInChromium.diffKeys = Object.keys(nodeRes).filter((k) => JSON.stringify(nodeRes[k]) !== JSON.stringify(r.result[k]));
    await c.page.close();
  }
  // what does fetch() see when nginx rejects an oversized body?
  {
    const page = await ctx.newPage();
    await page.goto(ORIGIN + "/ui/");
    const tryPost = (url, n, extra) => page.evaluate(async ({ url, n, extra }) => {
      try { const r = await fetch(url, { method: extra.method, body: new Blob([new Uint8Array(n).fill(97)]), credentials: "omit", headers: extra.headers }); return { status: r.status }; }
      catch (e) { return { error: String(e) }; }
    }, { url, n, extra });
    results.browser.fetchOversize = {
      "POST /ui/api/upload 100 KiB (limit 64k)": await tryPost("/ui/api/upload", 100 * 1024, { method: "POST", headers: {} }),
      "POST /ui/api/upload 3 MiB (limit 64k)": await tryPost("/ui/api/upload", 3 * 1024 * 1024, { method: "POST", headers: {} }),
      "PUT /alice/ 51 MiB (limit 50M)": await tryPost("/alice/size-probe-c.ics", 51 * 1024 * 1024, { method: "PUT", headers: { Authorization: GOOD, "Content-Type": "text/calendar" } }),
    };
    await page.close();
  }
  await ctx.close();
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
