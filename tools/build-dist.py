#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Build the distribution tree of the static app: dist/ from src/ (stdlib only; needs `terser` and `node`).

What it does:
  1. copies src/ to the output directory (without sw-manifest.js: tools/deploy-static.sh generates it from the
     tree it is given, so `--src dist` works unchanged);
  2. minifies every js/**/*.js (ES modules) and sw.js (classic script) one file at a time with the system
     `terser`. Safe options only: compress + mangle, class names kept, no `unsafe*`, no property mangling,
     no toplevel renaming across files. The SPDX comment of each file is kept. vendor/ is copied byte for byte;
  3. flattens each language's dictionary (the aggregator i18n/<lang>.js and its part files) into ONE file
     i18n/<lang>.js that carries the frozen dictionary, removes the part files, and proves with node that the
     flattened dictionary equals the one the source aggregator produces (a difference fails the build);
  4. writes build-info.json: {"source": ..., "minified": bool, "terser": version or null}. No path, host or user.

The output is deterministic: the same source tree gives a byte-identical dist tree. dist/ is git-ignored and
never edited by hand; the repository stays the readable source (AGPL-3.0-or-later).

Usage:  build-dist.py [--src DIR] [--out DIR] [--no-minify] [--source-label TEXT]
  --src DIR            the app tree (default: <repository>/src)
  --out DIR            the output tree (default: <repository>/dist). Refused: a directory inside or equal to
                       --src, one that contains --src, "/", your home directory, a non-empty directory that
                       is not a previous build (no build-info.json inside), a symlink.
  --no-minify          copy and flatten only (for a machine without terser); build-info.json says minified: false
  --source-label TEXT  override the "source" value (default: `git describe --always --dirty` of --src, or "unknown")
