# SPDX-License-Identifier: AGPL-3.0-or-later
"""Helpers for the rights-plugin tests (throwaway Radicale instances only).

Everything here starts, drives and removes *throwaway* Radicale instances:
current user, 127.0.0.1 only, ports 15380-15389, directories under the
git-ignored ``.throwaway/plugin-tests/`` of the repository (or
``RADUI_TEST_DIR``). Nothing here touches a system service or system path.

The rights files are rendered by a small local renderer below; the plugin
tests deliberately do not import the admin backend.

Environment:
    RADICALE_BIN      radicale executable (also read from the repo's .env.local)
    RADUI_TEST_DIR    base directory for instances
"""

import atexit
import hashlib
import http.client
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
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PLUGIN_DIR = os.path.join(REPO, "backend", "plugin")
BASE_DIR = os.environ.get("RADUI_TEST_DIR") or os.path.join(
    REPO, ".throwaway", "plugin-tests")
PORT_FIRST, PORT_LAST = 15380, 15389
PLUGIN_NAME = "radui_rights"

Resp = namedtuple("Resp", "status headers body")
Section = namedtuple("Section", "name user collection perms")


# -- locating Radicale --------------------------------------------------------

def _env_local(key):
    try:
        with open(os.path.join(REPO, ".env.local")) as fh:
            for line in fh:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return None


def find_radicale():
    cand = os.environ.get("RADICALE_BIN") or _env_local("RADICALE_BIN") \
        or shutil.which("radicale")
    if cand and (os.path.isfile(cand) and os.access(cand, os.X_OK)):
        return cand
    found = shutil.which(cand) if cand else None
    return found


RADICALE_BIN = find_radicale()


def radicale_python():
    """The interpreter that runs Radicale (read from the script's shebang)."""
    if not RADICALE_BIN:
        return None
    try:
        with open(RADICALE_BIN, "rb") as fh:
            first = fh.readline().decode(errors="replace").strip()
    except OSError:
        return None
    if first.startswith("#!"):
        py = first[2:].split()[0]
        if os.path.isfile(py):
            return py
    return None


requires_radicale = unittest.skipUnless(
    RADICALE_BIN and radicale_python(),
    "Radicale not found (set RADICALE_BIN or put it on PATH)")

_instances = []
_info_lines = []


def info(text):
    """Report a non-assertion observation (never counted as a pass)."""
    line = "INFO %s" % text
    _info_lines.append(line)
    print(line, file=sys.stderr, flush=True)


def _cleanup():
    for inst in list(_instances):
        try:
            inst.close()
        except Exception:  # noqa: BLE001
            pass


atexit.register(_cleanup)


def _port_free(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def claim_port():
    used = {i.port for i in _instances}
    for port in range(PORT_FIRST, PORT_LAST + 1):
        if port not in used and _port_free(port):
            return port
    raise RuntimeError("no free port in %d-%d" % (PORT_FIRST, PORT_LAST))


# -- rights file rendering ------------------------------------------------------

def header_line(generation):
    return b"# radui-admin generated; DO NOT EDIT. generation=%d\n" % generation


def render_body(sections, generation, extra_keys=None):
    """Header plus sections (everything the trailer hash covers)."""
    out = [header_line(generation), b"\n"]
    for sec in sections:
        text = "[%s]\nuser: %s\ncollection: %s\npermissions: %s\n" % (
            sec.name, sec.user, sec.collection, sec.perms)
        if extra_keys and sec.name in extra_keys:
            text += extra_keys[sec.name] + "\n"
        out.append((text + "\n").encode("ascii"))
    return b"".join(out)


def trailer_for(body, generation):
    return b"# radui-end generation=%d sha256=%s\n" % (
        generation, hashlib.sha256(body).hexdigest().encode())


def render(sections, generation, **kw):
    body = render_body(sections, generation, **kw)
    return body + trailer_for(body, generation)


def new_token():
    return secrets.token_hex(16)


def standard_sections(token, grants=(), users=("alice", "bob")):
    """The test layout: probe rule, root, principals, own collections,
    grants as ``(grantee, owner, collection, letters)``, final deny."""
    secs = [Section("g000-generation", "^$", "^radui-gen-%s$" % token, "i"),
            Section("g010-root", ".+", "^$", "R")]
    for u in users:
        secs.append(Section("u-%s-principal" % u, "^%s$" % u, "^%s$" % u, "RW"))
        secs.append(Section("u-%s-own" % u, "^%s$" % u,
                            "^%s/[^/]+$" % u, "rwDO"))
    for i, (grantee, owner, coll, letters) in enumerate(grants, 1):
        secs.append(Section("gr-%04d" % i, "^%s$" % grantee,
                            "^%s/%s$" % (owner, coll), letters))
    secs.append(Section("zzz-deny", ".*", ".*", ""))
    return secs


def good_rights(generation, grants=(), token=None, users=("alice", "bob")):
    token = token or new_token()
    return render(standard_sections(token, grants, users), generation), token


# -- request bodies --------------------------------------------------------------

NS = ('xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"')
MKCALENDAR = ('<?xml version="1.0"?><C:mkcalendar %s><D:set><D:prop>'
              '<D:displayname>t</D:displayname>'
              '<C:supported-calendar-component-set><C:comp name="VEVENT"/>'
              '</C:supported-calendar-component-set></D:prop></D:set>'
              '</C:mkcalendar>' % NS)
PROPFIND_PRIV = ('<?xml version="1.0"?><D:propfind %s><D:prop>'
                 '<D:current-user-privilege-set/></D:prop></D:propfind>' % NS)
XML_HDR = {"Content-Type": "application/xml; charset=utf-8"}
ICS_HDR = {"Content-Type": "text/calendar"}


def ics_event(uid, summary="s"):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RadUI test//EN\r\n"
            "BEGIN:VEVENT\r\nUID:%s\r\nDTSTAMP:20260101T000000Z\r\n"
            "DTSTART:20260601T100000Z\r\nDTEND:20260601T110000Z\r\n"
            "SUMMARY:%s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n" % (uid, summary))


