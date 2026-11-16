# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run one store mutation and die abruptly at a fault point (os._exit), like a
killed process: ``crash_helper.py <config> <point> <create|disable> <login>``.
Used by the crash/reconcile integration test; the real validator and the real
probe are used, only the process death is simulated."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "..")))

from radui_admin import config, filewrite, passwords  # noqa: E402
from radui_admin import model as M  # noqa: E402


def main(cfg_path, point, action, login):
    cfg = config.load(cfg_path)

    def fault(p):
        if p == point:
            os._exit(137)
    store = filewrite.Store(cfg, fault=fault)
    now = store.now()
    if action == "create":
        pw_hash = passwords.hash_password("a long enough passphrase 7!", 4)

        def op(old):
            return M.create_account(old, login=login, display_name="Crash",
                                    hash=pw_hash, now=now, by="alice")
    else:
        def op(old):
            return M.disable_account(old, login, now=now, by="alice")
    store.apply(op, actor="alice")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:5]))
