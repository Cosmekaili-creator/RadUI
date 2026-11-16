#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Round-trip harness runner (Makefile-independent).
#
#   run.sh            start a throwaway Radicale, run the harness, tear down
#   run.sh offline    run only the tests that need no server
#   run.sh up|down    start / stop the throwaway instance only
#
# Throwaway only: current user, 127.0.0.1, temporary directory carrying a marker
# file, never a system path. One account (alice) with a random password written
# to <dir>/passwords (mode 600, never printed) owns its collections.
#
# Environment (all optional):
#   RADICALE_BIN         radicale executable (default: radicale, or .env.local)
#   RADUI_RT_PORT        listen port (default 15300; must be within 15300-15309)
#   RADUI_RT_DIR         state directory (default <repo>/.throwaway/roundtrip-<port>)
#   RADUI_BCRYPT_COST    bcrypt rounds for the test account (default 4)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

if [ -z "${RADICALE_BIN:-}" ] && [ -f "$REPO/.env.local" ]; then
  RADICALE_BIN="$(grep -E '^RADICALE_BIN=' "$REPO/.env.local" | head -n1 | cut -d= -f2- | tr -d '"' || true)"
fi
RADICALE_BIN="${RADICALE_BIN:-radicale}"
PORT="${RADUI_RT_PORT:-15300}"
COST="${RADUI_BCRYPT_COST:-4}"
DIR="$(realpath -m "${RADUI_RT_DIR:-$REPO/.throwaway/roundtrip-$PORT}")"
MARKER="$DIR/.radui-throwaway"
PIDFILE="$DIR/radicale.pid"
CONF="$DIR/config"

die() { echo "run.sh: $*" >&2; exit 1; }

case "$PORT" in
  1530[0-9]) ;;
  *) die "port $PORT outside the throwaway range 15300-15309" ;;
esac
case "$DIR" in
  /|/var/lib|/var/lib/*|/etc|/etc/*|/usr|/usr/*|/home|"$HOME") die "refusing state dir $DIR" ;;
esac

running_pid() {
  local pid
  [ -f "$PIDFILE" ] || return 1
  pid="$(cat "$PIDFILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$CONF" || return 1
  echo "$pid"
}

pick_python() {
  local py bin
  bin="$(command -v "$RADICALE_BIN" 2>/dev/null || echo "$RADICALE_BIN")"
  for py in python3 "$(dirname "$bin")/python"; do
    if "$py" -c 'import bcrypt' >/dev/null 2>&1; then echo "$py"; return 0; fi
  done
  return 1
}

write_account() {
  local py
  py="$(pick_python)" || die "no python with the bcrypt module found"
  DIR="$DIR" COST="$COST" "$py" - <<'PYEOF'
import bcrypt, os, secrets
d, cost = os.environ["DIR"], int(os.environ["COST"])
pw = secrets.token_urlsafe(18)
h = bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=cost)).decode()
for fn, row in (("users", "alice:" + h), ("passwords", "alice:" + pw)):
    fd = os.open(os.path.join(d, fn), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(row + "\n")
PYEOF
}

write_config() {
  mkdir -p "$DIR/collections"
  cat > "$DIR/rights" <<'RIGHTSEOF'
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
  cat > "$CONF" <<CONFEOF
[server]
hosts = 127.0.0.1:$PORT

[auth]
type = htpasswd
htpasswd_filename = $DIR/users
htpasswd_encryption = bcrypt
delay = 0

[rights]
type = from_file
file = $DIR/rights

[storage]
filesystem_folder = $DIR/collections

[logging]
level = warning
CONFEOF
}

cmd_up() {
  local pid i code avail
  avail="$(free -m | awk '/^Mem:/ {print $7}')"
  [ "${avail:-0}" -ge 2048 ] || die "less than 2 GB memory available ($avail MB)"
  command -v "$RADICALE_BIN" >/dev/null 2>&1 || [ -x "$RADICALE_BIN" ] || die "radicale binary not found (set RADICALE_BIN)"
  if running_pid >/dev/null; then die "already running (pid $(running_pid))"; fi
  if [ -e "$DIR" ] && [ ! -f "$MARKER" ]; then die "$DIR exists and is not a throwaway dir"; fi
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then die "port $PORT is in use"; fi
  rm -rf -- "$DIR"
  (umask 077; mkdir -p "$DIR"; : > "$MARKER"; write_account)
  write_config
  nohup "$RADICALE_BIN" --config "$CONF" </dev/null >"$DIR/radicale.log" 2>&1 &
  pid=$!
  echo "$pid" > "$PIDFILE"
  for i in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || { tail -n 20 "$DIR/radicale.log" >&2; die "radicale exited during startup"; }
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' -X PROPFIND "http://127.0.0.1:$PORT/" 2>/dev/null || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      echo "throwaway radicale up on 127.0.0.1:$PORT (pid $pid)"
      echo "export RADUI_TEST_RADICALE=http://127.0.0.1:$PORT"
      echo "export RADUI_TEST_PASSWORDS_FILE=$DIR/passwords"
      return 0
    fi
    sleep 0.2
  done
  kill "$pid" 2>/dev/null || true
  die "radicale did not become ready within 20 s"
}

cmd_down() {
  local pid i
  if pid="$(running_pid)"; then
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  if [ -f "$MARKER" ]; then rm -rf -- "$DIR"; fi
  echo "throwaway radicale down"
}

case "${1:-test}" in
  up) cmd_up ;;
  down) cmd_down ;;
  offline)
    cd "$REPO"
    env -u RADUI_TEST_RADICALE -u RADUI_TEST_PASSWORDS_FILE timeout 300 node --test tests/roundtrip/*.test.mjs
    ;;
  test)
    trap cmd_down EXIT
    cmd_up >/dev/null
    export RADUI_TEST_RADICALE="http://127.0.0.1:$PORT"
    export RADUI_TEST_PASSWORDS_FILE="$DIR/passwords"
    cd "$REPO"
    timeout 900 node --test tests/roundtrip/*.test.mjs
    ;;
  *) echo "usage: $0 [test|offline|up|down]" >&2; exit 2 ;;
esac
