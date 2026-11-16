# SPDX-License-Identifier: AGPL-3.0-or-later
"""HTTP server: stdlib ``ThreadingHTTPServer``, HTTP/1.0, bound to loopback.

Socket-level rules enforced here (everything else is in ``api.py``): 15 s
socket timeout, request body at most ``max_body_bytes`` (default 16 KiB),
``Content-Length`` required for POST/PUT/PATCH/DELETE, chunked encoding and any
``Transfer-Encoding`` refused, a body on GET refused, duplicate security
headers refused. Every response carries ``Cache-Control: no-store``,
``X-Content-Type-Options: nosniff`` and ``Content-Security-Policy:
default-src 'none'``; ``WWW-Authenticate`` is never sent.

Start-up: load and validate the configuration, create the store, reconcile
the managed files with the model (see ``filewrite``), then serve. When the
model cannot be loaded the server still starts, read-only: every endpoint but
``health`` answers 503 ``model_corrupt`` until ``restore`` or ``import`` fixes
it (the model file is re-read on change, no restart needed).
"""
import argparse
import json
import re
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional, Sequence

from . import config as config_mod
from .api import MUTATING, Api, Request, Response
from .audit import Audit
from .authn import RadicaleClient
from .filewrite import Store
from .ratelimit import FailureLimiter, RequestRate

SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
}
_SINGLE = ("host", "authorization", "content-length", "content-type",
           "x-radui", "origin", "sec-fetch-site")
