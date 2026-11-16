#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Render the deploy templates from a variables file (stdlib only).

    render-deploy.py --vars deploy.local/vars.env --out deploy.local/rendered
    render-deploy.py --vars deploy/vars.example.env --check

Every ``*.tpl`` file under the template directory (default: ``deploy/`` next to this tool's
parent) is rendered to the same relative path without the ``.tpl`` suffix. A placeholder is
``@@NAME@@`` (NAME = capital letters, digits, underscore).

The render FAILS (exit 1, nothing written) when

* a placeholder names a variable that is not set, or is set to an empty value;
* a value has a character outside the allowed set (so a value can never inject a directive,
  a quote or a line break into the generated file);
* any ``@@`` is left in the output, or in a deploy file that is not a template;
* with ``--check``: a variable of the file is not documented by a comment, or is used by no
  template and no shell script of the template directory.

The variables file has one ``KEY=VALUE`` per line; ``#`` starts a comment line; no shell
expansion; a value cannot refer to another variable. Exit status: 0 ok, 1 render/check
failure, 2 usage error.
"""
import argparse
import os
import re
import sys
from typing import Dict, List, Optional, Sequence, Set, Tuple

NAME_RE = re.compile(r"[A-Z][A-Z0-9_]*")
PLACEHOLDER_RE = re.compile(r"@@([A-Z][A-Z0-9_]*)@@")
#: Characters a value may contain. No quote, semicolon, brace, dollar, backslash, '#', '@'
#: or control character: the same value ends up in nginx, systemd, INI, TOML and fail2ban files.
VALUE_RE = re.compile(r"[A-Za-z0-9 ._/:,%+=~-]+")
SUFFIX = ".tpl"
#: Non-template files that may legitimately mention "@@" (documentation about the syntax).
UNTEMPLATED_TEXT_EXT = {".conf", ".ini", ".sh", ".toml", ".service", ".inc"}

DEFAULT_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "deploy")


class RenderError(Exception):
    """A problem with the variables or a template; the message says which."""


def parse_vars(text: str, source: str = "<vars>") -> Tuple[Dict[str, str], Set[str]]:
    """Return ``(variables, documented)``; ``documented`` holds the names that are covered by a
    comment: a comment block directly above them, with no blank line in between (several
    assignments in a row share the comment above the first)."""
    values: Dict[str, str] = {}
    documented: Set[str] = set()
    prev_comment = False
    for no, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip("\r")
        stripped = line.strip()
        if not stripped:
            prev_comment = False
            continue
        if stripped.startswith("#"):
            prev_comment = True
            continue
        if "=" not in line:
            raise RenderError("%s:%d: expected KEY=VALUE" % (source, no))
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not NAME_RE.fullmatch(key):
            raise RenderError("%s:%d: bad variable name %r" % (source, no, key))
        if key in values:
            raise RenderError("%s:%d: %s is set twice" % (source, no, key))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
        if prev_comment:
            documented.add(key)
        # the comment block stays in force for the assignments that follow it directly, up to a
        # blank line (a pair such as TLS_CERT / TLS_KEY shares one comment)
    return values, documented


def check_values(values: Dict[str, str], used: Optional[Set[str]] = None) -> None:
    """Refuse empty values and values with characters outside the allowed set. When ``used``
    is given only those variables are examined (a render needs only what the templates use)."""
    for key, value in values.items():
        if used is not None and key not in used:
            continue
        if value == "":
            raise RenderError("%s is set but empty" % key)
        if not VALUE_RE.fullmatch(value):
            bad = sorted(set(c for c in value if not VALUE_RE.fullmatch(c)))
            raise RenderError("%s has a character that is not allowed: %s (allowed: letters, "
                              "digits, space and . _ / : , %% + = ~ -)"
                              % (key, " ".join(repr(c) for c in bad)))


def render_text(template: str, values: Dict[str, str], name: str = "<template>") -> str:
    """Substitute every placeholder in one pass (a value is never re-expanded)."""
    missing: List[str] = []

    def sub(m: "re.Match[str]") -> str:
        key = m.group(1)
        if key not in values or values[key] == "":
            if key not in missing:
                missing.append(key)
            return m.group(0)
        return values[key]

    out = PLACEHOLDER_RE.sub(sub, template)
    if missing:
        raise RenderError("%s: variable(s) not set: %s" % (name, ", ".join(missing)))
    if "@@" in out:
        line = next(i for i, ln in enumerate(out.splitlines(), 1) if "@@" in ln)
        raise RenderError("%s:%d: a placeholder is left over after rendering" % (name, line))
    return out


def find_templates(src: str) -> List[str]:
    found = []
    for base, dirs, files in os.walk(src):
        dirs.sort()
        for f in sorted(files):
            if f.endswith(SUFFIX):
                found.append(os.path.relpath(os.path.join(base, f), src))
    return found


def placeholders_in(text: str) -> Set[str]:
    return set(PLACEHOLDER_RE.findall(text))


def check_untemplated(src: str) -> None:
    """A deploy file that is not a template must not contain a placeholder: it would never
    be rendered and would be installed as it is."""
    for base, dirs, files in os.walk(src):
        for f in sorted(files):
            if f.endswith(SUFFIX) or os.path.splitext(f)[1] not in UNTEMPLATED_TEXT_EXT:
                continue
            path = os.path.join(base, f)
            with open(path, encoding="utf-8", errors="replace") as fh:
                for no, line in enumerate(fh, 1):
                    if PLACEHOLDER_RE.search(line):
                        raise RenderError("%s:%d: placeholder in a file that is not a template"
                                          % (os.path.relpath(path, src), no))


def render_tree(src: str, values: Dict[str, str]) -> Dict[str, str]:
    """Render every template; return ``{relative output path: text}``. Raises before any
    output exists if anything is wrong."""
    templates = find_templates(src)
    if not templates:
        raise RenderError("no *.tpl template under %s" % src)
    texts = {}
    used: Set[str] = set()
    for rel in templates:
        with open(os.path.join(src, rel), encoding="utf-8") as fh:
            texts[rel] = fh.read()
        used |= placeholders_in(texts[rel])
    check_values(values, used)
    out = {}
    for rel, text in texts.items():
        out[rel[:-len(SUFFIX)]] = render_text(text, values, rel)
    check_untemplated(src)
    return out


def check_variables_file(src: str, values: Dict[str, str], documented: Set[str]) -> None:
    """Consistency of a variables file with the templates and scripts (vars.example.env)."""
    used: Set[str] = set()
    for rel in find_templates(src):
        with open(os.path.join(src, rel), encoding="utf-8") as fh:
            used |= placeholders_in(fh.read())
    undefined = sorted(used - set(values))
    if undefined:
        raise RenderError("placeholders without a variable: %s" % ", ".join(undefined))
    # shell scripts under the template directory read variables by name (install-backend.sh)
    for base, _dirs, files in os.walk(src):
        for f in files:
            if f.endswith(".sh"):
                with open(os.path.join(base, f), encoding="utf-8") as fh:
                    used |= set(re.findall(r"\b[A-Z][A-Z0-9_]*\b", fh.read())) & set(values)
    unused = sorted(set(values) - used)
    if unused:
        raise RenderError("variables no template uses: %s" % ", ".join(unused))
    undocumented = sorted(set(values) - documented)
    if undocumented:
        raise RenderError("variables without a comment above them: %s" % ", ".join(undocumented))


def write_tree(out_dir: str, rendered: Dict[str, str]) -> None:
    for rel, text in rendered.items():
        path = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Render the RadUI deploy templates.")
    ap.add_argument("--vars", required=True, help="variables file (KEY=VALUE lines)")
    ap.add_argument("--src", default=DEFAULT_SRC, help="template directory (default: deploy/)")
    ap.add_argument("--out", help="output directory (created; must not be inside --src)")
    ap.add_argument("--check", action="store_true",
                    help="render in memory and validate (also that every variable is documented "
                         "and used); writes nothing")
    args = ap.parse_args(argv)
    if not args.check and not args.out:
        ap.error("--out is required unless --check is given")
    try:
        with open(args.vars, encoding="utf-8") as fh:
            values, documented = parse_vars(fh.read(), args.vars)
        rendered = render_tree(args.src, values)
        if args.check:
            check_variables_file(args.src, values, documented)
            print("ok: %d templates render cleanly with %d variables" % (len(rendered), len(values)))
            return 0
        src = os.path.realpath(args.src)
        out = os.path.realpath(args.out)
        if out == src or out.startswith(src + os.sep):
            raise RenderError("--out must not be inside the template directory")
        write_tree(out, rendered)
    except (RenderError, OSError) as exc:
        print("render-deploy: %s" % exc, file=sys.stderr)
        return 1
    print("rendered %d files into %s" % (len(rendered), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
