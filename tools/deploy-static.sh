#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Deploy the static web app (the contents of src/) into the directory your web server serves, in the
# order the service worker needs, with a backup first and a hash check afterwards.
#
#   tools/deploy-static.sh --dest DIR [--src DIR] [--init] [--prune] [--tag TAG]        dry run (default)
#   tools/deploy-static.sh --dest DIR --backup-dir DIR [...] --apply                    do it
#
# --src DIR          the app tree (default: <repository>/src). It is never written to. Normally the output of
#                    `make dist` (tools/build-dist.py): --src dist. A tree without build-info.json is deployed
#                    too, with a notice (it is just bigger).
# --dest DIR         the served directory (required; absolute or relative). Must already exist unless --init.
#                    Refused: an empty value, "/", a top-level system directory, your home directory, and a
#                    directory that contains or lies inside --src.
# --init             first installation: create --dest when it does not exist.
# --backup-dir DIR   where the backup goes (required with --apply; must exist and lie outside --dest).
#                    Name: <basename of dest>.before-<tag>-<YYYYMMDD>.tar.gz, mode 600, never overwritten.
# --tag TAG          backup name tag (default: ui-deploy). Use another tag for a second deploy on the same day.
# --prune            also delete files in dest that are not part of the app (default: off). config.json is
#                    never deleted.
# --keep-config      never overwrite an existing config.json in dest (this is the default and cannot be
#                    switched off; the first installation copies the shipped config.json).
# --allow-dirty      deploy a build whose build-info.json "source" ends in "-dirty" (built from a working tree with
#                    uncommitted changes). Without it the dry run prints a WARNING and --apply is refused: commit,
#                    then `make dist`, then deploy, so the deployed tree can be traced to a commit.
# --apply            act. Without it the script only reports what it would do and changes nothing.
# -h, --help         this text.
#
# What it does: (1) builds sw-manifest.js into a temporary copy of the source tree with
# tools/build-sw-manifest.py (the source tree is not touched); (2) lists the files to deploy with the
# same exclusions as the generator and stops if the two lists differ; (3) backs up the current dest;
# (4) copies the assets, then js/, then LAST sw-manifest.js, sw.js and index.html (so a worker can never
# find a manifest that lists files that are not there yet); (5) optionally prunes; (6) checks that
# every SHA-256 of the manifest matches the file now in dest and prints the exact rollback command.
# When the previous deployment had no sw.js (the first deploy of a worker), a plain restore would leave
# the new sw.js and sw-manifest.js in place and clients that installed the worker would keep serving the
# new app: the printed rollback then also removes sw-manifest.js and installs deploy/sw-selfdestruct.js
# as sw.js (the self-removing worker; keep it served no-cache for a day or more, then remove it).
# Idempotent: a second run reports "unchanged" and makes no backup. It never calls sudo: run it with
# the rights the dest directory needs.
#
# Environment (tests): RADUI_DEPLOY_DATE overrides the date of the backup name; RADUI_DEPLOY_TRACE=1
# prints one "TRACE copy <path>" line per copied file, in order; RADUI_DEPLOY_TEST_TAMPER=<path> corrupts
# that file after copying, to exercise the verification (never set it in real use).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/src"
DEST=""
BACKUP_DIR=""
TAG="ui-deploy"
APPLY=0
ALLOW_DIRTY=0
INIT=0
PRUNE=0
DATE="${RADUI_DEPLOY_DATE:-$(date +%Y%m%d)}"
STAGE=""
WORK=""
MAN=""
LATE=(sw-manifest.js sw.js index.html)

die() { echo "deploy-static: $*" >&2; exit 2; }
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
usage() { sed -n '4,/^set -e/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }
cleanup() { if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf -- "$WORK"; fi; return 0; }
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --src) [ $# -ge 2 ] || die "--src needs a directory"; SRC="$2"; shift ;;
    --dest) [ $# -ge 2 ] || die "--dest needs a directory"; DEST="$2"; shift ;;
    --backup-dir) [ $# -ge 2 ] || die "--backup-dir needs a directory"; BACKUP_DIR="$2"; shift ;;
    --tag) [ $# -ge 2 ] || die "--tag needs a value"; TAG="$2"; shift ;;
    --keep-config) ;;
    --init) INIT=1 ;;
    --prune) PRUNE=1 ;;
    --apply) APPLY=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

