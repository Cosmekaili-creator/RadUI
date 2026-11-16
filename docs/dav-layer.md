<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# DAV layer (`src/js/dav/`)

Plain ES modules, no dependencies, no DOM: the same files run in browsers and in Node 20
(`fetch`, `AbortController`, `TextEncoder`, `btoa`). Nothing is hard-coded: the origin and the Radicale
base path are parameters of `createTransport`.

| Module | Purpose |
|---|---|
| `xml.js` | namespace-aware XML parser and builder |
| `http.js` | transport, typed errors, href/path handling, line-ending helpers |
| `requests.js` | request-body builders (PROPFIND, REPORTs, MKCALENDAR, MKCOL, PROPPATCH) |
| `client.js` | CalDAV/CardDAV operations on top of the above |
| `discovery.js` | own collections plus grants from the backend |
| `sync.js` | pure synchronisation state machine |

## Rules

1. **Same origin only.** The transport sends only to `origin + path`. Every href from the server is
   validated by `normalizeHref`: absolute foreign URLs, protocol-relative URLs, `.`/`..` segments (also
   percent-encoded), encoded slashes, backslashes, control characters, empty segments, queries and
   fragments are rejected (`DavError` kind `invalid`). Accepted hrefs are canonicalised (each segment
   decoded and re-encoded with `encodeSegment`), so equivalent spellings compare equal. If a base path
   is configured, hrefs must lie under it.
2. **No native login prompts.** Every request uses `cache:'no-store'`, `credentials:'omit'`,
   `redirect:'error'` and an explicit `Authorization` header from `getAuth()`. Credentials are never
   logged and never stored in errors. There are no automatic retries: a 401 is reported once.
3. **ETag discipline.** ETags are opaque strings exactly as the server sent them (quotes included);
   the client never computes one. `putItem` needs exactly one of `{etag}` (sends `If-Match`) or
   `{create:true}` (sends `If-None-Match: *`) and throws `TypeError` otherwise. `deleteItem` and
   `deleteCollection` need a real ETag and throw `TypeError` for none or `*`. A 412 on any of these
   becomes `ConflictError{href, sentEtag}` (`sentEtag` is `null` for a create).
4. **LF in memory, CRLF on the wire.** Item text returned by `getItem`, the queries and the multigets is
   normalised from CRLF/CR to LF (`toLf`); `putItem` converts the body to CRLF (`toCrlf`). Text from GET
   and from REPORT is identical after normalisation. The server re-serialises on storage (property
   order, parameter case, folding), so equality across a PUT is semantic, never byte-exact.
5. **Hostile XML cannot hurt.** `parseXml` rejects `<!DOCTYPE` and every other markup declaration,
   decodes only the five predefined entities and numeric references (each yields one character, so
   decoding never expands), and enforces limits (`DEFAULT_LIMITS`: 16 MiB, depth 64, 500 000 elements,
   32 attributes per element, 256-character names). All text placed in request bodies goes through
   the builder's escaping; element and attribute names are validated.

## `xml.js`

