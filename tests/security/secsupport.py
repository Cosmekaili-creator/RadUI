# SPDX-License-Identifier: AGPL-3.0-or-later
"""Helpers of the negative-security suite: throwaway stack (see
``backend/tests/integration/wp10_support.py``), raw sockets for requests an
HTTP client library would refuse to send, state snapshots and a canary
server that must never receive a request."""
import hashlib
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
INTEG = os.path.join(REPO, "backend", "tests", "integration")
if INTEG not in sys.path:
    sys.path.insert(0, INTEG)

import wp10_support as W  # noqa: E402

H = W.H
WStack = W.WStack
info = W.info
requires_radicale = W.requires_radicale
HOST = H.HOST
ORIGIN = H.ORIGIN
PREFIX = H.PREFIX
basic = H.basic

#: authorisation values and passwords used by a test module; scanned in logs
USED_SECRETS = set()


def raw_http(port, data, timeout=10, recv_limit=1 << 20):
    """Send ``data`` verbatim, return ``(status, headers, body)``; ``status``
    is None when the server closed without an HTTP status line."""
    with socket.create_connection(("127.0.0.1", port), timeout) as c:
        try:
            c.sendall(data)
        except OSError:
            pass
        try:
            c.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        chunks, total = [], 0
        c.settimeout(timeout)
        try:
            while total < recv_limit:
                chunk = c.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
        except (socket.timeout, ConnectionResetError):
            pass
    blob = b"".join(chunks)
    head, _, body = blob.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status = None
    if lines and lines[0].startswith(b"HTTP/"):
        try:
            status = int(lines[0].split()[1])
        except (IndexError, ValueError):
            status = None
    headers = {}
    for line in lines[1:]:
        k, _, v = line.partition(b":")
        headers[k.strip().lower().decode("latin-1")] = v.strip().decode("latin-1")
    return status, headers, body


def request_bytes(method, path, headers, body=b"", version="HTTP/1.0"):
    lines = ["%s %s %s" % (method, path, version)]
    for k, v in headers:
        lines.append("%s: %s" % (k, v))
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body


def good_headers(stack, login, mutating=False, extra=()):
    hs = [("Host", HOST), ("Origin", ORIGIN), ("Sec-Fetch-Site", "same-origin"),
          ("Authorization", basic(login, stack.pw[login]))]
    if mutating:
        hs += [("X-RadUI", "1"), ("Content-Type", "application/json")]
    return hs + list(extra)


def snapshot(stack):
    """Bytes of the files an attack must not change."""
    out = {}
    for name, path in (("model", os.path.join(stack.state, "model.json")),
                       ("rights", os.path.join(stack.managed, "rights")),
                       ("users", os.path.join(stack.managed, "users"))):
        with open(path, "rb") as fh:
            out[name] = hashlib.sha256(fh.read()).hexdigest()
    out["managed"] = sorted(os.listdir(stack.managed))
    return out


class Canary:
    """A server that records every request it receives. Nothing the backend
    does with attacker-controlled headers may ever reach it."""

    def __init__(self, port, status=200, location=None):
        self.hits = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *a):
                pass

            def _any(self):
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    self.rfile.read(n)
                outer.hits.append((self.command, self.path,
                                   dict(self.headers.items())))
                self.send_response(status)
                if location:
                    self.send_header("Location", location)
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = do_POST = do_PUT = do_PROPFIND = do_DELETE = _any
            do_REPORT = do_PATCH = do_OPTIONS = do_HEAD = _any

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.daemon_threads = True
        self.port = port
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def log_text(stack):
    """Everything the backend and Radicale wrote (the audit log is stdout)."""
    parts = [stack.stdout(), stack.stderr(), stack.radicale_log_text()]
    return "\n".join(parts)