# -- the instance -----------------------------------------------------------------

class Instance:
    """One throwaway Radicale with the plugin loaded through PYTHONPATH."""

    def __init__(self, name, logins=("alice", "bob"), level="warning",
                 max_connections=24):
        os.makedirs(BASE_DIR, exist_ok=True)
        self.dir = tempfile.mkdtemp(prefix=name + "-", dir=BASE_DIR)
        os.chmod(self.dir, 0o700)
        self.port = claim_port()
        self.log_level = level
        self.max_connections = max_connections
        self.proc = None
        self.pw = {u: secrets.token_urlsafe(12) for u in logins}
        self.rights_path = os.path.join(self.dir, "rights")
        self.lkg_path = self.rights_path + ".lkg"
        self.users_path = os.path.join(self.dir, "users")
        self.conf_path = os.path.join(self.dir, "config")
        self.log_path = os.path.join(self.dir, "radicale.log")
        os.makedirs(os.path.join(self.dir, "collections"))
        with open(self.users_path, "w") as fh:
            fh.write("".join("%s:%s\n" % kv for kv in self.pw.items()))
        os.chmod(self.users_path, 0o600)
        with open(self.conf_path, "w") as fh:
            fh.write("\n".join([
                "[server]", "hosts = 127.0.0.1:%d" % self.port,
                "max_connections = %d" % self.max_connections, "",
                "[auth]", "type = htpasswd",
                "htpasswd_filename = %s" % self.users_path,
                "htpasswd_encryption = plain", "delay = 0", "",
                "[rights]", "type = %s" % PLUGIN_NAME,
                "file = %s" % self.rights_path,
                "permit_delete_collection = False",
                "permit_overwrite_collection = False", "",
                "[storage]", "filesystem_folder = %s"
                % os.path.join(self.dir, "collections"), "",
                "[logging]", "level = %s" % level, ""]))
        _instances.append(self)

    # files
    def atomic_write(self, path, data, mode=0o640):
        tmp = "%s.tmp%d" % (path, os.getpid())
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    def write_rights(self, data, how="atomic", keep_mtime=False):
        """``atomic`` (rename), ``inplace`` (same inode, truncating rewrite) or
        ``inplace-samelen`` (overwrite without truncating). ``keep_mtime``
        restores the previous mtime with ``os.utime`` afterwards. Returns
        (stat before, stat after)."""
        before = os.stat(self.rights_path) if os.path.exists(
            self.rights_path) else None
        if how == "atomic":
            self.atomic_write(self.rights_path, data)
        else:
            with open(self.rights_path,
                      "r+b" if how == "inplace-samelen" else "wb") as fh:
                fh.write(data)
        if keep_mtime and before is not None:
            os.utime(self.rights_path,
                     ns=(before.st_atime_ns, before.st_mtime_ns))
        return before, os.stat(self.rights_path)

    # process
    def start(self, timeout=30):
        """Start Radicale; returns True if it is listening."""
        env = dict(os.environ)
        env["PYTHONPATH"] = PLUGIN_DIR
        self.logfh = open(self.log_path, "ab")
        self.proc = subprocess.Popen(
            [RADICALE_BIN, "--config", self.conf_path], env=env,
            stdout=self.logfh, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True)
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None:
                return False
            if not _port_free(self.port):
                return True
            time.sleep(0.05)
        return False

    def start_expect_failure(self, timeout=15):
        """Start Radicale; True if it exited (refused to start)."""
        env = dict(os.environ)
        env["PYTHONPATH"] = PLUGIN_DIR
        self.logfh = open(self.log_path, "ab")
        self.proc = subprocess.Popen(
            [RADICALE_BIN, "--config", self.conf_path], env=env,
            stdout=self.logfh, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            self.proc.wait(timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def stop(self, timeout=15):
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.proc.wait()
        self.proc = None
        fh = getattr(self, "logfh", None)
        if fh is not None:
            fh.close()
            self.logfh = None

    def close(self):
        self.stop()
        try:
            os.chmod(self.rights_path, 0o640)
        except OSError:
            pass
        for _ in range(3):
            shutil.rmtree(self.dir, ignore_errors=True)
            if not os.path.exists(self.dir):
                break
            time.sleep(0.1)
        if self in _instances:
            _instances.remove(self)

    def log(self):
        try:
            with open(self.log_path, errors="replace") as fh:
                return fh.read()
        except OSError:
            return ""

    def log_lines(self, token, since=0):
        return [ln for ln in self.log()[since:].splitlines() if token in ln]

    # http
    def req(self, method, path, user=None, body=None, headers=None,
            timeout=60):
        import base64
        h = dict(headers or {})
        if user is not None:
            h["Authorization"] = "Basic " + base64.b64encode(
                ("%s:%s" % (user, self.pw[user])).encode()).decode()
        if isinstance(body, str):
            body = body.encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.port,
                                          timeout=timeout)
        try:
            conn.request(method, path, body=body, headers=h)
            r = conn.getresponse()
            data = r.read()
            return Resp(r.status, {k.lower(): v for k, v in r.getheaders()},
                        data)
        except (OSError, http.client.HTTPException) as exc:
            return Resp(0, {"x-error": type(exc).__name__},
                        repr(exc).encode())
        finally:
            conn.close()

    def probe(self, token):
        """Anonymous GET of the generation path: 404 = active, 401 = not."""
        return self.req("GET", "/radui-gen-" + token).status

    def confirm(self, token, timeout=5.0):
        """Poll the probe until it answers 404; return the monotonic time
        of the first 404, or None."""
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            if self.probe(token) == 404:
                return time.monotonic()
            time.sleep(0.005)
        return None

    def make_calendar(self, owner, name):
        return self.req("MKCALENDAR", "/%s/%s/" % (owner, name), owner,
                        MKCALENDAR, XML_HDR)

    def put_event(self, user, owner, coll, uid, summary="s"):
        return self.req("PUT", "/%s/%s/%s.ics" % (owner, coll, uid), user,
                        ics_event(uid, summary), ICS_HDR)

    def can_write(self, user, owner, coll):
        """PROPFIND privilege set: True if write-content is offered."""
        r = self.req("PROPFIND", "/%s/%s/" % (owner, coll), user,
                     PROPFIND_PRIV, dict(XML_HDR, Depth="0"))
        return r.status, (b"write-content" in r.body)

    def level(self, user, owner, coll):
        """"W" write-content offered, "R" readable only, "-" denied (403),
        else the HTTP status as text."""
        status, writable = self.can_write(user, owner, coll)
        if status == 207:
            return "W" if writable else "R"
        return "-" if status == 403 else str(status)

    def bootstrap(self, collections=("cal-aa", "cal-bb"), generation=1,
                  grants=()):
        """Start Radicale on a good rights file and create alice's
        collections. Returns the first token."""
        data, token = good_rights(generation, grants)
        self.atomic_write(self.rights_path, data)
        if not self.start():
            raise RuntimeError("Radicale did not start:\n" + self.log())
        for c in collections:
            r = self.make_calendar("alice", c)
            if r.status != 201:
                raise RuntimeError("MKCALENDAR %s -> %d" % (c, r.status))
        return token


def bad_variants():
    """Rights files that must be rejected (plus the good baseline), keyed by
    a descriptive name. Generation 7; the good one grants bob rw on cal-aa."""
    S = Section
    good_secs = standard_sections("a" * 32, [("bob", "alice", "cal-aa", "rw")])
    good = render(good_secs, 7)
    body = render_body(good_secs, 7)
    out = {"good": good}

    def resign(new_body):
        return new_body + trailer_for(new_body, 7)

    # truncation at the section boundary just before zzz-deny, trailer lost
    cut = body.index(b"[zzz-deny]")
    out["truncated-at-section-boundary"] = body[:cut]
    # same cut, with the original trailer re-appended (hash must not match)
    out["truncated-original-trailer"] = body[:cut] + trailer_for(body, 7)
    # truncated and re-signed: only the missing zzz-deny can catch it
    out["truncated-resigned"] = body[:cut] + trailer_for(body[:cut], 7)
    tampered = bytearray(good)
    tampered[good.index(b"permissions: rw") + 14] = ord("R")
    out["tampered-byte"] = bytes(tampered)
    out["empty"] = b""
    out["whitespace-only"] = b"\n\n"
    out["header-only"] = header_line(7)
    out["no-trailer"] = body
    out["trailing-garbage"] = good + b"x\n"
    out["generation-mismatch"] = body + trailer_for(body, 8)
    out["no-header"] = good.split(b"\n", 1)[1]
    out["no-sections"] = render([], 7)
    out["zzz-deny-not-last"] = render(
        good_secs[:-1] + [S("zzz-extra", ".+", "^x$", "r")] , 7)
    out["zzz-deny-with-letters"] = render(
        good_secs[:-1] + [S("zzz-deny", ".*", ".*", "r")], 7)
    out["missing-zzz-deny"] = render(good_secs[:-1], 7)
    out["bad-letter"] = render(
        good_secs[:3] + [S("x", "^bob$", "^a$", "rx")] + good_secs[3:], 7)
    out["letter-d-not-allowed"] = render(
        good_secs[:3] + [S("x", "^bob$", "^a$", "dD")] + good_secs[3:], 7)
    out["bad-regex"] = render(
        good_secs[:3] + [S("x", "^bob$", "^a(", "r")] + good_secs[3:], 7)
    out["bad-user-regex"] = render(
        good_secs[:3] + [S("x", "([", "^a$", "r")] + good_secs[3:], 7)
    out["bad-format-placeholder"] = render(
        good_secs[:3] + [S("x", "^bob$", "^{nope}$", "r")] + good_secs[3:], 7)
    out["group-index-out-of-range"] = render(
        good_secs[:3] + [S("x", "^(b)ob$", "^{1}$", "r")] + good_secs[3:], 7)
    out["groups-key"] = render(
        good_secs, 7, extra_keys={"g010-root": "groups: admins"})
    out["nul-byte"] = good.replace(b"alice", b"al\x00ce", 1)
    out["non-ascii"] = good.replace(b"alice", "alicé".encode(), 1)
    out["duplicate-section"] = render(
        good_secs[:3] + [good_secs[2]] + good_secs[3:], 7)
    out["no-permissions-key"] = resign(body.replace(b"permissions: R\n", b"", 1))
    return out


def run_inproc(scenario, timeout=120, files=None):
    """Run one scenario of ``inproc.py`` under the Radicale interpreter in a
    throwaway work directory; returns the decoded JSON result. ``files`` maps
    names to JSON-serialisable inputs written into the work directory first."""
    import json
    os.makedirs(BASE_DIR, exist_ok=True)
    work = tempfile.mkdtemp(prefix="inproc-", dir=BASE_DIR)
    for fname, payload in (files or {}).items():
        with open(os.path.join(work, fname), "w") as fh:
            json.dump(payload, fh)
    env = dict(os.environ)
    env["PYTHONPATH"] = PLUGIN_DIR
    try:
        proc = subprocess.run(
            [radicale_python(), os.path.join(HERE, "inproc.py"), scenario,
             work], env=env, capture_output=True, text=True, timeout=timeout,
            cwd=work)
        if proc.returncode != 0:
            raise RuntimeError("inproc %s failed:\n%s\n%s"
                               % (scenario, proc.stdout, proc.stderr))
        return json.loads(proc.stdout.strip().splitlines()[-1])
    finally:
        shutil.rmtree(work, ignore_errors=True)
