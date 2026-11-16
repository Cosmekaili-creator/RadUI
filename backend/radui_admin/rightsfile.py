# SPDX-License-Identifier: AGPL-3.0-or-later
"""Format and checker of the generated Radicale rights file (pure, no I/O).

File layout (ASCII only, LF line ends)::

    # radui-admin generated; DO NOT EDIT. generation=<N>
    <blank line>
    [section-name]
    user: <regex>
    collection: <regex>
    permissions: <letters>
    <blank line>
    ... more sections, the last one is [zzz-deny] ...
    # radui-end generation=<N> sha256=<hex>

The SHA-256 covers every byte before the trailer line (header through the
newline that ends the last section's blank line). A truncated, edited or
half-written file therefore never validates.

``check_text`` mirrors how Radicale's ``rights/from_file.py`` reads the file
(``configparser.ConfigParser`` defaults, ``user.format()``,
``collection.format(user=...)``, ``re.fullmatch``) and reports every rule of
decision D2.
"""
import configparser
import hashlib
import re
from typing import List, NamedTuple, Sequence

HEADER_PREFIX = "# radui-admin generated; DO NOT EDIT. generation="
TRAILER_PREFIX = "# radui-end generation="
DENY_SECTION = "zzz-deny"
ALLOWED_LETTERS = frozenset("RWrwDOil")
FORBIDDEN_CHARS = "{}%\r\n"
KEYS = ("user", "collection", "permissions")

_GEN = r"(0|[1-9][0-9]*)"
_HEADER_RE = re.compile(re.escape(HEADER_PREFIX) + _GEN)
_TRAILER_RE = re.compile(re.escape(TRAILER_PREFIX) + _GEN + r" sha256=([0-9a-f]{64})")
_NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,100}")


class Section(NamedTuple):
    name: str
    user: str
    collection: str
    permissions: str


class RightsError(NamedTuple):
    code: str
    message: str

    def __str__(self) -> str:
        return "%s: %s" % (self.code, self.message)


def error_codes(errors: Sequence[RightsError]) -> List[str]:
    return [e.code for e in errors]


def _printable_ascii(value: str) -> bool:
    return value.isascii() and all(32 <= ord(c) < 127 for c in value)


def _body(sections: Sequence[Section], generation: int) -> str:
    parts = ["%s%d\n\n" % (HEADER_PREFIX, generation)]
    for s in sections:
        parts.append("[%s]\nuser: %s\ncollection: %s\npermissions: %s\n\n"
                     % (s.name, s.user, s.collection, s.permissions))
    return "".join(parts)


def sha256_hex(body: str) -> str:
    return hashlib.sha256(body.encode("ascii")).hexdigest()


def render(sections: Sequence[Section], generation: int) -> str:
    """Render the file. Raises ``ValueError`` if the result would be unsafe.

    Safety is established by ``check_text`` on the rendered text (so the
    generator and the checker can never disagree) plus a ConfigParser round
    trip that must reproduce exactly the intended tuples.
    """
    if not isinstance(generation, int) or isinstance(generation, bool) \
            or generation < 0:
        raise ValueError("generation must be a non-negative integer")
    sections = [Section(*s) for s in sections]
    for s in sections:
        for value in s:
            if not isinstance(value, str) or not _printable_ascii(value):
                raise ValueError("non-printable or non-ASCII field in %r" % (s,))
    body = _body(sections, generation)
    text = "%s%s%d sha256=%s\n" % (body, TRAILER_PREFIX, generation,
                                   sha256_hex(body))
    errors = check_text(text)
    if errors:
        raise ValueError("generated rights file rejected: %s" % str(errors[0]))
    parsed = parse_sections(text)
    if parsed != sections:
        raise ValueError("rights round trip mismatch")
    return text


def _split(text: str):
    """Return (header_line, body, trailer_line) or raise ValueError."""
    pos = text.rfind("\n", 0, len(text) - 1)
    if pos < 0:
        raise ValueError("no trailer")
    body = text[:pos + 1]
    trailer = text[pos + 1:-1]
    header = body.split("\n", 1)[0]
    return header, body, trailer


def _parser(body: str) -> configparser.ConfigParser:
    cp = configparser.ConfigParser()  # same defaults as radicale from_file
    cp.read_string(body)
    return cp


def parse_sections(text: str) -> List[Section]:
    """Read the sections back with ConfigParser (raw values). Call only on
    text for which ``check_text`` returned no errors."""
    _, body, _ = _split(text)
    cp = _parser(body)
    return [Section(s, cp.get(s, "user", raw=True),
                    cp.get(s, "collection", raw=True),
                    cp.get(s, "permissions", raw=True))
            for s in cp.sections()]


