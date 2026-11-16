#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tiny stdlib stub of the admin backend, used only by the browser spikes (S10, S11).

Listens on 127.0.0.1:<port> and answers:

  GET  /ui/api/health            200 {"ok": true}
  GET  /ui/api/whoami            200 with the Basic login name, or 401 WITHOUT a
                                 WWW-Authenticate header (the behaviour the plan requires)
  GET  /ui/api/whoami-challenge  same, but a 401 that DOES carry
                                 "WWW-Authenticate: Basic realm=stub" (negative control)
  GET  /ui/api/echo-headers      200 JSON of the request headers as received (Authorization
                                 is replaced by "<present>")
  POST/PUT /ui/api/upload        reads the body and returns its length

Every request is appended as one JSON line to the log file (never the Authorization value).
The accepted credentials are read from a "user:password" file (--credentials); passwords
are never printed or logged.
"""
import argparse
import base64
import hmac
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    server_version = "stub"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silence stderr access log
        pass

    # -- helpers -----------------------------------------------------------
    def _record(self, status, extra=None):
        hdrs = {k: ("<present>" if k.lower() == "authorization" else v)
                for k, v in self.headers.items()}
        entry = {"t": round(time.time(), 3), "method": self.command, "path": self.path,
                 "status": status, "peer": self.client_address[0], "headers": hdrs}
        if extra:
            entry.update(extra)
        with open(self.server.logfile, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def _send(self, status, body=b"", ctype="application/json", headers=None, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self._record(status, extra)

    def _login(self):
        auth = self.headers.get("Authorization", "")
        if not auth.lower().startswith("basic "):
            return None
        try:
            user, _, pw = base64.b64decode(auth[6:].strip(), validate=True).decode("utf-8").partition(":")
        except Exception:
            return None
        expected = self.server.credentials.get(user)
        if expected is not None and hmac.compare_digest(expected.encode(), pw.encode()):
            return user
        return None

    # -- routes ------------------------------------------------------------
    def _route(self):
        path = self.path.split("?", 1)[0]
        if path == "/ui/api/health":
            return self._send(200, b'{"ok": true}')
        if path == "/ui/api/echo-headers":
            hdrs = {k: ("<present>" if k.lower() == "authorization" else v)
                    for k, v in self.headers.items()}
            return self._send(200, json.dumps({"peer": self.client_address[0], "headers": hdrs}).encode())
        if path in ("/ui/api/whoami", "/ui/api/whoami-challenge"):
            user = self._login()
            if user is not None:
                return self._send(200, json.dumps({"login": user}).encode())
            hdrs = {}
            if path.endswith("-challenge"):
                hdrs["WWW-Authenticate"] = 'Basic realm="stub"'
            return self._send(401, b'{"error": "unauthorized"}', headers=hdrs)
        if path == "/ui/api/upload":
            n = int(self.headers.get("Content-Length") or 0)
            got = 0
            while got < n:
                chunk = self.rfile.read(min(65536, n - got))
                if not chunk:
                    break
                got += len(chunk)
            return self._send(200, json.dumps({"received": got}).encode())
        return self._send(404, b'{"error": "not found"}')

    do_GET = do_POST = do_PUT = do_PROPFIND = do_OPTIONS = do_HEAD = _route


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=18081)
    ap.add_argument("--credentials", required=True, help="file with user:password lines")
    ap.add_argument("--log", required=True, help="JSON-lines request log")
    args = ap.parse_args()
    creds = {}
    with open(args.credentials, encoding="utf-8") as fh:
        for line in fh:
            user, sep, pw = line.rstrip("\n").partition(":")
            if sep:
                creds[user] = pw
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.credentials = creds
    srv.logfile = args.log
    print("stub backend listening on 127.0.0.1:%d" % args.port, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