"""
import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MARKER = "build-info.json"
SPDX_LINE = "// SPDX-License-Identifier: AGPL-3.0-or-later\n"
TERSER_ARGS = ["--ecma", "2022", "--compress", "--mangle", "--keep-classnames",
               "--comments", "/SPDX-License-Identifier/"]
LANG_RE = re.compile(r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$")
IGNORED_NAMES = {"sw-manifest.js", "__pycache__"}
JOBS = 4


class BuildError(Exception):
    pass


# ------------------------------------------------------------------ tools

def find_terser():
    path = shutil.which("terser")
    if not path:
        raise BuildError("terser is not installed. Install it (Debian/Ubuntu package `terser`, or `npm i -g terser`)"
                         " or build without minifying: build-dist.py --no-minify")
    return path


def terser_version(terser):
    r = subprocess.run([terser, "--version"], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise BuildError("terser --version failed: " + r.stderr.strip())
    m = re.search(r"(\d+\.\d+\.\d+\S*)", r.stdout)
    return m.group(1) if m else r.stdout.strip()


def find_node():
    path = shutil.which(os.environ.get("NODE", "node"))
    if not path:
        raise BuildError("node is not installed (needed to flatten the dictionaries)")
    return path


# ------------------------------------------------------------ safety checks

def check_paths(src, out):
    """Return the resolved (src, out) or raise BuildError when `out` is not a safe place to empty and fill."""
    if not out or not str(out).strip():
        raise BuildError("--out is empty")
    if not os.path.isdir(src):
        raise BuildError("--src is not a directory: %s" % src)
    src_r = os.path.realpath(src)
    if os.path.islink(out):
        raise BuildError("--out is a symlink: %s" % out)
    out_r = os.path.realpath(out)
    if out_r == os.path.sep:
        raise BuildError("refusing to use / as --out")
    home = os.environ.get("HOME")
    if home and out_r == os.path.realpath(home):
        raise BuildError("refusing to use the home directory as --out")
    if out_r == src_r or out_r.startswith(src_r + os.sep):
        raise BuildError("--out lies inside or equals --src: %s" % out)
    if src_r.startswith(out_r + os.sep):
        raise BuildError("--out contains --src: %s" % out)
    if os.path.exists(out_r):
        if not os.path.isdir(out_r):
            raise BuildError("--out exists and is not a directory: %s" % out)
        if os.listdir(out_r) and not os.path.isfile(os.path.join(out_r, MARKER)):
            raise BuildError("--out is not empty and holds no previous build (%s missing): %s" % (MARKER, out))
    return src_r, out_r


# ----------------------------------------------------------------- copying

def copy_tree(src, out):
    if os.path.isdir(out):
        shutil.rmtree(out)
    shutil.copytree(src, out, ignore=shutil.ignore_patterns(*IGNORED_NAMES), symlinks=False)


def js_files(out):
    """Relative paths of the files to minify: js/**/*.js (modules) and sw.js (classic)."""
    found = []
    base = os.path.join(out, "js")
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(filenames):
            if name.endswith(".js"):
                found.append(os.path.relpath(os.path.join(dirpath, name), out).replace(os.sep, "/"))
    return found


def minify_one(terser, out, rel, module):
    path = os.path.join(out, rel)
    cmd = [terser, path] + (["--module"] if module else []) + TERSER_ARGS
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    if r.returncode != 0:
        raise BuildError("terser failed on %s: %s" % (rel, r.stderr.decode("utf-8", "replace").strip()))
    code = r.stdout
    with open(path, "rb") as fh:
        had_spdx = b"SPDX-License-Identifier" in fh.read()
    if had_spdx and b"SPDX-License-Identifier" not in code:
        raise BuildError("the SPDX header was lost while minifying %s" % rel)
    if not code.endswith(b"\n"):
        code += b"\n"
    with open(path, "wb") as fh:
        fh.write(code)


def minify_tree(terser, out):
    jobs = [(rel, True) for rel in js_files(out)]
    if os.path.isfile(os.path.join(out, "sw.js")):
        jobs.append(("sw.js", False))
    with concurrent.futures.ThreadPoolExecutor(max_workers=JOBS) as pool:
        futures = [pool.submit(minify_one, terser, out, rel, module) for rel, module in jobs]
        for fut in futures:
            fut.result()
    return len(jobs)


# ------------------------------------------------------------ dictionaries

def _node_json(node, script, *args):
    r = subprocess.run([node, "--input-type=module", "-e", script, "--", *args], capture_output=True, timeout=120)
    if r.returncode != 0:
        raise BuildError("node failed: " + r.stderr.decode("utf-8", "replace").strip())
    return r.stdout.decode("utf-8")


def supported_languages(node, src):
    script = ("import { pathToFileURL } from 'node:url';"
              "const m = await import(pathToFileURL(process.argv[1]).href);"
              "process.stdout.write(JSON.stringify(m.SUPPORTED_LANGUAGES));")
    langs = json.loads(_node_json(node, script, os.path.join(src, "js", "i18n.js")))
    if not isinstance(langs, list) or not langs or not all(isinstance(x, str) and LANG_RE.match(x) for x in langs):
        raise BuildError("js/i18n.js SUPPORTED_LANGUAGES is not a list of language codes: %r" % (langs,))
    return langs


def dictionary_json(node, path):
    script = ("import { pathToFileURL } from 'node:url';"
              "const m = await import(pathToFileURL(process.argv[1]).href);"
              "process.stdout.write(JSON.stringify(m.default));")
    return _node_json(node, script, path)


def flatten_dictionaries(node, src, out):
    langs = supported_languages(node, src)
    for lang in langs:
        agg = os.path.join(src, "i18n", lang + ".js")
        if not os.path.isfile(agg):
            raise BuildError("no dictionary aggregator for language %r: i18n/%s.js" % (lang, lang))
        text = dictionary_json(node, agg)
        data = json.loads(text)
        if not isinstance(data, dict) or not data:
            raise BuildError("the dictionary of %r is empty or not an object" % lang)
        target = os.path.join(out, "i18n", lang + ".js")
        with open(target, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(SPDX_LINE + "export default Object.freeze(" + text + ");\n")
        part_re = re.compile(r"^" + re.escape(lang) + r"\.[^.]+\.js$")
        for name in sorted(os.listdir(os.path.join(out, "i18n"))):
            if part_re.match(name):
                os.remove(os.path.join(out, "i18n", name))
        verify_flattened(node, agg, target)
    return langs


def verify_flattened(node, source_aggregator, flattened):
    """Raise BuildError unless the flattened file's dictionary equals the source aggregator's (keys, order, values)."""
    script = ("import { pathToFileURL } from 'node:url'; import { isDeepStrictEqual } from 'node:util';"
              "const a = (await import(pathToFileURL(process.argv[1]).href)).default;"
              "const b = (await import(pathToFileURL(process.argv[2]).href)).default;"
              "const same = isDeepStrictEqual(a, b) && JSON.stringify(a) === JSON.stringify(b) && Object.isFrozen(b);"
              "process.stdout.write(same ? 'same' : 'different');")
    verdict = _node_json(node, script, source_aggregator, flattened)
    if verdict != "same":
        raise BuildError("the flattened dictionary %s differs from its source aggregator" % os.path.basename(flattened))


# --------------------------------------------------------------- build info

def source_label(src):
    try:
        r = subprocess.run(["git", "-C", src, "describe", "--always", "--dirty"], capture_output=True, text=True, timeout=30)
        label = r.stdout.strip()
        if r.returncode == 0 and re.fullmatch(r"[A-Za-z0-9._-]{1,80}", label):
            return label
    except (OSError, subprocess.SubprocessError):
        pass
    return "unknown"


def write_build_info(out, label, minified, version):
    info = {"source": label, "minified": bool(minified), "terser": version if minified else None}
    with open(os.path.join(out, MARKER), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(info, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return info


# --------------------------------------------------------------------- main

def build(src, out, minify=True, label=None):
    src, out = check_paths(src, out)
    node = find_node()
    terser = find_terser() if minify else None
    version = terser_version(terser) if terser else None
    if label is None:
        label = source_label(src)
    if not os.path.isfile(os.path.join(src, "index.html")):
        raise BuildError("%s does not look like the app source (no index.html)" % src)
    copy_tree(src, out)
    count = minify_tree(terser, out) if minify else 0
    langs = flatten_dictionaries(node, src, out)
    info = write_build_info(out, label, minify, version)
    return {"out": out, "minified_files": count, "languages": langs, "info": info}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build the distribution tree (dist/) of the static app.")
    ap.add_argument("--src", default=os.path.join(REPO, "src"), help="app tree (default: <repository>/src)")
    ap.add_argument("--out", default=os.path.join(REPO, "dist"), help="output tree (default: <repository>/dist)")
    ap.add_argument("--no-minify", action="store_true", help="skip terser (copy and flatten dictionaries only)")
    ap.add_argument("--source-label", default=None, help="value of build-info.json 'source'")
    args = ap.parse_args(argv)
    try:
        res = build(args.src, args.out, minify=not args.no_minify, label=args.source_label)
    except BuildError as e:
        print("build-dist: %s" % e, file=sys.stderr)
        return 2
    info = res["info"]
    print("build-dist: %s (source %s, %s, languages %s) -> %s" % (
        "%d files minified with terser %s" % (res["minified_files"], info["terser"]) if info["minified"] else "not minified",
        info["source"], "minified" if info["minified"] else "plain", ",".join(res["languages"]), res["out"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
