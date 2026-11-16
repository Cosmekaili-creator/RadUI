# RadUI

A web interface for [Radicale](https://radicale.org/): calendars, tasks and contacts in the browser, plus a
small admin backend that manages accounts, sub-accounts and sharing by generating Radicale's `users` and
`rights` files.

- **Calendar** - month, week, day and agenda views; create, edit and delete events with recurrence
  (including single-occurrence and "this and following" edits), all-day events, alarms and time zones;
  a birthdays calendar read from your contacts
- **Tasks** - one list across all task collections with filters, one-tap completion and a task form
- **Contacts** - list with search, A-Z jump and group filter; phones, e-mails, addresses, web, birthday,
  notes, categories and photos; contact **groups**; fields the app does not know are written back untouched
- **Collections** - own and shared address books and calendars with counts; create, rename, recolour and
  delete (typed confirmation)
- **Import and export** - `.vcf` and `.ics` import with a preview, duplicate handling and a report; export of
  a book, a contact or a calendar
- **Conflicts** - a save never silently overwrites someone else's change; a side-by-side dialog offers
  reload, overwrite with only your changes, save as a copy, or cancel
- **Users and permissions** - accounts, sub-accounts (for example a bot account) and read-only or
  read/write sharing, managed in the app by an administrator
- **Admin backend** - generates Radicale's `users` and `rights` files, validates them with Radicale's own
  engine, keeps generations for rollback, and a rights plugin hot-reloads them without restarting Radicale
- **Installable app (PWA)** - a service worker precaches the hash-verified app files, so the app starts
  without a network and shows an update banner for new versions; no calendar or contact data is kept on
  the device
- **Small and plain** - plain JavaScript ES modules, no framework; `make dist` builds a minified tree with
  one dictionary per language
- **i18n** - English and French, with a documented way to add languages

## Licence

Copyright (C) Majorum Network. AGPL-3.0-or-later. See [LICENSE](LICENSE). If you modify RadUI and let
others use it over a network, the AGPL asks you to offer them your source. RadUI is compatible with
Radicale (GPL-3.0) and the vendored `ical.js` (MPL-2.0). Vendored code is listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

**Status: pre-alpha.** Interfaces and file formats may still change.

## Requirements

- Radicale **3.9** series (tested on 3.9.0) with `htpasswd` authentication and bcrypt hashes
- Python **3.11+** for the admin backend and CLI (3.13 tested), with the `bcrypt` module
- nginx over HTTPS (templates provided) and systemd (units provided); fail2ban optional
- A current evergreen browser
- To build the app: `python3`, `node` and optionally `terser`. No Node.js is needed on the server.

## Quick start (developers)

```bash
make test              # unit tests and repository checks
make throwaway-up      # throwaway Radicale on 127.0.0.1:15232 (see tools/throwaway/README.md)
make throwaway-down
make dist              # minified app in dist/ (git-ignored)
```

Machine-specific settings (for example the path of the `radicale` binary) go in a git-ignored
`.env.local`; see the top of the `Makefile`.

## Production

All host-specific values (names, paths, ports) come from one variables file
(`deploy/vars.example.env`, copied to a git-ignored `deploy.local/vars.env`) and are rendered into the
templates in `deploy/`.

| Path | Role |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Step-by-step installation, supported versions |
| [deploy/](deploy/) | systemd, nginx, tmpfiles, fail2ban and Radicale templates with placeholders |
| [deploy/CUTOVER.md](deploy/CUTOVER.md) | Switching an existing Radicale from hand-written `users`/`rights` files |
| [deploy/ROLLBACK.md](deploy/ROLLBACK.md), [deploy/RECOVERY.md](deploy/RECOVERY.md) | Rolling back and recovering |
| [docs/UPGRADE-UI.md](docs/UPGRADE-UI.md) | Deploying a new app version (`tools/deploy-static.sh`) |

## Docs

| Doc | Contents |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Using the app |
| [docs/ADMIN.md](docs/ADMIN.md) | Users and permission model, limits of Radicale's rights, recovery |
| [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) | Threats, guarantees and residual risks |
| [docs/api.md](docs/api.md), [docs/admin-cli.md](docs/admin-cli.md) | Admin HTTP API and command line |
| [docs/testing.md](docs/testing.md) | Test suites and how to run them |
| [docs/upgrading-radicale.md](docs/upgrading-radicale.md) | Checking a new Radicale release |
| [CHANGELOG.md](CHANGELOG.md) | Changes |

## Intentional limits

- Sharing and accounts are changed by an administrator only; other users see who a collection is shared
  with but cannot change it
- Offline, the app is read-only: nothing is cached on the device besides the app itself
- No invitations or scheduling (iTIP): attendees are shown, not managed
- One proxy layout is supported for client addresses (nginx in front of Radicale and the backend); see
  [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)
- The admin backend listens on loopback only; there are no default credentials and no telemetry

## Links

- Issue tracker: https://github.com/Cosmekaili-creator/RadUI/issues
- Project home: https://github.com/Cosmekaili-creator/RadUI
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md); security reports: [SECURITY.md](SECURITY.md);
  conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Maintainer

Created and maintained by **[Majorum Network](https://www.majorum.net)**.

## Credits

- [Radicale](https://radicale.org/) by the Radicale developers (GPL-3.0), the CalDAV/CardDAV server RadUI
  is built for
- [ical.js](https://github.com/kewisch/ical.js) by Mozilla and contributors (MPL-2.0), vendored for
  iCalendar and vCard parsing
- [bcrypt](https://pypi.org/project/bcrypt/) (Apache-2.0) for password hashing in the admin backend