# ---- arguments and safety checks -------------------------------------------------------------
[ -n "$DEST" ] || { usage >&2; die "--dest is required"; }
[ -n "${DEST//[[:space:]]/}" ] || die "--dest is empty"
[[ "$TAG" =~ ^[A-Za-z0-9._-]+$ ]] || die "--tag may only contain letters, digits, . _ -"
[[ "$DATE" =~ ^[0-9]{8}$ ]] || die "bad date: $DATE"
command -v python3 >/dev/null || die "python3 is needed"
command -v sha256sum >/dev/null || die "sha256sum is needed"
command -v realpath >/dev/null || die "realpath is needed"

[ -d "$SRC" ] || die "--src is not a directory: $SRC"
SRC="$(realpath -e -- "$SRC")"
[ -f "$SRC/index.html" ] || die "$SRC has no index.html (wrong --src?)"
[ -f "$SRC/sw.js" ] || die "$SRC has no sw.js (wrong --src?)"

DEST="$(realpath -m -- "$DEST")"
case "$DEST" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib32|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/var/www|/var/lib|/var/log)
    die "refusing to deploy into $DEST (a system directory)" ;;
esac
[ "$DEST" != "$(realpath -m -- "${HOME:-/nonexistent-home}")" ] || die "refusing to deploy into the home directory"
case "$DEST/" in "$SRC"/*) die "--dest lies inside --src" ;; esac
case "$SRC/" in "$DEST"/*) die "--dest contains --src" ;; esac

if [ -e "$DEST" ] && [ ! -d "$DEST" ]; then die "--dest exists and is not a directory: $DEST"; fi
if [ ! -d "$DEST" ] && [ "$INIT" -ne 1 ]; then
  die "--dest does not exist: $DEST (first installation? add --init)"
fi
DEST_EXISTS=0; [ -d "$DEST" ] && DEST_EXISTS=1

if [ -n "$BACKUP_DIR" ]; then
  BACKUP_DIR="$(realpath -m -- "$BACKUP_DIR")"
  case "$BACKUP_DIR/" in "$DEST"/*) die "--backup-dir lies inside --dest" ;; esac
fi
if [ "$APPLY" -eq 1 ]; then
  [ -n "$BACKUP_DIR" ] || die "--backup-dir is required with --apply"
  [ -d "$BACKUP_DIR" ] || die "--backup-dir does not exist: $BACKUP_DIR"
  [ -w "$BACKUP_DIR" ] || die "--backup-dir is not writable: $BACKUP_DIR"
  if [ "$DEST_EXISTS" -eq 1 ]; then
    [ -w "$DEST" ] || die "$DEST is not writable by this user (run the script with the rights it needs)"
  else
    PARENT="$(dirname -- "$DEST")"
    [ -d "$PARENT" ] && [ -w "$PARENT" ] || die "cannot create $DEST: $PARENT is missing or not writable"
  fi
fi
BACKUP=""
if [ -n "$BACKUP_DIR" ]; then
  BACKUP="$BACKUP_DIR/$(basename -- "$DEST").before-$TAG-$DATE.tar.gz"
fi

say "deploy-static: $([ "$APPLY" -eq 1 ] && echo APPLY || echo 'DRY RUN (nothing is changed; add --apply)')"
say "  source:      $SRC"
say "  destination: $DEST$([ "$DEST_EXISTS" -eq 0 ] && echo ' (does not exist yet)')"
if [ -f "$SRC/build-info.json" ]; then
  say "  build:       $(tr -d '\n' <"$SRC/build-info.json" | tr -s ' ')"
  BUILD_SOURCE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("source") or "")' "$SRC/build-info.json" 2>/dev/null || true)"
  if [[ "$BUILD_SOURCE" == *-dirty ]]; then
    say "  WARNING:     this build was made from a working tree with uncommitted changes (source \"$BUILD_SOURCE\"): it cannot be traced to a commit."
    say "               Commit, then 'make dist', then deploy. --apply is refused unless you pass --allow-dirty."
    [ "$APPLY" -ne 1 ] || [ "$ALLOW_DIRTY" -eq 1 ] || die "refusing --apply: the build is dirty (commit, then make dist, then deploy; or pass --allow-dirty)"
  fi
else
  say "  notice:      $SRC has no build-info.json: this is not a build (readable, unminified sources, both languages as part files)."
  say "               For a production deployment run 'make dist' and deploy with --src dist (docs/pwa.md, Build)."
fi

# ---- the exclusion rules: the same as tools/build-sw-manifest.py (excluded()) -----------------
excluded() {
  local rel="$1" name="${1##*/}"
  case "$rel" in sw.js|sw-manifest.js|package.json) return 0 ;; esac
  case "$name" in .gitkeep|README.md) return 0 ;; esac
  if [ "$name" = SHA256SUMS ] && [ "${rel%%/*}" = vendor ]; then return 0; fi
  return 1
}

