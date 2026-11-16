# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared helpers for the server-side spike scripts (throwaway Radicale only).

Everything here starts, drives and removes *throwaway* Radicale instances:
current user, 127.0.0.1 only, directories under the git-ignored
``.throwaway/`` of the repository (or ``RADUI_SPIKE_DIR``), ports from
``RADUI_SPIKE_PORT`` (default 15240) upwards. Nothing here ever touches a
system service or a system path. Passwords are random, kept in memory and in a
mode-600 file inside the instance directory, and are never printed.

Environment:
    RADICALE_BIN        radicale executable (also read from .env.local)
    RADUI_SPIKE_DIR     base directory for instances (default <repo>/.throwaway/spike)
    RADUI_SPIKE_PORT    first port to use (default 15240)
    RADUI_SPIKE_KEEP    1 = keep instance directories after the run
"""

import atexit
import base64
import hashlib
import http.client
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from collections import namedtuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
PLUGIN_DIR = os.path.join(REPO, "backend", "plugin")
sys.path.insert(0, HERE)
import proto_generator as gen  # noqa: E402


def _env_local(key):
    path = os.path.join(REPO, ".env.local")
    try:
        with open(path) as fh:
            for line in fh:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return None


RADICALE_BIN = os.environ.get("RADICALE_BIN") or _env_local("RADICALE_BIN") or "radicale"
BASE_DIR = os.environ.get("RADUI_SPIKE_DIR") or os.path.join(REPO, ".throwaway", "spike")
BASE_PORT = int(os.environ.get("RADUI_SPIKE_PORT", "15240"))
KEEP = os.environ.get("RADUI_SPIKE_KEEP") == "1"

Resp = namedtuple("Resp", "status headers body dt")

_instances = []


def _cleanup():
    for inst in list(_instances):
        try:
            inst.stop()
        except Exception:  # noqa: BLE001
            pass
        if not KEEP:
            shutil.rmtree(inst.dir, ignore_errors=True)


atexit.register(_cleanup)


def _port_free(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def free_port(offset=0):
    port = BASE_PORT + offset
    while not _port_free(port):
        port += 1
    return port


def basic(user, password):
    return "Basic " + base64.b64encode(("%s:%s" % (user, password)).encode()).decode()


class Instance:
    """One throwaway Radicale: config, users, rights, storage, process."""

    def __init__(self, name, port_offset=0, rights="from_file", bcrypt_cost=4,
                 delay=1, max_connections=None, level="warning", extra_config="",
                 env_extra=None, model=None, ownspace_false_principal="RW",
                 plugin_path=True, gen_opts=None):
        self.name = name
        self.dir = os.path.join(BASE_DIR, name)
        self.port = free_port(port_offset)
        self.rights_type = rights
        self.cost = bcrypt_cost
        self.delay = delay
        self.max_connections = max_connections
        self.level = level
        self.extra_config = extra_config
        self.env_extra = env_extra or {}
        self.ofp = ownspace_false_principal
        self.plugin_path = plugin_path
        self.gen_opts = gen_opts or {}
        self.proc = None
        self.pw = {}
        self.hashes = {}
        self.model = model if model is not None else gen.default_model()
        if os.path.exists(self.dir):
            shutil.rmtree(self.dir)
        os.makedirs(self.dir, mode=0o700)
        os.makedirs(os.path.join(self.dir, "collections"))
        self.users_path = os.path.join(self.dir, "users")
        self.rights_path = os.path.join(self.dir, "rights")
        self.conf_path = os.path.join(self.dir, "config")
        self.log_path = os.path.join(self.dir, "radicale.log")
        _instances.append(self)
        self.set_passwords()
        self.write_users()
        self.write_rights_model(self.model)
        self.write_config()

    # -- files ---------------------------------------------------------------

    def set_passwords(self, logins=None):
        import bcrypt
        for login in (logins or self.model["accounts"]):
            pw = secrets.token_urlsafe(18)
            self.pw[login] = pw
            self.hashes[login] = bcrypt.hashpw(
                pw.encode(), bcrypt.gensalt(rounds=self.cost)).decode()

    def atomic_write(self, path, text, mode=0o640):
        tmp = path + ".tmp%d" % os.getpid()
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    def write_users(self, logins=None):
        use = {k: v for k, v in self.hashes.items()
               if (logins is None or k in logins)
               and not self.model["accounts"].get(k, {}).get("disabled")}
        self.atomic_write(self.users_path, gen.users_text(use), 0o600)

    def write_rights_model(self, model, atomic=True):
        self.model = model
        self.write_rights_text(gen.rights_text(model, self.ofp, **self.gen_opts), atomic)

    def write_rights_text(self, text, atomic=True):
        if atomic:
            self.atomic_write(self.rights_path, text)
        else:
            with open(self.rights_path, "w") as fh:  # in place, same inode
                fh.write(text)

    def write_config(self):
        cfg = ["[server]", "hosts = 127.0.0.1:%d" % self.port]
        if self.max_connections:
            cfg.append("max_connections = %d" % self.max_connections)
        cfg += ["", "[auth]", "type = htpasswd",
                "htpasswd_filename = %s" % self.users_path,
                "htpasswd_encryption = bcrypt", "delay = %s" % self.delay, "",
                "[rights]", "type = %s" % self.rights_type,
                "file = %s" % self.rights_path,
                "permit_delete_collection = False",
                "permit_overwrite_collection = False", "",
                "[storage]",
                "filesystem_folder = %s" % os.path.join(self.dir, "collections"),
                "", "[logging]", "level = %s" % self.level, ""]
        if self.extra_config:
            cfg.append(self.extra_config)
        with open(self.conf_path, "w") as fh:
            fh.write("\n".join(cfg) + "\n")

    # -- process -------------------------------------------------------------

    def start(self, wait=True, timeout=30):
        """Start Radicale; returns the pid, or None if it did not come up."""
        env = dict(os.environ)
        env.pop("PYTHONPATH", None)
        if self.plugin_path:
            env["PYTHONPATH"] = PLUGIN_DIR
        env.update(self.env_extra)
        self.logfh = open(self.log_path, "ab")
        self.proc = subprocess.Popen(
            [RADICALE_BIN, "--config", self.conf_path], env=env,
            stdout=self.logfh, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True)
        if not wait:
            return self.proc.pid
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None:
                return None
            if not _port_free(self.port):
                return self.proc.pid
            time.sleep(0.05)
        return None

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def stop(self, sig=signal.SIGTERM, timeout=15):
        if self.proc is None:
            return
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, sig)
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

    def restart(self):
        self.stop()
        return self.start()

    def log(self):
        try:
            with open(self.log_path, errors="replace") as fh:
                return fh.read()
        except OSError:
            return ""

    def log_since(self, offset):
        return self.log()[offset:]

    # -- http ----------------------------------------------------------------

    def req(self, method, path, user=None, body=None, headers=None, timeout=60,
            password=None):
        h = dict(headers or {})
        if user is not None:
            h["Authorization"] = basic(user, password if password is not None
                                       else self.pw[user])
        if isinstance(body, str):
            body = body.encode()
        t0 = time.monotonic()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request(method, path, body=body, headers=h)
            r = conn.getresponse()
            data = r.read()
            return Resp(r.status, {k.lower(): v for k, v in r.getheaders()},
                        data, time.monotonic() - t0)
        except (OSError, http.client.HTTPException) as exc:
            return Resp(0, {"x-error": type(exc).__name__}, repr(exc).encode(),
                        time.monotonic() - t0)
        finally:
            conn.close()

    def collections_dir(self):
        return os.path.join(self.dir, "collections", "collection-root")

    def make_member(self, owner, name, kind="VEVENT"):
        """Create a collection as its owner (admin-free helper)."""
        path = "/%s/%s/" % (owner, name)
        if kind == "VCARD":
            return self.req("MKCOL", path, owner, MKCOL_BOOK,
                            {"Content-Type": "application/xml"})
        return self.req("MKCALENDAR", path, owner, mkcalendar_body(kind),
                        {"Content-Type": "application/xml"})


# -- request bodies -----------------------------------------------------------

NS = ('xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" '
      'xmlns:CR="urn:ietf:params:xml:ns:carddav" '
      'xmlns:CS="http://calendarserver.org/ns/"')


def mkcalendar_body(kind="VEVENT"):
    return ('<?xml version="1.0"?><C:mkcalendar %s><D:set><D:prop>'
            '<D:displayname>t</D:displayname>'
            '<C:supported-calendar-component-set><C:comp name="%s"/>'
            '</C:supported-calendar-component-set></D:prop></D:set>'
            '</C:mkcalendar>' % (NS, kind))


MKCOL_BOOK = ('<?xml version="1.0"?><D:mkcol %s><D:set><D:prop>'
              '<D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype>'
              '<D:displayname>b</D:displayname></D:prop></D:set></D:mkcol>' % NS)

PROPFIND_ALL = ('<?xml version="1.0"?><D:propfind %s><D:allprop/></D:propfind>'
                % NS)
PROPFIND_PRIV = ('<?xml version="1.0"?><D:propfind %s><D:prop>'
                 '<D:current-user-privilege-set/><D:resourcetype/>'
                 '<D:getetag/></D:prop></D:propfind>' % NS)
PROPPATCH_NAME = ('<?xml version="1.0"?><D:propertyupdate %s><D:set><D:prop>'
                  '<D:displayname>renamed</D:displayname></D:prop></D:set>'
                  '</D:propertyupdate>' % NS)
REPORT_QUERY = ('<?xml version="1.0"?><C:calendar-query %s><D:prop><D:getetag/>'
                '<C:calendar-data/></D:prop><C:filter><C:comp-filter '
                'name="VCALENDAR"/></C:filter></C:calendar-query>' % NS)
XML_HDR = {"Content-Type": "application/xml; charset=utf-8"}


def ics_event(uid, summary="s"):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RadUI spike//EN\r\n"
            "BEGIN:VEVENT\r\nUID:%s\r\nDTSTAMP:20260101T000000Z\r\n"
            "DTSTART:20260601T100000Z\r\nDTEND:20260601T110000Z\r\n"
            "SUMMARY:%s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n" % (uid, summary))


def ics_todo(uid, summary="t"):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RadUI spike//EN\r\n"
            "BEGIN:VTODO\r\nUID:%s\r\nDTSTAMP:20260101T000000Z\r\n"
            "SUMMARY:%s\r\nEND:VTODO\r\nEND:VCALENDAR\r\n" % (uid, summary))


def vcard(uid, fn="Test Person"):
    return ("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:%s\r\nFN:%s\r\nN:Person;Test;;;\r\n"
            "END:VCARD\r\n" % (uid, fn))


# -- reporting ----------------------------------------------------------------

class Checker:
    """PASS/FAIL lines with evidence; non-zero exit status on any FAIL."""

    def __init__(self, title):
        self.title = title
        self.fails = 0
        self.passes = 0
        print("== %s ==" % title, flush=True)

    def check(self, name, ok, evidence=""):
        if ok:
            self.passes += 1
        else:
            self.fails += 1
        print("%s %s :: %s" % ("PASS" if ok else "FAIL", name, evidence),
              flush=True)
        return ok

    def info(self, text):
        print("INFO %s" % text, flush=True)

    def finish(self):
        print("== %s: %d PASS, %d FAIL ==" % (self.title, self.passes, self.fails),
              flush=True)
        return 1 if self.fails else 0


def code_of(resp):
    return resp.status


def md_table(rows, header):
    out = ["| " + " | ".join(header) + " |",
           "|" + "|".join("---" for _ in header) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def wait_for(fn, timeout=5.0, step=0.02):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        v = fn()
        if v:
            return time.monotonic() - t0
        time.sleep(step)
    return None


def sha(b):
    return hashlib.sha256(b).hexdigest()


def radicale_python_version(mod):
    py = os.path.join(os.path.dirname(os.path.realpath(
        shutil.which(RADICALE_BIN) or RADICALE_BIN)), "python")
    out = subprocess.run([py, "-c", "import %s;print(%s.__version__)" % (mod, mod)],
                         capture_output=True, text=True)
    return out.stdout.strip()


def tmpdir(prefix):
    os.makedirs(BASE_DIR, exist_ok=True)
    return tempfile.mkdtemp(prefix=prefix, dir=BASE_DIR)


def status_set(*resps):
    return sorted(set(r.status for r in resps))


re_compile = re.compile


def tree_hash(inst):
    """Hash of every data file below the storage root (cache and lock excluded)."""
    h = hashlib.sha256()
    root = inst.collections_dir()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames
                             if d not in (".Radicale.cache", ".Radicale.lock"))
        for fn in sorted(filenames):
            if fn == ".Radicale.lock":
                continue
            full = os.path.join(dirpath, fn)
            h.update(os.path.relpath(full, root).encode() + b"\0")
            with open(full, "rb") as fh:
                h.update(fh.read())
        for d in dirnames:
            h.update(b"D" + os.path.relpath(os.path.join(dirpath, d), root).encode())
    return h.hexdigest()[:16]


def scrub(text, inst=None):
    """Remove machine paths and user names from evidence strings."""
    if inst is not None:
        text = text.replace(inst.dir, "<dir>")
    text = re.sub(r"/[^\s'\"]*\.throwaway/spike/[^\s'\"]*", "<dir>", text)
    return text
