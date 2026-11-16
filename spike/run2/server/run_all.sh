#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run every Run 2 server spike once (throwaway stacks only: loopback ports
# 15400-15409, directories under .throwaway/run2) and print a verdict table.
#
# Usage: spike/run2/server/run_all.sh [OUTPUT_DIR]
#
#   OUTPUT_DIR   where the per-spike logs go (default <repo>/.throwaway/run2-logs)
#   RADICALE_BIN radicale executable (also read from .env.local)
#
# One stack at a time, each script limited by `timeout` and run at low CPU
# priority. FAIL lines are findings that contradict an assumption (see
# results.md); the exit status is 1 when any script printed a FAIL.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/../../../.throwaway/run2-logs}"
mkdir -p "$OUT"
PY="${PYTHON:-python3}"

if [ "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)" -lt 2000 ]; then
  echo "less than 2 GB of memory available: not starting" >&2
  exit 2
fi

ANY_FAIL=0
for spec in s2_01_collection_get:300 s2_02_groups:300 s2_03_fidelity:400 \
            s2_04_etag:300 s2_05_collections:300 s2_06_put_shapes:300 \
            s2_07_sync:300 s2_09_concurrency:300 s2_10_large_book:600; do
  name="${spec%%:*}"; limit="${spec##*:}"
  nice -n 10 timeout "$limit" "$PY" "$HERE/$name.py" >"$OUT/$name.log" 2>&1
  rc=$?
  summary="$(grep -E '^== .*: [0-9]+ PASS, [0-9]+ FAIL, [0-9]+ INFO ==' "$OUT/$name.log" | tail -n 1)"
  [ -z "$summary" ] && summary="no summary line (exit status $rc)"
  printf '%-24s rc=%-3s %s\n' "$name" "$rc" "$summary"
  if [ "$rc" -ne 0 ]; then ANY_FAIL=1; fi
done
echo "logs in $OUT"
exit "$ANY_FAIL"