#: ASCII digits only: ``str.isdigit`` also accepts characters such as a
#: superscript two, which ``int`` then refuses.
_LENGTH_RE = re.compile(r"[0-9]{1,9}")
DRAIN_LIMIT = 256 * 1024
KNOWN_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 32

    def __init__(self, cfg: config_mod.Config, api: Api) -> None:
        self.cfg = cfg
        self.api = api
        super().__init__((cfg.listen_host, cfg.listen_port), Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "radui-admin"
    sys_version = ""
    server: Server

    def setup(self) -> None:
        self.timeout = self.server.cfg.socket_timeout_s
        super().setup()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass  # the audit log is the only log

    # -- responses ----------------------------------------------------------
    def _send(self, resp: Response) -> None:
        data = json.dumps(resp.body, separators=(",", ":"),
                          ensure_ascii=True).encode("ascii")
        self.send_response(resp.status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        for k, v in resp.headers.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_error(self, code, message=None, explain=None) -> None:  # noqa
        status = code if isinstance(code, int) else int(code)
        if status == 501:  # unknown method
            status = 405
        self.close_connection = True
        try:
            self._send(Response(status if status >= 400 else 400, {
                "error": {"code": "bad_request",
                          "message": "malformed request"}}))
        except OSError:
            pass

    def _fail(self, status: int, code: str, message: str,
              drain: int = 0) -> None:
        self._send(Response(status, {"error": {"code": code,
                                               "message": message}}))
        if drain:
            self._drain(drain)

    def _drain(self, n: int) -> None:
        """Read (and drop) what the client is still sending so that closing
        the socket does not reset the connection before it read our answer."""
        try:
            self.connection.shutdown(socket.SHUT_WR)
            self.connection.settimeout(1.0)
            left = min(n, DRAIN_LIMIT)
            while left > 0:
                chunk = self.rfile.read1(min(left, 65536))
                if not chunk:
                    break
                left -= len(chunk)
        except OSError:
            pass

    # -- request ------------------------------------------------------------
    def _handle(self) -> None:
        method = self.command
        headers = {}
        for name in set(k.lower() for k in self.headers.keys()):
            values = self.headers.get_all(name) or []
            if name in _SINGLE and len(values) > 1:
                return self._fail(400, "bad_request",
                                  "duplicate %s header" % name)
            headers[name] = values[0].strip() if values else ""
        if method not in KNOWN_METHODS:
            return self._fail(405, "bad_request", "method not allowed")
        length = 0
        if method in MUTATING:
            if "transfer-encoding" in headers:
                return self._fail(400, "bad_request",
                                  "chunked or encoded bodies are not accepted")
            raw_len = headers.get("content-length")
            if raw_len is None or _LENGTH_RE.fullmatch(raw_len) is None:
                return self._fail(400, "bad_request",
                                  "Content-Length is required")
            length = int(raw_len)
            cap = self.server.cfg.max_body_bytes
            if length > cap:
                return self._fail(413, "too_large",
                                  "request body is limited to %d bytes" % cap,
                                  drain=length)
        elif "transfer-encoding" in headers or \
                headers.get("content-length", "0") not in ("0", ""):
            return self._fail(400, "bad_request", "a body is not allowed here")
        body = b""
        if length:
            try:
                body = self.rfile.read(length)
            except OSError:
                return
            if len(body) != length:
                return self._fail(400, "bad_request", "incomplete body")
        resp = self.server.api.dispatch(Request(
            method, self.path, headers, body, self.client_address[0]))
        self._send(resp)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle
    do_HEAD = do_OPTIONS = _handle


class SelfHealer:
    """Background thread running ``Store.self_heal`` every ``interval_s``
    seconds (never at the same time as a change: the store skips the pass when
    it cannot take the lock at once). ``stop()`` ends it promptly."""

    def __init__(self, store: Store, interval_s: float,
                 audit: Optional[Audit] = None) -> None:
        self.store = store
        self.interval_s = interval_s
        self.audit = audit or store.audit
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> bool:
        """Start the thread; ``False`` when the interval is 0 (off)."""
        if self.interval_s <= 0 or self._thread is not None:
            return False
        self._thread = threading.Thread(target=self._run, name="self-heal",
                                        daemon=True)
        self._thread.start()
        return True

    def _run(self) -> None:
        while not self._stop.wait(self.interval_s):
            try:
                self.store.self_heal()
            except Exception as exc:  # noqa: BLE001 - never let the thread die
                self.audit.log("self-heal", actor="system",
                               result="error:%s" % type(exc).__name__)

    def stop(self, timeout: float = 30.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)


def build(cfg: config_mod.Config, *, audit: Optional[Audit] = None,
          store: Optional[Store] = None) -> Server:
    audit = audit or Audit()
    store = store or Store(cfg, audit=audit)
    api = Api(cfg, store, RadicaleClient(cfg),
              FailureLimiter(cfg.rate_limit_failures, cfg.rate_limit_window_s,
                             cfg.rate_limit_block_s),
              RequestRate(cfg.requests_per_minute, cfg.requests_burst), audit,
              diag=lambda m: print("radui-admin: " + m, file=sys.stderr,
                                   flush=True))
    return Server(cfg, api)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="radui-admin",
                                 description="RadUI admin backend")
    ap.add_argument("--config", help="configuration file (default: "
                    "$RADUI_CONFIG or %s)" % config_mod.DEFAULT_CONFIG_PATH)
    args = ap.parse_args(argv)
    try:
        cfg = config_mod.load(args.config)
        audit = Audit()
        store = Store(cfg, audit=audit)
    except (config_mod.ConfigError, ValueError, OSError) as exc:
        print("radui-admin: %s" % exc, file=sys.stderr)
        return 2
    outcome = store.reconcile()
    audit.log("startup", actor="system", target=cfg.listen,
              result="reconcile:%s" % outcome["state"])
    if outcome["state"] in ("model_error", "validation_failed"):
        print("radui-admin: %s (%s); running read-only until fixed with "
              "`radui-admin-cli restore --generation N`"
              % (outcome["state"], outcome["detail"]), file=sys.stderr,
              flush=True)
    try:
        server = build(cfg, audit=audit, store=store)
    except OSError as exc:
        print("radui-admin: cannot listen on %s: %s" % (cfg.listen, exc),
              file=sys.stderr)
        return 2
    stop = threading.Event()
    healer = SelfHealer(store, cfg.self_heal_interval_s, audit)
    healer.start()

    def shutdown(*_: object) -> None:
        if not stop.is_set():
            stop.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    import signal
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever()
    finally:
        healer.stop()
        server.server_close()
    return 0
