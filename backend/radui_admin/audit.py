# SPDX-License-Identifier: AGPL-3.0-or-later
"""Audit log: one JSON object per line on stdout (the service journal).

Fields: ``ts, event, actor, ip, target, result, generation``. Passwords,
password hashes and ``Authorization`` values are never written: callers do not
pass them, and every value is additionally scrubbed (a bcrypt hash or a
``Basic`` credential that slips into a field is replaced).
"""
import datetime
import json
import re
import sys
import threading
from typing import IO, Any, Callable, Optional

FIELDS = ("ts", "event", "actor", "ip", "target", "result", "generation")
_SECRET_RE = re.compile(r"\$2[abxy]\$\d\d\$|Basic\s+[A-Za-z0-9+/=]{6,}",
                        re.IGNORECASE)
MAX_VALUE = 200


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def scrub(value: Any) -> Any:
    """Make one field value safe: strings only (or int/None), no secrets,
    bounded length, no control characters."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    text = str(value)
    if _SECRET_RE.search(text):
        return "[redacted]"
    text = "".join(c if c.isprintable() else "?" for c in text)
    return text[:MAX_VALUE]


class Audit:
    def __init__(self, stream: Optional[IO[str]] = None,
                 clock: Callable[[], str] = _utc_now) -> None:
        self._stream = stream
        self._clock = clock
        self._lock = threading.Lock()

    def log(self, event: str, *, actor: Any = None, ip: Any = None,
            target: Any = None, result: Any = "ok",
            generation: Any = None) -> str:
        """Write one line and return it (without the newline)."""
        record = {
            "ts": self._clock(), "event": scrub(event), "actor": scrub(actor),
            "ip": scrub(ip), "target": scrub(target), "result": scrub(result),
            "generation": scrub(generation),
        }
        line = json.dumps(record, sort_keys=False, ensure_ascii=True,
                          separators=(",", ":"))
        with self._lock:
            stream = self._stream if self._stream is not None else sys.stdout
            stream.write(line + "\n")
            stream.flush()
        return line
