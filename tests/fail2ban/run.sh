#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Tests for deploy/fail2ban/radui-radicale-auth.conf. Runs as a normal user, reads no live log,
# changes nothing outside a temporary directory:
#   1. fail2ban-regex (the real command) on a log file in Radicale's "verbose" format built from
#      samples/cases.tsv, comparing the extracted addresses with the expected ones;
#   2. journal_flow.py: the same cases through fail2ban's systemd-journal line formatter.
# Includes the injection cases: a login that contains "(forwarded for '203.0.113.9')" must never
# yield that address.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
FILTER="$REPO/deploy/fail2ban/radui-radicale-auth.conf"
CASES="$HERE/samples/cases.tsv"
command -v fail2ban-regex >/dev/null || { echo "fail2ban-regex not found: skipping" >&2; exit 77; }
TMP="$(mktemp -d "${TMPDIR:-/tmp}/radui-f2b.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# 1. verbose file format: "[<timestamp>] " + the journal message
n=0
: > "$TMP/verbose.log"
: > "$TMP/expected.txt"
while IFS=$'\t' read -r expected desc msg; do
  case "$expected" in "#"*|"") continue ;; esac
  n=$((n + 1))
  printf '[2026-11-12 10:00:%02d +0000] %s\n' "$((n % 60))" "$msg" >> "$TMP/verbose.log"
  if [ "$expected" != "-" ]; then echo "$expected" >> "$TMP/expected.txt"; fi
done < "$CASES"

timeout 60 fail2ban-regex -o ip "$TMP/verbose.log" "$FILTER" > "$TMP/got.txt"
if diff -u "$TMP/expected.txt" "$TMP/got.txt"; then
  echo "PASS  fail2ban-regex on the verbose log: $(wc -l < "$TMP/got.txt") addresses, all as expected ($n lines)"
else
  echo "FAIL  fail2ban-regex on the verbose log" >&2; exit 1
fi
if grep -q '203\.0\.113\.9' "$TMP/got.txt"; then
  echo "FAIL  the attacker-chosen address was extracted" >&2; exit 1
fi
echo "PASS  the attacker-chosen address 203.0.113.9 was never extracted"

# 2. systemd journal flow
timeout 60 python3 -I "$HERE/journal_flow.py" "$CASES" "$FILTER"

# 3. the documented override of the trusted proxy address (jail option) works
mkdir -p "$TMP/conf/filter.d"
cp "$FILTER" "$TMP/conf/filter.d/"
printf '%s\n' \
  "[2026-11-12 10:00:04 +0000] [4242/Thread-7 (process_request_thread)] [WARNING] Failed login attempt from 192.0.2.50 (forwarded for '198.51.100.9'): 'alice' (htpasswd)" \
  "[2026-11-12 10:00:05 +0000] [4242/Thread-7 (process_request_thread)] [WARNING] Failed login attempt from 127.0.0.1 (forwarded for '198.51.100.8'): 'alice' (htpasswd)" \
  > "$TMP/override.log"
got="$(timeout 60 fail2ban-regex -c "$TMP/conf" -o ip "$TMP/override.log" 'radui-radicale-auth[_trusted_proxy="192\.0\.2\.50"]')"
if [ "$got" = "198.51.100.9" ]; then echo "PASS  _trusted_proxy override: only the configured proxy address is trusted"
else echo "FAIL  _trusted_proxy override (got: $got)" >&2; exit 1; fi

# 4. negative control: the unanchored filter first proposed for this jail IS fooled by the same
#    cases, so the injection cases above really test something.
cat > "$TMP/naive.conf" <<'NAIVE'
[Definition]
failregex = Failed login attempt from .* \(forwarded for '<ADDR>'\)
NAIVE
timeout 60 fail2ban-regex -o ip "$TMP/verbose.log" "$TMP/naive.conf" > "$TMP/naive.out"
if grep -q '203\.0\.113\.9' "$TMP/naive.out"; then
  echo "PASS  negative control: the naive filter extracts the attacker-chosen address, ours does not"
else
  echo "FAIL  negative control: the naive filter was not fooled, the injection cases are too weak" >&2; exit 1
fi
