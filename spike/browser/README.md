# Browser-side spikes (S10, S11, S12)

Throwaway experiments for RadUI run 1, work package 2. Nothing here ships. Results and
conclusions are in `REPORT.md`; raw outputs are in `results/`.

## Layout

| Path | Purpose |
|---|---|
| `env.sh` | `up` / `down` / `status`: throwaway Radicale (15240), backend stub (18081), unprivileged nginx (18080), all as the current user in `$RADUI_BROWSER_RUN` |
| `stub_backend.py` | stdlib stub of the admin backend (401 with and without `WWW-Authenticate`, header echo, upload counter) |
| `nginx.conf.in` | nginx config template (placeholders `@NAME@`, rendered by `env.sh`) |
| `ui-stub/` | static files served under `/ui/` (module script, stylesheet, manifest, service-worker file, CSP positive control, S12 page) |
| `fixtures/` | synthetic vCard 3.0/4.0 and iCalendar samples (fictional data, `example.org`) |
| `s12-icaljs.mjs` | S12 in Node: parse and re-serialise report for the vendored ical.js |
| `s12-probe.mjs` | DOM-free probe shared by Node and Chromium (parity check) |
| `s10-auth.mjs` | S10: native auth prompt, storage, DAV methods from `fetch` |
| `s11-nginx.mjs` | S11: nginx routing, headers, X-Forwarded-For, body limits, CSP, S12 parity in Chromium |
| `lib.mjs` | shared helpers (Playwright loader, memory guard, account file reader) |

## Prerequisites

- Node 20, Python 3 with `bcrypt` (used by `tools/throwaway/radicale.sh`), `radicale`, `nginx`.
- Playwright is **not** installed in the repository. Install it once, pinned, into a directory
  outside the tree (the version is also recorded in `tests/e2e/package.json`):

```
mkdir -p "$PW_DIR" && cd "$PW_DIR" && npm init -y
npm install --save-exact @playwright/test@1.65.0 playwright@1.65.0
PLAYWRIGHT_BROWSERS_PATH="$PW_DIR/browsers" npx playwright install chromium
```

## Running

Resource rules: one Chromium at a time, check `free -m` first (stop below 2000 MB available),
use the capped wrapper and a timeout, kill everything at the end.

```
export RADUI_BROWSER_RUN=<scratch dir outside the repo>   # created and removed by env.sh
export NGINX_BIN=<path of the nginx binary, if not in PATH>
spike/browser/env.sh up

node spike/browser/s12-icaljs.mjs > spike/browser/results/s12-node-output.txt

sudo -n systemd-run --scope --quiet --uid="$(id -un)" --gid="$(id -gn)" \
  -p MemoryMax=2G -p MemorySwapMax=0 -- timeout 600 \
  env RADUI_PW_DIR="$PW_DIR" PLAYWRIGHT_BROWSERS_PATH="$PW_DIR/browsers" RADUI_BROWSER_RUN="$RADUI_BROWSER_RUN" \
  node spike/browser/s10-auth.mjs > spike/browser/results/s10-results.json
# same wrapper for s11-nginx.mjs > results/s11-results.json

spike/browser/env.sh down
```

`RADUI_BROWSER_STOCK_MIME=1 env.sh up` renders nginx without the extra MIME types, to show what
the stock `mime.types` does to `.mjs` and `.webmanifest` files.

Inside Chromium the neutral host name `example.org` is mapped to `127.0.0.1` with
`--host-resolver-rules`, and the origin is treated as a secure context (as `https` would be in
production). No real host name appears anywhere. Passwords of the throwaway accounts are read
from the throwaway directory and are never printed or stored in the results.
