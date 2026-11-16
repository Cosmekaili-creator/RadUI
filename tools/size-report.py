#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Size report of a built app tree (stdlib only): raw and gzip sizes, and the first-screen JavaScript budget.

Usage:  size-report.py --www DIR [--budget-kb 250] [--lang en] [--json]
  --www DIR        the tree to measure (normally dist/, from tools/build-dist.py; src/ works too)
  --budget-kb N    limit for the gzip-6 size of the CALENDAR first screen (default 250). Exit status 1 above it.
  --lang CODE      the one language counted in a first screen (default: en)

Figures (raw bytes, gzip level 6, gzip level 9; gzip is made without a timestamp, so it is reproducible):
  - total JavaScript (js/, sw.js, vendor/), each language dictionary, css, the full app (every file);
  - three FIRST-SCREEN figures (calendar, contacts, tasks): the static-import closure of js/app.js, plus the
    data model (js/model/item.js, loaded before a model screen is mounted), plus the store (js/store/index.js),
    plus the module of that screen, plus ONE language dictionary (i18n/<lang>.js). Dictionaries reached through
    imports are ignored: a language is counted once, explicitly. Dynamic import() is not followed (it is lazy).
The closure is read with a regular expression over `import ... from '...'`, `export ... from '...'` and bare
`import '...'` statements with relative specifiers; line and block comments are removed first.
"""
import argparse
import gzip
import json
import os
import re
import sys

SCREENS = {
    "calendar": "js/views/calendar/screen.js",
    "contacts": "js/views/contacts/screen.js",
    "tasks": "js/views/tasks/screen.js",
}
BASE_ENTRIES = ["js/app.js", "js/model/item.js", "js/store/index.js"]
IMPORT_RE = re.compile(r"""\b(?:import|export)\b[^;'"`()]*?\bfrom\s*(['"])(\.[^'"]*)\1""")
BARE_IMPORT_RE = re.compile(r"""(?:^|[;{}\s])import\s*(['"])(\.[^'"]*)\1""")
BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT_RE = re.compile(r"^\s*//.*$", re.M)


def sizes(data):
    return {
        "raw": len(data),
        "gzip6": len(gzip.compress(data, compresslevel=6, mtime=0)),
        "gzip9": len(gzip.compress(data, compresslevel=9, mtime=0)),
    }


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


def static_imports(text):
    """Relative specifiers of the static imports and re-exports of one module's source text."""
    text = BLOCK_COMMENT_RE.sub("", text)
    text = LINE_COMMENT_RE.sub("", text)
    found = [m.group(2) for m in IMPORT_RE.finditer(text)]
    found += [m.group(2) for m in BARE_IMPORT_RE.finditer(text)]
    return found


def closure(www, entries):
    """Sorted relative paths of the files reachable from `entries` through static imports (dictionaries skipped)."""
    seen = set()
    todo = list(entries)
    while todo:
        rel = todo.pop()
        if rel in seen:
            continue
        full = os.path.join(www, rel)
        if not os.path.isfile(full):
            raise SystemExit("size-report: %s is missing (reached through a static import)" % rel)
        seen.add(rel)
        text = read(full).decode("utf-8", "replace")
        for spec in static_imports(text):
            target = os.path.normpath(os.path.join(os.path.dirname(rel), spec)).replace(os.sep, "/")
            if target.startswith("../") or target.startswith("i18n/"):
                continue
            if not os.path.isfile(os.path.join(www, target)):
                raise SystemExit("size-report: %s imports %s, which does not exist" % (rel, spec))
            todo.append(target)
    return sorted(seen)


def all_files(www):
    found = []
    for dirpath, dirnames, filenames in os.walk(www):
        dirnames.sort()
        for name in sorted(filenames):
            found.append(os.path.relpath(os.path.join(dirpath, name), www).replace(os.sep, "/"))
    return found


def total(www, rels):
    """Sum of the per-file sizes (each file is compressed on its own, as a server does)."""
    acc = {"raw": 0, "gzip6": 0, "gzip9": 0}
    for rel in rels:
        for k, v in sizes(read(os.path.join(www, rel))).items():
            acc[k] += v
    return acc


def report(www, lang="en"):
    files = all_files(www)
    js = [f for f in files if f.endswith(".js") and not f.startswith("i18n/") and f != "sw-manifest.js"]
    dicts = sorted(f for f in files if re.fullmatch(r"i18n/[A-Za-z0-9-]+\.js", f))
    out = {
        "files": len(files),
        "total_js": total(www, js),
        "css": total(www, [f for f in files if f.endswith(".css")]),
        "full_app": total(www, files),
        "languages": {d[len("i18n/"):-3]: total(www, [d]) for d in dicts},
        "part_files": sorted(f for f in files if re.fullmatch(r"i18n/[a-z-]+\.[a-z]+\.js", f)),
        "first_screen": {},
    }
    dictionary = "i18n/%s.js" % lang
    if not os.path.isfile(os.path.join(www, dictionary)):
        raise SystemExit("size-report: no dictionary %s in %s" % (dictionary, www))
    for name, module in SCREENS.items():
        rels = closure(www, BASE_ENTRIES + [module]) + [dictionary]
        entry = total(www, rels)
        entry["files"] = len(rels)
        out["first_screen"][name] = entry
    info = os.path.join(www, "build-info.json")
    out["build_info"] = json.loads(read(info)) if os.path.isfile(info) else None
    return out


def kb(n):
    return "%7.1f" % (n / 1024.0)


def render(rep, budget_kb):
    lines = ["size report (KB; gzip per file, summed)", "%-30s %9s %9s %9s" % ("", "raw", "gzip-6", "gzip-9")]

    def row(label, s):
        lines.append("%-30s %9s %9s %9s" % (label, kb(s["raw"]), kb(s["gzip6"]), kb(s["gzip9"])))

    info = rep["build_info"]
    lines.insert(1, "build: %s" % ("not built (no build-info.json)" if not info else
                                   "%s, %s" % (info.get("source"), "minified" if info.get("minified") else "NOT minified")))
    row("all JS (js/, sw.js, vendor/)", rep["total_js"])
    for lang, s in rep["languages"].items():
        row("dictionary %s" % lang, s)
    row("css", rep["css"])
    row("full app, %d files" % rep["files"], rep["full_app"])
    for name, s in rep["first_screen"].items():
        row("first screen: %s (%d files)" % (name, s["files"]), s)
    if rep["part_files"]:
        lines.append("note: %d dictionary part files are present (a built tree flattens them)" % len(rep["part_files"]))
    cal = rep["first_screen"]["calendar"]["gzip6"] / 1024.0
    lines.append("budget: calendar first screen gzip-6 %.1f KB %s %d KB -> %s" % (
        cal, "<=" if cal <= budget_kb else ">", budget_kb, "OK" if cal <= budget_kb else "OVER BUDGET"))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Size report and first-screen budget of a built app tree.")
    ap.add_argument("--www", required=True, help="the tree to measure (normally dist/)")
    ap.add_argument("--budget-kb", type=float, default=250, help="calendar first screen, gzip-6 (default 250)")
    ap.add_argument("--lang", default="en", help="language counted in a first screen (default en)")
    ap.add_argument("--json", action="store_true", help="print the figures as JSON")
    args = ap.parse_args(argv)
    if not os.path.isdir(args.www):
        raise SystemExit("size-report: not a directory: %s" % args.www)
    rep = report(args.www, args.lang)
    print(json.dumps(rep, indent=2, sort_keys=True) if args.json else render(rep, args.budget_kb))
    return 0 if rep["first_screen"]["calendar"]["gzip6"] / 1024.0 <= args.budget_kb else 1


if __name__ == "__main__":
    sys.exit(main())
