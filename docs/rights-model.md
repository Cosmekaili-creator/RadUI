<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Rights model

RadUI keeps one JSON model (accounts, grants, tombstones) and **generates**
Radicale's `users` and `rights` files from it. Nothing else writes those
files. This page explains the model, the generated layout, why the rule order
is safe, and what the model cannot express. Names (`alice`, `bob`, `agent-1`,
`example.org`) are placeholders.

Code: `backend/radui_admin/{names,model,rightsfile,generator,expected,lockout,passwords,importer}.py`.
Golden examples: `tests/golden/rights/`.

## Model (schema 1)

```json
{"schema": 1, "generation": 7, "genToken": "<32 hex>", "bcryptCost": 12,
 "accounts": {"alice": {"displayName": "Alice", "type": "person", "admin": true,
                        "disabled": false, "ownSpace": true,
                        "created": "2026-01-01T00:00:00Z",
                        "passwordChanged": "2026-01-01T00:00:00Z", "hash": "$2b$12$..."}},
 "grants": [{"owner": "alice", "collection": "cal-work", "grantee": "agent-1",
             "level": "read", "created": "...", "by": "alice"}],
 "tombstones": {"bob": {"deleted": "...", "by": "alice"}}}
```

* Strict: unknown or missing keys, wrong types, duplicate JSON keys, floats,
  nesting deeper than 4 and strings over 128 characters are rejected
  (`model_corrupt`). At most 200 accounts and 2000 grants.
* `generation` increases by one on every change; `genToken` is a fresh random
  token per generation (used by the activation probe, see below).
* Logins: `^[a-z0-9][a-z0-9._-]{1,31}$`. Creation forms fold ASCII upper case to
  lower case; non-ASCII input is always refused. Reserved: `ui api web sharing
  token anonymous nobody system root admin administrator radicale radui`, every
  login starting with `radui-`, every tombstoned login, plus the configured
  `extra_reserved_logins`.
* Collection names: `^[A-Za-z0-9_][A-Za-z0-9._@~+-]{0,127}$`. The `radui-gen-`
  prefix is reserved at the top level. A name must not end in `~`: Radicale
  answers 400 for it, so such a collection cannot be created or used over DAV
  (the whitelist alone does not reject it). A collection whose name does not
  match the whitelist cannot be granted (it is "unsupported" and stays
  read-only to its owner).
* A `bot` account can never be an admin.
* Deleting an account removes it, **tombstones** the login for good (it can
  never be re-created) and removes every grant that names it as owner or
  grantee. Collection data is not touched by the backend.
