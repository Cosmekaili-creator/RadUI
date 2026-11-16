# SPDX-License-Identifier: AGPL-3.0-or-later
"""Radicale rights plugin: hot-reloads a generated ``from_file`` rights file.

Enable it with ``[rights] type = radui_rights`` and make the module importable
by Radicale (for example ``PYTHONPATH=/path/to/plugin`` in the service
environment). The rights file keeps Radicale's standard ``from_file`` format and
Radicale's own ``from_file.Rights`` remains the only rule matcher; this module
only decides *when* a new matcher is built and refuses files that do not pass
the checks below, so a broken or truncated file can never replace working
rules.

Rights file format accepted (decision D2 of the RadUI design). The checks are
the same, rule for rule, as ``radui_admin.rightsfile.check_text`` of the admin
backend (duplicated here on purpose: this module never imports the backend),
and a parity test in ``backend/tests/plugin/test_parity.py`` keeps the two
verdicts identical:

* ASCII only, no control character except ``\n`` (so no CR, TAB, NUL, BOM);
  at most ``MAX_FILE_BYTES`` long (the only plugin-only rule);
* first line ``# radui-admin generated; DO NOT EDIT. generation=<N>``
  (``N`` has no leading zeros), last line ``# radui-end generation=<N>
  sha256=<hex>`` terminated by exactly one newline, same ``N`` in both, where
  the hash is the SHA-256 over every byte before the trailer line;
* ``from_file`` sections whose names match ``[A-Za-z0-9._-]{1,100}``, are not
  ``DEFAULT`` in any case, and are unique; no ``[DEFAULT]`` keys;
* the last section is ``[zzz-deny]`` with ``user`` ``.*``, ``collection``
  ``.*`` and empty ``permissions``;
* every section has exactly the keys ``user``, ``collection``, ``permissions``
  (so no ``groups`` key, no unknown key, no missing key);
* values contain only printable ASCII and none of ``{``, ``}``, ``%``;
  ``user`` and ``collection`` are not empty and compile as regular
  expressions; ``permissions`` uses only ``ALLOWED_PERMISSION_LETTERS``, each
  letter at most once;
* the text is canonical: re-rendering the parsed sections reproduces the body
  byte for byte (no comments, no extra blank lines, no ``key = value``
  spelling, no other key order).

Generation probe contract: this plugin does not serve any probe. The rights
file itself must contain a rule that lets an anonymous request reach an
unguessable path (see the project documentation); the generator owns it.

Behaviour:

* All state lives in one immutable ``_State`` tuple that is replaced by a
  single assignment, so a request sees either the old engine with the old
  signature or the new engine with the new signature, never a mix.
* The state is module-level and shared per rights file path: Radicale builds
  its rights object twice (application and sharing) and both must see the same
  rules.
* Change detection: the stat signature ``(st_ino, st_mtime_ns, st_ctime_ns,
  st_size)`` AND the SHA-256 of the content. A stat that equals the recorded
  one is trusted only when the file was already "settled" (older than
  ``RACY_NS``) at read time; younger files are re-read and re-hashed on every
  request, so an equal-length in-place rewrite inside one timestamp granule is
  still noticed. A rewrite that restores ``st_mtime_ns`` with ``os.utime``
  still changes ``st_ctime_ns``.
* Consistent reads: the file is stat'ed before and after reading and re-read on
  mismatch; the bytes that were hashed and validated are the bytes parsed (they
  are parsed from a private temporary copy, hence the ``PrivateTmp=yes``
  requirement in the README).
* A file that fails validation or cannot be read leaves the old rules in
  force. Its signature and hash are remembered, so it is not re-read on every
  request; one ERROR line is logged per failed file version. Successful
  reloads are logged at WARNING (production runs at that level).
* At startup the file is loaded; if that fails ``<file>.lkg`` is loaded, with
  a CRITICAL line; if both fail the constructor raises (Radicale does not
  start; fail closed). The message names the Radicale version and points to
  the ``check-radicale`` procedure.
* One WARNING at startup says the plugin is active; one WARNING is logged when
  the installed Radicale is outside the tested range (``TESTED_SERIES``).

Radicale internals this module depends on (re-check on every upgrade; see the
README, section "Upgrade procedure"):

* ``radicale.rights.BaseRights``: base class, constructor takes the
  configuration, ``authorization(user, user_groups, path)`` returns a letter
  string.
* ``radicale.rights.from_file.Rights(configuration)``: the matcher; read via
  its private attribute ``_rights_config`` (an ordered dict of section name to
  ``{"user_pattern", "collection_pattern", "allowed_groups", "permission"}``)
  and the pattern semantics of its ``authorization`` method.
* ``Configuration.copy()`` and ``Configuration.update({"rights": {"file":
  path}}, source)``: used to point a private matcher at a different file.
* ``radicale.log.logger``: Radicale's logger.
* ``radicale.VERSION``: the installed version string.
* ``radicale.utils.load_plugin`` (loads this module by its ``type`` name and
  instantiates ``Rights``; Radicale does so twice).

This module never imports anything from the RadUI admin backend.
"""

