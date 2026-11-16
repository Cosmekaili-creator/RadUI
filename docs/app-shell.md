<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# App shell (`src/`)

Static files, plain ES modules, no build step. `src/package.json` (`"type": "module"`) lets Node load
`src/js` for the unit tests; it does not need to be deployed. Nothing deployment-specific is in the
code: paths, language, time zone and title come from `config.json`.

## Files

| Path | Purpose |
|---|---|
| `index.html` | Static shell: header, navigation, banner slots, live regions, `<main>`, Activity panel. Manifest link, theme-color metas, meta CSP aligned with the header (`manifest-src`, `worker-src`). No inline script, style or handler. |
| `config.json` | Deployment settings (below). Served next to `index.html`; a missing file means defaults. |
| `css/tokens.css`, `css/app.css`, `css/layout.css` | Design tokens (light, dark, manual override), shell styles, and the frame (tab bar / side rail, header rows, banners). |
| `css/widgets.css`, `css/contacts.css`, `css/collections.css` | Stubs; the work package that owns the area fills them. |
| `css/settings.css` | Settings screen, rail-only navigation entries and the phone top-bar shortcuts. |
| `icons/` | Logo mark and icon set (see `icons/README.md`). |
| `i18n/{en,fr}.js` | Aggregators: spread the part files below. Identical keys and `{placeholders}` in both languages, and no key in two parts (tested). In the built tree (`make dist`) each is one flat file with the same default export. |
| `i18n/{en,fr}.<area>.js` | Part files, one owner each: `shell` (this package), `widgets`, `contacts`, `groups`, `collections`, `import`, `conflict`, `pwa`, `common` (stubs until their work package fills them). |
| `js/app.js` | Boot: config, services, router, chrome, readiness. |
| `js/router.js` | Hash router: route table with `:param` patterns, query parsing, guard, `next` handling, `canLeave` veto, `collectionForParam`. |
| `js/screens.js` | Screen registry: module path, export and feedback family per screen; lazy loader. |
| `js/session.js` | Session container (one per login) and its holder. |
| `js/i18n.js` | Dictionary loader (`loadDictionary`, `createDictionaryLoader`), `t()`/`tp()`, parity check, language choice and switching (`createLanguageSwitcher`), `Intl` helpers. It imports no dictionary. |
| `js/config.js` | `config.json` loading, validation, path resolution. |
| `js/auth.js` | Credential store (sessionStorage, localStorage, memory fallback). |
| `js/api.js` | Account-service client (`me`, `me/access`), typed errors, login flow. The service's `health` endpoint is loopback-only behind the proxy and is never called from the browser; `me` carries `rightsActive` and `ok` instead. |
| `js/ui.js` | `h()` DOM builder, `vars`, `setDataImage`, write gate (`markWrite`), feedback store, Activity log, readiness, dialogs, unsaved-input guard, form snapshot, form field. |
| `js/views/comingsoon.js` | "Coming soon" page for the calendar and task routes (until slices 3b and 3c ship) and for screens whose module is not delivered yet. |
| `js/views/settings/screen.js`, `prefs.js` | Settings screen; per-login preference store. |
| `js/login.js` | Login screen. |
| `js/debug/debug.js` | Read-only diagnostics screen. |

## `config.json`

| Key | Default | Meaning |
|---|---|---|
| `basePath` | `"./"` | Where the app is served (resolved against the page; serve it from a directory URL). |
| `radicaleBasePath` | `"/"` | Where CalDAV/CardDAV answers. |
| `apiBasePath` | `"api/"` | Account service, relative to `basePath`. |
| `defaultLanguage` | `null` | `"en"`, `"fr"` or `null` (browser language). The user's own choice wins. |
| `defaultTimeZone` | `null` | IANA name, or `null` for the browser's zone. |
| `firstWeekday` | `null` | 1 (Monday) to 7 (Sunday), or `null` for the locale's. |
| `appTitle` | `"RadUI"` | Header and document title. |
| `sourceUrl` | `""` | `https:` address of the source code of this deployment's build, shown in Settings, About (AGPL section 13). Empty shows a neutral sentence; any other scheme is rejected with a warning. |
| `debug` | `false` | `true` shows test scaffolding on `#/debug` (the "Try the blocking dialog" button). Leave it off in production. |

