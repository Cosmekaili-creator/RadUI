// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S10: HTTP Basic auth behaviour in Chromium (fetch + native auth prompt, storage, DAV methods).
// Run through the capped wrapper, with the environment from env.sh up:
//   node spike/browser/s10-auth.mjs > spike/browser/results/s10-results.json
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ORIGIN, RUN, RADICALE_PORT, loadPlaywright, launch, accounts, basic, sleep, readLog, assertMemory, CHROMIUM_ARGS } from "./lib.mjs";

const pw = await loadPlaywright();
const acc = accounts();
const GOOD = basic("alice", acc.alice);
const BAD = basic("alice", "definitely-wrong-" + Date.now());
const results = { origin: ORIGIN, chromium: null, a_authPrompt: [], a_navigationControls: [], b_storage: {}, c_methods: [], c_crossOriginControl: {}, notes: [] };

const browser = await launch(pw);
results.chromium = browser.version();
try {
  // ---------- (a) native auth prompt ----------
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/ui/");
  const cdp = await ctx.newCDPSession(page);
  let authEvents = [];
  let paused = 0;
  cdp.on("Fetch.requestPaused", async (e) => { paused++; try { await cdp.send("Fetch.continueRequest", { requestId: e.requestId }); } catch {} });
  cdp.on("Fetch.authRequired", async (e) => {
    authEvents.push({ url: e.request.url.replace(ORIGIN, ""), scheme: e.authChallenge.scheme, realm: e.authChallenge.realm, source: e.authChallenge.source });
    try { await cdp.send("Fetch.continueWithAuth", { requestId: e.requestId, authChallengeResponse: { response: "CancelAuth" } }); } catch {}
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }], handleAuthRequests: true });

  const targets = [
    { id: "radicale-PROPFIND", url: "/alice/", method: "PROPFIND", extra: { Depth: "0" } },
    { id: "radicale-GET", url: "/alice/", method: "GET", extra: {} },
    { id: "stub-no-challenge", url: "/ui/api/whoami", method: "GET", extra: {} },
    { id: "stub-with-challenge", url: "/ui/api/whoami-challenge", method: "GET", extra: {} },
  ];
  const doFetch = (spec) => page.evaluate(async (s) => {
    const init = { method: s.method, headers: Object.assign({}, s.extra, s.auth ? { Authorization: s.auth } : {}), cache: "no-store" };
    if (s.credentials) init.credentials = s.credentials;
    try {
      const r = await fetch(s.url, init);
      return { status: r.status, wwwAuthenticate: r.headers.get("www-authenticate") };
    } catch (e) { return { error: String(e) }; }
  }, spec);

  const cases = [];
  for (const t of targets) for (const credentials of ["omit", "same-origin", "include"]) {
    cases.push({ t, credentials, authLabel: "wrong-explicit-header", auth: BAD });
    cases.push({ t, credentials, authLabel: "no-header", auth: null });
  }
  for (const t of targets.slice(0, 2)) for (const credentials of ["omit", "same-origin"]) cases.push({ t, credentials, authLabel: "correct-explicit-header", auth: GOOD });
  for (const c of cases) {
    authEvents = [];
    const r = await doFetch({ url: c.t.url, method: c.t.method, extra: c.t.extra, auth: c.auth, credentials: c.credentials });
    await sleep(150);
    results.a_authPrompt.push({ target: c.t.id, credentials: c.credentials, authorization: c.authLabel, ...r, authRequiredEvents: authEvents.length, authEvents: authEvents.slice() });
  }

  // controls: top-level navigations (own page + own CDP session) must raise the event when a challenge is sent
  for (const t of ["/ui/api/whoami", "/ui/api/whoami-challenge", "/alice/"]) {
    const p2 = await ctx.newPage();
    const cdp2 = await ctx.newCDPSession(p2);
    const ev2 = [];
    cdp2.on("Fetch.requestPaused", async (e) => { try { await cdp2.send("Fetch.continueRequest", { requestId: e.requestId }); } catch {} });
    cdp2.on("Fetch.authRequired", async (e) => {
      ev2.push({ scheme: e.authChallenge.scheme, realm: e.authChallenge.realm });
      try { await cdp2.send("Fetch.continueWithAuth", { requestId: e.requestId, authChallengeResponse: { response: "CancelAuth" } }); } catch {}
    });
    await cdp2.send("Fetch.enable", { patterns: [{ urlPattern: "*" }], handleAuthRequests: true });
    const resp = await p2.goto(ORIGIN + t).catch((e) => ({ status: () => "error: " + e.message.split("\n")[0] }));
    await sleep(300);
    results.a_navigationControls.push({ target: t, status: resp.status(), authRequiredEvents: ev2.length, authEvents: ev2 });
    await p2.close();
  }
  await cdp.send("Fetch.disable");
  results.requestsPaused = paused;
  await ctx.close();

  // ---------- (b) sessionStorage vs localStorage ----------
  const S = "Basic ZHVtbXk6ZHVtbXk="; // dummy value, not a real credential
  const read = (p) => p.evaluate(() => ({ session: sessionStorage.getItem("cred"), local: localStorage.getItem("cred") }));
  const b = results.b_storage;
  const c1 = await browser.newContext();
  const p1 = await c1.newPage();
  await p1.goto(ORIGIN + "/ui/");
  await p1.evaluate((v) => { sessionStorage.setItem("cred", v + "-session"); localStorage.setItem("cred", v + "-local"); }, S);
  const show = (o) => ({ session: o.session ? "present" : null, local: o.local ? "present" : null });
  b.afterSet = show(await read(p1));
  await p1.reload(); b.afterReload = show(await read(p1));
  await p1.goto(ORIGIN + "/ui/inline.html"); await p1.goto(ORIGIN + "/ui/"); b.afterOtherPathSameOrigin = show(await read(p1));
  await p1.goto(ORIGIN + "/.web/"); b.visibleFromRadicaleWebUiPath = show(await read(p1));
  await p1.goto(ORIGIN + "/ui/");
  const p2 = await c1.newPage(); await p2.goto(ORIGIN + "/ui/"); b.newTabSameContext = show(await read(p2)); await p2.close();
  // window.open keeping the opener
  const [pop] = await Promise.all([c1.waitForEvent("page"), p1.evaluate(() => { window.open("/ui/"); })]);
  await pop.waitForLoadState(); b.windowOpenWithOpener = show(await read(pop)); await pop.close();
  const [pop2] = await Promise.all([c1.waitForEvent("page"), p1.evaluate(() => { window.open("/ui/", "_blank", "noopener"); })]);
  await pop2.waitForLoadState(); b.windowOpenNoopener = show(await read(pop2)); await pop2.close();
  await p1.evaluate(() => { const a = document.createElement("a"); a.href = "/ui/"; a.target = "_blank"; a.textContent = "x"; a.id = "lnk"; document.body.appendChild(a); });
  const [pop3] = await Promise.all([c1.waitForEvent("page"), p1.click("#lnk")]);
  await pop3.waitForLoadState(); b.anchorTargetBlank = show(await read(pop3)); await pop3.close();
  await c1.close();
  const c2 = await browser.newContext(); const p3 = await c2.newPage(); await p3.goto(ORIGIN + "/ui/");
  b.newBrowserContext = show(await read(p3)); await c2.close();
  results.chromium = browser.version();
  await browser.close();

  // persistent profile: relaunch the browser (one chromium at a time)
  assertMemory();
  const prof = path.join(RUN, "profile"); rmSync(prof, { recursive: true, force: true }); mkdirSync(prof, { recursive: true });
  let pc = await pw.chromium.launchPersistentContext(prof, { headless: true, args: CHROMIUM_ARGS });
  let pp = pc.pages()[0] || await pc.newPage(); await pp.goto(ORIGIN + "/ui/");
  await pp.evaluate((v) => { sessionStorage.setItem("cred", v); localStorage.setItem("cred", v); }, S);
  await pp.reload(); await sleep(300); await pc.close();
  pc = await pw.chromium.launchPersistentContext(prof, { headless: true, args: CHROMIUM_ARGS });
  pp = pc.pages()[0] || await pc.newPage(); await pp.goto(ORIGIN + "/ui/");
  b.afterBrowserRestartSameProfile = show(await read(pp));
  // ---------- (c) DAV methods from fetch ----------
  const nginxLogBefore = readLog(path.join(RUN, "nginx", "access.log")).split("\n").length;
  const dav = (spec) => pp.evaluate(async (s) => {
    const headers = Object.assign({ Authorization: s.auth }, s.headers || {});
    try {
      const r = await fetch(s.url, { method: s.method, headers, body: s.body, credentials: "omit", cache: "no-store" });
      const text = await r.text();
      return { status: r.status, etag: r.headers.get("etag"), dav: r.headers.get("dav"), contentType: r.headers.get("content-type"), bodyLength: text.length, bodyHead: text.slice(0, 80).replace(/\s+/g, " ") };
    } catch (e) { return { error: String(e) }; }
  }, spec);
  const XML = { "Content-Type": "application/xml; charset=utf-8" };
  const home = "/alice/", cal = "/alice/cal-spike/", book = "/alice/book-spike/";
  const ev = (uid, summary) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//Spike//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", "DTSTART:20260401T090000Z", "DTEND:20260401T100000Z", `SUMMARY:${summary}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  const steps = [
    ["PROPFIND Depth:0", { method: "PROPFIND", url: home, headers: { ...XML, Depth: "0" }, body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><current-user-privilege-set/></prop></propfind>' }],
    ["PROPFIND Depth:1", { method: "PROPFIND", url: home, headers: { ...XML, Depth: "1" }, body: '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>' }],
    ["MKCALENDAR", { method: "MKCALENDAR", url: cal, headers: XML, body: '<?xml version="1.0"?><C:mkcalendar xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><displayname>Spike</displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></prop></set></C:mkcalendar>' }],
    ["PROPPATCH", { method: "PROPPATCH", url: cal, headers: XML, body: '<?xml version="1.0"?><propertyupdate xmlns="DAV:" xmlns:I="http://apple.com/ns/ical/"><set><prop><displayname>Spike renamed</displayname><I:calendar-color>#336699</I:calendar-color></prop></set></propertyupdate>' }],
    ["PUT create If-None-Match:*", { method: "PUT", url: cal + "ev1.ics", headers: { "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" }, body: ev("spike-ev1@example.org", "First") }],
    ["PUT overwrite If-Match wrong", { method: "PUT", url: cal + "ev1.ics", headers: { "Content-Type": "text/calendar; charset=utf-8", "If-Match": '"bogus"' }, body: ev("spike-ev1@example.org", "Second") }],
    ["REPORT calendar-query Depth:1", { method: "REPORT", url: cal, headers: { ...XML, Depth: "1" }, body: '<?xml version="1.0"?><C:calendar-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/><C:calendar-data/></prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>' }],
    ["REPORT sync-collection", { method: "REPORT", url: cal, headers: XML, body: '<?xml version="1.0"?><sync-collection xmlns="DAV:"><sync-token/><sync-level>1</sync-level><prop><getetag/></prop></sync-collection>' }],
    ["MKCOL addressbook (extended)", { method: "MKCOL", url: book, headers: XML, body: '<?xml version="1.0"?><mkcol xmlns="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav"><set><prop><resourcetype><collection/><CR:addressbook/></resourcetype><displayname>Book</displayname></prop></set></mkcol>' }],
  ];
  for (const [label, spec] of steps) results.c_methods.push({ step: label, method: spec.method, requestHeaders: Object.keys(spec.headers || {}).concat(["Authorization"]).join(","), ...(await dav({ ...spec, auth: GOOD })) });
  // PUT with the real ETag (taken from the create), then DELETE with If-Match
  const create = results.c_methods.find((r) => r.step.startsWith("PUT create"));
  const etag = create && create.etag;
  results.c_methods.push({ step: "PUT overwrite If-Match correct", method: "PUT", requestHeaders: "Content-Type,If-Match,Authorization", ...(await dav({ method: "PUT", url: cal + "ev1.ics", headers: { "Content-Type": "text/calendar; charset=utf-8", "If-Match": etag }, body: ev("spike-ev1@example.org", "Third"), auth: GOOD })) });
  const get = await dav({ method: "GET", url: cal + "ev1.ics", auth: GOOD });
  results.c_methods.push({ step: "GET item (ETag readable)", method: "GET", requestHeaders: "Authorization", ...get });
  results.c_methods.push({ step: "DELETE item If-Match", method: "DELETE", requestHeaders: "If-Match,Authorization", ...(await dav({ method: "DELETE", url: cal + "ev1.ics", headers: { "If-Match": get.etag }, auth: GOOD })) });
  results.c_methods.push({ step: "DELETE collection", method: "DELETE", requestHeaders: "Authorization", ...(await dav({ method: "DELETE", url: cal, auth: GOOD })) });
  results.c_methods.push({ step: "DELETE addressbook", method: "DELETE", requestHeaders: "Authorization", ...(await dav({ method: "DELETE", url: book, auth: GOOD })) });
  await sleep(300);
  const nginxLog = readLog(path.join(RUN, "nginx", "access.log")).split("\n").slice(nginxLogBefore - 1).filter(Boolean);
  const methods = {};
  for (const l of nginxLog) { const m = /"([A-Z]+) \S+ HTTP/.exec(l); if (m) methods[m[1]] = (methods[m[1]] || 0) + 1; }
  results.c_nginxMethodCountsDuringDavSteps = methods;
  results.c_preflightOptionsSeen = methods.OPTIONS || 0;
  // cross-origin control from a CSP-free page: the same PROPFIND against Radicale's own port
  await pp.goto(ORIGIN + "/demo/inherit");
  const x = await pp.evaluate(async (u) => { try { const r = await fetch(u, { method: "PROPFIND", headers: { Depth: "0", Authorization: "Basic ZHVtbXk6ZHVtbXk=" }, credentials: "omit" }); return { status: r.status }; } catch (e) { return { error: String(e) }; } }, `http://127.0.0.1:${RADICALE_PORT}/alice/`);
  await sleep(300);
  results.c_crossOriginControl = { from: ORIGIN + "/demo/inherit (no CSP)", to: `http://127.0.0.1:${RADICALE_PORT}/alice/`, ...x };
  const radLog = readLog(path.join(RUN, "radicale", "radicale.log"));
  results.c_crossOriginControl.radicaleLogShowsOptionsPreflight = /OPTIONS/.test(radLog);
  // CSP: does default-src 'self' block the same cross-origin call from the /ui/ page?
  await pp.goto(ORIGIN + "/ui/");
  results.c_crossOriginControl.fromUiPageWithCsp = await pp.evaluate(async (u) => { try { const r = await fetch(u, { method: "PROPFIND", headers: { Depth: "0" }, credentials: "omit" }); return { status: r.status }; } catch (e) { return { error: String(e) }; } }, `http://127.0.0.1:${RADICALE_PORT}/alice/`);
  await pc.close();
  rmSync(prof, { recursive: true, force: true });
} finally {
  try { await browser.close(); } catch {}
}
console.log(JSON.stringify(results, null, 2));