# ---- 1. staging copy and the generated file list ----------------------------------------------
step "Build sw-manifest.js in a temporary copy of the source"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/radui-deploy.XXXXXX")"
STAGE="$WORK/app"
MAN="$WORK/manifest.lines"
mkdir -- "$STAGE"
cp -R -- "$SRC/." "$STAGE/"
rm -f -- "$STAGE/sw-manifest.js"
python3 "$REPO/tools/build-sw-manifest.py" --src "$STAGE" --out "$STAGE/sw-manifest.js"
[ -f "$STAGE/sw-manifest.js" ] || die "the manifest was not generated"

# sw-manifest.js -> lines "<sha256 or '-'>TAB<path>"
manifest_lines() {
  python3 - "$1" <<'PY'
import json, sys
text = open(sys.argv[1], encoding="utf-8").read()
data = json.loads(text[text.index("Object.freeze(") + len("Object.freeze("):text.rindex(")")])
for f in data["files"]:
    sys.stdout.write("%s\t%s\n" % (f["sha256"] or "-", f["path"]))
PY
}

mapfile -d '' -t ALL < <(cd "$STAGE" && find . -type f -printf '%P\0' | LC_ALL=C sort -z)
APP=()
for rel in "${ALL[@]}"; do
  [[ "$rel" != *$'\n'* && "$rel" != *$'\t'* && "$rel" != *$'\r'* ]] || die "unsupported file name in the source tree: $rel"
  excluded "$rel" || APP+=("$rel")
done
[ "${#APP[@]}" -gt 0 ] || die "no files to deploy"

# the generator must list exactly these files; otherwise the worker install would fail on every client
manifest_lines "$STAGE/sw-manifest.js" >"$MAN"
if ! diff -u <(printf '%s\n' "${APP[@]}" | LC_ALL=C sort) <(cut -f2- "$MAN" | LC_ALL=C sort) >/dev/null; then
  die "the file list of this script differs from the one of tools/build-sw-manifest.py (fix the exclusion rules in both)"
fi
say "  $((${#APP[@]})) files in the manifest, plus sw-manifest.js and sw.js"

