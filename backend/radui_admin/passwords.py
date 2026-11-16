# SPDX-License-Identifier: AGPL-3.0-or-later
"""Password hashing, generation and validation (decision D4).

bcrypt (system ``python3-bcrypt``) produces the ``$2b$`` hashes that
Radicale's htpasswd backend reads. Passwords and hashes are never logged or
included in exceptions raised from this module.
"""
import hmac
import re
import secrets
import unicodedata
from typing import Optional

import bcrypt

from . import names
from .names import validation_error

MIN_BYTES = 12
MAX_BYTES = 72  # bcrypt ignores everything beyond 72 bytes
DEFAULT_COST = 12
GENERATED_LENGTH = 20
#: No 0/O/o, 1/l/I: 56 symbols, about 5.8 bits per character (about 116 bits).
GENERATED_ALPHABET = ("ABCDEFGHJKLMNPQRSTUVWXYZ"
                      "abcdefghijkmnpqrstuvwxyz"
                      "23456789")

_COMMON = (
    "password", "passw0rd", "p4ssword", "pass1234", "password1", "password12",
    "password123", "password1234", "123456", "1234567", "12345678",
    "123456789", "1234567890", "12345678901", "123456789012", "1234567890123",
    "0123456789", "111111", "11111111", "000000", "00000000", "121212",
    "123123", "123321", "654321", "987654321", "qwerty", "qwerty123",
    "qwertyuiop", "qwertyuiop123", "qwertyui", "azerty", "azerty123",
    "azertyuiop", "qazwsx", "qazwsxedc", "zaq12wsx", "1qaz2wsx", "1q2w3e4r",
    "1q2w3e4r5t", "q1w2e3r4", "asdfgh", "asdfghjkl", "asdfghjkl123",
    "zxcvbn", "zxcvbnm", "zxcvbnm123", "abc123", "abcd1234", "abcdefg",
    "abcdefgh", "abcdefghi", "abcdefghijkl", "letmein", "letmein123",
    "welcome", "welcome1", "welcome123", "admin", "admin123", "administrator",
    "adminadmin", "root", "rootroot", "toor", "login", "loginlogin", "master",
    "masterkey", "superman", "batman", "spiderman", "starwars", "pokemon",
    "dragon", "monkey", "shadow", "sunshine", "princess", "football",
    "baseball", "basketball", "soccer", "hockey", "iloveyou", "iloveyou1",
    "loveyou", "trustno1", "trustnoone", "whatever", "freedom", "michael",
    "jordan", "jennifer", "hunter", "hunter2", "ranger", "buster", "thomas",
    "robert", "daniel", "andrew", "charlie", "jessica", "ashley", "nicole",
    "matthew", "joshua", "summer", "winter", "spring", "autumn", "january",
    "september", "october", "november", "december", "monday", "friday",
    "sunday", "football1", "access", "secret", "secret123", "mysecret",
    "changeme", "changeit", "change_me", "default", "guest", "guest123",
    "test", "test123", "testtest", "testing", "testing123", "demo", "demo123",
    "sample", "example", "temp", "temp123", "temporary", "tempass",
    "newpassword", "mypassword", "mypass", "mypassword1", "yourpassword",
    "thepassword", "passphrase", "passcode", "pass", "pa55word", "pa55w0rd",
    "p@ssw0rd", "p@ssword", "passw0rd1", "letmein1", "welcome2", "hello",
    "hello123", "helloworld", "helloworld1", "hellohello", "internet",
    "computer", "computer1", "server", "serverserver", "radicale",
    "calendar", "calendar1", "contacts", "company", "company1", "office",
    "windows", "linux", "ubuntu", "debian", "google", "facebook", "twitter",
    "youtube", "amazon", "samsung", "iphone", "apple", "orange", "banana",
    "cheese", "chocolate", "coffee", "cookie", "flower", "butterfly",
    "rainbow", "ginger", "maggie", "bailey", "diamond", "mustang", "ferrari",
    "porsche", "corvette", "harley", "yankees", "cowboys", "liverpool",
    "chelsea", "arsenal", "barcelona", "realmadrid", "marseille",
    "paris", "london", "newyork", "california", "florida", "america",
)
COMMON_PASSWORDS = tuple(sorted(set(_COMMON)))
_COMMON_SET = frozenset(COMMON_PASSWORDS)
_TRAILING_RE = re.compile(r"[0-9!@#$%^&*()_.+=?-]+$")
_PREFIX_RE = re.compile(r"^[0-9!@#$%^&*()_.+=?-]+")
_LEET = str.maketrans("01345@$!", "oieasasi")


