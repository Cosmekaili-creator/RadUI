#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Check (or --fix) the SPDX licence header of every source file.

Checked extensions: .py .js .mjs .css .html .sh (TOML, JSON, fixtures, vendor/
and LICENSE are excluded). The identifier must appear in the first 5 lines.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _treefiles  # noqa: E402

TAG = "SPDX-License-Identifier: AGPL-3.0-or-later"
EXTS = {".py", ".js", ".mjs", ".css", ".html", ".sh"}
EXCLUDED_PARTS = {"vendor", "fixtures", "golden", "node_modules"}
GENERATED = {"src/sw-manifest.js"}


def wanted(rel):
    if rel in GENERATED:
        return False
    parts = rel.split("/")
    if set(parts[:-1]) & EXCLUDED_PARTS:
        return False
    return os.path.splitext(rel)[1] in EXTS


def has_tag(lines):
    return any(TAG in ln for ln in lines[:5])


def add_header(rel, text):
    ext = os.path.splitext(rel)[1]
    lines = text.splitlines(keepends=True)
    if ext in (".py", ".sh"):
        header = "# " + TAG + "\n"
        at = 0
        if lines and lines[0].startswith("#!"):
            at = 1
        if at < len(lines) and ext == ".py" and "coding" in lines[at][:30] \
                and lines[at].startswith("#"):
            at += 1
    elif ext in (".js", ".mjs"):
        header = "// " + TAG + "\n"
        at = 1 if lines and lines[0].startswith("#!") else 0
    elif ext == ".css":
        header = "/* " + TAG + " */\n"
        at = 0
        if lines and lines[0].lower().startswith("@charset"):
            at = 1
    else:  # .html: keep the doctype first (a comment before it is risky)
        header = "<!-- " + TAG + " -->\n"
        at = 0
        if lines and lines[0].lstrip().lower().startswith("<!doctype"):
            at = 1
    lines.insert(at, header)
    return "".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--fix", action="store_true",
                    help="add the missing header in place")
    args = ap.parse_args(argv)
    missing = []
    for rel in _treefiles.list_files(args.root):
        if not wanted(rel):
            continue
        path = os.path.join(args.root, rel)
        text = _treefiles.read_text(path)
        if has_tag(text.splitlines()):
            continue
        if args.fix:
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(add_header(rel, text))
            print("fixed   " + rel)
        else:
            missing.append(rel)
            print("missing SPDX header: " + rel)
    if missing:
        print("%d file(s) without header; run tools/spdx.py --fix" % len(missing))
        return 1
    if not args.fix:
        print("spdx: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
