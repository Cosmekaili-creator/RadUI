# SPDX-License-Identifier: AGPL-3.0-or-later
"""Independent oracle for the generated rights (built ONLY from the model).

``expected(model, user, path)`` answers "what level should this login have on
this path?" without looking at generator output; ``letters(level)`` maps a
level to Radicale permission letters. The probe list ``probe_pairs`` is what
the candidate validator checks the generated file against, using Radicale's
own matcher (see :class:`RadicaleMatcher`, the only part of this module that
does I/O: it starts a subprocess).

Levels
------
``none``          ``""``       no access
``generation``    ``i``        anonymous probe of the current generation path
``root``          ``R``        the root path ``""`` (any non-empty login)
``principal``     ``RW``       a principal the login may use or create
``principal-ro``  ``R``        an admin looking at a top-level name that is not
                               an enabled own-space account
``own``           ``rwDO``     a collection in the login's own space
``grant-r``       ``r``        a granted collection, read
``grant-rw``      ``rwl``      a granted collection, read/write items
``admin``         ``RWrwDO``   below a principal, for an admin

Paths are Radicale-sane paths: no leading/trailing slash, no empty segment.
"""
import json
import os
import subprocess
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from . import names
from .model import Model

LEVEL_LETTERS: Dict[str, str] = {
    "none": "",
    "generation": "i",
    "root": "R",
    "principal": "RW",
    "principal-ro": "R",
    "own": "rwDO",
    "grant-r": "r",
    "grant-rw": "rwl",
    "admin": "RWrwDO",
}


def letters(level: str) -> str:
    """Permission letters of a level, in canonical order."""
    return LEVEL_LETTERS[level]


def letter_set(value: str) -> frozenset:
    return frozenset(value)


def _segments(path: str) -> List[str]:
    if path == "":
        return []
    segs = path.split("/")
    if any(s == "" for s in segs):
        raise ValueError("path must be stripped and have no empty segment: %r"
                         % path)
    return segs


def expected(model: Model, user: str, path: str) -> str:
    """Level of ``user`` ("" = anonymous) on ``path`` according to the model."""
    segs = _segments(path)
    if user == "":
        if segs == [names.GENERATION_PREFIX + model.gen_token]:
            return "generation"
        return "none"
    if not segs:
        return "root"  # every authenticated login (even disabled/unknown)
    acc = model.accounts.get(user)
    if acc is None or acc.disabled:
        return "none"
    if acc.admin:
        if len(segs) >= 2:
            return "admin"
        if segs[0] == user:
            return "principal"
        other = model.accounts.get(segs[0])
        if other is not None and not other.disabled and other.own_space:
            return "principal"
        return "principal-ro"
    if len(segs) == 1:
        return "principal" if segs[0] == user else "none"
    if len(segs) == 2:
        if segs[0] == user:
            return "own" if acc.own_space else "none"
        if segs[0] not in model.accounts:
            return "none"
        for g in model.grants:
            if g.grantee == user and g.owner == segs[0] \
                    and g.collection == segs[1]:
                return "grant-r" if g.level == "read" else "grant-rw"
    return "none"


def probe_pairs(model: Model) -> List[Tuple[str, str]]:
    """Deterministic (user, path) probes per decision D2.

    Users: anonymous, every account (enabled, disabled, admin or not), every
    tombstoned login and one unknown login. Paths: the root, every principal
    (also tombstoned/unknown ones: an admin's never-logged-in principal), one
    synthetic collection and one synthetic item below every principal, every
    granted collection and an item inside it, the current generation path, a
    stale generation path and an arbitrary top-level name.
    """
    unknown = "radui-probe-user"
    users = [""] + sorted(set(model.accounts) | set(model.tombstones)) + [unknown]
    principals = sorted(set(model.accounts) | set(model.tombstones))
    paths = ["", "radui-probe-top", "radui-gen-x",
             names.GENERATION_PREFIX + model.gen_token]
    for p in principals + [unknown]:
        paths += [p, p + "/radui-probe", p + "/radui-probe/x"]
    for g in model.grants:
        paths += ["%s/%s" % (g.owner, g.collection),
                  "%s/%s/x" % (g.owner, g.collection)]
    seen = set()
    ordered_paths = [p for p in paths if not (p in seen or seen.add(p))]
    return [(u, p) for u in users for p in ordered_paths]


