#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Install the RadUI admin backend on a host (steps H1 and H2 of deploy/CUTOVER.md): system user
# and group, directories, backend code, the Radicale rights plugin file, the backend
# configuration and the systemd unit. It does NOT touch Radicale, nginx or fail2ban, does not
# enable or start the service, and only PRINTS the Radicale configuration snippet and drop-in.
#
#   deploy/install-backend.sh [--vars FILE] [--root DIR] [--replace-config]          dry run (default)
#   deploy/install-backend.sh [--vars FILE] [--root DIR] [--replace-config] --apply  do it
#
# --vars FILE        variables (default: deploy.local/vars.env, copy deploy/vars.example.env).
#                    The script refuses to run without it and without every variable it needs.
# --apply            act. Without it the script only prints what it would do.
# --root DIR         staging root: every path is placed below DIR and no user, group, ownership,
#                    systemd or tmpfiles change is made (used by the tests; also useful to look at
#                    the result before a real run).
# --replace-config   replace an existing config.toml that differs from the rendered one (the
#                    default keeps it and shows the difference).
#
# Idempotent: a second run reports "unchanged". Before anything existing is replaced, a copy is
# made as <ARCHIVE_DIR>/<thing>.before-radui-<YYYYMMDD> (mode 600, directories as a tar file);
# an existing backup is never overwritten. RADUI_INSTALL_DATE overrides the date (tests).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY=0
VARS_FILE="$REPO/deploy.local/vars.env"
ROOT=""
REPLACE_CONFIG=0
DATE="${RADUI_INSTALL_DATE:-$(date +%Y%m%d)}"
CHANGES=0
STAGE=""

die() { echo "install-backend: $*" >&2; exit 2; }
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
usage() { sed -n '4,/^set -e/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --vars) [ $# -ge 2 ] || die "--vars needs a file"; VARS_FILE="$2"; shift ;;
    --root) [ $# -ge 2 ] || die "--root needs a directory"; ROOT="${2%/}"; shift ;;
    --replace-config) REPLACE_CONFIG=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

# ---- variables -------------------------------------------------------------------------------
[ -f "$VARS_FILE" ] || die "variables file not found: $VARS_FILE (copy deploy/vars.example.env to deploy.local/vars.env and edit it)"