def check_text(text: object) -> List[RightsError]:
    """Return every D2 violation found in ``text`` (empty list = acceptable)."""
    err: List[RightsError] = []

    def add(code: str, msg: str) -> None:
        err.append(RightsError(code, msg))

    if not isinstance(text, str) or not text.strip():
        return [RightsError("empty", "file is empty or not text")]
    if not text.isascii():
        return [RightsError("non_ascii", "file contains non-ASCII characters")]
    if "\r" in text or any(ord(c) < 32 and c != "\n" for c in text) \
            or "\x7f" in text:
        return [RightsError("control_chars", "control characters present")]
    if not text.endswith("\n") or text.endswith("\n\n"):
        return [RightsError("bad_trailer", "file must end with the trailer line")]
    try:
        header, body, trailer = _split(text)
    except ValueError:
        return [RightsError("bad_trailer", "no trailer line")]
    hm = _HEADER_RE.fullmatch(header)
    tm = _TRAILER_RE.fullmatch(trailer)
    if hm is None:
        add("bad_header", "first line is not the radui-admin header")
    if tm is None:
        add("bad_trailer", "last line is not a radui-end trailer")
    if hm is None or tm is None:
        return err
    if hm.group(1) != tm.group(1):
        add("generation_mismatch", "header generation %s, trailer generation %s"
            % (hm.group(1), tm.group(1)))
    if sha256_hex(body) != tm.group(2):
        add("hash_mismatch", "sha256 of the body does not match the trailer")

    try:
        cp = _parser(body)
    except configparser.Error as exc:
        add("parse_error", "%s: %s" % (type(exc).__name__, str(exc).splitlines()[0]))
        return err
    if cp.defaults():
        add("default_section", "a DEFAULT section is not allowed")
    sections = cp.sections()
    if not sections:
        add("no_sections", "no rule sections")
        return err
    if sections[-1] != DENY_SECTION:
        add("last_section_not_deny", "last section must be [%s]" % DENY_SECTION)
    ok_for_roundtrip = True
    for name in sections:
        if _NAME_RE.fullmatch(name) is None or name.upper() == "DEFAULT":
            add("bad_section_name", "section name %r not allowed" % name)
            ok_for_roundtrip = False
            continue
        keys = cp.options(name)
        if "groups" in keys:
            add("groups_key", "[%s] uses a groups key" % name)
            ok_for_roundtrip = False
        elif sorted(keys) != sorted(KEYS):
            add("bad_keys", "[%s] must have exactly user/collection/permissions"
                % name)
            ok_for_roundtrip = False
        if "groups" in keys or sorted(keys) != sorted(KEYS):
            continue
        user, coll, perms = (cp.get(name, k, raw=True) for k in KEYS)
        bad_chars = False
        for key, value in zip(KEYS, (user, coll, perms)):
            if any(c in value for c in FORBIDDEN_CHARS) \
                    or not _printable_ascii(value):
                add("forbidden_chars", "[%s] %s contains a forbidden character"
                    % (name, key))
                bad_chars = True
        if bad_chars:
            ok_for_roundtrip = False
            continue
        if (set(perms) - ALLOWED_LETTERS) or len(set(perms)) != len(perms):
            add("bad_letters", "[%s] permissions %r not allowed" % (name, perms))
            ok_for_roundtrip = False
        for key, value in (("user", user), ("collection", coll)):
            if value == "":
                add("empty_pattern", "[%s] %s pattern is empty" % (name, key))
                ok_for_roundtrip = False
                continue
            try:
                # Radicale formats before matching; mirror it exactly.
                re.compile(value.format() if key == "user"
                           else value.format(user=re.escape("probe")))
            except Exception as exc:  # noqa: BLE001 - any failure is a reject
                add("bad_pattern", "[%s] %s pattern does not compile: %s"
                    % (name, key, exc))
                ok_for_roundtrip = False
    if sections and sections[-1] == DENY_SECTION and ok_for_roundtrip:
        last = Section(DENY_SECTION,
                       cp.get(DENY_SECTION, "user", raw=True),
                       cp.get(DENY_SECTION, "collection", raw=True),
                       cp.get(DENY_SECTION, "permissions", raw=True))
        if last[1:] != (".*", ".*", ""):
            add("last_section_not_deny", "[%s] must be .* / .* / empty"
                % DENY_SECTION)
    if ok_for_roundtrip and not err:
        rebuilt = _body(parse_sections(text), int(hm.group(1)))
        if rebuilt != body:
            add("not_canonical", "text differs from its canonical rendering")
    return err