def expected_letters(model: Model, user: str, path: str) -> str:
    return letters(expected(model, user, path))


# ---------------------------------------------------------------------------
# Radicale's own matcher (subprocess; the only I/O in this module)
# ---------------------------------------------------------------------------

_RUNNER = r'''
import json, os, sys, tempfile
from radicale import config
from radicale.rights import from_file
req = json.load(sys.stdin)
fd, tmp = tempfile.mkstemp(prefix="radui-match-")
try:
    # utf-8: a LEGACY rights file may carry non-ASCII comments (generated
    # files are ASCII-only, which is a subset)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(req["rights"])
    cfg = config.load()
    cfg.update({"rights": {"file": tmp}}, "radui-match")
    rights = from_file.Rights(cfg)
finally:
    os.unlink(tmp)
out = []
for user, path in req["pairs"]:
    # Radicale hands the engine sanitised paths: leading slash, no ".."
    out.append("".join(sorted(rights.authorization(user, set(), "/" + path))))
json.dump(out, sys.stdout)
'''


def _env_local_value(key: str, repo_root: str) -> Optional[str]:
    try:
        with open(os.path.join(repo_root, ".env.local"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    return None


def find_radicale_python(repo_root: Optional[str] = None) -> Optional[str]:
    """Interpreter that can import ``radicale``: ``RADICALE_PYTHON``, else the
    ``python`` next to ``RADICALE_BIN`` (environment or ``.env.local``, the
    variable the Makefile uses). ``None`` when nothing usable is configured."""
    if repo_root is None:
        repo_root = os.path.abspath(os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    cand = os.environ.get("RADICALE_PYTHON") or _env_local_value(
        "RADICALE_PYTHON", repo_root)
    if not cand:
        binary = os.environ.get("RADICALE_BIN") or _env_local_value(
            "RADICALE_BIN", repo_root)
        if binary and os.sep in binary:
            cand = os.path.join(os.path.dirname(binary), "python")
    if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
        return cand
    return None


class RadicaleMatcher:
    """Evaluate rights text with Radicale's own ``from_file`` engine.

    ``matcher(rights_text, pairs)`` returns one sorted-letters string per
    ``(user, path)`` pair. The subprocess runs ``python -I``; the rights text
    is passed through a temporary file that the runner removes immediately.
    Raises ``RuntimeError`` if Radicale refuses the file.
    """

    def __init__(self, python: Optional[str] = None, timeout: int = 60) -> None:
        self.python = python or find_radicale_python()
        if not self.python:
            raise RuntimeError("no Radicale interpreter configured "
                               "(set RADICALE_PYTHON or RADICALE_BIN)")
        self.timeout = timeout

    def __call__(self, rights_text: str,
                 pairs: Sequence[Tuple[str, str]]) -> List[str]:
        proc = subprocess.run(
            [self.python, "-I", "-c", _RUNNER],
            input=json.dumps({"rights": rights_text,
                              "pairs": [list(p) for p in pairs]}),
            capture_output=True, text=True, timeout=self.timeout, check=False)
        if proc.returncode != 0:
            last = proc.stderr.strip().splitlines()[-1:] or ["unknown error"]
            raise RuntimeError("radicale matcher failed: %s" % last[0])
        return json.loads(proc.stdout)


Matcher = Callable[[str, Sequence[Tuple[str, str]]], List[str]]


def mismatches(model: Model, rights_text: str, matcher: Matcher,
               pairs: Optional[Iterable[Tuple[str, str]]] = None
               ) -> List[Tuple[str, str, str, str]]:
    """Probe the generated text with ``matcher`` and compare with the oracle.

    Returns ``[(user, path, got_letters, expected_letters), ...]`` for every
    pair whose letter SETS differ (empty list = the file matches the model).
    """
    probe = list(pairs if pairs is not None else probe_pairs(model))
    got = matcher(rights_text, probe)
    out = []
    for (user, path), g in zip(probe, got):
        want = expected_letters(model, user, path)
        if frozenset(g) != frozenset(want):
            out.append((user, path, g, want))
    return out
