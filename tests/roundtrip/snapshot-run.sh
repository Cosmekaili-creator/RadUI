#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run the round-trip checks over a local snapshot of real collections.
#
#   snapshot-run.sh          extract the snapshot into a private temp dir, start a throwaway
#                            Radicale on that COPY, run snapshot-run.mjs, clean everything
#   snapshot-run.sh pii      extract, run tools/pii-check.py --snapshot on the extracted data,
#                            clean (a one-off proof that no real value leaked into the repository)
#   snapshot-run.sh pii-summary
#                            same, but print only counts: e-mail hits, phone hits, hits of words taken
#                            from name-bearing properties (N, FN, ORG, NICKNAME, CN) per top-level directory
#                            (the plain deny-list also holds ordinary vocabulary and is noisy);
#                            RT_PII_WHERE=<path prefix> also lists file:line of the hits there
#
# Environment:
#   RADUI_LOCAL_DIR      private directory OUTSIDE the repository (default: <repo>/../Radicale-UI-local)
#   RADUI_SNAPSHOT_TAR   collections tar (default: $RADUI_LOCAL_DIR/snapshot/collections.tar), read-only
#   RADUI_RT_REPORT      detailed report (default: $RADUI_LOCAL_DIR/roundtrip-report.md, mode 600)
#   RADUI_SNAPSHOT_PORT  throwaway port (default 15301; within 15300-15309)
#   RADICALE_BIN         radicale executable (default: radicale, or .env.local)
#   RT_LIMIT, RT_WORKERS see snapshot-run.mjs
#
# The console shows aggregates only. The extracted copy lives in a mode-700 directory
# under RADUI_LOCAL_DIR and is deleted on exit (also on interruption).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
if [ -z "${RADICALE_BIN:-}" ] && [ -f "$REPO/.env.local" ]; then
  RADICALE_BIN="$(grep -E '^RADICALE_BIN=' "$REPO/.env.local" | head -n1 | cut -d= -f2- | tr -d '"' || true)"
fi
RADICALE_BIN="${RADICALE_BIN:-radicale}"
LOCAL="${RADUI_LOCAL_DIR:-$REPO/../Radicale-UI-local}"
TAR="${RADUI_SNAPSHOT_TAR:-$LOCAL/snapshot/collections.tar}"
REPORT="${RADUI_RT_REPORT:-$LOCAL/roundtrip-report.md}"
PORT="${RADUI_SNAPSHOT_PORT:-15301}"
MODE="${1:-run}"

die() { echo "snapshot-run.sh: $*" >&2; exit 1; }
case "$PORT" in 1530[0-9]) ;; *) die "port $PORT outside 15300-15309" ;; esac
[ -d "$LOCAL" ] || die "private directory $LOCAL not found (set RADUI_LOCAL_DIR)"
[ -f "$TAR" ] || die "snapshot tar not found"
avail="$(free -m | awk '/^Mem:/ {print $7}')"
[ "${avail:-0}" -ge 2048 ] || die "less than 2 GB memory available ($avail MB)"

umask 077
TMP="$(mktemp -d "$LOCAL/rt-run-XXXXXX")"
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
  echo "snapshot-run: temporary copy removed"
}
trap cleanup EXIT INT TERM

tar -xf "$TAR" -C "$TMP" --no-same-owner
chmod -R go-rwx "$TMP"
COLL="$(find "$TMP" -maxdepth 3 -name collection-root -type d | head -n1)"
[ -n "$COLL" ] || die "no collection-root in the snapshot"
STORE="$(dirname "$COLL")"

if [ "$MODE" = "pii" ]; then
  python3 "$REPO/tools/pii-check.py" --snapshot "$COLL"
  exit $?
fi
if [ "$MODE" = "pii-summary" ]; then
  COLL="$COLL" REPO="$REPO" RT_PII_WHERE="${RT_PII_WHERE:-}" python3 -I - <<'PYEOF'
import importlib.util, os, re, sys
repo = os.environ["REPO"]
sys.path.insert(0, os.path.join(repo, "tools"))
spec = importlib.util.spec_from_file_location("piic", os.path.join(repo, "tools", "pii-check.py"))
pii = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pii)
import _treefiles
words, emails, phones = pii.build_denylist(os.environ["COLL"])
names = set()
for dp, _, fns in os.walk(os.environ["COLL"]):
    for fn in fns:
        if not fn.lower().endswith((".ics", ".vcf")):
            continue
        t = pii.unfold(open(os.path.join(dp, fn), "rb").read().decode("utf-8", "replace"))
        for ln in t.splitlines():
            head, sep, val = ln.partition(":")
            prop = head.split(";", 1)[0].split(".")[-1].upper()
            blob = ""
            if prop in ("N", "FN", "ORG", "NICKNAME"):
                blob = val
            for m in re.finditer(r'CN=("[^"]*"|[^;:]*)', head):
                blob += " " + m.group(1)
            for w in pii.WORD_RE.findall(blob.replace("\\,", ",")):
                if w.lower() not in pii.STOPLIST:
                    names.add(w.lower())
print("deny-list: %d words (%d from name-bearing properties), %d e-mails, %d phones" % (len(words), len(names), len(emails), len(phones)))
counts = {}
for rel in _treefiles.list_files(repo):
    if rel in pii.SELF_FILES or "vendor" in rel.split("/")[:-1]:
        continue
    p = os.path.join(repo, rel)
    if _treefiles.is_binary(p):
        continue
    text = _treefiles.read_text(p)
    top = "/".join(rel.split("/")[:2]) if rel.startswith("tests/") else rel.split("/")[0]
    c = counts.setdefault(top, [0, 0, 0])
    for n, line in enumerate(text.splitlines(), 1):
        low = line.lower()
        if any(e in low for e in emails):
            c[0] += 1
        if phones and any(d in phones for d in pii.phones_in(line)):
            c[1] += 1
        if set(pii.WORD_RE.findall(low)) & names:
            c[2] += 1
            if os.environ.get("RT_PII_WHERE") and rel.startswith(os.environ["RT_PII_WHERE"]):
                print("  where: %s:%d" % (rel, n))
print("hits per top-level path as [email, phone, name-word lines]:")
for k in sorted(counts):
    if any(counts[k]):
        print("  %s: %s" % (k, counts[k]))
print("total email hits %d, phone hits %d, name-word lines %d" % tuple(sum(v[i] for v in counts.values()) for i in range(3)))
PYEOF
  exit 0
fi
[ "$MODE" = "run" ] || die "usage: $0 [run|pii|pii-summary]"

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
filesystem_folder = $STORE

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
RT_SNAPSHOT_ROOT="$COLL" RT_REPORT="$REPORT" RT_TMP="$TMP" \
RADUI_TEST_RADICALE="http://127.0.0.1:$PORT" RADUI_TEST_PASSWORDS_FILE="$TMP/passwords" \
  timeout 3000 node "$HERE/snapshot-run.mjs"
rc=$?
set -e
exit $rc
