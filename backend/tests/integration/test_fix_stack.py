# SPDX-License-Identifier: AGPL-3.0-or-later
"""``FStack``: the integration ``Stack`` on the ports and directory of the fix
work order 1 tests (Radicale 15360-15369, backend 15370-15374). No tests here.

``FStack.close`` also removes ``.throwaway/fix`` when it is left empty."""
import contextlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness as H  # noqa: E402
from plugin import support  # noqa: F401,E402

if H.BACKEND not in sys.path:
    sys.path.insert(0, H.BACKEND)

from radui_admin import model as model_mod  # noqa: E402

FIX_RADICALE_PORTS = range(15360, 15370)
FIX_BACKEND_PORTS = range(15370, 15375)
FIX_DIR = os.path.join(H.REPO, ".throwaway", "fix")

requires_radicale = H.requires_radicale


class FStack(H.Stack):
    def __init__(self, name, **kw):
        saved = (H.RADICALE_PORTS, H.BACKEND_PORTS, H.BASE_DIR)
        H.RADICALE_PORTS, H.BACKEND_PORTS = FIX_RADICALE_PORTS, \
            FIX_BACKEND_PORTS
        H.BASE_DIR = FIX_DIR
        try:
            super().__init__(name, **kw)
        finally:
            H.RADICALE_PORTS, H.BACKEND_PORTS, H.BASE_DIR = saved

    def close(self):
        super().close()
        with contextlib.suppress(OSError):
            os.rmdir(FIX_DIR)

    def model(self):
        with open(os.path.join(self.state, "model.json")) as fh:
            return model_mod.load(fh.read())

    def make_user(self, login, *, admin=False, bot=False, **kw):
        body = {"login": login, "displayName": login.title(),
                "type": "bot" if bot else "person", "admin": admin,
                "generate": True}
        body.update(kw)
        r = self.api("POST", "/accounts", "alice", body)
        if r.status != 201:
            raise RuntimeError("create %s: %s %s" % (login, r.status, r.json))
        self.pw[login] = r.json["password"]
        return r
