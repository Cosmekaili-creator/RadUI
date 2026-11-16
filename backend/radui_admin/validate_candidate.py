# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pre-write validation of candidate ``rights`` and ``users`` files.

Three layers, every one of which must pass before anything is written:

(a) ``rightsfile.check_text``: the pure D2 checker of this package;
(b) the plugin's own ``validate_rights_bytes`` (what Radicale will apply);
(c) a subprocess under the interpreter that can import Radicale
    (``radicale_python``, run with ``-I``), which loads the candidate rights
    through Radicale's own ``radicale.rights.from_file.Rights``, parses the
    candidate users with ``radicale.auth.htpasswd.Auth`` exactly as Radicale
    does at startup, and answers the probe pairs of ``expected.probe_pairs``.
    The answers are compared as sorted letter sets with the model oracle
    ``expected.expected_letters``.

Any problem raises :class:`CandidateRejected` and the caller writes nothing.
The same code backs ``radui-admin-cli check-radicale``, which administrators
run before restarting Radicale after an upgrade.

The plugin module cannot be imported by the backend (it imports Radicale), so
layer (b) runs inside the subprocess. ``plugin_dir`` is the directory holding
``radui_rights.py``: a ``plugin`` directory next to this package in a source
checkout, or the configured ``plugin_dir``.
"""
import hashlib
import json
import os
import subprocess
from typing import List, NamedTuple, Optional, Sequence, Tuple

from . import expected as exp
from . import rightsfile
from .model import Model

DEFAULT_TIMEOUT = 20.0
MAX_REPORTED = 5
#: Radicale scans the rules for every probe; the full probe set grows with the
#: square of the number of accounts (about 12000 probes in 3 s at 50 accounts,
#: 140000 probes in 100 s at 200). Above this many probes the set is reduced
#: deterministically (see ``reduce_pairs``).
MAX_PROBES = 15000
OTHERS_SAMPLE = 15

_RUNNER = r'''
import hashlib, json, os, shutil, sys, tempfile
try:
    req = json.load(sys.stdin)
    out = {"problems": []}
    sys.path.insert(0, req["plugin_dir"])
    import radicale
    out["radicale"] = str(getattr(radicale, "VERSION", "unknown"))
    import radui_rights
    gen, sections = radui_rights.validate_rights_bytes(
        req["rights"].encode("ascii"))
    out["plugin_generation"] = gen
    from radicale import config
    from radicale.auth import htpasswd
    from radicale.rights import from_file
    tmpdir = tempfile.mkdtemp(prefix="radui-check-")
    try:
        os.chmod(tmpdir, 0o700)
        rp = os.path.join(tmpdir, "rights")
        up = os.path.join(tmpdir, "users")
        with open(rp, "w", encoding="ascii") as fh:
            fh.write(req["rights"])
        with open(up, "w", encoding="ascii") as fh:
            fh.write(req["users"])
        cfg = config.load()
        cfg.update({"rights": {"file": rp},
                    "auth": {"type": "htpasswd", "htpasswd_filename": up,
                             "htpasswd_encryption": "bcrypt"}}, "radui-check")
        rights = from_file.Rights(cfg)
        if list(rights._rights_config) != sections:
            out["problems"].append("sections seen by Radicale differ from "
                                   "the plugin check")
        auth = htpasswd.Auth(cfg)
        entries = getattr(auth, "_htpasswd", None)
        if isinstance(entries, dict):
            out["users"] = {k: hashlib.sha256(v.encode()).hexdigest()
                            for k, v in entries.items()}
        out["letters"] = ["".join(sorted(rights.authorization(
            u, set(), "/" + p))) for u, p in req["pairs"]]
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    json.dump(out, sys.stdout)
except Exception as exc:
    msg = (str(exc).splitlines() or [""])[0][:300]
    json.dump({"error": "%s: %s" % (type(exc).__name__, msg)}, sys.stdout)
'''


class CandidateRejected(Exception):
    """The candidate files were rejected; ``problems`` lists why."""

    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = list(problems)
        super().__init__("; ".join(self.problems[:MAX_REPORTED]) or "rejected")


class Result(NamedTuple):
    radicale_version: str
    probes: int
    users_checked: bool


def reduce_pairs(model: Model, pairs: Sequence[Tuple[str, str]],
                 limit: int = MAX_PROBES) -> List[Tuple[str, str]]:
    """Keep the probe set under ``limit`` for large models.

    Always kept: every probe of an admin, of the anonymous user and of the
    unknown login; every probe on the root, global and generation paths; every
    probe of a login on its own principal, on the owners of its grants and on
    tombstoned principals; and for every other principal a deterministic
    rotating sample of ``OTHERS_SAMPLE`` neighbours (so every pair of logins
    is probed against the next ones in sorted order)."""
    pairs = list(pairs)
    if len(pairs) <= limit:
        return pairs
    principals = sorted(set(model.accounts) | set(model.tombstones))
    idx = {p: i for i, p in enumerate(principals)}
    n = max(len(principals), 1)
    admins = set(model.admins())
    owners = {}
    for g in model.grants:
        owners.setdefault(g.grantee, set()).add(g.owner)
    out = []
    for user, path in pairs:
        top = path.split("/", 1)[0]
        if user == "" or user in admins or top not in idx \
                or top in model.tombstones or user not in model.accounts \
                or top == user or top in owners.get(user, ()) \
                or (idx[user] - idx[top]) % n <= OTHERS_SAMPLE:
            out.append((user, path))
    return out


def default_plugin_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "plugin")


def run_radicale(rights_text: str, users_text: str,
                 pairs: Sequence[Tuple[str, str]], *, python: str,
                 plugin_dir: str = "", timeout: float = DEFAULT_TIMEOUT
                 ) -> dict:
    """Run the subprocess check; return its decoded answer or raise
    :class:`CandidateRejected`."""
    pdir = plugin_dir or default_plugin_dir()
    if not os.path.isfile(os.path.join(pdir, "radui_rights.py")):
        raise CandidateRejected(["plugin not found in %s" % pdir])
    if not python or not os.path.isfile(python) or not os.access(python,
                                                                 os.X_OK):
        raise CandidateRejected(["radicale_python is not an executable file"])
    payload = json.dumps({"rights": rights_text, "users": users_text,
                          "pairs": [list(p) for p in pairs],
                          "plugin_dir": pdir})
    env = {"LC_ALL": "C.UTF-8", "PATH": os.environ.get("PATH", "")}
    try:
        proc = subprocess.run([python, "-I", "-c", _RUNNER], input=payload,
                              capture_output=True, text=True, env=env,
                              cwd="/", timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise CandidateRejected(["radicale check timed out after %ds"
                                 % int(timeout)]) from None
    except OSError as exc:
        raise CandidateRejected(["cannot run radicale_python: %s"
                                 % exc.strerror]) from None
    if proc.returncode != 0:
        last = (proc.stderr.strip().splitlines() or ["no output"])[-1][:200]
        raise CandidateRejected(["radicale check failed to run: %s" % last])
    try:
        answer = json.loads(proc.stdout)
    except ValueError:
        raise CandidateRejected(["radicale check returned no result"]) \
            from None
    if "error" in answer:
        raise CandidateRejected([answer["error"]])
    return answer


def validate(rights_text: str, users_text: str,
             model: Optional[Model] = None, *, python: str,
             plugin_dir: str = "", timeout: float = DEFAULT_TIMEOUT
             ) -> Result:
    """Validate candidate files; raise :class:`CandidateRejected` on any
    problem. With a ``model`` the files are also compared with the oracle."""
    errors = rightsfile.check_text(rights_text)
    if errors:
        raise CandidateRejected(["rights: %s" % str(e) for e in errors[:MAX_REPORTED]])
    pairs: List[Tuple[str, str]] = []
    if model is not None:
        pairs = reduce_pairs(model, exp.probe_pairs(model))
    answer = run_radicale(rights_text, users_text, pairs, python=python,
                          plugin_dir=plugin_dir, timeout=timeout)
    problems: List[str] = list(answer.get("problems", []))
    if model is not None:
        if answer.get("plugin_generation") != model.generation:
            problems.append("rights generation %s, model generation %d"
                            % (answer.get("plugin_generation"),
                               model.generation))
        got_letters = answer.get("letters", [])
        if len(got_letters) != len(pairs):
            problems.append("radicale answered %d of %d probes"
                            % (len(got_letters), len(pairs)))
        else:
            bad = 0
            for (user, path), got in zip(pairs, got_letters):
                want = exp.expected_letters(model, user, path)
                if frozenset(got) != frozenset(want):
                    bad += 1
                    if bad <= MAX_REPORTED:
                        problems.append(
                            "probe %s on %s: got %r, expected %r"
                            % (user or "<anonymous>", path or "<root>",
                               "".join(sorted(got)), "".join(sorted(want))))
            if bad > MAX_REPORTED:
                problems.append("%d probe mismatches in total" % bad)
        users = answer.get("users")
        if users is not None:
            want_users = {k: hashlib.sha256(a.hash.encode()).hexdigest()
                          for k, a in model.accounts.items() if not a.disabled}
            if users != want_users:
                problems.append("users file does not match the enabled "
                                "accounts of the model")
    if problems:
        raise CandidateRejected(problems)
    return Result(str(answer.get("radicale", "")), len(pairs),
                  answer.get("users") is not None)


def validate_files(rights_path: str, users_path: str,
                   model: Optional[Model] = None, **kw) -> Result:
    """Read both files and run :func:`validate` (``check-radicale``)."""
    try:
        with open(rights_path, encoding="ascii") as fh:
            rights = fh.read()
        with open(users_path, encoding="ascii") as fh:
            users = fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        raise CandidateRejected(["cannot read managed files: %s"
                                 % type(exc).__name__]) from None
    return validate(rights, users, model, **kw)
