#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run every server-side spike script once and print a PASS/FAIL summary.
#
# Usage: spike/server/run_all.sh [OUTPUT_DIR]
#
# Environment (all optional):
#   RADICALE_BIN               radicale executable (also read from .env.local)
#   RADUI_SPIKE_PORT           first throwaway port (default 15240)
#   RADUI_SNAPSHOT_DIR         directory holding an extracted copy of a real data set:
#                                collections-x/collections/collection-root, users, rights
#                              (enables the realistic-size part of S9 and the S15 inventory;
#                               keep it OUTSIDE the repository)
#   RADUI_S15_DETAIL           where S15 writes its detailed (name-bearing) report
#
# Everything runs on throwaway instances (current user, 127.0.0.1, git-ignored dirs).
# Each script is limited by `timeout` and runs at low CPU priority.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/../../.throwaway/spike-results}"
mkdir -p "$OUT"
PY="${PYTHON:-python3}"
SNAP="${RADUI_SNAPSHOT_DIR:-}"

if [ "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)" -lt 2000 ]; then
  echo "less than 2 GB of memory available: not starting" >&2
  exit 2
fi

run() {  # name, timeout, command...
  local name="$1" t="$2"; shift 2
  local log="$OUT/$name.log"
  nice -n 10 timeout "$t" "$@" >"$log" 2>&1
  local rc=$?
  local summary
  summary="$(grep -E '^== .*: [0-9]+ PASS, [0-9]+ FAIL ==' "$log" | tail -n 1)"
  [ -z "$summary" ] && summary="no summary line (exit status $rc)"
  printf '%-28s rc=%-3s %s\n' "$name" "$rc" "$summary"
  [ "$rc" -eq 0 ] || FAILED=1
}

FAILED=0
export RADUI_USERS_SAMPLE="${SNAP:+$SNAP/users}"
export RADUI_SNAPSHOT_COLLECTIONS="${SNAP:+$SNAP/collections-x/collections/collection-root}"
run s01_reload        300 "$PY" "$HERE/s01_reload.py"
run s02_malformed     600 "$PY" "$HERE/s02_malformed.py"
run s03_letters       600 "$PY" "$HERE/s03_letters.py"
run s04_discovery     300 "$PY" "$HERE/s04_discovery.py"
run s05_probe         300 "$PY" "$HERE/s05_probe.py"
run s06_bcrypt        300 "$PY" "$HERE/s06_bcrypt.py"
run s07_users_reread  300 "$PY" "$HERE/s07_users_reread.py"
run s08_concurrency   600 "$PY" "$HERE/s08_concurrency.py"
run s09_restart       400 "$PY" "$HERE/s09_restart.py"
run s14_canonical     200 "$PY" "$HERE/s14_canonical.py"
run s17_sync          200 "$PY" "$HERE/s17_sync.py"
run s18_latency       400 "$PY" "$HERE/s18_latency.py"
if [ -n "$SNAP" ]; then
  args=(--collections "$SNAP/collections-x/collections/collection-root" --rights "$SNAP/rights" --users "$SNAP/users")
  [ -n "${RADUI_S15_DETAIL:-}" ] && args+=(--detail "$RADUI_S15_DETAIL")
  run s15_inventory   120 "$PY" "$HERE/s15_inventory.py" "${args[@]}"
fi
echo "logs in $OUT"
exit "$FAILED"
