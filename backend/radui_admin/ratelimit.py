# SPDX-License-Identifier: AGPL-3.0-or-later
"""In-memory abuse limiters (per client IP).

* :class:`FailureLimiter`: after ``max_failures`` failed logins from one IP in
  ``window_s`` seconds, that IP is blocked for ``block_s`` seconds
  (HTTP 429 ``rate_limited``). A success does not reset the counter: an
  attacker holding one valid account could otherwise interleave it with
  guesses.
* There is deliberately **no per-login lockout**. A lockout keyed on the login
  would let anyone who knows the admin's login block the admin out by sending
  wrong passwords. Per-IP blocking, nginx ``limit_req`` and the fail2ban jail
  slow guessing without that denial of service.
* :class:`RequestRate`: a per-IP token bucket, for deployments without a
  rate-limiting reverse proxy in front (and for tests).

State is per process and lost on restart. Both classes are thread-safe, take
an injectable clock and bound their memory.
"""
import collections
import threading
import time
from typing import Callable, Deque, Dict, Tuple

from .names import ApiError

MAX_TRACKED_IPS = 10000


def rate_limited(retry_after: float) -> ApiError:
    err = ApiError("rate_limited", "too many requests, try again later",
                   reason="rate_limited")
    err.retry_after = max(1, int(retry_after + 0.999))  # type: ignore[attr-defined]
    return err


class FailureLimiter:
    def __init__(self, max_failures: int = 10, window_s: float = 600,
                 block_s: float = 900,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.max_failures = max_failures
        self.window_s = window_s
        self.block_s = block_s
        self._clock = clock
        self._lock = threading.Lock()
        self._failures: Dict[str, Deque[float]] = {}
        self._blocked_until: Dict[str, float] = {}

    def _prune(self, now: float) -> None:
        for ip in [i for i, t in self._blocked_until.items() if t <= now]:
            del self._blocked_until[ip]
        if len(self._failures) > MAX_TRACKED_IPS:
            for ip in list(self._failures)[:len(self._failures) // 2]:
                del self._failures[ip]

    def check(self, ip: str) -> None:
        """Raise ``rate_limited`` (with ``retry_after``) if ``ip`` is blocked."""
        now = self._clock()
        with self._lock:
            until = self._blocked_until.get(ip)
            if until is not None:
                if until > now:
                    raise rate_limited(until - now)
                del self._blocked_until[ip]

    def record_failure(self, ip: str) -> bool:
        """Count one failed login; True if this failure triggered a block."""
        now = self._clock()
        with self._lock:
            self._prune(now)
            q = self._failures.setdefault(ip, collections.deque())
            q.append(now)
            while q and q[0] <= now - self.window_s:
                q.popleft()
            if len(q) >= self.max_failures:
                self._blocked_until[ip] = now + self.block_s
                q.clear()
                return True
        return False

    def is_blocked(self, ip: str) -> bool:
        try:
            self.check(ip)
        except ApiError:
            return True
        return False


class RequestRate:
    """Token bucket: ``per_minute`` sustained, ``burst`` at once.
    ``per_minute == 0`` disables the limiter."""

    def __init__(self, per_minute: int, burst: int,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.rate = per_minute / 60.0
        self.burst = float(burst)
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: Dict[str, Tuple[float, float]] = {}

    def check(self, ip: str) -> None:
        if self.rate <= 0:
            return
        now = self._clock()
        with self._lock:
            if len(self._buckets) > MAX_TRACKED_IPS:
                self._buckets.clear()
            tokens, last = self._buckets.get(ip, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            if tokens < 1.0:
                self._buckets[ip] = (tokens, now)
                raise rate_limited((1.0 - tokens) / self.rate)
            self._buckets[ip] = (tokens - 1.0, now)