import configparser
import errno
import hashlib
import os
import re
import tempfile
import threading
import time
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

import radicale
from radicale import rights
from radicale.log import logger
from radicale.rights import from_file

# -- named constants ---------------------------------------------------------

# A file whose newest timestamp (mtime or ctime) is younger than this when it
# was read is re-hashed on every call until it has settled.
RACY_NS = 2_000_000_000
# Attempts to obtain a consistent (stat == stat) copy of a file.
MAX_READ_ATTEMPTS = 5
READ_RETRY_SLEEP_S = 0.005
MAX_FILE_BYTES = 4 * 1024 * 1024
LKG_SUFFIX = ".lkg"
LAST_SECTION = "zzz-deny"
ALLOWED_PERMISSION_LETTERS = frozenset("RWrwDOil")
# Radicale series the plugin was tested with (major, minor).
TESTED_SERIES = ((3, 9),)
TESTED_SERIES_TEXT = "3.9.x"
CHECK_PROCEDURE = ("`radui-admin-cli check-radicale` and the section "
                   "\"Upgrade procedure\" of the plugin README")
LOG_PREFIX = "radui_rights: "

_GEN = r"(0|[1-9][0-9]*)"
_HEADER_PREFIX = "# radui-admin generated; DO NOT EDIT. generation="
_TRAILER_PREFIX = "# radui-end generation="
_HEADER_RE = re.compile(re.escape(_HEADER_PREFIX) + _GEN)
_TRAILER_RE = re.compile(re.escape(_TRAILER_PREFIX) + _GEN
                         + r" sha256=([0-9a-f]{64})")
_NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,100}")
_KEYS = ("user", "collection", "permissions")
_FORBIDDEN_VALUE_CHARS = "{}%"

_version_warned = False
_version_lock = threading.Lock()


# -- errors and state --------------------------------------------------------

class RightsFileError(Exception):
    """The rights file failed a check (content or readability)."""


class _ReadFailure(RightsFileError):
    """The file could not be read; ``key`` names the problem, ``sig`` is the
    stat signature seen when it failed (``None`` if unknown)."""

    def __init__(self, message: str, key: str,
                 sig: Optional[Tuple[int, int, int, int]] = None) -> None:
        super().__init__(message)
        self.key = key
        self.sig = sig


class _State(NamedTuple):
    """Everything a request needs, replaced as a whole (never mutated)."""

    engine: Any                      # from_file.Rights built from active bytes
    active_digest: bytes             # SHA-256 of the bytes behind ``engine``
    generation: Optional[int]        # generation of the active bytes
    source: str                      # "file" or "lkg"
    watch_sig: Optional[tuple]       # signature of the last file version seen
    watch_digest: Optional[bytes]    # SHA-256 of that version (None: unread)
    settled: bool                    # trust ``watch_sig`` without re-reading
    problem: Optional[str]           # why the watched version is not active