Invalid or unknown entries are ignored with a warning (listed on `#/debug` and in the Activity log).
Paths must be same-origin (no scheme, no `//`, no query).

## Routes

Entries are `{name, screen, pattern, auth}`; `:param` segments become `route.pathParams`, the query becomes
`route.query`, and `route.params` merges both (path parameters win). Literal segments beat `:param` ones, so
`new` and `groups` are never contact keys. A path parameter over 200 characters, an invalid percent escape or
an unknown path gives the not-found page; query values over 2,048 characters are dropped.

| Hash | Screen (family) |
|---|---|
| `#/` and `#/login` when signed in | land on `#/contacts` (`LANDING_HASH`) |
| `#/login` | `login` (login) |
| `#/contacts` (`ab`, `q`, `group`, `from`, `dialog`), `#/contacts/<key>` | `contacts` (contacts) |
| `#/contacts/new`, `#/contacts/<key>/edit` | `contact-form` (contacts) |
| `#/contacts/groups`, `#/contacts/groups/<key>` | `groups` (contacts) |
| `#/collections` (`dialog`, `href`) | `collections` (collections) |
| `#/collections/new-calendar`, `/new-addressbook`, `/edit?href=` | `collection-form` (collections) |
| `#/users`, `#/users/new`, `#/users/permissions`, `#/users/<login>` | `users` (users): ONE controller for all four, it reads `route.name` (`users`, `user-new`, `users-permissions`, `user`); module by WP A2 |
| `#/settings` | `settings` (settings) |
| `#/calendar`, `#/calendar/<view>/<date>` | `calendar` (calendar); `comingsoon` until slice 3b |
| `#/events/new`, `#/events/<key>`, `#/events/<key>/edit` | `event-form`, `event`, `event-form` (calendar); `comingsoon` until 3b |
| `#/tasks`, `#/tasks/new`, `#/tasks/<key>`, `#/tasks/<key>/edit` | `tasks`, `task-form`, `task`, `task-form` (tasks); `comingsoon` until slice 3c |
| `#/debug` | `debug` |
| anything else | `notfound` |

- **Screen reuse.** When the next route has the same `screen` and the mounted controller has `update(ctx)`,
  the shell calls it instead of remounting: scroll position, search text and focus stay. A language switch
  always remounts.
- **Feedback scope = screen family** (`familyOf(screen)`): a status or alert survives moves inside a family
  (contacts list to its form) and is dropped when another family is entered.
- **Registry (`js/screens.js`).** Each screen has `{family, module, export, model?}`. `module: null` means "not
  delivered yet": the coming-soon page stands in. A work package only sets `module` (relative to `js/`) and
  `export`. `model: true` makes the shell load the data model (and ical.js) before mounting, so the login route
  stays small; screens may also `await app.loadModel()`.
- **Controller contract:** `mount(ctx) -> {title?, wide?, update?(ctx), snapshot?(), canLeave?(to), dispose?()}` with
  `ctx = {root, t, tp, params, route, host, restore, signal, app}`. `wide: true` (split views) and `full: true` (calendar) both
  make the shell add `main--wide` and `main--full` to `<main>`: from 900 px it then uses the whole width, aligned to its start edge
  (`layout.css`; the contacts list column is `minmax(300px, 400px)`). Phones keep the 960 px column.
- **Parameters from the hash are never trusted:** `collectionForParam(value, collections)` returns the
  discovered collection whose href equals the `href` / `ab` value (up to a trailing slash), else `null` (show
  "not found"); nothing is fetched from an address typed into the URL.

## Navigation

Bottom tab bar under 900 px, side rail from 900 px (same `<nav>`, `css/layout.css`, `css/settings.css`). Desktop rail order:
Calendar (`nav-calendar`), Tasks (`nav-tasks`), Contacts (`nav-contacts`), Collections (`nav-collections`), Users
(`nav-users`, administrators only), Settings (`nav-settings`), Diagnostics (`nav-debug`). Phones show four tabs (Calendar,
Tasks, Contacts, Collections); Users and Settings are top-bar shortcuts there (`topbar-users` for administrators,
`topbar-settings`), and the rail-only entries (`.nav__item--rail`) are not drawn. The entry of the current screen family
carries `aria-current="page"`.

