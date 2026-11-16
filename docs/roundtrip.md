<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Round-trip corpus and harness

The harness checks that RadUI's data model reads, edits and writes items without damaging
what it does not own, and that Radicale hands back what was sent. Fidelity across the server
is judged **semantically** (Radicale re-serialises every item); inside RadUI untouched lines
are re-emitted unchanged.

## Running it

```
make test-roundtrip            # starts a throwaway Radicale (port 15300), runs everything, stops it
make test-roundtrip-offline    # only the checks that need no server
tests/roundtrip/run.sh up|down # start or stop the throwaway instance by hand
```

Needs Node 20, Python 3 with `bcrypt`, and a Radicale executable (`RADICALE_BIN`, or
`.env.local`). The instance runs as the current user on `127.0.0.1`, inside the git-ignored
`.throwaway/`, with one random-password account. It never touches a system path.

| File | Checks |
|---|---|
| `noedit.test.mjs` | (a) a no-edit round trip is byte-exact (LF-normalised input re-emitted as CRLF; `byteExact:false` fixtures against the normalised form); a save without change sends nothing |
| `fields.test.mjs` | (b) for every owned field of the registry (`lib.mjs`, one edit per field): the semantic diff shows only that property, in the edited component, plus DTSTAMP/SEQUENCE/LAST-MODIFIED/REV; read-only items refuse edits |
| `server.test.mjs` | (c) PUT, GET, semantic comparison with the allowlist below; (d) multiget REPORT text equals GET text and ETag; (e) writer output of every owned-field edit, built from the served text, survives PUT, GET, open (not read-only, stable, no lossy rule needed); new items (event, task, contact, both group forms) |
| `guard.test.mjs` | (f) the fidelity guard rejects deliberate tampering (dropped, altered, reordered or added foreign lines; UID/PRODID/VERSION; VTIMEZONE; foreign alarms; truncation) and accepts owned-line changes |
| `compare.test.mjs` | unit tests of the allowlist comparison, including negative cases |
| `ui-ops-events.test.mjs` | events (Run 3, WP B4), through the real write path `store/writes.js` and the form/scope modules: the **time-zone gate** (below), the event form no-op over the whole event corpus (no PUT), every single-field form edit (PUT, GET, semantic diff limited to the edited property, write verification, stable re-open), and every scope operation on `event-series-overrides-exdates.ics` (this, all, following/split, delete this and following, restore, `shiftExceptions` across DST with a UTC-written EXDATE, a date-time UNTIL, the all-day refusal, the rule-change question, a custom rule left alone, a two-zone event). Helpers: `evlib.mjs`, `tzgate.mjs` |

A new vCard photo is written as `PHOTO;ENCODING=b;TYPE=JPEG:` (3.0) or
`PHOTO;ENCODING=b;MEDIATYPE=image/jpeg:` (4.0), because Radicale drops the payload of the
RFC 6350 data-URI form (see the `photo-data-uri-payload-dropped` rule); one nickname is written
at a time, because Radicale cuts a `NICKNAME` list to its first value. Both are checked on
every run.

## What Radicale canonicalises (the allowlist)

`tests/roundtrip/compare.mjs` flattens both texts to property lines per component. Property
order, parameter-name case, parameter order, quoting, merged or repeated `TYPE`, folding, line
endings and blank lines never count. What remains must be explained by one of these rules
(evidence: Radicale 3.9.0 with vobject 0.9.9; each fixture named below shows the effect):

| Rule | Class | Evidence | Effect |
|---|---|---|---|
| `vtimezone-generated` | normalisation | `event-tzid-iana-novtimezone.ics` | a VTIMEZONE is added for a used IANA TZID that had none; an existing VTIMEZONE is never changed |
| `prodid-added` | normalisation | `event-quirk-no-dtstamp.ics` | PRODID added to a calendar without one |
| `dtstamp-added` | normalisation | `event-quirk-no-dtstamp.ics` | DTSTAMP (current time) added where missing |
| `zero-duration-dropped` | normalisation | `event-quirk-zero-duration.ics` | `DURATION:PT0S` next to DTEND removed (Radicale quirk) |
| `exdate-retyped` | normalisation | `event-quirk-exdate-value-date.ics` | `EXDATE;VALUE=DATE` on a timed series becomes a date-time at the DTSTART time (Radicale quirk) |
| `default-value-param-dropped` | normalisation | `event-quirk-redundant-params.ics` | `TRIGGER;VALUE=DURATION` loses the redundant parameter |
| `text-reescaped` | normalisation | `vcard30-vendor-cloud.vcf` | an unescaped `;` in a TEXT value is served as `\;` (same decoded value) |
| `text-cut-at-unescaped-comma` | **lossy** | `event-text-unescaped-separators.ics` | vobject keeps only the text before the first unescaped comma of SUMMARY, DESCRIPTION, LOCATION, COMMENT, NOTE, NICKNAME, TITLE and unknown `X-` properties |
| `photo-data-uri-payload-dropped` | **lossy** | `vcard40-photo.vcf` | `PHOTO:data:<mime>;base64,<data>` is cut at the comma: the payload is lost |

Lossy rules only describe input that breaks RFC 5545 or RFC 6350 (an unescaped comma in TEXT) or the
RFC 6350 data-URI form; stored data is already in the served form. The checks on writer output
(e) accept normalisation rules only. Everything else, in either direction, is a failure.
Evidence that does not change the verdict: escaped commas, semicolons, backslashes and `\n`,
folding by octets (never inside a character), CRLF output, multiple CATEGORIES lines, long
multi-valued ADR, grouped properties, `ENCODING=b` photos (also inside a 4.0 card), RRULE
variants, all-day DTEND, RELATED-TO, inline binary ATTACH and unknown `X-` parameters survive
unchanged.

