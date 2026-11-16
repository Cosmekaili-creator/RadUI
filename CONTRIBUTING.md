# Contributing

RadUI is pre-alpha. Bug reports, feedback and small, focused pull requests are welcome. For anything
larger, please open an issue first so we can agree on the approach before you spend time on it.

## Ground rules

- Licence: AGPL-3.0-or-later; every source file carries
  `SPDX-License-Identifier: AGPL-3.0-or-later` in its first lines (`make lint-licence`).
  By sending a change you agree to license it under the same terms.
- English for code, comments, documentation and commit messages.
- No deployment-specific values (hosts, addresses, e-mail addresses, personal names, home
  paths) and no real personal data in code, tests, fixtures or docs. Use `example.org`,
  `alice`, `bob`, `agent-1`. `make test` runs the checks that enforce this.
- Say so in the pull request if a change was written with an AI assistant. You are still responsible for it
  and for having run the tests.

## Development setup

You need Python 3.11+ (3.13 is the tested one), Node 20+ and, for the integration and browser tests, a
`radicale` binary (3.x; developed against 3.9), `bcrypt` for Python and nginx. The repository has no
`node_modules`: the app is plain ES modules and needs no build to run from `src/`.

```
make test              # unit tests (Python, Node) and the repository checks
make throwaway-up      # throwaway Radicale on 127.0.0.1:15232, current user, no system service touched
make throwaway-down
make dist              # minified build into the git-ignored dist/ (python3 and node)
make size              # first-screen size budget (250 KB gzip per screen)
```

Machine-specific settings (for example the path of the `radicale` binary) go in a git-ignored
`.env.local`; see the top of the `Makefile`. Integration, security, deploy and browser (Playwright)
tests, their ports and the resource rules are in `docs/testing.md`. Do not run two of them at once.

## Code style

- Plain JavaScript ES modules, no framework and no runtime dependency; the only vendored library is
  `ical.js` (read-only use). Python uses the standard library plus `bcrypt`.
- All data goes through the single write path in `src/js/store/`; read `docs/store.md` and
  `docs/data-model.md` before changing it. Fields the app does not understand must be written back
  untouched.
- Every user-visible string goes in both `src/i18n/en*.js` and `src/i18n/fr*.js`.
- Add or update tests with the change (`tests/unit-js/`, `backend/tests/`, `tests/e2e/`).

## Pull requests

1. Branch from `main`, keep the change small and on one topic.
2. Run `make test`; run the relevant integration or `E2E_SUITE` target when you touch that area.
3. Describe what changed and why, and how you checked it. Screenshots help for UI changes.

Review is by the maintainer, best effort. Security problems go through the private channel in
`SECURITY.md`, not a public issue.