**Which entries are offered** (`NAV_ITEMS`, `TOPBAR_ITEMS`, `navVisible`, `applyNav` in `js/app.js`): an entry needs its
`slice` in `ENABLED_SLICES` (frozen; `base`, `3a` today) and, when it is an `admin` entry, an administrator. A slice's
last work package adds its name to `ENABLED_SLICES` in one line: `3a-users` (WP A2 / the `users` E2E run), `3b`, `3c`.
Until then its routes show the coming-soon page. Hiding an entry is a convenience only: a non-admin who types `#/users`
gets `access-required` (A2's screen) and the backend refuses anyway.

`app.isAdmin()` and `app.getMe({refresh})` (in `ctx.app`) give the signed-in user's `GET me` result, loaded once per login
(cached on the session container; a failure means "not an administrator"). The chrome is drawn again when it arrives.
`app.prefs()` is the per-login preference store of the session (`views/settings/prefs.js`: `get`, `set`, `remove`,
`clearAll`, `subscribe`; keys `radui.pref.<login>.<name>`; localStorage in try/catch with an in-memory fallback).
`app.setLanguage(code)` does what the language select does. `app.signOutWith(messageKey)` signs out at once (no
unsaved-input prompt) and shows that text on the login screen.

The header has the language switch, the theme control, Activity and the sign-out button `btn-sign-out`. On phones the
header is two rows (brand and sign-out, then the tools). DOM and tab order: skip link, brand, language, theme, (users,
settings), Activity, sign-out, navigation, screen. `#app` gets the class `has-nav` while signed in.

## Language loading

Only the active language is loaded. `app.js` imports no dictionary: at start-up it awaits
`dictionaries.load(lang)` (`js/i18n.js`, dynamic `import('../i18n/<lang>.js')`, default export) before the first
render. `loadDictionary` checks the language against `SUPPORTED_LANGUAGES` before it builds the path, so a name like
`../x` never reaches `import()`. If the chosen language cannot be loaded the app falls back to English; if English
fails too, `#app` gets `data-state="error"` and the bilingual static text `FATAL_TEXT`. There is no hidden English
fallback dictionary when another language is active: a key missing from it shows as the key (parity is a test).

The language select (and the Settings radios) go through `createLanguageSwitcher`: it loads the dictionary (busy
state, `aria-busy` on `#app`, meanwhile), then switches, stores the choice on this device (the only write; nothing
goes to the server) and remounts the screen with its `snapshot()` restored. A failed load keeps the current language
and shows `shell.language.loadFailed`. Each language is imported once per page load. The service worker still
precaches both languages (they are ordinary files of the manifest), so switching works offline. Tests that need
both dictionaries use `tests/unit-js/_i18n-all.mjs`; it is never shipped.

## Settings and the own-password change (D-R3-9, D-R3-10)

`#/settings`: account facts (`settings-account`), password (`settings-password`), language (`settings-lang-en|fr`),
`btn-sign-out-forget` (removes this login's saved preferences and its "last address book", then signs out), a link to
Diagnostics, and **About** (`settings-about`: application, version `about-version`, licence, source link
`about-source-link` or the neutral sentence `about-source-none`). The version is the `source` of `build-info.json`
(written by `tools/build-dist.py`, fetched with `cache: 'no-cache'` when About is shown); a source tree has none and
shows "development build". Calendar preferences (WP B3b) are added by appending a section builder to `SECTIONS` in `screen.js`.

The account service has no self-service password endpoint yet (Run 4, backend). In this version an **administrator**
changes their own password through `POST accounts/<login>/password` (typed twice, or generated and shown once in
`dialog-password-once`); on success `auth.replaceCredential(login, password)` replaces the stored credential in place
(same storage kind: session, local or memory), `GET me` with the new header confirms it (for a generated password only
after the dialog was confirmed), and if that fails the user is signed out with "Your password was changed. Sign in again
with the new password." Everyone else sees `own-password-admin-only`. The password never reaches Activity, the console or
a URL.

## Unsaved input (D-R2-22)

A form screen calls `app.setDirty(true/false)`. While dirty, `beforeunload` is armed and a navigation made by the
browser (link, Back, typed hash) is vetoed: the router puts the URL back WITHOUT a new history entry (it walks
`history.back()`/`forward()` using entry numbers stamped in `history.state`; `replaceState` only when the window
cannot walk) and the shell opens `dialog-discard-changes` with `dialog-keep-editing` (focused) and
`dialog-discard`. Discard clears the flag and navigates with `router.navigate(hash, {force: true})`. The sign-out
button asks the same question. A controller may whitelist moves it handles itself with `canLeave(to) -> true`
(or `app.setLeaveHook(fn)`). A non-dismissible dialog vetoes without asking.

## Session container (M9)

`js/session.js`: one `createSession({login, storage, timers})` per login, held by `createSessionHolder`. app.js
ties the holder to the credential store: signing in starts a container, signing out and session expiry both end
it (`dispose()`: timers cleared, listeners removed, stores stopped, `session.data` emptied, Activity log and
feedback cleared, screen unmounted). A different login always gets a fresh container.

`app.session` (in `ctx.app`) offers: `register(store)` (a store with `dispose()`, `stop()` or `destroy()`),
`unregister(store)`, `onDispose(fn)` (newest first; returns an unsubscribe), `setTimeout(fn, ms)` /
`setInterval(fn, ms)` (tracked; return a cancel function), `listen(target, type, fn, opts)`, `data` (a Map),
`lastBook` / `setLastBook(href)` (localStorage key `radui.lastbook.<login>`, so a second login never sees the
first login's preference), `login`, `disposed`, `dispose()`. After dispose, new timers are inert and new stores
are stopped at once.

## `ui.js` helpers

- `vars(el, {'--name': value}, allowRegExp) -> rejectedNames[]`: CSS custom properties through
  `el.style.setProperty`; every value must match the caller's whitelist in full, else it is skipped. `h()` takes
  `vars: {allow, values}`. Nothing writes a `style` attribute.
- `setDataImage(img, mime, b64) -> boolean`: the ONLY place a `data:` image source is set. jpeg, png, webp, gif
  only (never svg), valid base64, at most 1.5 MB decoded; otherwise the source is cleared and `false` is
  returned (show initials). `h()` still refuses `data:` URLs, `style`, `on*` and raw HTML.
- `markWrite(el)` / `h(.., {write: true})` / dialog action `write: true`: registers a write control with the
  global gate `writeGate`. `writeGate.setReason('offline' | 'readonly', suffixText | null)` disables every
  registered control and appends the suffix to its accessible name ("Save (offline: changes disabled)");
  turning the reason off restores both. The shell drives `offline` from `navigator.onLine` and the
  online/offline events; the PWA module may drive the same gate. `createWriteGate()` makes a separate one.
- `openDialog({... focus})`: `'cancel'` focuses the action marked `cancel: true` (or the one with test id
  `dialog-cancel`), another string focuses the field with that test id, an element focuses it (m7).
  `dismissible: false` is the one-time dialog of SPECS 10b-4 (unchanged).
- `createLeaveGuard`, `snapshotForm(root)` / `restoreForm(root, snap)` (typed input keyed by test id; passwords and
  files are never captured) for form screens that implement `snapshot()` (m11).
- Banner slots: `banner-offline` (text and `hidden` driven by the shell) and `banner-update` with
  `btn-reload-update` (shown by the PWA module), both `role="status"`.
- Activity: `activity.op.<name>` labels not in the shell part fall back to the raw operation name; the
  `activity.op.*` and `err.dav.*` keys for the new operations belong to the `common` part.

## Dictionaries

Add keys to the part file of your area in BOTH languages (`i18n/en.<area>.js`, `i18n/fr.<area>.js`). A key may
live in one part only; `tests/unit-js/app/i18n.test.mjs` checks collisions, parity per part and the aggregates.

## Behaviour

- **Readiness:** `#app` has `data-state="loading|ready|error"`, `aria-busy`, and `data-route`.
  `loading` lasts while any request of the current screen is in flight.
- **Feedback:** one status slot and one alert slot (`role="status"`, `role="alert"`). Messages stay
  until dismissed or replaced and belong to the screen family that produced them; entering another family
  clears them. The Activity panel keeps the history (ring buffer of 50, credentials redacted).
- **Sign-in:** the account service `me` is asked first (401: wrong credentials; 429: rate limited);
  network errors, 404, 5xx and 403 fall back to a DAV principal lookup (account details are then
  limited). The header lives in sessionStorage, or in localStorage when "Stay signed in" is ticked
  (off by default); a blocked storage falls back to memory. Sign-out clears everything.
- **Requests:** `credentials: 'omit'`, explicit `Authorization`, `cache: 'no-store'`, same-origin
  paths, `X-RadUI: 1` on mutating account-service calls.
- **Blocking dialog:** `openDialog({dismissible: false})` ignores Esc (keydown and `cancel`),
  re-opens if the browser closes it anyway, ignores backdrop clicks, warns on page unload, and the
  router refuses to navigate away until it is confirmed (the URL goes back without a history entry).
- **Diagnostics:** `#/debug?items=<0-50>` (default 5) sets how many items per collection are opened.
  The "Account service health" card is built from `me` (`rightsActive`, `ok`): healthy, reports a
  problem, or "not reported" when a server omits the fields; it never calls the loopback-only
  health endpoint. The account type, Yes/No values and the first weekday are shown localized.
  The "Try the blocking dialog" button (`debug-dialog-test`) is test scaffolding: it is drawn only
  when `config.json` has `"debug": true` or the address carries `?debug=1`
  (for example `#/debug?debug=1`). The browser test suite turns it on through its generated `config.json`.
- **Sign-in failure:** a wrong password is announced once, in the `role="alert"` `login-error` region;
  the password field gets `aria-invalid` and `aria-describedby="login-error"`, receives focus
  (never a text selection) and shows no second copy of the message.
- **Header on phones (up to 480 px):** brand and tab on the first row; language, theme and Activity on
  the second. "Signed in as ..." is not drawn but stays available to assistive technology
  (`aria-label` on `header-user`). The skip link, when focused, is a full-width opaque bar at the very
  top that pushes the header down instead of covering it.

## Test ids

Shell: `app-root`, `skip-link`, `app-header`, `brand`, `app-title`, `main-nav`, `nav-contacts`, `nav-collections`,
`nav-debug`, `btn-sign-out`, `banner-offline`, `banner-update`, `btn-reload-update`, `dialog-discard-changes`,
`dialog-discard`, `dialog-keep-editing`, `comingsoon-screen`, `comingsoon-home`, `header-user`, `lang-select`, `theme-select`, `activity-toggle`, `activity-panel`, `activity-close`,
`activity-empty`, `activity-list`, `activity-row` (`data-op`, `data-result`), `feedback-regions`,
`status-region`, `status-message`, `status-text`, `status-dismiss`, `alert-region`, `alert-message`,
`alert-text`, `alert-dismiss`, `screen` (the `<main>`).

Login: `login-form`, `login-server`, `login-username`, `login-username-error`, `login-password`,
`login-password-error`, `login-stay`, `login-stay-note`, `login-submit`, `login-error`.

Diagnostics: `debug-screen`, `debug-progress` (`data-state` running/done/error), `debug-refresh`,
`debug-dialog-test`, `debug-signout`, `debug-session`, `debug-session-login`, `debug-session-name`,
`debug-session-type`, `debug-session-admin`, `debug-session-ownspace`, `debug-session-generation`,
`debug-session-source`, `debug-session-limited`, `debug-health`, `debug-config`,
`debug-config-appbase`, `debug-config-apibase`, `debug-config-radicalebase`, `debug-config-language`,
`debug-config-timezone`, `debug-config-firstweekday`, `debug-config-warnings`, `debug-collections`,
`debug-collections-note`, `debug-collections-empty`,
`debug-summary`, `debug-collection` (`data-href`, `data-status`, `data-source`, `data-kind`),
`debug-collection-count` (`data-count`), `debug-collection-checked`, `debug-items`,
`debug-item-row` (`data-href`, `data-result`, `data-reason`), `debug-dialog`, `debug-dialog-ack`,
`debug-dialog-confirm`.

Not found: `notfound-screen`, `notfound-home`.

## Tests

`node --test tests/unit-js/app` (fakes for fetch, storage, history, timers and DOM; no browser). Files: `router`, `ui`
(+ `ui-shell`), `session`, `nav`, `static` (CSP-style scan of all of `src/` except `src/vendor`), `i18n`, `login`, `debug`, `api`,
`auth`, `config`, `weekday`.