## Time-zone gate (S13-lite, `ui-ops-events.test.mjs`)

New events carry a bare `TZID`; Radicale adds the VTIMEZONE (`vtimezone-generated`) and the app reads time from THAT
VTIMEZONE (`icalview.js`, class `embedded`). The gate compares, for each of 11 zones plus the runner's zone, the instant
the app derives with an independent brute-force Intl reference (RFC 5545 rules: a gap uses the offset before it, an
overlap the first occurrence): (a) 40 events PUT and read back (wall times around the transitions of 2024, 2026, 2029,
2034 and 2040, in gaps and overlaps, plus generic ones); (b) over 600 wall times of the years 2024 to 2040 (quarter hours around every
transition) against the served VTIMEZONE; (c) two ten-year weekly series (Sunday 02:30 and 00:30, 520 occurrences each)
occurrence by occurrence. A failing zone fails its test; nothing is repaired in the app.

Result with Radicale 3.9.0 / vobject 0.9.9 (what differs from Intl is the VTIMEZONE the server generates, not the app):
**passes** America/New_York, Europe/London, Asia/Kathmandu, America/Sao_Paulo, Asia/Tehran, UTC; **fails** Australia/Lord_Howe
and Pacific/Chatham (autumn onset written 30 / 60 minutes late), America/Santiago (wrong from 2031) and Africa/Casablanca
(Ramadan changes). Cause of all of them: vobject regenerates the VTIMEZONE from its tzinfo for the years 2000 to 2030 only and
cannot write non-yearly rules. **Europe/Paris was intermittent, cause found (WP B5):** Radicale keeps ONE tzinfo per TZID in a
process-global registry (vobject `__tzidMap`): the first one it sees wins for the life of the process, either a pytz zone (a bare
TZID event) or one parsed from ANY client's VTIMEZONE (a fixture, another user, another app). A server-generated VTIMEZONE built
from a parsed (dateutil) tzinfo is wrong (Paris: STANDARD `DTSTART:...T040000`, one hour late), one built from pytz is right. So
the server-generated result depends on which request reached the process first. Reproduced: PUT `event-dst-autumn-overlap.ics`
(a correct Paris VTIMEZONE), then a bare-TZID Paris event: the served VTIMEZONE has the 04:00 onset; with the bare event first it
is correct. Consequence: since WP B5 this gate is informative only (`RADUI_TZGATE_SERVER_STRICT=1` makes it fail again).

## Time-zone gate S13-own (WP B5, `tzgate-own.test.mjs`)

RadUI no longer relies on the server: every event it writes carries a VTIMEZONE generated by `src/js/calendar/tz.js`
(see docs/calendar.md). The gate writes events through the real item path (`createItem` then `save`), PUTs them, GETs, and
checks with the app's embedded read path (class `embedded`) against the brute-force Intl reference: (a) 40 events per zone,
(b) a 17-year yearly series plus the 600-wall-time matrix 2024 to 2040 (also served zone against the zone of the sent text),
(c) two 10-year weekly series occurrence by occurrence, (d) Europe/Paris five times in five event years, (e) a wrong foreign
VTIMEZONE seen first by the server does not change an item that carries ours. Result: all 11 zones plus the runner zone, Paris x5
and (e) pass (13 of 13).

Radicale with a client VTIMEZONE: kept as sent (it re-orders the properties inside a STANDARD/DAYLIGHT block, nothing else; our
text came back with identical content in all 40 x 12 events), with ONE exception found by the gate: **a comma-separated
`RDATE:a,b,c` in a VTIMEZONE is cut to its first value** (vobject bug), so `tz.js` writes one `RDATE` line per onset. TZID=UTC
comes back as a plain UTC time (class `utc`, same instant).

## Corpus

`tests/fixtures/ics` and `tests/fixtures/vcf` hold fictional items (example.org, reserved phone
ranges, two-decimal coordinates, invented PRODIDs). `manifest.json` gives the kind and the
expected model verdict of each. The two large photo cards (`vcard40-photo-100k.vcf`,
`vcard30-photo-b-20k.vcf`) are generated by `tests/roundtrip/gen-photo-fixtures.py` from
pseudo-random bytes. Vendor-shaped items carry only invented PRODIDs and structural `X-` names.

`tools/sanitize-fixture.py INPUT... -o OUT` turns real `.ics`/`.vcf` files into
structure-preserving fakes (deterministic, keyed by a hash): values are replaced, while
component structure, property and parameter names, groups, TZIDs, RRULEs, date-times,
escaping and the per-line octet lengths (so the folding) stay. Review the result and run
`tools/pii-check.py` before committing any output.

## Snapshot runner

`tests/roundtrip/snapshot-run.sh` runs the checks over a local snapshot of real collections
(a tar kept outside the repository). It extracts the tar into a private temporary directory,
starts a throwaway Radicale on that copy, and for every item records: model verdict
(ok, read-only with a reason code, refused), no-edit byte-exactness, the owned-field edits,
PUT of the item back and the comparison with the allowlist, and the edited item's PUT, GET and
re-open. The console shows aggregates only; per-item rows (index and path hash, reason codes)
go to a mode-600 report outside the repository. The temporary copy is deleted on exit.
`tests/roundtrip/snapshot-run.sh pii` runs `tools/pii-check.py --snapshot` on the extracted copy.
