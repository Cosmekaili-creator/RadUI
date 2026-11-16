# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared helper: list the files of the working tree (stdlib only).

Uses ``git ls-files -co --exclude-standard`` when the root is the top level of
a git work tree, otherwise falls back to os.walk with a simple .gitignore
implementation (basename globs, directory names, anchored paths).
"""
import fnmatch
import os
import subprocess

ALWAYS_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".throwaway"}


def _git_files(root):
    try:
        prefix = subprocess.run(
            ["git", "-C", root, "rev-parse", "--show-prefix"],
            capture_output=True, text=True, check=True).stdout.strip()
        if prefix:
            return None  # root is a subdirectory of some other repo
        out = subprocess.run(
            ["git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z"],
            capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    names = [n for n in out.decode("utf-8", "surrogateescape").split("\0") if n]
    return sorted(n for n in names if os.path.isfile(os.path.join(root, n)))


def _load_patterns(root):
    patterns = []
    try:
        with open(os.path.join(root, ".gitignore"), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    patterns.append(line)
    except OSError:
        pass
    return patterns


def _ignored(rel, is_dir, patterns):
    parts = rel.split("/")
    for pat in patterns:
        anchored = pat.startswith("/")
        dir_only = pat.endswith("/")
        core = pat.strip("/")
        if dir_only and not is_dir:
            # a file inside an ignored directory is handled by pruning
            continue
        if anchored or "/" in core:
            if fnmatch.fnmatch(rel, core):
                return True
        elif any(fnmatch.fnmatch(p, core) for p in parts[-1:]):
            return True
    return False


def _walk_files(root):
    patterns = _load_patterns(root)
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        reldir = os.path.relpath(dirpath, root)
        reldir = "" if reldir == "." else reldir.replace(os.sep, "/")
        keep = []
        for d in dirnames:
            rel = (reldir + "/" + d) if reldir else d
            if d in ALWAYS_SKIP_DIRS or _ignored(rel, True, patterns):
                continue
            keep.append(d)
        dirnames[:] = keep
        for f in filenames:
            rel = (reldir + "/" + f) if reldir else f
            if not _ignored(rel, False, patterns):
                found.append(rel)
    return sorted(found)


def list_files(root):
    """Return sorted repo-relative POSIX paths of non-ignored regular files."""
    files = _git_files(root)
    if files is None:
        files = _walk_files(root)
    return [f for f in files
            if not (set(f.split("/")) & ALWAYS_SKIP_DIRS)]


def is_binary(path):
    try:
        with open(path, "rb") as fh:
            return b"\0" in fh.read(8192)
    except OSError:
        return True


def read_text(path):
    with open(path, "rb") as fh:
        return fh.read().decode("utf-8", "replace")
