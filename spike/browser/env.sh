#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Throwaway environment for the browser spikes: Radicale + backend stub + unprivileged nginx.
#   env.sh up | down | status
# Everything runs as the current user on 127.0.0.1; nothing is installed or written outside
# $RADUI_BROWSER_RUN. Ports: Radicale 15240, stub 18081, nginx 18080 (override via env).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RUN="${RADUI_BROWSER_RUN:-${TMPDIR:-/tmp}/radui-browser-spike}"
RADICALE_PORT="${RADUI_BROWSER_RADICALE_PORT:-15240}"
STUB_PORT="${RADUI_BROWSER_STUB_PORT:-18081}"
NGINX_PORT="${RADUI_BROWSER_NGINX_PORT:-18080}"
NGINX_BIN="${NGINX_BIN:-nginx}"
MIME_TYPES="${NGINX_MIME_TYPES:-/etc/nginx/mime.types}"
MARKER="$RUN/.radui-browser-spike"
die() { echo "env.sh: $*" >&2; exit 1; }

case "$RUN" in /etc/*|/var/lib/*|/|/home|/tmp) die "unsafe run dir: $RUN";; esac

radicale() {
  RADUI_THROWAWAY_DIR="$RUN/radicale" RADUI_RADICALE_PORT="$RADICALE_PORT" "$REPO/tools/throwaway/radicale.sh" "$@"
}

pid_ok() {  # pid file + a string that must appear in /proc/<pid>/cmdline
  local f="$1" needle="$2" pid
  [ -f "$f" ] || return 1
  pid="$(cat "$f")"; [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$needle" || return 1
  echo "$pid"
}

cmd_up() {
  [ -e "$RUN" ] && [ ! -f "$MARKER" ] && die "$RUN exists and is not a spike dir"
  mkdir -p "$RUN"; chmod 700 "$RUN"; : > "$MARKER"
  radicale up
  # stub backend
  python3 -I "$HERE/stub_backend.py" --port "$STUB_PORT" --credentials "$RUN/radicale/passwords" \
    --log "$RUN/stub.log" </dev/null >"$RUN/stub.out" 2>&1 &
  echo $! > "$RUN/stub.pid"
  # static files for /ui/
  mkdir -p "$RUN/www/ui/fixtures" "$RUN/nginx/tmp"
  cp "$HERE"/ui-stub/* "$RUN/www/ui/"
  cp "$HERE/s12-probe.mjs" "$RUN/www/ui/"
  cp "$HERE"/fixtures/* "$RUN/www/ui/fixtures/"
  cp "$REPO"/src/vendor/ical.js/2.2.1/ical.min.js "$RUN/www/ui/"
  # nginx
  sed -e "s|@RUN@|$RUN/nginx|g" -e "s|@WWW@|$RUN/www|g" -e "s|@NGINX_PORT@|$NGINX_PORT|g" \
      -e "s|@RADICALE_PORT@|$RADICALE_PORT|g" -e "s|@STUB_PORT@|$STUB_PORT|g" \
      -e "s|@MIME_TYPES@|$MIME_TYPES|g" "$HERE/nginx.conf.in" > "$RUN/nginx/nginx.conf"
  # RADUI_BROWSER_STOCK_MIME=1 renders the config without the extra mime types (for comparison)
  if [ "${RADUI_BROWSER_STOCK_MIME:-0}" = 1 ]; then sed -i '/#extra-types$/d' "$RUN/nginx/nginx.conf"; fi
  "$NGINX_BIN" -t -c "$RUN/nginx/nginx.conf" -p "$RUN/nginx/" -e "$RUN/nginx/error.log"
  "$NGINX_BIN" -c "$RUN/nginx/nginx.conf" -p "$RUN/nginx/" -e "$RUN/nginx/error.log"
  for _ in $(seq 1 50); do
    curl -s -o /dev/null -m 2 "http://127.0.0.1:$NGINX_PORT/ui/api/health" && break; sleep 0.2
  done
  echo "up: radicale $RADICALE_PORT, stub $STUB_PORT, nginx $NGINX_PORT (run dir $RUN)"
}

cmd_down() {
  local pid
  if [ -f "$RUN/nginx/nginx.pid" ] && pid="$(pid_ok "$RUN/nginx/nginx.pid" "$RUN/nginx/nginx.conf")"; then
    kill -QUIT "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  fi
  if pid="$(pid_ok "$RUN/stub.pid" "stub_backend.py")"; then kill "$pid" 2>/dev/null || true; fi
  [ -d "$RUN/radicale" ] && radicale down || true
  if [ -f "$MARKER" ]; then rm -rf -- "$RUN"; fi
  echo "down"
}

cmd_status() {
  pid_ok "$RUN/nginx/nginx.pid" "$RUN/nginx/nginx.conf" >/dev/null && echo "nginx: running" || echo "nginx: stopped"
  pid_ok "$RUN/stub.pid" "stub_backend.py" >/dev/null && echo "stub: running" || echo "stub: stopped"
  radicale status || true
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
