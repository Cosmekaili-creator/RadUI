# SPDX-License-Identifier: AGPL-3.0-or-later
"""Helpers of the ``test_fix_*`` unit tests (fix work order 1). No tests here.

Every temporary directory is created under ``.throwaway/fix-unit`` and removed
by ``addCleanup``; the parent is removed too when it is left empty.
"""
import contextlib
import json
import os
import shutil
import socket
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: F401  (also puts helpers and the package on sys.path)
import helpers
from radui_admin import filewrite
from radui_admin.audit import Audit

FIX_TMP = os.path.join(helpers.REPO, ".throwaway", "fix-unit")
UNIT_PORTS = range(15375, 15380)


def tmp_root(test):
    """A fresh directory for one test, removed when the test ends."""
    os.makedirs(FIX_TMP, exist_ok=True)
    root = tempfile.mkdtemp(prefix="f-", dir=FIX_TMP)

    def cleanup():
        shutil.rmtree(root, ignore_errors=True)
        with contextlib.suppress(OSError):
            os.rmdir(FIX_TMP)       # only when nobody else uses it
    test.addCleanup(cleanup)
    return root


def free_port():
    for port in UNIT_PORTS:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("no free port in %r" % (UNIT_PORTS,))


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


def read_json(path):
    with open(path) as fh:
        return json.load(fh)


def fresh_store(like):
    """A second ``Store`` over the same directories (a "restarted" process)."""
    stream = apihelpers.ListStream()
    store = filewrite.Store(like.cfg, audit=Audit(stream),
                            prober=apihelpers.FakeProber(like.cfg, True),
                            validator=lambda m, r, u: None)
    store.test_stream = stream
    return store


def base_builder():
    return (helpers.Builder().account("alice", admin=True).account("bob")
            .account("agent-1", type="bot").account("carol"))