class _Shared:
    """One per rights file path; ``state`` is only ever assigned whole."""

    __slots__ = ("path", "configuration", "state", "lock")

    def __init__(self, path: str, configuration: Any, state: _State) -> None:
        self.path = path
        self.configuration = configuration
        self.state = state
        self.lock = threading.Lock()


_shared_by_path: Dict[str, _Shared] = {}
_registry_lock = threading.Lock()


# -- file reading ------------------------------------------------------------

def _signature(st: os.stat_result) -> Tuple[int, int, int, int]:
    return (st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size)


def _stat(path: str) -> os.stat_result:
    """Stat used by the per-request fast path (a seam for tests)."""
    return os.stat(path)


def _is_settled(sig: Tuple[int, int, int, int], read_ns: int) -> bool:
    return (read_ns - max(sig[1], sig[2])) > RACY_NS


def _errno_key(exc: OSError) -> str:
    return "io:" + errno.errorcode.get(exc.errno or 0, type(exc).__name__)


def _read_consistent(path: str) -> Tuple[Tuple[int, int, int, int], bytes, int]:
    """Return (signature, content, read time in ns); stat, read, stat, retry."""
    failure: Optional[_ReadFailure] = None
    for attempt in range(1, MAX_READ_ATTEMPTS + 1):
        try:
            with open(path, "rb") as fh:
                before = os.fstat(fh.fileno())
                if before.st_size > MAX_FILE_BYTES:
                    sig = _signature(before)
                    raise _ReadFailure(
                        "rights file is too large (%d bytes, limit %d)"
                        % (before.st_size, MAX_FILE_BYTES), "too-large", sig)
                content = fh.read(MAX_FILE_BYTES + 1)
                after = os.fstat(fh.fileno())
            read_ns = time.time_ns()
            path_stat = os.stat(path)
        except _ReadFailure:
            raise
        except OSError as exc:
            sig = None
            try:
                sig = _signature(os.stat(path))
            except OSError:
                pass
            failure = _ReadFailure("cannot read rights file: %s" % exc,
                                   _errno_key(exc), sig)
        else:
            if (_signature(before) == _signature(after)
                    == _signature(path_stat)
                    and len(content) == after.st_size):
                return _signature(after), content, read_ns
            failure = _ReadFailure("rights file changed while it was read",
                                   "unstable", None)
        if attempt < MAX_READ_ATTEMPTS:
            time.sleep(READ_RETRY_SLEEP_S * attempt)
    assert failure is not None
    raise failure


# -- validation and engine construction ---------------------------------------

def _printable_ascii(value: str) -> bool:
    return all(32 <= ord(c) < 127 for c in value)


def _canonical_body(parser: configparser.ConfigParser,
                    generation: int) -> str:
    """The text a generator would write for the parsed sections."""
    parts = ["%s%d\n\n" % (_HEADER_PREFIX, generation)]
    for name in parser.sections():
        parts.append("[%s]\n" % name)
        for key in _KEYS:
            parts.append("%s: %s\n" % (key, parser.get(name, key, raw=True)))
        parts.append("\n")
    return "".join(parts)


