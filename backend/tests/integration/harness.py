# SPDX-License-Identifier: AGPL-3.0-or-later
"""Throwaway stack for the integration tests: Radicale (production plugin) plus
the backend, both on loopback ports of their own, in a directory under the
git-ignored ``.throwaway/``. Nothing here touches a system service or path.

Ports: Radicale 15290-15296, backend 15297-15299. Helpers from
``tests/plugin/support.py`` are imported, not edited.
"""
import atexit
import base64
import http.client
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from collections import namedtuple

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(BACKEND, ".."))
for _p in (BACKEND, os.path.join(BACKEND, "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import bcrypt  # noqa: E402
from plugin import support  # noqa: E402

BASE_DIR = os.environ.get("RADUI_TEST_DIR") or os.path.join(
    REPO, ".throwaway", "integration-tests")
RADICALE_PORTS = range(15290, 15297)
BACKEND_PORTS = range(15297, 15300)
PYTHON = "/usr/bin/python3"
CLI = os.path.join(BACKEND, "bin", "radui-admin-cli")
SERVER = os.path.join(BACKEND, "bin", "radui-admin")
HOST = "example.org"
ORIGIN = "https://example.org"
PREFIX = "/ui/api"

Resp = namedtuple("Resp", "status headers json raw")

requires_radicale = unittest.skipUnless(
    support.RADICALE_BIN and support.radicale_python(),
    "Radicale not found (set RADICALE_BIN)")

LEGACY_RIGHTS = """\
[root]
user: .+
collection:
permissions: R

[principal]
user: .+
collection: {user}
permissions: RW

[admin-all]
user: alice
collection: ^[^/]+/.+$
permissions: RrWw

[admin-top]
user: alice
collection: ^[^/]+$
permissions: R

[own]
user: .+
collection: {user}/[^/]+
permissions: rw

[agent-1-grants]
user: agent-1
collection: ^alice/(cal-work|contacts)$
permissions: rw
"""

_stacks = []


def _cleanup():
    for s in list(_stacks):
        try:
            s.close()
        except Exception:  # noqa: BLE001
            pass


atexit.register(_cleanup)


def _port_free(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _claim(rng, used):
    for port in rng:
        if port not in used and _port_free(port):
            used.add(port)
            return port
    raise RuntimeError("no free port in %r" % (rng,))


_used_ports = set()


def hash_pw(password, cost=4):
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(cost)).decode()


def basic(login, password):
    return "Basic " + base64.b64encode(
        ("%s:%s" % (login, password)).encode()).decode()


class Stack:
    def __init__(self, name, *, cfg=None, legacy=True):
        os.makedirs(BASE_DIR, exist_ok=True)
        self.dir = tempfile.mkdtemp(prefix=name + "-", dir=BASE_DIR)
        os.chmod(self.dir, 0o700)
        self.rport = _claim(RADICALE_PORTS, _used_ports)
        self.bport = _claim(BACKEND_PORTS, _used_ports)
        self.managed = os.path.join(self.dir, "managed")
        self.state = os.path.join(self.dir, "state")
        os.makedirs(self.managed, mode=0o750)
        self.config_path = os.path.join(self.dir, "config.toml")
        self.radicale_conf = os.path.join(self.dir, "radicale.conf")
        self.radicale_log = os.path.join(self.dir, "radicale.log")
        self.out_path = os.path.join(self.dir, "backend.out")
        self.err_path = os.path.join(self.dir, "backend.err")
        self.pw = {"alice": secrets.token_urlsafe(14),
                   "agent-1": secrets.token_urlsafe(14)}
        self.cfg_extra = dict(cfg or {})
        self.rproc = self.bproc = None
        self.import_output = ""
        self.seen_headers = set()
        self.secrets_seen = set()
        _stacks.append(self)
        self._write_config()
        self._write_radicale_conf()
        if legacy:
            self.legacy_users = os.path.join(self.dir, "legacy-users")
            self.legacy_rights = os.path.join(self.dir, "legacy-rights")
            with open(self.legacy_users, "w") as fh:
                for k, v in self.pw.items():
                    fh.write("%s:%s\n" % (k, hash_pw(v)))
            os.chmod(self.legacy_users, 0o600)
            with open(self.legacy_rights, "w") as fh:
                fh.write(LEGACY_RIGHTS)

    # -- files ------------------------------------------------------------
    def _write_config(self):
        values = {
            "radicale_url": "http://127.0.0.1:%d" % self.rport,
            "listen": "127.0.0.1:%d" % self.bport,
            "allowed_hosts": [HOST, "127.0.0.1:%d" % self.bport],
            "allowed_origins": [ORIGIN],
            "managed_dir": self.managed, "state_dir": self.state,
            "radicale_python": support.radicale_python(),
            "bcrypt_cost": 4, "requests_per_minute": 0,
            "rate_limit_failures": 1000, "socket_timeout_s": 5,
        }
        values.update(self.cfg_extra)
        lines = []
        for k, v in values.items():
            lines.append("%s = %s" % (k, json.dumps(v)))
        with open(self.config_path, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        os.chmod(self.config_path, 0o600)

    def _write_radicale_conf(self):
        with open(self.radicale_conf, "w") as fh:
            fh.write("\n".join([
                "[server]", "hosts = 127.0.0.1:%d" % self.rport,
                "max_connections = 24", "",
                "[auth]", "type = htpasswd",
                "htpasswd_filename = %s" % os.path.join(self.managed, "users"),
                "htpasswd_encryption = bcrypt", "delay = 0", "",
                "[rights]", "type = radui_rights",
                "file = %s" % os.path.join(self.managed, "rights"),
                "permit_delete_collection = False",
                "permit_overwrite_collection = False", "",
                "[storage]", "filesystem_folder = %s"
                % os.path.join(self.dir, "collections"), "",
                "[logging]", "level = warning", ""]))

    # -- processes ----------------------------------------------------------
    def cli(self, *args, env=None, timeout=60):
        e = {"PATH": os.environ.get("PATH", "")}
        e.update(env or {})
        p = subprocess.run([PYTHON, "-I", CLI, "--config", self.config_path]
                           + list(args), capture_output=True, text=True,
                           timeout=timeout, env=e)
        return p.returncode, p.stdout, p.stderr

    def import_legacy(self, *extra):
        rc, out, err = self.cli(
            "import", "--admin", "alice", "--users", self.legacy_users,
            "--rights", self.legacy_rights, *extra)
        self.import_output = out + err
        if rc != 0:
            raise RuntimeError("import failed (%d):\n%s" % (rc, out + err))
        return out

    def start_radicale(self, timeout=30):
        env = dict(os.environ)
        env["PYTHONPATH"] = support.PLUGIN_DIR
        self.rlog = open(self.radicale_log, "ab")
        self.rproc = subprocess.Popen(
            [support.RADICALE_BIN, "--config", self.radicale_conf], env=env,
            stdout=self.rlog, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True)
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.rproc.poll() is not None:
                raise RuntimeError("Radicale did not start:\n"
                                   + self.radicale_log_text())
            if not _port_free(self.rport):
                return
            time.sleep(0.05)
        raise RuntimeError("Radicale start timeout")

    def start_backend(self, timeout=30, expect_up=True):
        self.bout = open(self.out_path, "ab")
        self.berr = open(self.err_path, "ab")
        self.bproc = subprocess.Popen(
            [PYTHON, "-I", SERVER, "--config", self.config_path],
            stdout=self.bout, stderr=self.berr, stdin=subprocess.DEVNULL,
            start_new_session=True)
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.bproc.poll() is not None:
                if expect_up:
                    raise RuntimeError("backend exited:\n" + self.stderr())
                return
            if not _port_free(self.bport):
                return
            time.sleep(0.05)
        raise RuntimeError("backend start timeout")

    def _stop(self, proc, sig=signal.SIGTERM):
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                pass
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()

    def stop_backend(self, sig=signal.SIGTERM):
        self._stop(self.bproc, sig)
        self.bproc = None
        for name in ("bout", "berr"):
            f = getattr(self, name, None)
            if f:
                f.close()
                setattr(self, name, None)

    def stop_radicale(self):
        self._stop(self.rproc)
        self.rproc = None
        if getattr(self, "rlog", None):
            self.rlog.close()
            self.rlog = None

    def up(self):
        """Import the legacy files, start Radicale, then the backend."""
        self.import_legacy()
        self.start_radicale()
        self.start_backend()
        return self

    def close(self):
        self.stop_backend()
        self.stop_radicale()
        for fh in ("rlog", "bout", "berr"):
            f = getattr(self, fh, None)
            if f:
                f.close()
                setattr(self, fh, None)
        shutil.rmtree(self.dir, ignore_errors=True)
        if self in _stacks:
            _stacks.remove(self)
        _used_ports.discard(self.rport)
        _used_ports.discard(self.bport)

    def radicale_log_text(self):
        try:
            with open(self.radicale_log, errors="replace") as fh:
                return fh.read()
        except OSError:
            return ""

    def stdout(self):
        with open(self.out_path, errors="replace") as fh:
            return fh.read()

    def stderr(self):
        with open(self.err_path, errors="replace") as fh:
            return fh.read()

    # -- HTTP -------------------------------------------------------------
    def api(self, method, path, login=None, body=None, *, password=None,
            headers=None, raw=None, mutate_headers=True, host=HOST,
            query="", auth=None, timeout=30):
        """Call the backend. ``body`` is JSON-encoded; ``raw`` replaces it."""
        h = {"Host": host, "Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}
        if login is not None:
            h["Authorization"] = basic(login, password if password is not None
                                       else self.pw[login])
        if auth is not None:
            h["Authorization"] = auth
        data = None
        if raw is not None:
            data = raw
        elif body is not None or (mutate_headers and method != "GET"):
            data = json.dumps(body if body is not None else {}).encode()
        if method != "GET" and mutate_headers:
            h["X-RadUI"] = "1"
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        resp = self._request("127.0.0.1", self.bport, method,
                             PREFIX + path + query, data, h, timeout)
        self.seen_headers.update(resp.headers)
        if isinstance(resp.json, dict) and "password" in resp.json:
            self.secrets_seen.add(resp.json["password"])
        return resp

    @staticmethod
    def _request(host, port, method, path, data, headers, timeout=30):
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        try:
            conn.putrequest(method, path, skip_host=True,
                            skip_accept_encoding=True)
            for k, v in headers.items():
                conn.putheader(k, v)
            if data is not None and "Content-Length" not in headers \
                    and "Transfer-Encoding" not in headers:
                conn.putheader("Content-Length", str(len(data)))
            conn.endheaders()
            if data:
                try:
                    conn.send(data)
                except OSError:
                    pass
            r = conn.getresponse()
            raw = r.read()
            try:
                parsed = json.loads(raw) if raw else None
            except ValueError:
                parsed = None
            return Resp(r.status, {k.lower(): v for k, v in r.getheaders()},
                        parsed, raw)
        finally:
            conn.close()

    def dav(self, method, path, login, body=None, headers=None, password=None):
        pw = password if password is not None else self.pw[login]
        h = dict(headers or {})
        h["Authorization"] = basic(login, pw)
        if isinstance(body, str):
            body = body.encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.rport, timeout=60)
        try:
            conn.request(method, path, body=body, headers=h)
            r = conn.getresponse()
            data = r.read()
            return support.Resp(r.status, {k.lower(): v for k, v in
                                           r.getheaders()}, data)
        finally:
            conn.close()

    def radicale_probe(self, token):
        conn = http.client.HTTPConnection("127.0.0.1", self.rport, timeout=10)
        try:
            conn.request("GET", "/radui-gen-" + token)
            r = conn.getresponse()
            r.read()
            return r.status
        finally:
            conn.close()

    def mkcalendar(self, login, owner, name):
        return self.dav("MKCALENDAR", "/%s/%s/" % (owner, name), login,
                        support.MKCALENDAR, support.XML_HDR)

    def put_event(self, login, owner, coll, uid, summary="s"):
        return self.dav("PUT", "/%s/%s/%s.ics" % (owner, coll, uid), login,
                        support.ics_event(uid, summary), support.ICS_HDR)

    def level(self, login, owner, coll):
        r = self.dav("PROPFIND", "/%s/%s/" % (owner, coll), login,
                     support.PROPFIND_PRIV, dict(support.XML_HDR, Depth="0"))
        if r.status == 207:
            return "W" if b"write-content" in r.body else "R"
        return "-" if r.status == 403 else str(r.status)

    def read_json(self, path):
        with open(path) as fh:
            return json.load(fh)
