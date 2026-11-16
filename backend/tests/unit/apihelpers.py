# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fakes for the backend runtime unit tests (no Radicale, no network)."""
import atexit
import os
import shutil
import tempfile
import threading

import helpers  # noqa: F401  (sets sys.path)
from radui_admin import config, filewrite
from radui_admin.audit import Audit
from radui_admin.ratelimit import FailureLimiter, RequestRate

REPO_TMP = os.path.join(helpers.REPO, ".throwaway", "unit-tests")


class ListStream:
    def __init__(self):
        self.lines = []

    def write(self, text):
        self.lines.extend(t for t in text.split("\n") if t)

    def flush(self):
        pass

    def events(self):
        import json
        return [json.loads(x) for x in self.lines]


class FakeProber:
    """Stands in for ``probe.Prober``: ``active`` decides every answer."""

    def __init__(self, cfg, active=True):
        self.cfg = cfg
        self.active = active
        self.waited = []

    def wait_active(self, token, budget=None):
        self.waited.append(token)
        return self.active

    def is_active(self, token):
        return self.active

    def generation(self):
        return filewrite.header_generation(
            filewrite._read_bytes(self.cfg.rights_path))


_LEFTOVERS = []


def _remove_leftovers():
    while _LEFTOVERS:
        shutil.rmtree(_LEFTOVERS.pop(), ignore_errors=True)


atexit.register(_remove_leftovers)


def make_dir(test=None):
    """A fresh temp directory that is always removed again.

    Pass the running ``unittest.TestCase`` so the directory is removed right
    after that test (``addCleanup``). Without it the directory is removed at
    interpreter exit, so nothing is ever left behind either way.
    """
    os.makedirs(REPO_TMP, exist_ok=True)
    path = tempfile.mkdtemp(prefix="u-", dir=REPO_TMP)
    if test is not None:
        test.addCleanup(shutil.rmtree, path, True)
    else:
        _LEFTOVERS.append(path)
    return path


def make_cfg(root, **extra):
    values = {"allowed_hosts": ["example.org"],
              "allowed_origins": ["https://example.org"],
              "state_dir": os.path.join(root, "state"),
              "managed_dir": os.path.join(root, "managed"),
              "bcrypt_cost": 4, "requests_per_minute": 0,
              "lock_timeout_s": 0.3}
    values.update(extra)
    return config.from_dict(values)


def make_store(root, *, active=True, fault=None, validator=None, **cfg_extra):
    cfg = make_cfg(root, **cfg_extra)
    stream = ListStream()
    prober = FakeProber(cfg, active)
    store = filewrite.Store(cfg, audit=Audit(stream), prober=prober,
                            validator=validator or (lambda m, r, u: None),
                            fault=fault)
    store.test_stream = stream
    return store


class StubDav:
    """Radicale stand-in: a password table and canned collection answers."""

    def __init__(self, passwords):
        self.passwords = passwords
        self.owned = 0
        self.kinds = {}
        self.calls = []

    def authenticate(self, auth, ip):
        import base64
        login, _, pw = base64.b64decode(auth.split()[1]).decode().partition(":")
        self.calls.append(("authenticate", login, ip))
        return self.passwords.get(login) == pw

    def count_collections(self, auth, ip, login):
        self.calls.append(("count", login))
        return self.owned

    def collection_kind(self, auth, ip, owner, collection):
        self.calls.append(("kind", owner, collection))
        return self.kinds.get((owner, collection))


class ApiFixture:
    def __init__(self, root, builder=None, **cfg_extra):
        from radui_admin.api import Api
        self.store = make_store(root, **cfg_extra)
        b = builder or helpers.Builder().account("alice", admin=True) \
            .account("bob").account("agent-1", type="bot")
        self.store.install_initial(b.m, probe=False)
        self.passwords = {k: "pw-" + k for k in b.m.accounts}
        self.dav = StubDav(self.passwords)
        cfg = self.store.cfg
        self.limiter = FailureLimiter(3, 60, 60)
        self.api = Api(cfg, self.store, self.dav, self.limiter,
                       RequestRate(0, 1), self.store.audit,
                       diag=lambda m: None)

    def call(self, method, path, login="alice", body=None, headers=None,
             query="", password=None, raw=None):
        import base64
        import json
        from radui_admin.api import Request
        h = {"host": "example.org", "origin": "https://example.org",
             "sec-fetch-site": "same-origin"}
        if login:
            pw = password if password is not None else self.passwords[login]
            h["authorization"] = "Basic " + base64.b64encode(
                ("%s:%s" % (login, pw)).encode()).decode()
        if method != "GET":
            h["x-radui"] = "1"
            h["content-type"] = "application/json"
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        data = raw if raw is not None else (
            json.dumps(body).encode() if body is not None else b"")
        return self.api.dispatch(Request(
            method, "/ui/api" + path + query, h, data, "127.0.0.1"))
