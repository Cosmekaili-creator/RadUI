# Throwaway Radicale

`radicale.sh up|down|status|reset` starts a disposable Radicale for development and tests.

- Runs as the current user, bound to `127.0.0.1` only. No root, no system paths.
- Everything lives in one directory (default `.throwaway/` in the repository, git-ignored):
  generated `config`, `users` (bcrypt hashes), `rights` (type `from_file`), `collections/`,
  `radicale.log` (level `debug`), `radicale.pid`.
- Test accounts: `alice`, `bob`, `agent-1`. Random passwords are written to `passwords` in the
  throwaway directory (mode 600) and are never printed.
- `up` refuses to run if the port is in use, if Radicale is already running from this
  directory, or if the directory is under `/var/lib` or `/etc`.
- `down` stops only the process it started (the pid is checked against the config path) and
  removes the directory (only if it carries the marker file the script created).

Configuration (environment, or `KEY=value` lines in a git-ignored `.env.local` at the
repository root; the environment wins):

| Variable | Default | Meaning |
|---|---|---|
| `RADICALE_BIN` | `radicale` | Radicale executable |
| `RADUI_THROWAWAY_DIR` | `./.throwaway` | state directory (relative paths are relative to the repository) |
| `RADUI_RADICALE_PORT` | `15232` | listen port on 127.0.0.1 |
| `RADUI_BCRYPT_COST` | `5` | bcrypt rounds for the test accounts (low on purpose) |

Needs Python 3 with the `bcrypt` module (the script also tries the Python next to
`RADICALE_BIN`).

Check:

```
make throwaway-up
curl -s -o /dev/null -w '%{http_code}' -X PROPFIND http://127.0.0.1:15232/   # 401
make throwaway-down
```
