# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
intends to follow [Semantic Versioning](https://semver.org/) once it has a first release. The
project is pre-alpha: nothing below has been released.

## [Unreleased]

### Added

- Admin backend (`backend/radui_admin`): account and grant model, generator for Radicale's
  `users` and `rights` files, expected-access oracle, lockout rules, password policy, legacy
  importer with an equivalence report, atomic file writing with generations, validation with
  Radicale's own engine, activation probe, HTTP API with CSRF and request checks, rate limiting,
  audit log and the `radui-admin-cli` command line.
- Radicale rights plugin (`backend/plugin/radui_rights.py`) that checks and hot-reloads the
  generated rights file, with a last-known-good fallback.
- Web app core (`src/`): router, i18n loader (English and French), authentication store and
  login, read-only diagnostics page, `config.json` loading; DAV layer (XML, HTTP client,
  discovery, sync) and data model (content-line tokenizer, writer, item views, owned-property
  registries, fidelity guard).
- Deployment templates and procedures (`deploy/`): nginx, systemd, tmpfiles, fail2ban and
  Radicale snippets rendered from variables; cutover, recovery and rollback guides.
- Tooling and tests: SPDX, hard-coded-value and PII checks; unit, integration, security,
  plugin, round-trip, deployment and end-to-end suites; round-trip corpus tooling.
- Documentation (`docs/`): security model, administration, API, rights model, data model, DAV
  layer, testing and Radicale upgrade notes.
- Contacts and collections screens (run 2): contact list, search, A-Z, group filter, contact form
  that preserves unknown fields, photos, groups, `.vcf` import with preview and report, `.vcf` and
  `.ics` export, collection create/edit/delete, a three-way conflict dialog, and a write path that
  verifies what the server stored. Read-only grantees and offline mode disable writes with a reason.
- Installable app: web manifest, service worker with a SHA-256 file list (`sw-manifest.js`, generated
  by `tools/build-sw-manifest.py`), cache-first navigation, update banner and a stale-tab write gate.
- `tools/deploy-static.sh`: dry-run-by-default deployment of the static app (backup, assets then
  `js/` then `sw-manifest.js`, `sw.js` and `index.html` last, optional prune, `config.json` kept,
  post-copy hash verification, rollback command), with tests.
- `deploy/sw-selfdestruct.js`: a worker that deletes the app caches, unregisters itself and reloads open pages,
  for recovery and for rolling back the first deploy of the service worker (`tools/deploy-static.sh` detects a
  previous deployment without `sw.js` and prints the extra rollback steps).
- Documentation: `docs/UPGRADE-UI.md` (deploying and rolling back a new app version), `docs/user-guide.md`.
- nginx template: `location = <UI>/sw-manifest.js` with `Cache-Control: no-cache`.
- Publication files: `LICENSE` (AGPL-3.0-or-later), `THIRD-PARTY-NOTICES.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates (placeholders to be
  completed before publication).

### Changed

- Restore keeps tombstones and current password hashes authoritative and requires a typed
  confirmation; a trusted proxy list controls which peers may supply the client address; a
  backend self-heal timer repairs a stale rights file; non-admin grant changes no longer reveal
  whether a login exists. See [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

### Security

- Security model, threats and residual risks are documented in
  [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