def validate_rights_bytes(content: bytes) -> Tuple[int, List[str]]:
    """Check ``content`` against the D2 rules (same verdicts as the backend's
    ``rightsfile.check_text``; see the module docstring).

    Returns ``(generation, [section names in order])`` or raises
    ``RightsFileError``. Nothing is parsed by Radicale here.
    """
    if not content or not content.strip():
        raise RightsFileError("rights file is empty")
    if len(content) > MAX_FILE_BYTES:
        raise RightsFileError("rights file is too large")
    if b"\x00" in content:
        raise RightsFileError("NUL byte in rights file")
    try:
        text = content.decode("ascii")
    except UnicodeDecodeError as exc:
        raise RightsFileError("rights file is not ASCII: %s" % exc) from exc
    if not text.strip():
        raise RightsFileError("rights file is empty")
    if any(ord(c) < 32 and c != "\n" for c in text) or "\x7f" in text:
        raise RightsFileError("control character in rights file")
    if not text.endswith("\n") or text.endswith("\n\n"):
        raise RightsFileError("missing trailer line: the file must end with "
                              "exactly one trailer line (file truncated?)")
    pos = text.rfind("\n", 0, len(text) - 1)
    if pos < 0:
        raise RightsFileError("missing trailer line (file truncated?)")
    body, trailer_line = text[:pos + 1], text[pos + 1:-1]
    header = _HEADER_RE.fullmatch(body.split("\n", 1)[0])
    if header is None:
        raise RightsFileError("missing or malformed header line")
    trailer = _TRAILER_RE.fullmatch(trailer_line)
    if trailer is None:
        raise RightsFileError("malformed trailer line or data after it")
    if hashlib.sha256(body.encode("ascii")).hexdigest() != trailer.group(2):
        raise RightsFileError("trailer SHA-256 does not match the content "
                              "(file truncated or modified)")
    if header.group(1) != trailer.group(1):
        raise RightsFileError("header generation %s != trailer generation %s"
                              % (header.group(1), trailer.group(1)))
    generation = int(header.group(1))
    parser = configparser.ConfigParser()
    try:
        parser.read_string(body)
    except configparser.Error as exc:
        raise RightsFileError("not a valid rights file: %s" % exc) from exc
    if parser.defaults():
        raise RightsFileError("a DEFAULT section is not allowed")
    sections = parser.sections()
    if not sections:
        raise RightsFileError("rights file has no sections")
    if sections[-1] != LAST_SECTION:
        raise RightsFileError("last section is %r, expected %r"
                              % (sections[-1], LAST_SECTION))
    for section in sections:
        _validate_section(parser, section)
    last = tuple(parser.get(LAST_SECTION, key, raw=True) for key in _KEYS)
    if last != (".*", ".*", ""):
        raise RightsFileError("section %r must grant nothing (user and "
                              "collection patterns '.*', empty permissions)"
                              % LAST_SECTION)
    if _canonical_body(parser, generation) != body:
        raise RightsFileError("rights file is not in the canonical form "
                              "(comments, spacing or key order differ)")
    return generation, sections


def _validate_section(parser: configparser.ConfigParser, section: str) -> None:
    if _NAME_RE.fullmatch(section) is None or section.upper() == "DEFAULT":
        raise RightsFileError("section name %r not allowed" % section)
    keys = parser.options(section)
    if "groups" in keys:
        raise RightsFileError("section %r has a 'groups' key" % section)
    if sorted(keys) != sorted(_KEYS):
        raise RightsFileError("section %r must have exactly the keys user, "
                              "collection, permissions" % section)
    values = {key: parser.get(section, key, raw=True) for key in _KEYS}
    for key, value in values.items():
        if any(c in value for c in _FORBIDDEN_VALUE_CHARS) \
                or not _printable_ascii(value):
            raise RightsFileError("section %r: %s contains a forbidden "
                                  "character" % (section, key))
    letters = values["permissions"]
    bad = sorted(set(letters) - ALLOWED_PERMISSION_LETTERS)
    if bad:
        raise RightsFileError("section %r: permission letter(s) %s not allowed"
                              % (section, "".join(bad)))
    if len(set(letters)) != len(letters):
        raise RightsFileError("section %r: duplicate permission letter in %r"
                              % (section, letters))
    for key in ("user", "collection"):
        if values[key] == "":
            raise RightsFileError("section %r: %s pattern is empty"
                                  % (section, key))
    try:
        # Radicale formats the patterns before matching; mirror that. With
        # braces forbidden above, format() leaves them unchanged.
        re.compile(values["user"].format())
        re.compile(values["collection"].format(user="x"))
    except Exception as exc:  # noqa: BLE001 - any failure rejects the file
        raise RightsFileError("section %r: pattern does not compile: %s: %s"
                              % (section, type(exc).__name__, exc)) from exc


