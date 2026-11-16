<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Browser-side spike report (S10, S11, S12)

Scope: Chromium 158 (headless, Playwright 1.65.0, pinned in `tests/e2e/package.json`), Node 20, a throwaway Radicale 3.9 instance, an unprivileged nginx and a stub backend. All data synthetic (`example.org`). Raw outputs are in `results/`. Scripts: `s10-auth.mjs`, `s11-nginx.mjs`, `s12-icaljs.mjs`, `s12-probe.mjs`.

## S12 — ical.js: PASS

| Item | Result |
|---|---|
| Version / licence | 2.2.1, MPL-2.0 (no other licence bundled). Integrity verified against `npm view` (sha512 and shasum). Vendored in `src/vendor/ical.js/2.2.1/` with `LICENSE` and `SHA256SUMS`; listed in `THIRD-PARTY-NOTICES.md`. |
| Size | `ical.min.js` is an ES module, 77,698 B (22,821 B gzip). |
| Import | ESM import works in Node 20 and in Chromium under `script-src 'self'`; probe output identical in both. |
| Recurrence | RRULE with EXDATE and a RECURRENCE-ID override expands correctly across a DST change. |

Re-serialisation findings (decisive for the writer design):
- `Component.toString()` rewrites too much: upper-cases property names, group prefixes (`ITEM1.X-ABLABEL`) and parameter names; merges repeated `TYPE=` parameters; drops quotes; rewrites vCard 3.0 `BDAY`/`REV` into iCalendar notation; **corrupts vCard 4.0 `PHOTO:data:...base64,` into `base64\,`**; emits no trailing CRLF; a lone CR in the input throws.
- `Property.toICALString()` does not fold. `ICAL.helpers.foldline` folds by octets but continuation lines come out at 76 octets including the leading space.
- A quoted `TZID="UTC+02:00"` without a matching VTIMEZONE silently becomes floating (the instant is shifted by the offset).

**Decision it feeds:** confirms the plan: keep raw lines, serialise only the properties RadUI touched with our own writer (own folding, own escaping), use ical.js as a read/expansion engine (values, recurrence, time zones), never as the writer of whole components. Unknown TZIDs must be detected and handled explicitly (read-only item or user-visible warning).

## S10 — Basic authentication in Chromium: PASS

- `Fetch.authRequired` never fires for a backend that answers 401 without `WWW-Authenticate`.
- With `credentials: 'omit'` and an explicit `Authorization` header it never fires, even against Radicale (which does send `WWW-Authenticate`) or a challenging stub. With default or `include` credentials mode it **does** fire, even with an explicit wrong header. A navigation control confirms the detector works.
- `sessionStorage`: survives reload and in-tab navigation, is empty in a new tab, is copied by `window.open` with an opener, is lost on browser restart. `localStorage` survives all of these. The built-in Radicale UI (`/.web/`) shares the origin's storage.
- PROPFIND, REPORT, MKCALENDAR, PROPPATCH, MKCOL, PUT, DELETE with `Depth` and `If-Match` work same-origin with **zero OPTIONS preflights**; a cross-origin control does preflight.

**Decision it feeds:** the app always calls `fetch` with `credentials: 'omit'` and an explicit header, so no native prompt can appear; the backend still must never send `WWW-Authenticate`. The "login must go through the backend" fallback (plan Q6) is not needed. The credential store design (sessionStorage by default, localStorage when "stay signed in" is ticked) is viable. Same-origin storage is shared with the built-in UI, which is another reason for the strict CSP.

## S11 — nginx coexistence: PASS

- `/ui/` (static), `/ui/api/health` (proxied), `/` and PROPFIND (Radicale) and `/.web/` all work side by side.
- A location-level `add_header` **drops all four server-level security headers** (demonstrated): every location must repeat them.
- `X-Forwarded-For` is overwritten with `$remote_addr`: a spoofed value never reached the stub nor Radicale's log.
- A stub page with a module script and a stylesheet from `/ui/` produced 0 CSP violations; an inline control page produced 4 (collector works).
- `sw.js` and the manifest are served `no-cache`.
- Body limits give a real 413 status to `fetch` for `/ui/api/` and for a 51 MiB PUT to `/`.

Deviations to apply in the deploy templates:
- Stock `mime.types` lacks `.mjs`, `.webmanifest`, `.ics`, `.vcf`: add a `types {}` block at `http` level.
- nginx forwards client-supplied `X-Forwarded-Host` and `X-Remote-Addr`: the template must clear both.
- An nginx `add_header Cache-Control` duplicates the upstream header: use `proxy_hide_header` where needed.
- The inline-hash CSP exception for Radicale's built-in UI was **not reproduced** on 3.9.0; re-check on the real UI before shipping a hash-based exception at all.

## Not verified
Headed-Chromium dialog behaviour, session restore of duplicated tabs, `<a>`/`<img>` navigations to protected URLs, `/.web/` after login under the strict CSP, Firefox and Safari, service-worker registration.