* A grant needs two existing accounts, `owner != grantee`, a supported
  collection name and level `read` or `readwrite` (`none` removes it). A grant
  to an admin is refused: admins already have full access. A grant needs an
  enabled grantee to have any effect; a disabled owner does not matter
  (disabling freezes the owner's credentials, it is not a data takedown), so
  the grantee keeps access until the owner or an admin revokes the grant.
* `ownSpace = false` means no own space at all: the account may use its
  principal (so it can log in) but cannot create or use collections of its
  own. Switching it off while collections exist needs a typed confirmation
  (the owner loses access to them); `model.own_space_losses` lists such logins.

## Letters

Radicale uses upper-case letters for plain collections (a user's principal)
and lower-case letters for calendars and address books.

| Letter | Meaning |
|---|---|
| `R` / `r` | read (principal / calendar or address book) |
| `W` / `w` | write: create/change/delete items; create a principal / collection |
| `D` | delete a whole collection (explicit allow; RadUI sets `permit_delete_collection = False`) |
| `O` | overwrite a whole collection (explicit allow; `permit_overwrite_collection = False`) |
| `l` | deny PROPPATCH (rename, colour, description) |
| `i` | anonymous `GET` answers 404 instead of 401 (generation probe only) |

Levels used by the oracle (`expected.py`):

| Level | Letters | Where |
|---|---|---|
| `none` | (empty) | everything not listed |
| `generation` | `i` | anonymous, `radui-gen-<token>` |
| `root` | `R` | every authenticated login on the root path |
| `principal` | `RW` | own principal; an admin on an enabled own-space principal |
| `principal-ro` | `R` | an admin on any other top-level name |
| `own` | `rwDO` | `<login>/<collection>` of a non-admin with own space |
| `grant-r` | `r` | granted collection, read |
| `grant-rw` | `rwl` | granted collection, read/write items |
| `admin` | `RWrwDO` | an admin below any principal |

Consequences of the letters: nobody, admins included, can delete a principal over
DAV (no `D` on `RW`). A read/write grantee can add, edit and delete items but
cannot delete, overwrite, rename or recolour the collection (`l`, no `D`/`O`)
and cannot create collections inside a shared one (no matching rule).

## Generated layout

First match wins. Sections after `g010` carry a running counter
(`s0001-<kind>-<login>`), so names cannot collide whatever the logins are.

```
[g000-generation]  user ^$   collection ^radui-gen-<token>$   i
[g010-root]        user .+   collection ^$                    R
for each enabled admin A (sorted):
  user ^A$  collection ^A$              RW
  user ^A$  collection ^L$              RW     for each other enabled L with ownSpace (sorted)
  user ^A$  collection ^[^/]+$          R
  user ^A$  collection ^[^/]+/.+$       RWrwDO
for each enabled non-admin L (sorted):
  user ^L$  collection ^L$              RW
  user ^L$  collection ^L/[^/]+$        rwDO   only with ownSpace
for each grant (sorted by grantee, owner, collection; grantee enabled and not admin, owner any state):
  user ^G$  collection ^O/C$            r | rwl
[zzz-deny]         user .*   collection .*                    (empty)
```

Every login and collection name is whitelist-validated, then `re.escape`d.

Why the admin never gets `RW` on `^[^/]+$`: an admin could then create top-level
collections nobody can delete. The enumerated `RW` on each existing account's
principal exists because MKCALENDAR needs the parent principal to exist; the
admin creates a never-logged-in account's principal with MKCOL first.
Tombstoned and disabled logins get no `RW`.

Disabled accounts appear neither in `users` nor in `rights` (their data stays).
The `users` file is a comment header plus `login:hash` per enabled account, each
hash matching `^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$`.

### File format and integrity

```
# radui-admin generated; DO NOT EDIT. generation=<N>
<blank>
[section] / user: / collection: / permissions: / <blank>   (repeated)
# radui-end generation=<N> sha256=<hex>
```

ASCII only, LF line ends. The hash covers every byte before the trailer line, so
a truncated or edited file never validates. `rightsfile.check_text` rejects an
empty file, no sections, a missing or altered last `[zzz-deny]`, a
header/trailer generation mismatch, a hash mismatch, a `groups` key, any other
key, a permission letter outside `RWrwDOil`, any `{ } % \r \n` or non-ASCII
character, a pattern that does not compile after the same `.format()`
substitution Radicale applies, and any text that is not exactly the canonical
rendering of what ConfigParser reads from it. Only atomic rename may write it.

## Why the order is safe (first match wins)

1. Every rule except `g000`, `g010` and `zzz-deny` names **one exact login** in
   `user` (`^L$`, escaped). Rules of different logins never match the same
   request, so only the rules of one login can shadow each other.
2. `g000` matches only the anonymous user (empty login). `g010` matches only the
   root path. No other rule can match an empty login or an empty path, so these
   two never shadow anything.
3. Inside an admin's block the specific rules (`^A$`, then each `^L$`) come
   **before** the generic `^[^/]+$` (`R`): reversed, the generic read-only rule
   would shadow the `RW` on principals. The generic `^[^/]+$` and
   `^[^/]+/.+$` are disjoint (one has a slash, the other none), as are `^L$` and
   `^L/[^/]+$` in a non-admin's block.
4. A grant targets `^O/C$` with `O != G`, so it cannot overlap the grantee's own
   `^G/[^/]+$` rule; two grants for the same pair of path and grantee cannot exist
   (unique key). Admin grantees get no grant rules, so an admin's `RWrwDO` is
   never contradicted by a narrower rule.
5. Anything that matches nothing falls through to `[zzz-deny]` (empty letters),
   which makes the default "no access".

## Validation

The independent oracle `expected(model, user, path)` and `probe_pairs(model)`
use only the model. The candidate validator evaluates the generated text with
Radicale's own `from_file` engine and requires equal letter sets for every
probe: every account (enabled, disabled), every tombstoned login and one unknown
login, anonymous; the root, every principal (including never-logged-in and
tombstoned ones), a synthetic collection and item below each, every granted
collection and an item inside it, the current and a stale generation path and an
arbitrary top-level name. Any difference aborts the write.

`lockout.check_change(old, new, actor)` refuses a change that would leave no
enabled admin, that removes the acting admin's own admin status (disable,
delete, demote), that makes a bot an admin, or after which an admin probe
(`admin_probes`) would fall below admin level (optionally evaluated through the
real generated file).

## Passwords

Admin-typed: 12 to 72 UTF-8 bytes, no control characters, no normalisation, must
not contain the login, not on the embedded deny list, and at least three
character classes unless 16 or more characters. Generated: 20 characters from
`secrets` over an alphabet without look-alike characters. Hashing is bcrypt
(`$2b$`, cost from configuration, default 12). Anything over 72 bytes never
verifies, because bcrypt would silently ignore the tail.

## Limits of the model

* **Edit cannot be separated from delete.** Radicale has one write letter for
  items: a read/write grantee can also delete items.
* **No free/busy level.** Only none, read and read/write exist.
* A grantee needs the direct collection URL: other users' collections are not
  discoverable (the backend's `me/access` lists them).
* Grants are per collection, one level below a principal; there is no
  inheritance and no per-item sharing.
* Collections with unsupported names remain usable by their owner but cannot be
  shared.

## Importing a legacy setup

`importer.import_legacy` reads a legacy `users` and `rights` pair, makes the named
admins admins and every other account a bot, and reconstructs grants by
evaluating the legacy rules on the collection names the rules mention (literal
paths and `^owner/(a|b|c)$` alternations; wildcard rules need a list of
collection names). `equivalence_report` compares old and new effective rights
through Radicale's matcher and explains each difference:
`expected_tightening` (explicit delete/overwrite/PROPPATCH letters, principals
not deletable, grants that could not be represented, and a legacy admin rule
such as `.+` that allowed writing the root, arbitrary top-level names and the
generation path, which the new layout never grants an admin),
`expected_loosening` (admin access, own principal, root discovery, generation
probe) or `unexplained`, which must be empty before cutover.
