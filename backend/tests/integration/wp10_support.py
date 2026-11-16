# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared helpers of the WP10 tests (extends ``harness.py``, never rewrites it).

``WStack`` is the integration ``Stack`` with its own port ranges (Radicale
15320-15329, backend 15330-15339), its own scratch directory
(``.throwaway/wp10``) and a configurable ``max_connections``. ``info()``
reports an observation that is NOT an assertion: INFO lines are never counted
as passes. ``independent_oracle`` holds the letter requirements of every DAV
method, derived from Radicale's source, evaluated against the model only.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness as H  # noqa: E402
from plugin import support  # noqa: E402

REPO = H.REPO
if H.BACKEND not in sys.path:
    sys.path.insert(0, H.BACKEND)

from radui_admin import expected as exp  # noqa: E402
from radui_admin import model as model_mod  # noqa: E402

WP10_RADICALE_PORTS = range(15320, 15330)
WP10_BACKEND_PORTS = range(15330, 15340)
WP10_DIR = os.path.join(REPO, ".throwaway", "wp10")

requires_radicale = H.requires_radicale
basic = H.basic


def info(text):
    """A non-assertion observation. Never counted as a pass."""
    print("INFO %s" % text, file=sys.stderr, flush=True)


class WStack(H.Stack):
    """``harness.Stack`` on the WP10 ports and directory."""

    def __init__(self, name, *, max_connections=24, **kw):
        self.max_connections = max_connections
        saved = (H.RADICALE_PORTS, H.BACKEND_PORTS, H.BASE_DIR)
        H.RADICALE_PORTS, H.BACKEND_PORTS = WP10_RADICALE_PORTS, WP10_BACKEND_PORTS
        H.BASE_DIR = WP10_DIR
        try:
            super().__init__(name, **kw)
        finally:
            H.RADICALE_PORTS, H.BACKEND_PORTS, H.BASE_DIR = saved

    def _write_radicale_conf(self):
        super()._write_radicale_conf()
        with open(self.radicale_conf) as fh:
            text = fh.read()
        text = text.replace("max_connections = 24",
                            "max_connections = %d" % self.max_connections)
        with open(self.radicale_conf, "w") as fh:
            fh.write(text)

    def set_max_connections(self, n):
        self.max_connections = n
        self.stop_radicale()
        self._write_radicale_conf()
        self.start_radicale()

    def model(self):
        with open(os.path.join(self.state, "model.json")) as fh:
            return model_mod.load(fh.read())

    def make_user(self, login, *, admin=False, bot=False, password=None, **kw):
        body = {"login": login, "displayName": login.title(),
                "type": "bot" if bot else "person", "admin": admin}
        if password:
            body["password"] = password
        else:
            body["generate"] = True
        body.update(kw)
        r = self.api("POST", "/accounts", "alice", body)
        if r.status != 201:
            raise RuntimeError("create %s: %s %s" % (login, r.status, r.json))
        self.pw[login] = password or r.json["password"]
        return r


# ---------------------------------------------------------------------------
# Independent oracle: which DAV request passes Radicale's rights checks?
# ---------------------------------------------------------------------------
# Derived by reading radicale/app/{base,propfind,report,get,put,delete,mkcol,
# mkcalendar,proppatch,move}.py (3.9.x), NOT from the backend's generator and
# NOT from observed answers. Letters come from ``expected()`` (WP3 oracle).

def _parent(path):
    return "/".join(path.split("/")[:-1]) if path else ""


def _letters(model, user, path):
    return set(exp.letters(exp.expected(model, user, path)))


def check(model, user, perm, path, kind=None):
    """``Access.check(perm, item)`` of Radicale. ``kind``: None (no item yet),
    ``"tagged"`` (calendar / address book), ``"plain"``, ``"item"``."""
    own = _letters(model, user, path)
    if kind is None:
        mine, par = perm + perm.upper(), perm
    elif kind == "tagged":
        mine, par = perm, ""
    elif kind == "plain":
        mine, par = perm.upper(), ""
    else:
        mine, par = "", perm
    if own & set(mine):
        return True
    if path != _parent(path) and _letters(model, user, _parent(path)) & set(par):
        return True
    return False


class Verdict:
    """``pre``: passes the checks made before the resource is looked up (a
    missing resource then answers 404/409); ``full``: passes everything."""

    def __init__(self, pre, full):
        self.pre, self.full = bool(pre), bool(full and pre)

    def __repr__(self):
        return "Verdict(pre=%s, full=%s)" % (self.pre, self.full)


def v_read(m, u, path, kind):              # PROPFIND (Depth 0), REPORT, GET
    pre = check(m, u, "r", path)
    return Verdict(pre, check(m, u, "r", path, kind))


def v_put_item(m, u, path):                # PUT of an item inside a collection
    pre = check(m, u, "w", path)
    return Verdict(pre, "w" in _letters(m, u, _parent(path)))


def v_put_whole(m, u, path, tagged=True):  # PUT on an existing collection
    pre = check(m, u, "w", path)
    L = _letters(m, u, path)
    return Verdict(pre, ("w" if tagged else "W") in L and "O" in L)


def v_delete_item(m, u, path):
    pre = check(m, u, "w", path)
    return Verdict(pre, check(m, u, "w", path, "item"))


def v_delete_collection(m, u, path, tagged=True):
    pre = check(m, u, "w", path)
    kind = "tagged" if tagged else "plain"
    L = _letters(m, u, path)
    return Verdict(pre, check(m, u, "w", path, kind) and "D" in L)


def v_mkcalendar(m, u, path):
    ok = "w" in _letters(m, u, path)
    return Verdict(ok, ok)


def v_mkcol(m, u, path, tagged=True):
    L = _letters(m, u, path)
    ok = bool(L & set("Ww")) and (("w" if tagged else "W") in L)
    return Verdict(ok, ok)


def v_proppatch(m, u, path):
    L = _letters(m, u, path)
    pre = "l" not in L and check(m, u, "w", path)
    return Verdict(pre, check(m, u, "w", path, "tagged"))


def v_move(m, u, src, dst, kind="item"):
    pre = check(m, u, "w", src) and check(m, u, "w", dst)
    return Verdict(pre, check(m, u, "w", src, kind)
                   and check(m, u, "w", dst, kind))
