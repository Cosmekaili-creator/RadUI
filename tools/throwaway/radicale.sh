#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Throwaway Radicale for development and tests: up | down | status | reset
#
# Runs as the CURRENT user on 127.0.0.1 with a temporary storage directory,
# generated config, generated test accounts (alice, bob, agent-1) and a
# from_file rights file. Random passwords go to $DIR/passwords (mode 600) and
# are never printed.
#
# Environment (defaults; .env.local KEY=value lines are read if unset):
#   RADICALE_BIN          radicale
#   RADUI_THROWAWAY_DIR   <repo>/.throwaway
#   RADUI_RADICALE_PORT   15232
#   RADUI_BCRYPT_COST     5
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

load_env_local() {
  local f="$REPO/.env.local" k v
  [ -f "$f" ] || return 0
  while IFS='=' read -r k v; do
    case "$k" in
      RADICALE_BIN|RADUI_THROWAWAY_DIR|RADUI_RADICALE_PORT|RADUI_BCRYPT_COST)
        v="${v%\"}"; v="${v#\"}"
        if [ -z "${!k:-}" ]; then export "$k=$v"; fi ;;
    esac
  done < <(grep -E '^[A-Z_]+=' "$f" || true)
}
load_env_local

RADICALE_BIN="${RADICALE_BIN:-radicale}"
PORT="${RADUI_RADICALE_PORT:-15232}"
COST="${RADUI_BCRYPT_COST:-5}"
DIR_RAW="${RADUI_THROWAWAY_DIR:-$REPO/.throwaway}"
case "$DIR_RAW" in /*) ;; *) DIR_RAW="$REPO/${DIR_RAW#./}" ;; esac
DIR="$(realpath -m "$DIR_RAW")"
MARKER="$DIR/.radui-throwaway"
PIDFILE="$DIR/radicale.pid"
CONF="$DIR/config"
LOG="$DIR/radicale.log"

die() { echo "radicale.sh: $*" >&2; exit 1; }

check_dir_safe() {
  case "$DIR" in
    /var/lib|/var/lib/*|/etc|/etc/*|/|/usr|/usr/*|/home|"$HOME") die "refusing storage dir $DIR" ;;
  esac
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -H -ltn "sport = :$PORT" 2>/dev/null)" ]
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
  fi
}

running_pid() {
  local pid
  [ -f "$PIDFILE" ] || return 1
  pid="$(cat "$PIDFILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  # only trust the pid if it still is the process we started
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$CONF" || return 1
  echo "$pid"
}

http_code() {
  curl -s -o /dev/null -m 3 -w '%{http_code}' -X PROPFIND "http://127.0.0.1:$PORT/" 2>/dev/null || true
}

pick_python() {
  local py bin
  bin="$(command -v "$RADICALE_BIN" 2>/dev/null || echo "$RADICALE_BIN")"
  for py in python3 "$(dirname "$bin")/python"; do
    if "$py" -c 'import bcrypt' >/dev/null 2>&1; then echo "$py"; return 0; fi
  done
  return 1
}

write_accounts() {
  local py
  py="$(pick_python)" || die "no python with the bcrypt module found"
  (
    umask 077
    DIR="$DIR" COST="$COST" "$py" - <<'PYEOF'
import bcrypt, os, secrets
d, cost = os.environ["DIR"], int(os.environ["COST"])
users, plain = [], []
for name in ("alice", "bob", "agent-1"):
    pw = secrets.token_urlsafe(18)
    h = bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=cost)).decode()
    users.append("%s:%s" % (name, h))
    plain.append("%s:%s" % (name, pw))
for fn, rows in (("users", users), ("passwords", plain)):
    path = os.path.join(d, fn)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write("\n".join(rows) + "\n")
PYEOF
  )
}

write_config() {
  mkdir -p "$DIR/collections"
  cat > "$DIR/rights" <<'RIGHTSEOF'
# Minimal neutral rights for the throwaway instance.
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
permissions: rw
RIGHTSEOF
  cat > "$CONF" <<CONFEOF
[server]
hosts = 127.0.0.1:$PORT

[auth]
type = htpasswd
htpasswd_filename = $DIR/users
htpasswd_encryption = bcrypt

[rights]
type = from_file
file = $DIR/rights

[storage]
filesystem_folder = $DIR/collections

[logging]
level = debug
CONFEOF
}

cmd_up() {
  local pid i code
  check_dir_safe
  if ! command -v "$RADICALE_BIN" >/dev/null 2>&1 && [ ! -x "$RADICALE_BIN" ]; then
    die "radicale binary not found (set RADICALE_BIN)"
  fi
  if running_pid >/dev/null; then die "already running (pid $(running_pid))"; fi
  if port_in_use; then die "port $PORT is already in use"; fi
  if [ -e "$DIR" ] && [ ! -f "$MARKER" ]; then die "$DIR exists and is not a throwaway dir"; fi
  mkdir -p "$DIR"; chmod 700 "$DIR"; : > "$MARKER"
  write_accounts
  write_config
  nohup "$RADICALE_BIN" --config "$CONF" </dev/null >"$LOG" 2>&1 &
  pid=$!
  echo "$pid" > "$PIDFILE"
  for i in $(seq 1 100); do
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 20 "$LOG" >&2
      die "radicale exited during startup"
    fi
    code="$(http_code)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      echo "throwaway radicale up on 127.0.0.1:$PORT (pid $pid)"
      return 0
    fi
    sleep 0.2
  done
  tail -n 20 "$LOG" >&2
  kill "$pid" 2>/dev/null || true
  die "radicale did not become ready within 20 s"
}

cmd_down() {
  local pid i
  check_dir_safe
  if pid="$(running_pid)"; then
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  if [ -f "$MARKER" ]; then
    rm -rf -- "$DIR"
  elif [ -e "$DIR" ]; then
    die "$DIR is not a throwaway dir (no marker); left untouched"
  fi
  echo "throwaway radicale down"
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then
    echo "running (pid $pid) on 127.0.0.1:$PORT"
  else
    echo "not running"
    return 1
  fi
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  reset) cmd_down; cmd_up ;;
  *) echo "usage: $0 up|down|status|reset" >&2; exit 2 ;;
esac