# deploy order: assets (everything outside js/), then js/, then the three entry files LAST
PHASE1=(); PHASE2=()
for rel in "${APP[@]}"; do
  case "$rel" in index.html) continue ;; esac
  case "$rel" in js/*) PHASE2+=("$rel") ;; *) PHASE1+=("$rel") ;; esac
done

# ---- 2. what would change ---------------------------------------------------------------------
NEW=0; CHANGED=0; SAME=0; KEPT_CONFIG=0
declare -A ACTION
plan_one() {
  local rel="$1" dst="$DEST/$1"
  if [ "$rel" = config.json ] && [ -e "$dst" ]; then ACTION[$rel]=kept; KEPT_CONFIG=1; return; fi
  if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then ACTION[$rel]=new; NEW=$((NEW+1))
  elif [ -f "$dst" ] && cmp -s -- "$STAGE/$rel" "$dst"; then ACTION[$rel]=unchanged; SAME=$((SAME+1))
  else ACTION[$rel]=changed; CHANGED=$((CHANGED+1)); fi
}
for rel in "${PHASE1[@]}" "${PHASE2[@]}" "${LATE[@]}"; do plan_one "$rel"; done

PRUNE_LIST=()
if [ "$DEST_EXISTS" -eq 1 ]; then
  declare -A KEEP=()
  for rel in "${APP[@]}" sw.js sw-manifest.js; do KEEP[$rel]=1; done
  KEEP[config.json]=1
  while IFS= read -r -d '' rel; do
    [ -n "${KEEP[$rel]:-}" ] || PRUNE_LIST+=("$rel")
  done < <(cd "$DEST" && find . \( -type f -o -type l \) -printf '%P\0' | LC_ALL=C sort -z)
fi

step "Plan"
for rel in "${PHASE1[@]}" "${PHASE2[@]}" "${LATE[@]}"; do
  [ "${ACTION[$rel]}" = unchanged ] || printf '  %-9s %s\n' "${ACTION[$rel]}" "$rel"
done
say "  new: $NEW   changed: $CHANGED   unchanged: $SAME   config.json: $([ "$KEPT_CONFIG" -eq 1 ] && echo 'kept (existing)' || echo 'shipped copy (first installation)')"
if [ "${#PRUNE_LIST[@]}" -gt 0 ]; then
  if [ "$PRUNE" -eq 1 ]; then say "  files to delete (--prune): ${#PRUNE_LIST[@]}"; printf '    %s\n' "${PRUNE_LIST[@]}"
  else say "  files in dest that are not part of the app: ${#PRUNE_LIST[@]} (kept; add --prune to delete them)"; printf '    %s\n' "${PRUNE_LIST[@]}"; fi
fi
TO_DO=$((NEW + CHANGED))
[ "$PRUNE" -eq 1 ] && TO_DO=$((TO_DO + ${#PRUNE_LIST[@]}))

if [ "$TO_DO" -eq 0 ]; then
  step "Result"
  say "unchanged: $DEST already matches this version. Nothing to do."
  exit 0
fi

# ---- 3. backup --------------------------------------------------------------------------------
HAVE_BACKUP=0
NEED_BACKUP=0
if [ "$DEST_EXISTS" -eq 1 ] && [ -n "$(find "$DEST" -mindepth 1 -print -quit)" ]; then NEED_BACKUP=1; fi
step "Backup"
if [ "$NEED_BACKUP" -eq 0 ]; then
  say "  nothing to back up (destination missing or empty)"
elif [ -z "$BACKUP" ]; then
  say "  would back up $DEST (pass --backup-dir to see the file name)"
else
  if [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; then
    die "backup already exists: $BACKUP (never overwritten; use --tag for another name)"
  fi
  say "  $BACKUP (mode 600)"
fi

if [ "$APPLY" -ne 1 ]; then
  step "Result"
  say "dry run: $NEW new, $CHANGED changed$([ "$PRUNE" -eq 1 ] && echo ", ${#PRUNE_LIST[@]} to delete"). Nothing was changed. Add --apply to deploy."
  exit 0
fi

if [ "$NEED_BACKUP" -eq 1 ]; then
  TMPB="$BACKUP.partial.$$"
  ( umask 077; tar -czf "$TMPB" -C "$(dirname -- "$DEST")" -- "$(basename -- "$DEST")" ) || { rm -f -- "$TMPB"; die "backup failed"; }
  chmod 600 -- "$TMPB"
  mv -n -- "$TMPB" "$BACKUP"
  [ ! -e "$TMPB" ] || { rm -f -- "$TMPB"; die "backup already exists: $BACKUP"; }
  tar -tzf "$BACKUP" >/dev/null || die "the backup does not read back: $BACKUP"
  HAVE_BACKUP=1
  say "  written: $BACKUP"
fi

# The rollback, as printed lines. The first line is always the restore of the backup.
SELFDESTRUCT="$REPO/deploy/sw-selfdestruct.js"
ROLLBACK_LINES=()
NO_PREVIOUS_SW=0
if [ "$HAVE_BACKUP" -eq 1 ]; then
  ROLLBACK_LINES+=("tar -xzf '$BACKUP' -C '$(dirname -- "$DEST")'")
  if [ ! -e "$DEST/sw.js" ] && [ ! -L "$DEST/sw.js" ]; then
    # the previous deployment had no service worker: a restore alone leaves the new worker in place
    NO_PREVIOUS_SW=1
    ROLLBACK_LINES+=("rm -f '$DEST/sw-manifest.js'")
    ROLLBACK_LINES+=("install -m 0644 '$SELFDESTRUCT' '$DEST/sw.js'")
  fi
fi
print_rollback() {
  local prefix="$1" first=1 line
  for line in "${ROLLBACK_LINES[@]}"; do
    if [ "$first" -eq 1 ]; then printf '%s%s\n' "$prefix" "$line"; first=0
    else printf '%*s%s\n' "${#prefix}" "" "$line"; fi
  done
  if [ "$NO_PREVIOUS_SW" -eq 1 ]; then
    printf '%*s%s\n' "${#prefix}" "" "(the backup has no sw.js: without the last two commands, browsers that installed the new worker keep serving the new app."
    printf '%*s%s\n' "${#prefix}" "" " sw-selfdestruct.js makes them delete their cache, unregister and reload. Keep it served with Cache-Control: no-cache"
    printf '%*s%s\n' "${#prefix}" "" " for at least a day (longer for devices rarely opened), then delete sw.js. See docs/UPGRADE-UI.md.)"
  fi
}

# ---- 4. copy ----------------------------------------------------------------------------------
step "Copy (assets, then js/, then sw-manifest.js, sw.js, index.html last)"
[ "$DEST_EXISTS" -eq 1 ] || { ( umask 022; mkdir -p -- "$DEST" ); say "  created $DEST"; }
COPIED=0
copy_one() {
  local rel="$1" dst="$DEST/$1" tmp
  case "${ACTION[$rel]}" in unchanged|kept) return 0 ;; esac
  ( umask 022; mkdir -p -- "$(dirname -- "$dst")" )
  tmp="$dst.radui-tmp.$$"
  install -m 0644 -- "$STAGE/$rel" "$tmp" || { rm -f -- "$tmp"; die "copy failed: $rel"; }
  mv -f -- "$tmp" "$dst" || { rm -f -- "$tmp"; die "copy failed: $rel"; }
  if [ -n "${RADUI_DEPLOY_TEST_TAMPER:-}" ] && [ "$RADUI_DEPLOY_TEST_TAMPER" = "$rel" ]; then printf 'x' >>"$dst"; fi
  COPIED=$((COPIED+1))
  if [ "${RADUI_DEPLOY_TRACE:-}" = 1 ]; then printf 'TRACE copy %s\n' "$rel"; fi
}
for rel in "${PHASE1[@]}" "${PHASE2[@]}" "${LATE[@]}"; do copy_one "$rel"; done
say "  copied $COPIED file(s)"

# ---- 5. prune ---------------------------------------------------------------------------------
PRUNED=0
if [ "$PRUNE" -eq 1 ] && [ "${#PRUNE_LIST[@]}" -gt 0 ]; then
  step "Prune"
  for rel in "${PRUNE_LIST[@]}"; do
    [ "$rel" != config.json ] || continue
    rm -f -- "$DEST/$rel"; PRUNED=$((PRUNED+1)); say "  deleted $rel"
  done
  find "$DEST" -mindepth 1 -type d -empty -delete
fi

# ---- 6. verify --------------------------------------------------------------------------------
step "Verify (every manifest hash against the file in dest)"
BAD=()
while IFS=$'\t' read -r want rel; do
  if [ "$want" = "-" ]; then
    [ -f "$DEST/$rel" ] || BAD+=("$rel (missing)")
    continue
  fi
  if [ ! -f "$DEST/$rel" ]; then BAD+=("$rel (missing)"); continue; fi
  got="$(sha256sum -- "$DEST/$rel" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || BAD+=("$rel (hash mismatch)")
done <"$MAN"
for rel in sw.js sw-manifest.js; do
  cmp -s -- "$STAGE/$rel" "$DEST/$rel" || BAD+=("$rel (differs from the built copy)")
done
if [ "${#BAD[@]}" -gt 0 ]; then
  {
    echo
    echo "deploy-static: VERIFICATION FAILED. Service workers would refuse this tree. Problems:"
    printf '  %s\n' "${BAD[@]}"
    if [ "${#ROLLBACK_LINES[@]}" -gt 0 ]; then
      echo "Roll back now with:"
      print_rollback "  "
    else
      echo "There was no previous deployment to roll back to; fix the destination or deploy again."
    fi
  } >&2
  exit 3
fi
say "  all ${#APP[@]} manifest entries and sw.js, sw-manifest.js verified"

# ---- 7. summary -------------------------------------------------------------------------------
step "Done"
say "  copied: $COPIED   unchanged: $SAME   deleted: $PRUNED   config.json: $([ "$KEPT_CONFIG" -eq 1 ] && echo kept || echo 'shipped copy installed')"
if [ "${#ROLLBACK_LINES[@]}" -gt 0 ]; then
  say "  backup:   $BACKUP"
  print_rollback "  rollback: "
  say "            (other files that did not exist before the deploy stay; delete them, or deploy the old version, for an exact copy)"
else
  say "  no previous deployment: nothing to restore. Clients that installed the new worker would keep it if you remove the"
  say "  tree: install '$SELFDESTRUCT' as sw.js instead (docs/UPGRADE-UI.md)."
fi
say "Next: check the headers of sw-manifest.js (see docs/UPGRADE-UI.md), then open the app and watch for the update banner."