def _is_common(pw: str) -> bool:
    low = pw.lower()
    forms = {low, _TRAILING_RE.sub("", low), _PREFIX_RE.sub("", low)}
    forms.add(_TRAILING_RE.sub("", _PREFIX_RE.sub("", low)))
    forms |= {f.translate(_LEET) for f in list(forms)}
    if any(f in _COMMON_SET for f in forms if f):
        return True
    # a single character (or one short block) repeated over and over
    return len(set(low)) == 1


def _classes(pw: str) -> int:
    kinds = set()
    for ch in pw:
        if ch.islower():
            kinds.add("lower")
        elif ch.isupper():
            kinds.add("upper")
        elif ch.isdigit():
            kinds.add("digit")
        else:
            kinds.add("other")
    return len(kinds)


def validate_password(password: object, login: Optional[str] = None) -> str:
    """Return ``password`` if it satisfies D4, else raise ``ApiError``.

    12-72 UTF-8 bytes, no control characters (NUL included), no normalisation,
    must not contain the login, not on the common-password list, and at least
    three character classes unless it has 16 or more characters.
    """
    field = "password"
    if not isinstance(password, str):
        raise validation_error(field, "not_a_string")
    try:
        raw = password.encode("utf-8")
    except UnicodeEncodeError:
        raise validation_error(field, "not_utf8") from None
    if len(raw) < MIN_BYTES:
        raise validation_error(field, "too_short",
                               "password must be at least 12 bytes")
    if len(raw) > MAX_BYTES:
        raise validation_error(field, "too_long",
                               "password must be at most 72 bytes")
    if any(unicodedata.category(c) == "Cc" for c in password):
        raise validation_error(field, "control_character")
    if login and login.lower() in password.lower():
        raise validation_error(field, "contains_login")
    if _is_common(password):
        raise validation_error(field, "common")
    if len(password) < 16 and _classes(password) < 3:
        raise validation_error(field, "weak",
                               "use at least three kinds of characters "
                               "or 16 characters")
    return password


def generate_password(length: int = GENERATED_LENGTH) -> str:
    """Random password from ``secrets``; always has lower, upper and a digit."""
    if length < 12:
        raise ValueError("length must be at least 12")
    while True:
        pw = "".join(secrets.choice(GENERATED_ALPHABET) for _ in range(length))
        if (any(c.islower() for c in pw) and any(c.isupper() for c in pw)
                and any(c.isdigit() for c in pw)):
            return pw


def hash_password(password: str, cost: int = DEFAULT_COST) -> str:
    """bcrypt hash (``$2b$``) of a password of at most 72 bytes."""
    raw = password.encode("utf-8")
    if len(raw) > MAX_BYTES:
        raise ValueError("password longer than 72 bytes")
    if not 4 <= cost <= 16:
        raise ValueError("bcrypt cost out of range")
    out = bcrypt.hashpw(raw, bcrypt.gensalt(rounds=cost)).decode("ascii")
    if names.BCRYPT_HASH_RE.fullmatch(out) is None:
        raise RuntimeError("unexpected hash format")
    return out


def verify_password(password: str, hashed: str) -> bool:
    """True if ``password`` matches ``hashed``; never raises on bad input.
    Passwords over 72 bytes never match (bcrypt would silently truncate)."""
    try:
        raw = password.encode("utf-8")
        if len(raw) > MAX_BYTES or names.BCRYPT_HASH_RE.fullmatch(hashed) is None:
            return False
        return bcrypt.checkpw(raw, hashed.encode("ascii"))
    except (ValueError, UnicodeError, AttributeError, TypeError):
        return False


def hash_cost(hashed: str) -> int:
    """The cost factor encoded in a bcrypt hash."""
    if names.BCRYPT_HASH_RE.fullmatch(hashed) is None:
        raise ValueError("not a bcrypt hash")
    return int(hashed[4:6])


def constant_time_equals(a: str, b: str) -> bool:
    """Timing-safe string comparison (for tokens, not for passwords)."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
