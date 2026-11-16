# SPDX-License-Identifier: AGPL-3.0-or-later
"""Generation probe: is the newest rights generation active in Radicale?

Every generated rights file starts with a rule that lets an anonymous request
reach the unguessable path ``/radui-gen-<token>`` with the letter ``i``. After
a write the backend sends an anonymous ``GET`` to that path on
``radicale_url``:

* ``404``: the rule is active, so the new generation is in force;
* ``401``: Radicale still uses an older generation (not active yet);
* anything else, or no answer: unexpected (Radicale down, wrong URL, a
  collection created at that path, which the reserved ``radui-gen-`` prefix
  prevents).

Polling: one probe in flight at a time (an anonymous 401 is delayed by
Radicale's failed-auth delay and holds one of its few connection slots), a new
attempt every 300 ms, at most ``probe_budget_s`` (default 3 s), so about three
attempts when Radicale delays its 401s.

The plugin exposes no endpoint that reports its active generation. The
fallback is :meth:`Prober.generation`: the generation number in the header of
the managed rights file (what was written, not proof of activation). Callers
use it only for display, never as an activation signal.
"""
import http.client
import re
import threading
import time
from typing import Callable, Optional

from .config import Config
from .names import GENERATION_PREFIX

POLL_INTERVAL_S = 0.3
ATTEMPT_TIMEOUT_S = 2.0
_TOKEN_RE = re.compile(r"[0-9a-f]{32}")
_HEADER_RE = re.compile(r"# radui-admin generated; DO NOT EDIT\. "
                        r"generation=([0-9]+)")


class Prober:
    def __init__(self, cfg: Config,
                 sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._cfg = cfg
        self._sleep = sleep
        self._clock = clock
        self._inflight = threading.Lock()
        self.attempts = 0          # total probe requests sent (tests)
        self.last_status = 0

    def probe_once(self, token: str, timeout: float = ATTEMPT_TIMEOUT_S) -> int:
        """One anonymous GET; the HTTP status, or 0 on a network error or when
        another probe is already in flight for longer than ``timeout``."""
        if _TOKEN_RE.fullmatch(token) is None:
            raise ValueError("bad generation token")
        if not self._inflight.acquire(timeout=timeout):
            return 0
        try:
            self.attempts += 1
            https, host, port = self._cfg.radicale_parts
            cls = http.client.HTTPSConnection if https \
                else http.client.HTTPConnection
            conn = cls(host, port, timeout=timeout)
            try:
                conn.request("GET", "/%s%s" % (GENERATION_PREFIX, token),
                             headers={"Connection": "close",
                                      "User-Agent": "radui-admin-probe"})
                resp = conn.getresponse()
                resp.read(1024)
                self.last_status = resp.status
                return resp.status
            except (OSError, http.client.HTTPException):
                self.last_status = 0
                return 0
            finally:
                conn.close()
        finally:
            self._inflight.release()

    def is_active(self, token: str) -> bool:
        return self.probe_once(token) == 404

    def wait_active(self, token: str, budget: Optional[float] = None) -> bool:
        """Poll until the token's path answers 404 or the budget is spent."""
        budget = self._cfg.probe_budget_s if budget is None else budget
        deadline = self._clock() + budget
        while True:
            started = self._clock()
            remaining = deadline - started
            if remaining <= 0:
                return False
            if self.probe_once(token, min(ATTEMPT_TIMEOUT_S, remaining)) == 404:
                return True
            pause = POLL_INTERVAL_S - (self._clock() - started)
            if self._clock() + max(pause, 0) >= deadline:
                return False
            if pause > 0:
                self._sleep(pause)

    def generation(self) -> Optional[int]:
        """Fallback accessor: generation in the header of the managed rights
        file (written, not necessarily active), or ``None``."""
        try:
            with open(self._cfg.rights_path, "rb") as fh:
                first = fh.readline(200).decode("ascii", "replace").rstrip("\n")
        except OSError:
            return None
        m = _HEADER_RE.fullmatch(first)
        return int(m.group(1)) if m else None
