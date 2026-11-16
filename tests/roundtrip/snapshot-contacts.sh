#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Contact-editing safety replay (snapshot-contacts.mjs) over a local COPY of a real address book.
#
#   snapshot-contacts.sh     copy the data directory into a private temp dir, start a throwaway Radicale on the
#                            copy, run the replay, remove everything
#
# Environment:
#   RADUI_GSNAP_ROOT     REQUIRED. The data directory: a collection-root tree <owner>/<book>/<card files>
#                        (read only; it is copied first and never modified)
#   RADUI_LOCAL_DIR      private directory OUTSIDE the repository (default: <repo>/../Radicale-UI-local)
#   RADUI_GSNAP_REPORT   detailed report (default: $RADUI_LOCAL_DIR/gsnap-report.md, mode 600)
#   RADUI_GSNAP_PORT     throwaway port (default 15460; within 15460-15469)
#   RADICALE_BIN         radicale executable (default: radicale, or .env.local)
#   GS_LIMIT             see snapshot-contacts.mjs
#
# The console shows aggregates only. The working copy lives in a mode-700 directory under RADUI_LOCAL_DIR and is
# deleted on exit (also on interruption).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
if [ -z "${RADICALE_BIN:-}" ] && [ -f "$REPO/.env.local" ]; then
  RADICALE_BIN="$(grep -E '^RADICALE_BIN=' "$REPO/.env.local" | head -n1 | cut -d= -f2- | tr -d '"' || true)"
fi
RADICALE_BIN="${RADICALE_BIN:-radicale}"
LOCAL="${RADUI_LOCAL_DIR:-$REPO/../Radicale-UI-local}"
SRC="${RADUI_GSNAP_ROOT:-}"
REPORT="${RADUI_GSNAP_REPORT:-$LOCAL/gsnap-report.md}"
PORT="${RADUI_GSNAP_PORT:-15460}"

die() { echo "snapshot-contacts.sh: $*" >&2; exit 1; }
case "$PORT" in 1546[0-9]) ;; *) die "port $PORT outside 15460-15469" ;; esac
[ -n "$SRC" ] || die "set RADUI_GSNAP_ROOT to the data directory"
[ -d "$SRC" ] || die "data directory not found"
[ -d "$LOCAL" ] || die "private directory $LOCAL not found (set RADUI_LOCAL_DIR)"
case "$(realpath "$SRC")" in "$(realpath "$REPO")"|"$(realpath "$REPO")"/*) die "the data directory must be outside the repository" ;; esac
avail="$(free -m | awk '/^Mem:/ {print $7}')"
[ "${avail:-0}" -ge 2048 ] || die "less than 2 GB memory available ($avail MB)"

umask 077
TMP="$(mktemp -d "$LOCAL/gs-run-XXXXXX")"
chmod 700 "$TMP"
PIDFILE="$TMP/radicale.pid"
cleanup() {
  local pid
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$TMP/config"; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -rf -- "$TMP"
  echo "snapshot-contacts: temporary copy removed"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP/store"
cp -a "$SRC" "$TMP/store/collection-root"
chmod -R go-rwx "$TMP"
find "$TMP/store" -name '.Radicale.cache' -prune -exec rm -rf {} +
COLL="$TMP/store/collection-root"

pick_python() {
  local py bin
  bin="$(command -v "$RADICALE_BIN" 2>/dev/null || echo "$RADICALE_BIN")"
  for py in python3 "$(dirname "$bin")/python"; do
    if "$py" -c 'import bcrypt' >/dev/null 2>&1; then echo "$py"; return 0; fi
  done
  return 1
}
PY="$(pick_python)" || die "no python with the bcrypt module found"
# one throwaway account per owner directory (names stay in the temp dir), random passwords, low bcrypt cost
COLL="$COLL" TMP="$TMP" "$PY" - <<'PYEOF'
import bcrypt, os, secrets
users, plain = [], []
for name in sorted(os.listdir(os.environ["COLL"])):
    if name.startswith(".") or ":" in name or not os.path.isdir(os.path.join(os.environ["COLL"], name)):
        continue
    pw = secrets.token_urlsafe(18)
    users.append("%s:%s" % (name, bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=4)).decode()))
    plain.append("%s:%s" % (name, pw))
for fn, rows in (("users", users), ("passwords", plain)):
    fd = os.open(os.path.join(os.environ["TMP"], fn), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write("\n".join(rows) + "\n")
PYEOF
cat > "$TMP/rights" <<'RIGHTSEOF'
[root]
user: .+
collection:
permissions: R

[principal]
user: .+
collection: {user}
permissions: RW

[own-collections]
user: .+
collection: {user}/[^/]+
permissions: rwDO
RIGHTSEOF
cat > "$TMP/config" <<CONFEOF
[server]
hosts = 127.0.0.1:$PORT

[auth]
type = htpasswd
htpasswd_filename = $TMP/users
htpasswd_encryption = bcrypt
delay = 0

[rights]
type = from_file
file = $TMP/rights

[storage]
filesystem_folder = $TMP/store

[logging]
level = warning
CONFEOF
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then die "port $PORT is in use"; fi
nohup "$RADICALE_BIN" --config "$TMP/config" </dev/null >"$TMP/radicale.log" 2>&1 &
echo $! > "$PIDFILE"
for i in $(seq 1 100); do
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || die "radicale exited during startup"
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' -X PROPFIND "http://127.0.0.1:$PORT/" 2>/dev/null || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then break; fi
  sleep 0.2
done

set +e
GS_ROOT="$COLL" GS_REPORT="$REPORT" \
RADUI_TEST_RADICALE="http://127.0.0.1:$PORT" RADUI_TEST_PASSWORDS_FILE="$TMP/passwords" \
  timeout 1500 node "$HERE/snapshot-contacts.mjs"
rc=$?
set -e
exit $rc