- `parseXml(text, limits?)` returns a node `{ns, name, attrs, children, text}` (`attrs` keys are the
  local name, or `{uri}local` for namespaced attributes; `children` are elements only; `text` is the
  element's own text and CDATA). Throws `XmlError`.
- Reading: `is(node, ns, name)`, `find`, `findAll`, `findPath(node, [[ns, name], ...])`, `text(node)`
  (full text content, not trimmed).
- Building: `el('{ns}name', attrs|null, ...children)` (strings become text, arrays are flattened,
  `null`/`false` skipped), `serializeXml(node, {declaration})`, `xmlEscape(value)`. `NS` holds the
  well-known namespaces.

## `http.js`

- `createTransport({origin, basePath, getAuth, fetchImpl, timeoutMs, maxResponseBytes, onUnauthorized})`
  returns `{origin, basePath, normalize(href), request(method, path, {headers, body, depth,
  timeoutMs, signal, allowStatus})}`. `request` resolves for 2xx and throws `DavError` otherwise;
  `getAuth` may be async and returns the full header value (or `null`). Timeouts use `AbortController`.
- `DavError{kind, status, body, method, path, xml, conditions}` with `hasCondition(ns, name)`. A
  `DAV:error` body is parsed on construction and kept (decision D5). Kinds: `auth` (401), `forbidden`
  (403), `notfound` (404, 410), `precondition` (412), `conflict` (409), `toolarge` (413), `network`
  (fetch failure, timeout, redirect; `timeout:true` for timeouts), `server` (5xx), `invalid` (other 4xx,
  malformed responses, rejected hrefs).
- `ConflictError extends DavError` (kind `precondition`) adds `href` and `sentEtag`.
- Helpers: `normalizeHref(href, origin, basePath)`, `encodeSegment` (stricter than
  `encodeURIComponent`: also encodes `!'()*`), `joinPath(segments, {trailingSlash})`, `toLf`, `toCrlf`,
  `kindForStatus`.

## `requests.js`

Builders return `{method, depth, body}` (no network): `propfind(props, {depth})`,
`calendarQuery({comp, start, end})` (UTC time range from `Date` or `YYYYMMDDTHHMMSSZ`, no server-side
expansion), `calendarMultiget(hrefs)`, `addressbookQuery()`, `addressbookMultiget(hrefs)`,
`syncCollection(token)`, `mkcalendar({displayName, color, description, components})`,
`mkAddressbook({displayName, description})` (extended MKCOL), `proppatch(kind, {displayName, color,
description})` (`null` removes). Colour is `#RRGGBB[AA]` (`http://apple.com/ns/ical/:calendar-color`).
`PROP` and `COLLECTION_PROPS` list the property names used.

## `client.js`

`createClient(transport, {multigetChunk})` returns:

| Method | Result |
|---|---|
| `principal()` | principal href |
| `homeSets(principal?)` | `{principal, calendarHomes, addressbookHomes}` |
| `listCollections(home)` | collection descriptors (below), calendars and address books only |
| `getCollection(href)` | one descriptor (Depth 0); `notfound`/`forbidden` pass through |
| `listItemEtags(href)` | `[{href, etag}]` (PROPFIND Depth 1, no data) |
| `calendarQuery(href, {comp, start, end})`, `addressbookQuery(href)` | `[{href, etag, text}]` |
| `calendarMultiget(href, hrefs)`, `addressbookMultiget(href, hrefs)` | `{items, missing}`; hrefs must be items of that collection; chunked |
| `syncCollection(href, token)` | `{token, changed: [{href, etag}], removed: [href]}` |
| `getItem(href)` | `{href, etag, text, contentType}` |
| `getCollectionText(href, {maxBytes})` | `{href, etag, text, contentType, kind: 'calendar'\|'addressbook'\|'empty'}`: GET of a whole collection (export); LF text |
| `putItem(href, text, {etag}\|{create:true})` | `{href, etag, created}` |
| `deleteItem(href, etag)`, `deleteCollection(href, etag)` | `{href}` |
| `mkcalendar(href, props)`, `mkAddressbook(href, props)` | `{href}`; an existing collection is kind `conflict` |
| `proppatch(href, kind, changes)` | `{href}`; a refused property throws |

Descriptor: `{href, kind: 'calendar'|'addressbook', name, components, displayName, color, description,
ctag, syncToken, etag, privileges}`. `name` is the decoded last path segment; missing values are `null`.
`components` comes from `supported-calendar-component-set`; a calendar without one is treated as
`{VEVENT, VTODO}`; address books report `['VCARD']`. `privileges` is the list of
`current-user-privilege-set` names, or `null` when the server did not report it. `canWriteItems(c)` is
true when `write-content`, `write` or `all` is present (unknown counts as writable; the server stays
the authority). `etag` is the collection ETag to pass to `deleteCollection`. Also exported:
`childHref(parent, name, {collection})`, `parseMultistatus(text)`.

`getCollectionText` needs a collection href (ending in `/`). Radicale answers a GET on a collection with
every item as one text (a VCALENDAR with all components, or the vCards one after the other); the text is
LF-normalised in memory like every other item text. An empty body is `kind: 'empty'` with text `''`. A body
that is neither empty nor calendar or vCard data (an error page from a proxy) throws kind `invalid`; a body
over `maxBytes` (default 32 MiB, checked after the read) throws `toolarge`, and the transport's own
`maxResponseBytes` refuses a larger `Content-Length` before the body is read. Other failures are the
transport's typed errors (`auth`, `forbidden`, `notfound`, `network`, `server`). The export code writes a
`.vcf` or `.ics` file from `text`.

## `discovery.js`

`discoverAccessible(client, api)` lists the user's own home children and adds the grants returned by
`api.meAccess()` (injected; an array or `{grants: [...]}` with `href` or `owner`+`collection`, and
`level`). Result: `{collections, apiError, ownError}`. Every entry has `source` (`own`|`grant`),
`owner`, and `status`: `ok` (full descriptor), `missing` (404), `inaccessible` (403) or `error`
(`error: {kind, status}`). Grant entries also carry `level` and the backend's record as `grant`.
Malformed or foreign grant hrefs are ignored. If the backend fails or is absent the own collections
are still listed; a 401 always rejects.

## `sync.js`

`createSyncState({href, kind})` makes `{href, kind, status, mode, token, ctag, etags}`.
`syncStep(client, state)` performs one step and returns `{state, upserted: [{href, etag, text}],
removed, via, signals}` without mutating its input and without timers; the caller decides when to
call it and keeps the new state. `resetStatus(state)` clears `inaccessible`/`missing`.

1. With mode `sync`: `sync-collection` with the stored token (empty on the first run). Changed hrefs
   whose ETag differs from the known one are fetched with multiget. A full listing derives removals
   from the known set.
2. Decision D5, for every 403: a `DAV:valid-sync-token` error drops the token and resyncs once with an
   empty token (`via: 'resync'`, `signals.tokenReset`); a second failure falls back to step 3 for
   this run (`signals.fellBack`) and sync is tried again next time. Any other 403 sets `status:
   'inaccessible'` and `signals.refetchAccess`. A 404 sets `status: 'missing'` with the same signal.
3. Fallback (no sync support, or the case above): compare `getctag`; if it changed or is not offered,
   list ETags, diff against the known ones and multiget the differences (`via: 'etag-list'`; an
   unchanged ctag gives `via: 'ctag'` after one request).

Network and server errors and 401 reject; the caller keeps its old state and retries on the next
tick.

## Observed Radicale 3.9 behaviour the layer relies on

- `403` is used both for an invalid sync token (body `DAV:valid-sync-token`) and for a permission
  denial (plain-text body); only the body tells them apart.
- A full (empty-token) sync-collection response may list long-deleted items as 404 entries; `client`
  returns `removed: []` for an empty token.
- Collection `getetag` equals `getctag`; item ETags are quoted hex strings, identical in the PUT
  response, GET, PROPFIND and REPORT.
- A collection name ending in `~` is rejected with 400; other odd names (space, `+`, `@`, `~` inside,
  non-ASCII) work.
- The `current-user-privilege-set` of a read-write grantee includes `write-properties` even when the
  rights letters deny PROPPATCH (the lower-case `l`): do not infer PROPPATCH ability from it.
- With `permit_delete_collection` on, a plain `w` is enough to delete a collection; the integration
  runner turns both permit options off, like the planned deployment.
- An unescaped comma in a TEXT value (for example `SUMMARY:A, B`) is truncated by the server to
  `SUMMARY:A` without any error: writers must escape TEXT values.

## Tests

- Unit: `node --test tests/unit-js/dav` (fake fetch, recorded Radicale responses in
  `tests/unit-js/dav/fixtures/`, hostile XML corpus).
- Integration: `tests/integration/dav/run.sh` starts a throwaway Radicale on port 15270 with the
  accounts alice and bob (rights file with a read-write and a read-only grant for bob), runs
  `tests/integration/dav/*.test.mjs` and removes everything. The tests are skipped with a message
  unless `RADUI_TEST_RADICALE` and `RADUI_TEST_PASSWORDS_FILE` are set. `run.sh up` / `run.sh down`
  start and stop the instance by hand.