def _validate_and_build(configuration: Any, content: bytes,
                        label: str) -> Tuple[int, Any]:
    """Validate ``content`` and build the stock engine from those bytes."""
    try:
        generation, sections = validate_rights_bytes(content)
        fd, tmp = tempfile.mkstemp(prefix="radui-rights-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(content)
            cfg = configuration.copy()
            cfg.update({"rights": {"file": tmp}}, "radui_rights")
            try:
                engine = from_file.Rights(cfg)
            except RuntimeError as exc:
                raise RightsFileError(str(exc).replace(tmp, label)) from exc
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        if list(engine._rights_config) != sections:
            raise RightsFileError(
                "Radicale's parser disagrees with the plugin about the "
                "sections of the file")
    except RightsFileError:
        raise
    except Exception as exc:  # noqa: BLE001 - internals changed or I/O error
        raise RightsFileError("%s: %s (Radicale internals changed?)"
                              % (type(exc).__name__, exc)) from exc
    return generation, engine


# -- state transitions ---------------------------------------------------------

def _radicale_version() -> str:
    return str(getattr(radicale, "VERSION", "unknown"))


def _check_radicale_version(version: Optional[str] = None) -> bool:
    """Warn (once) if ``version`` is outside the tested series.

    Returns True if the version is in the tested range. Module hook: tests
    call it with a simulated version string.
    """
    global _version_warned
    version = _radicale_version() if version is None else version
    match = re.match(r"(\d+)\.(\d+)", version)
    in_range = bool(match) and (int(match.group(1)),
                                int(match.group(2))) in TESTED_SERIES
    if not in_range:
        with _version_lock:
            if not _version_warned:
                _version_warned = True
                logger.warning(
                    "%sRadicale %s is outside the tested range %s; check the "
                    "plugin with %s before relying on it", LOG_PREFIX, version,
                    TESTED_SERIES_TEXT, CHECK_PROCEDURE)
    return in_range


def _describe(state: _State) -> str:
    return "generation=%s source=%s" % (
        state.generation if state.generation is not None else "unknown",
        state.source)


def _initial_state(configuration: Any, path: str) -> _State:
    """Load ``path``, else ``path + LKG_SUFFIX``, else raise."""
    watch_sig = watch_digest = None
    settled = True
    problem: Optional[str] = None
    try:
        sig, content, read_ns = _read_consistent(path)
    except _ReadFailure as exc:
        main_error, problem, watch_sig = str(exc), exc.key, exc.sig
    else:
        watch_sig, settled = sig, _is_settled(sig, read_ns)
        watch_digest = hashlib.sha256(content).digest()
        try:
            generation, engine = _validate_and_build(configuration, content,
                                                     path)
        except RightsFileError as exc:
            main_error, problem = str(exc), "invalid"
        else:
            state = _State(engine, watch_digest, generation, "file", sig,
                           watch_digest, settled, None)
            logger.warning("%sactive, hot-reload enabled, %s file=%r "
                           "sections=%d", LOG_PREFIX, _describe(state), path,
                           len(engine._rights_config))
            return state
    lkg = path + LKG_SUFFIX
    try:
        _, lkg_content, _ = _read_consistent(lkg)
        generation, engine = _validate_and_build(configuration, lkg_content,
                                                 lkg)
    except RightsFileError as exc:
        raise RuntimeError(
            "%sno usable rights file (Radicale %s, plugin tested with %s). "
            "%s: %s; %s: %s. Run %s." % (
                LOG_PREFIX, _radicale_version(), TESTED_SERIES_TEXT, path,
                main_error, lkg, exc, CHECK_PROCEDURE)) from exc
    state = _State(engine, hashlib.sha256(lkg_content).digest(), generation,
                   "lkg", watch_sig, watch_digest, settled, problem)
    logger.critical("%srights file unusable (%s); running on the "
                    "last-known-good copy %r, %s. It may be older than the "
                    "last change and grant access that was revoked since.",
                    LOG_PREFIX, main_error, lkg, _describe(state))
    logger.warning("%sactive, hot-reload enabled, %s file=%r sections=%d",
                   LOG_PREFIX, _describe(state), lkg,
                   len(engine._rights_config))
    return state


def _record_problem(shared: _Shared, state: _State, key: str, message: str,
                    sig: Optional[tuple]) -> _State:
    """Record a read problem once (lock held); the old rules stay in force."""
    if state.problem == key and state.watch_sig == sig:
        return state
    logger.error("%scannot use rights file %r, keeping the previous rules "
                 "(%s): %s", LOG_PREFIX, shared.path, _describe(state),
                 message)
    new = state._replace(watch_sig=sig, watch_digest=None, settled=True,
                         problem=key)
    shared.state = new
    return new


def _reload(shared: _Shared) -> _State:
    """Re-read the file and swap the state if needed.

    The read happens under the lock: a thread that read older bytes must not
    be able to install them after a newer version has been installed.
    """
    path = shared.path
    with shared.lock:
        state = shared.state
        try:
            sig, content, read_ns = _read_consistent(path)
        except _ReadFailure as exc:
            return _record_problem(shared, state, exc.key, str(exc), exc.sig)
        digest = hashlib.sha256(content).digest()
        settled = _is_settled(sig, read_ns)
        if digest == state.active_digest and state.source == "file":
            if state.problem is not None:
                logger.warning("%srights file %r is usable again, rules "
                               "unchanged (%s)", LOG_PREFIX, path,
                               _describe(state))
            new = state._replace(watch_sig=sig, watch_digest=digest,
                                 settled=settled, problem=None)
        elif digest == state.watch_digest:
            # Same rejected content as before (only timestamps changed).
            new = state._replace(watch_sig=sig, settled=settled)
        else:
            try:
                generation, engine = _validate_and_build(
                    shared.configuration, content, path)
            except RightsFileError as exc:
                logger.error("%snew rights file %r rejected, keeping the "
                             "previous rules (%s): %s", LOG_PREFIX, path,
                             _describe(state), exc)
                new = state._replace(watch_sig=sig, watch_digest=digest,
                                     settled=settled, problem="invalid")
            else:
                new = _State(engine, digest, generation, "file", sig, digest,
                             settled, None)
                logger.warning(
                    "%sreloaded %r: generation %s -> %s, sections=%d, "
                    "source %s -> file", LOG_PREFIX, path, state.generation,
                    generation, len(engine._rights_config), state.source)
        shared.state = new  # the single assignment
        return new


def _current_state(shared: _Shared) -> _State:
    state = shared.state
    try:
        st = _stat(shared.path)
    except OSError as exc:
        key = _errno_key(exc)
        if state.problem == key and state.watch_sig is None:
            return state
        with shared.lock:
            return _record_problem(shared, shared.state, key,
                                   "cannot stat rights file: %s" % exc, None)
    if state.settled and _signature(st) == state.watch_sig:
        return state
    return _reload(shared)


def _get_shared(configuration: Any, path: str) -> _Shared:
    key = os.path.abspath(path)
    with _registry_lock:
        shared = _shared_by_path.get(key)
        if shared is None:
            state = _initial_state(configuration, path)
            shared = _Shared(path, configuration, state)
            _shared_by_path[key] = shared
        return shared


def _reset_for_tests() -> None:
    """Forget all shared state and the version warning (tests only)."""
    global _version_warned
    with _registry_lock:
        _shared_by_path.clear()
    _version_warned = False


# -- Radicale API --------------------------------------------------------------

class Rights(rights.BaseRights):
    """Stock ``from_file`` matcher behind a change-detecting wrapper."""

    def __init__(self, configuration: Any) -> None:
        super().__init__(configuration)
        _check_radicale_version()
        self._shared = _get_shared(configuration,
                                   configuration.get("rights", "file"))

    def authorization(self, *args: Any, **kwargs: Any) -> str:
        state = _current_state(self._shared)
        return state.engine.authorization(*args, **kwargs)
