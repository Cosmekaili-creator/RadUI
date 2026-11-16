# SPDX-License-Identifier: AGPL-3.0-or-later
"""Name validation shared by the pure backend modules (no I/O).

Every login and collection name that ends up in a generated rights file passes
through this module first. The whitelists are deliberately narrow so that the
later ``re.escape`` step is a second line of defence, not the first.

Error handling: every rejection raises :class:`ApiError`, which carries the
error ``code`` of the HTTP API (``validation``, ``tombstoned``,
``unsupported_collection_name``, ...), the offending ``field`` and a
machine-readable ``reason``.
"""
import re
import unicodedata
from typing import Iterable, Optional

LOGIN_RE = re.compile(r"[a-z0-9][a-z0-9._-]{1,31}")
#: Radicale answers 400 for a collection name ending in "~", so the last
#: character may not be "~" (a lone first character is never "~").
COLLECTION_RE = re.compile(
    r"[A-Za-z0-9_](?:[A-Za-z0-9._@~+-]{0,126}[A-Za-z0-9._@+-])?")
#: A bcrypt hash as stored in an htpasswd file (60 characters).
BCRYPT_HASH_RE = re.compile(r"\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}")
#: Timestamps in the model: UTC, second resolution.
TIMESTAMP_RE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
GEN_TOKEN_RE = re.compile(r"[0-9a-f]{32}")

#: Prefix of the anonymous generation-probe path (top level, reserved).
GENERATION_PREFIX = "radui-gen-"
#: Logins starting with this prefix are reserved for the project itself.
RESERVED_PREFIX = "radui-"
RESERVED_LOGINS = frozenset((
    "root", "admin", "administrator", "radicale", "radui", "ui", "api", "web",
    "sharing", "token", "anonymous", "nobody", "system",
))

DISPLAY_NAME_MAX = 64
#: Unicode categories refused in display names (control, format, surrogate,
#: private use, unassigned, line and paragraph separators).
_BAD_CATEGORIES = frozenset(("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"))

#: HTTP status for every error code of the API (plan 2.2).
ERROR_STATUS = {
    "bad_request": 400, "missing_header": 400, "unauthenticated": 401,
    "forbidden": 403, "not_found": 404, "collection_not_found": 404,
    "exists": 409, "tombstoned": 409, "lockout_last_admin": 409,
    "lockout_self": 409, "too_large": 413, "unsupported_media_type": 415,
    "validation": 422, "unsupported_collection_name": 422,
    "rate_limited": 429, "radicale_unexpected": 502, "busy": 503,
    "model_corrupt": 503, "internal": 500,
}


class ApiError(Exception):
    """An error with an API code; raised by every pure module."""

    def __init__(self, code: str, message: str, field: Optional[str] = None,
                 reason: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.field = field
        self.reason = reason

    @property
    def status(self) -> int:
        return ERROR_STATUS.get(self.code, 500)

    def as_dict(self) -> dict:
        err = {"code": self.code, "message": self.message}
        if self.field is not None:
            err["field"] = self.field
        return {"error": err}

    def __repr__(self) -> str:
        return "ApiError(%r, %r, field=%r, reason=%r)" % (
            self.code, self.message, self.field, self.reason)


def validation_error(field: str, reason: str, message: Optional[str] = None
                     ) -> ApiError:
    return ApiError("validation", message or ("%s: %s" % (field, reason)),
                    field=field, reason=reason)


def is_valid_login(value: object) -> bool:
    """Strict whitelist check (no case folding, no reserved-name check)."""
    return isinstance(value, str) and LOGIN_RE.fullmatch(value) is not None


def is_valid_collection_name(value: object) -> bool:
    return (isinstance(value, str)
            and COLLECTION_RE.fullmatch(value) is not None)


def is_reserved_login(login: str, extra: Iterable[str] = ()) -> bool:
    return (login in RESERVED_LOGINS or login.startswith(RESERVED_PREFIX)
            or login in {e.lower() for e in extra})


def validate_login(raw: object, *, fold: bool = True,
                   tombstoned: Iterable[str] = (),
                   extra_reserved: Iterable[str] = (),
                   field: str = "login") -> str:
    """Return the normalised login or raise :class:`ApiError`.

    ``fold`` lower-cases ASCII input first (creation forms); non-ASCII input is
    always rejected before folding, so characters such as the Kelvin sign can
    never fold into an ASCII letter. With ``fold=False`` upper case is
    rejected (strict mode: lookups, authentication, stored data).
    """
    if not isinstance(raw, str):
        raise validation_error(field, "not_a_string")
    if not raw.isascii():
        raise validation_error(field, "non_ascii")
    value = raw.lower() if fold else raw
    if LOGIN_RE.fullmatch(value) is None:
        raise validation_error(
            field, "pattern",
            "%s must match ^[a-z0-9][a-z0-9._-]{1,31}$" % field)
    if is_reserved_login(value, extra_reserved):
        raise validation_error(field, "reserved",
                               "%s is a reserved name" % field)
    if value in set(tombstoned):
        raise ApiError("tombstoned", "this login was deleted and is reserved",
                       field=field, reason="tombstoned")
    return value


def validate_collection_name(raw: object, *, top_level: bool = False,
                             field: str = "collection") -> str:
    """Return ``raw`` if it is a supported collection name.

    ``top_level`` additionally refuses the reserved ``radui-gen-`` prefix (the
    anonymous generation probe lives at that top-level path).
    """
    if not isinstance(raw, str):
        raise ApiError("unsupported_collection_name", "not a string",
                       field=field, reason="not_a_string")
    if COLLECTION_RE.fullmatch(raw) is None:
        raise ApiError(
            "unsupported_collection_name",
            "collection names must match ^[A-Za-z0-9_][A-Za-z0-9._@~+-]{0,127}$ "
            "and may not end with '~'",
            field=field, reason="pattern")
    if top_level and raw.startswith(GENERATION_PREFIX):
        raise ApiError("unsupported_collection_name",
                       "the radui-gen- prefix is reserved at the top level",
                       field=field, reason="reserved_prefix")
    return raw


def validate_display_name(raw: object, *, field: str = "displayName") -> str:
    """1-64 characters, no control/format characters, no edge whitespace."""
    if not isinstance(raw, str):
        raise validation_error(field, "not_a_string")
    if not raw or raw != raw.strip():
        raise validation_error(field, "empty_or_padded")
    if len(raw) > DISPLAY_NAME_MAX:
        raise validation_error(field, "too_long")
    for ch in raw:
        if unicodedata.category(ch) in _BAD_CATEGORIES:
            raise validation_error(field, "control_character")
    return raw
