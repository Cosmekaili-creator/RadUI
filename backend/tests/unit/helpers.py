# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared fixtures for the backend unit tests (neutral names only)."""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(BACKEND, ".."))
GOLDEN = os.path.join(REPO, "tests", "golden", "rights")
for _p in (BACKEND, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from radui_admin import expected, model as M  # noqa: E402

NOW = "2026-01-01T00:00:00Z"
LATER = "2026-02-03T04:05:06Z"
TOKEN = "0123456789abcdef0123456789abcdef"


def fake_hash(login: str) -> str:
    """A syntactically valid, deterministic, non-secret bcrypt-shaped hash."""
    return "$2b$04$" + hashlib.sha256(login.encode()).hexdigest()[:53]


def _next_token(n: int) -> str:
    return "%032x" % (0xA0000000 + n)


class Builder:
    """Fluent model builder with deterministic tokens (no randomness)."""

    def __init__(self):
        self.m = M.empty_model(TOKEN, bcrypt_cost=4)
        self.n = 0

    def _tok(self):
        self.n += 1
        return _next_token(self.n)

    def account(self, login, *, type="person", admin=False, own_space=True,
                display_name=None):
        self.m = M.create_account(
            self.m, login=login, display_name=display_name or login.title(),
            type=type, admin=admin, own_space=own_space, hash=fake_hash(login),
            now=NOW, by="cli", token=self._tok())
        return self

    def grant(self, owner, collection, grantee, level):
        self.m = M.put_grant(self.m, owner=owner, collection=collection,
                             grantee=grantee, level=level, now=NOW, by="cli",
                             token=self._tok())
        return self

    def disable(self, login):
        self.m = M.disable_account(self.m, login, now=NOW, by="cli",
                                   token=self._tok())
        return self

    def delete(self, login):
        self.m = M.delete_account(self.m, login, now=LATER, by="cli",
                                  token=self._tok())
        return self


def case_models():
    """name -> Model; the golden-file cases."""
    out = {}
    out["admin-only"] = Builder().account("alice", admin=True).m
    b = Builder().account("alice", admin=True)
    b.account("agent-1", type="bot", own_space=False)
    b.account("agent-2", type="bot")
    b.account("bob")
    b.grant("alice", "cal-work", "agent-1", "read")
    b.grant("alice", "contacts", "agent-1", "readwrite")
    b.grant("alice", "cal-work", "agent-2", "read")
    b.grant("bob", "shared-tasks", "agent-1", "readwrite")
    b.grant("bob", "shared-tasks", "alice", "none")
    out["admin-bots-grants"] = b.m
    b = Builder().account("alice", admin=True).account("bob").account("carol")
    b.grant("alice", "cal-work", "bob", "read")
    b.grant("bob", "mine", "carol", "readwrite")
    b.grant("carol", "mine", "bob", "read")
    b.disable("bob")
    out["disabled"] = b.m
    b = Builder().account("alice", admin=True).account("bob").account("carol")
    b.grant("alice", "cal-work", "bob", "read")
    b.grant("carol", "mine", "bob", "readwrite")
    b.grant("carol", "mine", "alice", "none")
    b.delete("bob")
    out["tombstoned"] = b.m
    b = Builder().account("alice", admin=True)
    b.account("carol", own_space=False).account("dave")
    b.grant("dave", "cal", "carol", "readwrite")
    out["ownspace-false"] = b.m
    b = Builder().account("a.b", admin=True).account("x-y_z.0")
    b.account("agent.1", type="bot").account("n0")
    b.grant("x-y_z.0", "my.cal+1", "agent.1", "read")
    b.grant("x-y_z.0", "x@y~z", "agent.1", "readwrite")
    b.grant("a.b", "_Hidden-A", "n0", "read")
    b.grant("n0", "A", "x-y_z.0", "read")
    out["odd-names"] = b.m
    b = Builder().account("alice", admin=True).account("bob", admin=True)
    b.account("carol").account("agent-1", type="bot", own_space=False)
    b.account("dave", own_space=False)
    b.grant("carol", "cal", "agent-1", "read")
    b.grant("carol", "cal", "dave", "readwrite")
    out["two-admins"] = b.m
    return out


MATCHER = None
_py = expected.find_radicale_python()
if _py:
    MATCHER = expected.RadicaleMatcher(_py)