declare -A V
while IFS= read -r line || [ -n "$line" ]; do
  [[ -z "${line//[[:space:]]/}" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" == *=* ]] || die "$VARS_FILE: not a KEY=VALUE line: $line"
  key="${line%%=*}"; val="${line#*=}"
  key="${key//[[:space:]]/}"
  val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
  if [ "${#val}" -ge 2 ] && { [ "${val:0:1}" = '"' ] || [ "${val:0:1}" = "'" ]; } && [ "${val: -1}" = "${val:0:1}" ]; then
    val="${val:1:${#val}-2}"
  fi
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "$VARS_FILE: bad variable name: $key"
  [[ "$val" =~ ^[A-Za-z0-9\ ._/:,%+=~-]*$ ]] || die "$VARS_FILE: $key has a character that is not allowed"
  V[$key]="$val"
done < "$VARS_FILE"

MISSING=""
for k in RADUI_USER RADUI_GROUP RADICALE_GROUP CONFIG_DIR MANAGED_DIR STATE_DIR INSTALL_DIR PLUGIN_DIR BIN_DIR ARCHIVE_DIR; do
  [ -n "${V[$k]:-}" ] || MISSING="$MISSING $k"
done
[ -z "$MISSING" ] || die "variables not set in $VARS_FILE:$MISSING"
for k in CONFIG_DIR MANAGED_DIR STATE_DIR INSTALL_DIR PLUGIN_DIR BIN_DIR ARCHIVE_DIR; do
  v="${V[$k]}"
  [[ "$v" == /* ]] || die "$k must be an absolute path: $v"
  case "${v%/}" in
    ""|/etc|/var|/opt|/usr|/home|/root|/bin|/sbin|/lib|/boot|/run|/tmp|/srv|/var/lib|/var/backups|/usr/local|/usr/bin|/usr/sbin)
      die "$k is a system directory, refusing: $v" ;;
  esac
done

if [ -n "$ROOT" ]; then
  [[ "$ROOT" == /* ]] || die "--root must be an absolute path"
  case "$ROOT" in /etc*|/var*|/opt*|/usr*) die "--root must not be a system directory: $ROOT" ;; esac
fi
if [ "$APPLY" = 1 ] && [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then
  die "--apply on a real host needs root (or use --root DIR for a staging copy)"
fi

# ---- helpers ---------------------------------------------------------------------------------
hp() { printf '%s%s' "$ROOT" "$1"; }            # host path (below --root when given)
real_host() { [ -z "$ROOT" ]; }                  # users, ownership, systemd only on a real host
doit() {                                         # doit "description": print it, true when applying
  CHANGES=$((CHANGES + 1))
  if [ "$APPLY" = 1 ]; then say "  doing:  $*"; return 0; fi
  say "  would:  $*"; return 1
}
own() { if real_host; then chown "$@"; fi; }          # ownership only on a real host

ARCHIVE="$(hp "${V[ARCHIVE_DIR]}")"
ARCHIVE_READY=0
ensure_archive() {
  [ "$ARCHIVE_READY" = 1 ] && return 0
  if [ -d "$ARCHIVE" ]; then
    ARCHIVE_READY=1; return 0
  fi
  if doit "create the archive directory ${V[ARCHIVE_DIR]} (mode 700)"; then install -d -m 0700 "$ARCHIVE"; fi
  ARCHIVE_READY=1
}

# backup <existing path on host> <thing>: copy to <archive>/<thing>.before-radui-<date>, mode 600,
# never overwriting a backup that exists.
backup() {
  local src="$1" thing="$2" dst
  dst="$ARCHIVE/$thing.before-radui-$DATE"
  if [ -e "$dst" ]; then
    say "  backup already exists, kept (not overwritten): ${dst#"$ROOT"}"
    return 0
  fi
  ensure_archive
  if [ -d "$src" ] && [ ! -L "$src" ]; then
    if doit "back up the directory ${src#"$ROOT"} to ${dst#"$ROOT"}.tar (mode 600)"; then
      ( umask 077; tar -C "$(dirname "$src")" -cf "$dst.tar" "$(basename "$src")" )
      chmod 600 "$dst.tar"
    fi
  else
    if doit "back up ${src#"$ROOT"} to ${dst#"$ROOT"} (mode 600)"; then
      install -m 0600 -T "$src" "$dst"
    fi
  fi
}

# install_file <source> <destination path> <mode> <owner:group> <thing>
install_file() {
  local src="$1" dst="$2" mode="$3" own="$4" thing="$5" hdst cur
  hdst="$(hp "$dst")"
  if [ -L "$hdst" ]; then die "$dst is a symbolic link; refusing to replace it"; fi
  if [ -e "$hdst" ]; then
    if cmp -s "$src" "$hdst"; then
      cur="$(stat -c %a "$hdst")"
      if [ "$cur" != "${mode#0}" ] && [ "$cur" != "$mode" ]; then
        if doit "set mode $mode on $dst (now $cur)"; then chmod "$mode" "$hdst"; fi
      else
        say "  unchanged: $dst"
      fi
      return 0
    fi
    backup "$hdst" "$thing"
    if doit "replace $dst (mode $mode, owner $own)"; then
      install -d -m 0755 "$(dirname "$hdst")"
      install -m "$mode" -T "$src" "$hdst.radui-new"
      own "$own" "$hdst.radui-new"
      mv -f "$hdst.radui-new" "$hdst"
    fi
  else
    if doit "create $dst (mode $mode, owner $own)"; then
      install -d -m 0755 "$(dirname "$hdst")"
      install -m "$mode" -T "$src" "$hdst.radui-new"
      own "$own" "$hdst.radui-new"
      mv -f "$hdst.radui-new" "$hdst"
    fi
  fi
  return 0
}

cleanup() { [ -n "$STAGE" ] && rm -rf -- "$STAGE"; return 0; }
trap cleanup EXIT

# ---- render ----------------------------------------------------------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/radui-install.XXXXXX")"
python3 -I "$REPO/tools/render-deploy.py" --vars "$VARS_FILE" --out "$STAGE/rendered" > /dev/null \
  || die "the templates do not render with $VARS_FILE (see the message above)"
R="$STAGE/rendered"

# staged code with the permissions it will have (root-owned, read-only)
mkdir -p "$STAGE/code/backend"
cp -a "$REPO/backend/radui_admin" "$STAGE/code/backend/radui_admin"
cp -a "$REPO/backend/bin" "$STAGE/code/backend/bin"
find "$STAGE/code" -name __pycache__ -type d -prune -exec rm -rf {} +
find "$STAGE/code" -type d -exec chmod 0755 {} +
find "$STAGE/code" -type f -exec chmod 0644 {} +
chmod 0755 "$STAGE/code/backend/bin/"*

say "RadUI backend install: $([ "$APPLY" = 1 ] && echo APPLY || echo 'DRY RUN, nothing will be changed')"
say "variables: $VARS_FILE"
say "root: ${ROOT:-/ (the real host)}"
say "date stamp for backups: $DATE"

# ---- 1. user and group -----------------------------------------------------------------------
step "1. System user and group"
if real_host; then
  if getent group "${V[RADUI_GROUP]}" > /dev/null; then say "  exists: group ${V[RADUI_GROUP]}"
  elif doit "groupadd --system ${V[RADUI_GROUP]}"; then groupadd --system "${V[RADUI_GROUP]}"; fi
  if getent passwd "${V[RADUI_USER]}" > /dev/null; then say "  exists: user ${V[RADUI_USER]}"
  elif doit "useradd --system --gid ${V[RADUI_GROUP]} --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${V[RADUI_USER]}"; then
    useradd --system --gid "${V[RADUI_GROUP]}" --no-create-home --home-dir /nonexistent \
      --shell "$(command -v nologin || echo /usr/sbin/nologin)" "${V[RADUI_USER]}"
  fi
  if getent group "${V[RADICALE_GROUP]}" > /dev/null; then say "  exists: Radicale group ${V[RADICALE_GROUP]} (it is NOT given to ${V[RADUI_USER]}; the managed files get it through the setgid directory)"
  else die "the Radicale group ${V[RADICALE_GROUP]} does not exist on this host; set RADICALE_GROUP"; fi
else
  say "  skip:   user ${V[RADUI_USER]}, group ${V[RADUI_GROUP]} (staging root: no account change)"
fi

# ---- 2. directories --------------------------------------------------------------------------
step "2. Directories (tmpfiles.d)"
install_file "$R/tmpfiles/radui.conf" /etc/tmpfiles.d/radui.conf 0644 root:root radui-tmpfiles.conf
say "  directories declared by that file:"
while read -r typ path mode usr grp _; do
  [ "$typ" = d ] || continue
  hpath="$(hp "$path")"
  if [ -d "$hpath" ]; then
    cur="$(stat -c '%a %U:%G' "$hpath")"
    say "    $path  want $mode $usr:$grp  now $cur"
  else
    say "    $path  want $mode $usr:$grp  (missing)"
  fi
  if ! real_host; then
    if [ ! -d "$hpath" ]; then
      if doit "mkdir $path (mode $mode)"; then install -d "$hpath"; chmod "$mode" "$hpath"; fi
    else
      cur="$(stat -c %a "$hpath")"
      if [ "$cur" != "${mode#0}" ]; then
        if doit "chmod $mode $path (now $cur)"; then chmod "$mode" "$hpath"; fi
      fi
    fi
  fi
done < <(grep -E '^d ' "$R/tmpfiles/radui.conf")
if real_host; then
  if doit "systemd-tmpfiles --create /etc/tmpfiles.d/radui.conf (creates missing directories, corrects mode and owner)"; then
    systemd-tmpfiles --create /etc/tmpfiles.d/radui.conf
  fi
fi

# ---- 3. backend code -------------------------------------------------------------------------
step "3. Backend code in ${V[INSTALL_DIR]}/backend (root-owned, read-only)"
CODE_DST="$(hp "${V[INSTALL_DIR]}/backend")"
if [ -d "$CODE_DST" ]; then
  if diff -rq "$STAGE/code/backend" "$CODE_DST" > /dev/null 2>&1; then
    say "  unchanged: ${V[INSTALL_DIR]}/backend"
  else
    say "  differences found:"
    diff -rq "$STAGE/code/backend" "$CODE_DST" 2>&1 | sed 's/^/    /' | head -20 || true
    backup "$CODE_DST" radui-backend
    if doit "replace ${V[INSTALL_DIR]}/backend with this release"; then
      install -d -m 0755 "$(dirname "$CODE_DST")"
      rm -rf -- "$CODE_DST.radui-new"
      cp -a "$STAGE/code/backend" "$CODE_DST.radui-new"
      own -R root:root "$CODE_DST.radui-new"
      mv "$CODE_DST" "$CODE_DST.radui-old" && mv "$CODE_DST.radui-new" "$CODE_DST" && rm -rf -- "$CODE_DST.radui-old"
    fi
  fi
else
  if doit "copy the backend (package radui_admin and launchers) to ${V[INSTALL_DIR]}/backend"; then
    install -d -m 0755 "$(dirname "$CODE_DST")"
    cp -a "$STAGE/code/backend" "$CODE_DST"
    own -R root:root "$CODE_DST"
  fi
fi
LINK="$(hp "${V[BIN_DIR]}/radui-admin-cli")"
LINK_TARGET="${V[INSTALL_DIR]}/backend/bin/radui-admin-cli"
if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$LINK_TARGET" ]; then
  say "  unchanged: ${V[BIN_DIR]}/radui-admin-cli -> $LINK_TARGET"
elif [ -e "$LINK" ] || [ -L "$LINK" ]; then
  say "  WARNING: ${V[BIN_DIR]}/radui-admin-cli exists and is not the expected link; left alone"
else
  if doit "symlink ${V[BIN_DIR]}/radui-admin-cli -> $LINK_TARGET"; then
    install -d -m 0755 "$(dirname "$LINK")"
    ln -s "$LINK_TARGET" "$LINK"
  fi
fi

# ---- 4. plugin file --------------------------------------------------------------------------
step "4. Radicale rights plugin file in ${V[PLUGIN_DIR]} (not loaded until the cutover)"
install_file "$REPO/backend/plugin/radui_rights.py" "${V[PLUGIN_DIR]}/radui_rights.py" 0644 root:root radui_rights.py

# ---- 5. configuration ------------------------------------------------------------------------
step "5. Backend configuration ${V[CONFIG_DIR]}/config.toml"
CONF_DST="$(hp "${V[CONFIG_DIR]}/config.toml")"
if [ -e "$CONF_DST" ] && ! cmp -s "$R/backend/config.toml" "$CONF_DST" && [ "$REPLACE_CONFIG" != 1 ]; then
  say "  exists and differs from the rendered file: left untouched (use --replace-config to back it up and replace it)"
  diff -u "$CONF_DST" "$R/backend/config.toml" | sed 's/^/    /' | head -40 || true
else
  install_file "$R/backend/config.toml" "${V[CONFIG_DIR]}/config.toml" 0640 "root:${V[RADUI_GROUP]}" radui-config.toml
fi

# ---- 6. systemd unit -------------------------------------------------------------------------
step "6. systemd unit radui-admin.service (installed, NOT enabled or started)"
UNIT_CHANGES_BEFORE="$CHANGES"
install_file "$R/systemd/radui-admin.service" /etc/systemd/system/radui-admin.service 0644 root:root radui-admin.service
if real_host && [ "$CHANGES" != "$UNIT_CHANGES_BEFORE" ]; then
  if doit "systemctl daemon-reload"; then systemctl daemon-reload; fi
fi

# ---- 7. printed, not applied -----------------------------------------------------------------
step "7. Cutover material (PRINTED ONLY, nothing below is applied)"
say "  Radicale configuration changes, to merge by hand at cutover (deploy/CUTOVER.md):"
sed 's/^/    | /' "$R/radicale/config-snippet.ini"
say
say "  Radicale unit drop-in, to install as /etc/systemd/system/${V[RADICALE_UNIT]}.d/radui.conf at cutover:"
grep -v '^#' "$R/systemd/radicale-radui.conf" | sed 's/^/    | /'
say
say "  nginx and fail2ban files are rendered from deploy/nginx and deploy/fail2ban at cutover (Gate C);"
say "  the nginx address-header change and the fail2ban jail are a pair and are never installed apart."

step "Summary"
if [ "$APPLY" = 1 ]; then
  say "  $CHANGES change(s) made."
  say "  Next: create the first model with 'radui-admin-cli import' (deploy/CUTOVER.md, step 3),"
  say "  then 'systemctl enable --now radui-admin'. Radicale has not been touched."
else
  say "  $CHANGES change(s) would be made. Nothing was changed. Re-run with --apply to do it."
fi
