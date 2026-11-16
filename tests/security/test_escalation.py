# SPDX-License-Identifier: AGPL-3.0-or-later
"""A stolen bot credential, server-side request forgery through the
credential forwarding, and client-address header injection.

Attacker models
* Stolen bot: the attacker holds ``agent-1``'s login and password (a leaked
  token of an unattended agent). It may use everything the bot may, nothing
  else; the administrator's reaction (disable / password reset) must cut it
  off on the next request.
* SSRF: the backend forwards the caller's credentials to Radicale. Nothing the
  caller controls (Host, ``X-Forwarded-*``, ``Forwarded``, absolute-URI request
  line, names in bodies, a malicious or buggy upstream answering with
  redirects, huge or hostile XML) may change where the backend connects.
* Address injection: ``X-Real-IP`` / ``X-Forwarded-For`` values reach
  Radicale's failed-login log line (what fail2ban reads) and the audit log.
"""
import json
import os
import re
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import secsupport as S  # noqa: E402
from plugin import support  # noqa: E402

CANARY_PORT = 15329
FAKE_PORT = 15328


def code(r):
    return r.json["error"]["code"] if r.json else None


@S.requires_radicale
class StolenBot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("bot").up()
        cls.addClassCleanup(s.close)
        s.make_user("bob")
        s.make_user("bot-2", bot=True)
        assert s.mkcalendar("alice", "alice", "cal-work").status == 201
        assert s.mkcalendar("alice", "alice", "private").status == 201
        assert s.dav("PROPFIND", "/", "bob", headers={"Depth": "0"}).status == 207
        assert s.mkcalendar("bob", "bob", "secret").status == 201
        assert s.dav("PROPFIND", "/", "agent-1", headers={"Depth": "0"}).status == 207
        assert s.mkcalendar("agent-1", "agent-1", "mine").status == 201

    def setUp(self):
        self.start = S.snapshot(self.s)

    def test_cannot_create_or_become_an_admin(self):
        s = self.s
        for body in ({"login": "evil-1", "displayName": "E", "admin": True,
                      "generate": True},
                     {"login": "evil-2", "displayName": "E", "type": "bot",
                      "admin": True, "generate": True},
                     {"login": "evil-3", "displayName": "E", "generate": True}):
            r = s.api("POST", "/accounts", "agent-1", body)
            self.assertEqual((r.status, code(r)), (403, "forbidden"))
        for path, body in (("/accounts/agent-1", {"admin": True}),
                           ("/accounts/agent-1", {"type": "person"}),
                           ("/accounts/agent-1", {"ownSpace": True}),
                           ("/accounts/alice", {"disabled": True}),
                           ("/accounts/alice", {"admin": False}),
                           ("/accounts/bob", {"displayName": "Mallory"})):
            r = s.api("PATCH", path, "agent-1", body)
            self.assertEqual((r.status, code(r)), (403, "forbidden"), path)
        self.assertEqual(S.snapshot(s), self.start)

    def test_cannot_grant_itself_access_to_others_collections(self):
        s = self.s
        for owner, coll in (("alice", "private"), ("alice", "cal-work"),
                            ("bob", "secret"), ("agent-1", "mine")):
            for level in ("read", "readwrite"):
                r = s.api("PUT", "/grants", "agent-1", {
                    "owner": owner, "collection": coll, "grantee": "agent-1",
                    "level": level})
                self.assertIn(r.status, (403, 422), (owner, coll))
                if owner != "agent-1":
                    self.assertEqual(r.status, 403)
        # ... or give somebody else more than the bot has itself
        r = s.api("PUT", "/grants", "agent-1", {
            "owner": "alice", "collection": "private", "grantee": "bot-2",
            "level": "readwrite"})
        self.assertEqual(r.status, 403)
        self.assertEqual(s.level("agent-1", "alice", "private"), "-")
        self.assertEqual(s.level("agent-1", "bob", "secret"), "-")
        self.assertEqual(S.snapshot(s), self.start)

    def test_cannot_call_directory_or_read_other_accounts(self):
        s = self.s
        for path in ("/directory", "/accounts", "/accounts/alice",
                     "/accounts/agent-1", "/accounts/bob", "/effective/alice",
                     "/generations"):
            r = s.api("GET", path, "agent-1")
            self.assertEqual((r.status, code(r)), (403, "forbidden"), path)
        # the 403 is identical for an existing and a nonexistent account:
        # no existence oracle
        a = s.api("GET", "/accounts/alice", "agent-1")
        b = s.api("GET", "/accounts/ghost-1", "agent-1")
        self.assertEqual((a.status, a.json), (b.status, b.json))

    def test_me_and_access_show_only_the_caller(self):
        s = self.s
        for q in ("", "?login=alice", "?owner=bob", "?grantee=bob&owner=alice"):
            me = s.api("GET", "/me", "agent-1", query=q)
            acc = s.api("GET", "/me/access", "agent-1", query=q)
            self.assertEqual(me.json["login"], "agent-1")
            self.assertEqual(acc.json["login"], "agent-1")
            self.assertNotIn("principals", acc.json)
            self.assertTrue(all(g["owner"] == "alice" for g in acc.json["grants"]))
        r = s.api("GET", "/grants", "agent-1", query="?owner=alice")
        self.assertEqual((r.status, code(r)), (403, "forbidden"))
        r = s.api("GET", "/grants", "agent-1", query="?owner=bob")
        self.assertEqual(r.status, 403)
        # asking for somebody else's grants as grantee still lists only the
        # bot's own collections
        s.api("PUT", "/grants", "agent-1", {
            "owner": "agent-1", "collection": "mine", "grantee": "bob",
            "level": "read"})
        r = s.api("GET", "/grants", "agent-1", query="?grantee=alice")
        self.assertEqual(r.json, [])
        r = s.api("GET", "/grants", "agent-1")
        self.assertEqual({(g["owner"], g["grantee"]) for g in r.json},
                         {("agent-1", "bob")})
        s.api("PUT", "/grants", "agent-1", {
            "owner": "agent-1", "collection": "mine", "grantee": "bob",
            "level": "none"})

    def test_cannot_reset_passwords(self):
        s = self.s
        before = s.pw["alice"]
        for login in ("alice", "bob", "agent-1", "bot-2"):
            for body in ({"generate": True},
                         {"password": "a long enough passphrase 5!"}):
                r = s.api("POST", "/accounts/%s/password" % login, "agent-1", body)
                self.assertEqual(r.status, 403, login)
        self.assertEqual(s.api("GET", "/me", "alice", password=before).status, 200)
        self.assertEqual(S.snapshot(s), self.start)

    def test_dav_reach_is_exactly_the_grants(self):
        s = self.s
        # granted by the legacy rule: alice/cal-work (rw), alice/contacts
        self.assertEqual(s.put_event("agent-1", "alice", "cal-work", "e1").status, 201)
        self.assertEqual(s.dav("DELETE", "/alice/cal-work/", "agent-1").status, 403)
        # not granted
        for path in ("/alice/", "/bob/", "/alice/private/", "/bob/secret/",
                     "/bob/secret/x.ics", "/bot-2/"):
            for method in ("PROPFIND", "GET"):
                r = s.dav(method, path, "agent-1", None, {"Depth": "0"})
                self.assertEqual(r.status, 403, (method, path))
        self.assertEqual(s.mkcalendar("agent-1", "alice", "new").status, 403)
        self.assertEqual(s.dav("MKCOL", "/just-a-name/", "agent-1").status, 403)
        token = s.model().gen_token
        self.assertEqual(s.dav("PUT", "/radui-gen-%s" % token, "agent-1",
                               b"x").status, 403)

    def test_disable_and_reset_cut_the_stolen_credential_at_once(self):
        s = self.s
        s.make_user("thief-bot", bot=True)
        self.assertEqual(s.api("GET", "/me", "thief-bot").status, 200)
        stolen = s.pw["thief-bot"]
        r = s.api("PATCH", "/accounts/thief-bot", "alice", {"disabled": True})
        self.assertEqual(r.status, 200)
        self.assertEqual(s.api("GET", "/me", "thief-bot", password=stolen).status, 401)
        self.assertEqual(s.dav("PROPFIND", "/", "thief-bot", password=stolen,
                               headers={"Depth": "0"}).status, 401)
        r = s.api("PATCH", "/accounts/thief-bot", "alice", {"disabled": False})
        self.assertEqual(r.status, 200)
        self.assertEqual(s.api("GET", "/me", "thief-bot", password=stolen).status, 200)
        r = s.api("POST", "/accounts/thief-bot/password", "alice",
                  {"generate": True})
        self.assertEqual(s.api("GET", "/me", "thief-bot", password=stolen).status, 401)
        self.assertEqual(s.dav("PROPFIND", "/", "thief-bot", password=stolen,
                               headers={"Depth": "0"}).status, 401)
        self.assertEqual(s.api("GET", "/me", "thief-bot",
                               password=r.json["password"]).status, 200)
        # deleting the account kills it for good, and the name is not reusable
        s.pw["thief-bot"] = r.json["password"]
        self.assertEqual(s.api("DELETE", "/accounts/thief-bot", "alice",
                               {"confirm": "thief-bot"}).status, 200)
        self.assertEqual(s.api("GET", "/me", "thief-bot").status, 401)


# ---------------------------------------------------------------------------
# SSRF through the credential forwarding
# ---------------------------------------------------------------------------

@S.requires_radicale
class Ssrf(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("ssrf").up()
        cls.addClassCleanup(s.close)
        s.make_user("bob")
        assert s.dav("PROPFIND", "/", "bob", headers={"Depth": "0"}).status == 207
        assert s.mkcalendar("bob", "bob", "cal").status == 201
        cls.canary = S.Canary(CANARY_PORT)
        cls.addClassCleanup(cls.canary.close)

    def test_attacker_controlled_headers_never_change_the_upstream(self):
        s, c = self.s, self.canary
        target = "127.0.0.1:%d" % CANARY_PORT
        evil = [("X-Forwarded-Host", target), ("X-Forwarded-Server", target),
                ("X-Forwarded-Port", str(CANARY_PORT)), ("X-Forwarded-Proto", "http"),
                ("Forwarded", "host=%s;for=%s" % (target, target)),
                ("X-Original-URL", "http://%s/" % target),
                ("X-Rewrite-URL", "http://%s/" % target),
                ("X-Real-IP", target), ("X-Forwarded-For", target),
                ("X-Remote-Addr", target), ("Referer", "http://%s/" % target),
                ("X-HTTP-Method-Override", "DELETE"), ("Destination", "http://%s/" % target),
                ("Location", "http://%s/" % target), ("Via", target),
                ("Proxy-Connection", "keep-alive"), ("X-Radicale-URL", target)]
        for path in ("/me", "/me/access", "/accounts", "/health"):
            hs = S.good_headers(s, "alice", extra=evil)
            st, hd, body = S.raw_http(s.bport, S.request_bytes(
                "GET", S.PREFIX + path, hs))
            self.assertEqual(st, 200, path)
        # Host values that name the canary are refused before anything else
        for host in (target, "%s@%s" % (S.HOST, target),
                     "%s:%s" % (S.HOST, CANARY_PORT), "127.0.0.1:%d@%s" % (s.bport, target)):
            r = s.api("GET", "/me", "alice", host=host)
            self.assertEqual(r.status, 403, host)
        # absolute-URI request lines: a proxy-style request is not served
        for line in ("GET http://%s/ui/api/me HTTP/1.0" % target,
                     "GET http://%s%s/me HTTP/1.0" % (S.HOST, S.PREFIX),
                     "GET //%s/ui/api/me HTTP/1.0" % target,
                     "GET @%s/ui/api/me HTTP/1.0" % target):
            data = (line + "\r\n" + "\r\n".join("%s: %s" % h for h in
                                                S.good_headers(s, "alice")) + "\r\n\r\n").encode()
            st, hd, body = S.raw_http(s.bport, data)
            self.assertIn(st, (400, 404), line)
        # names with URL syntax never reach the path the backend requests
        for owner, coll in (("bob", "cal?x=1"), ("bob", "cal#f"), ("bob", "cal%2f.."),
                            ("bob@%s" % target, "cal"), ("bob/../alice", "cal"),
                            ("bob", "cal/../../alice")):
            r = s.api("PUT", "/grants", "alice", {
                "owner": owner, "collection": coll, "grantee": "agent-1",
                "level": "read"})
            self.assertIn(r.status, (400, 422), (owner, coll))
        # positive control: the real upstream really was used
        self.assertEqual(s.api("PUT", "/grants", "alice", {
            "owner": "bob", "collection": "cal", "grantee": "agent-1",
            "level": "read"}).status, 200)
        self.assertEqual(c.hits, [], "the canary received a request")


class _Upstream:
    """A hostile 'Radicale': answers PROPFIND / with 207 (authenticated) and
    everything else with a configurable hostile answer."""

    def __init__(self, port, mode, canary_port):
        outer = self
        self.mode, self.hits = mode, []
        self.canary_port = canary_port

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *a):
                pass

            def _any(self):
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    self.rfile.read(n)
                outer.hits.append((self.command, self.path))
                if self.path == "/radui-gen-" or self.path.startswith("/radui-gen-"):
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if self.path == "/":
                    self.send_response(207)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                outer.answer(self)

            do_GET = do_PROPFIND = do_REPORT = do_PUT = _any

        self.server = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def answer(self, h):
        mode = self.mode
        if mode in ("302", "307", "301", "308"):
            h.send_response(int(mode))
            h.send_header("Location", "http://127.0.0.1:%d/stolen" % self.canary_port)
            h.send_header("Content-Length", "0")
            h.end_headers()
        elif mode == "huge":
            body = b"<a>" + b"x" * (5 * 1024 * 1024)
            h.send_response(207)
            h.send_header("Content-Length", str(len(body)))
            h.end_headers()
            try:
                h.wfile.write(body)
            except OSError:
                pass
        elif mode == "entity":
            body = (b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">'
                    b'<!ENTITY b "&a;&a;&a;&a;">]><multistatus xmlns="DAV:">'
                    b'<response><href>&b;</href></response></multistatus>')
            h.send_response(207)
            h.send_header("Content-Length", str(len(body)))
            h.end_headers()
            h.wfile.write(body)
        elif mode == "deep":
            body = (b'<?xml version="1.0"?>' + b"<a>" * 20000 + b"</a>" * 20000)
            h.send_response(207)
            h.send_header("Content-Length", str(len(body)))
            h.end_headers()
            h.wfile.write(body)
        elif mode == "hang":
            time.sleep(6)
            h.send_response(207)
            h.send_header("Content-Length", "0")
            h.end_headers()
        elif mode == "500":
            h.send_response(500)
            h.send_header("Content-Length", "0")
            h.end_headers()
        elif mode == "html":
            body = b"<html>not xml"
            h.send_response(207)
            h.send_header("Content-Length", str(len(body)))
            h.end_headers()
            h.wfile.write(body)


@S.requires_radicale
class HostileUpstream(unittest.TestCase):
    """The backend itself against a misbehaving upstream (redirects, huge or
    hostile XML, slow answers). It must answer 502 and connect nowhere else."""

    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("hostile", legacy=True, cfg={
            "radicale_url": "http://127.0.0.1:%d" % FAKE_PORT,
            "radicale_timeout_s": 1.5, "probe_budget_s": 0.5})
        cls.addClassCleanup(s.close)
        s.import_legacy()
        cls.canary = S.Canary(CANARY_PORT)
        cls.addClassCleanup(cls.canary.close)
        cls.up = _Upstream(FAKE_PORT, "302", CANARY_PORT)
        cls.addClassCleanup(cls.up.server.shutdown)
        s.start_backend()

    def grant(self):
        return self.s.api("PUT", "/grants", "alice", {
            "owner": "alice", "collection": "cal-x", "grantee": "agent-1",
            "level": "read"}, timeout=30)

    def patch_ownspace(self):
        # needs the collection count (PROPFIND Depth 1 on the principal)
        self.s.api("PATCH", "/accounts/agent-1", "alice", {"ownSpace": True})
        return self.s.api("PATCH", "/accounts/agent-1", "alice",
                          {"ownSpace": False}, timeout=30)

    def test_redirects_are_not_followed(self):
        for mode in ("301", "302", "307", "308"):
            self.up.mode = mode
            for call in (self.grant, self.patch_ownspace):
                r = call()
                self.assertEqual((r.status, code(r)), (502, "radicale_unexpected"),
                                 (mode, call.__name__))
        self.assertEqual(self.canary.hits, [])

    def test_hostile_answers_give_502_not_a_crash(self):
        for mode in ("huge", "entity", "html", "500", "hang", "deep"):
            self.up.mode = mode
            for call in (self.grant, self.patch_ownspace):
                r = call()
                if mode == "deep":
                    # well-formed XML without a resourcetype: not a crash
                    self.assertIn(r.status, (200, 422, 502), (mode, r.json))
                else:
                    self.assertEqual((r.status, code(r)),
                                     (502, "radicale_unexpected"),
                                     (mode, call.__name__, r.json))
        self.assertEqual(self.canary.hits, [])
        self.up.mode = "302"
        self.assertEqual(self.s.api("GET", "/me", "alice").status, 200)  # alive
        # every connection the backend made went to the configured upstream
        paths = {p for _m, p in self.up.hits}
        self.assertTrue(all(p == "/" or p.startswith(("/alice/", "/agent-1/", "/radui-gen-"))
                            for p in paths), paths)


# ---------------------------------------------------------------------------
# address header injection
# ---------------------------------------------------------------------------

FORWARDED = re.compile(r"\(forwarded for '([^']*)'\)")


@S.requires_radicale
class AddressHeaders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("addr").up()
        cls.addClassCleanup(s.close)

    def failed_login_with(self, headers, raw_value=None):
        """Send a wrong-password API call with extra headers; return the
        address Radicale logged and the one in the audit log."""
        s = self.s
        before = len(s.radicale_log_text())
        before_audit = len(s.stdout())
        hs = [("Host", S.HOST), ("Origin", S.ORIGIN), ("Sec-Fetch-Site", "same-origin"),
              ("Authorization", S.basic("alice", "wrong-" + os.urandom(4).hex()))]
        hs += headers
        data = S.request_bytes("GET", S.PREFIX + "/me", hs)
        if raw_value is not None:
            data = data.replace(b"@@", raw_value)
        st, hd, body = S.raw_http(s.bport, data)
        time.sleep(0.15)
        self.assertEqual(st, 401, headers)
        log = s.radicale_log_text()[before:]
        m = FORWARDED.findall(log)
        audit = [json.loads(line) for line in s.stdout()[before_audit:].splitlines()
                 if line.startswith("{")]
        ips = [a["ip"] for a in audit if a["event"] == "auth.failed"]
        return (m[-1] if m else None), (ips[-1] if ips else None)

    def test_valid_addresses_are_used_everything_else_falls_back_to_the_peer(self):
        cases = [
            ("203.0.113.7", "203.0.113.7"), (" 203.0.113.8 ", "203.0.113.8"),
            ("2001:db8::1", "2001:db8::1"),
            ("2001:0DB8:0:0:0:0:0:2", "2001:db8::2"),
            ("::ffff:" + "203.0.113.9", "::ffff:" + "203.0.113.9"),
            ("999.1.1.1", "127.0.0.1"), ("203.0.113.1, 203.0.113.2", "127.0.0.1"),
            ("203.0.113.5:80", "127.0.0.1"), ("[2001:db8::1]", "127.0.0.1"),
            ("203.0.113.6 evil", "127.0.0.1"), ("localhost", "127.0.0.1"),
            ("'; DROP TABLE x;--", "127.0.0.1"), ("", "127.0.0.1"),
            ("203.0.113.4%0d%0aX-Evil: 1", "127.0.0.1"),
            ("198.51.100.4' (forwarded for '198.51.100.8", "127.0.0.1"),
            ("0x7f.1", "127.0.0.1"), ("203.0.113", "127.0.0.1"),
            ("203.000" + ".113.001", "127.0.0.1"), ("-198.51.100.0", "127.0.0.1"),
        ]
        for value, want in cases:
            radicale, audit = self.failed_login_with([("X-Real-IP", value)])
            self.assertEqual((radicale, audit), (want, want), repr(value))

    def test_x_forwarded_for_from_the_client_is_ignored(self):
        for value in ("203.0.113.99", "203.0.113.1, 203.0.113.2", "2001:db8::9"):
            radicale, audit = self.failed_login_with([("X-Forwarded-For", value)])
            self.assertEqual((radicale, audit), ("127.0.0.1", "127.0.0.1"), value)

    def test_header_injection_with_line_breaks(self):
        # a bare CR LF inside the value ends the header: the second line
        # becomes a header of its own, never part of the logged address
        radicale, audit = self.failed_login_with(
            [("X-Real-IP", "203.0.113.3@@X-Evil: (forwarded for '198.51.100.99')")],
            raw_value=b"\r\n")
        self.assertEqual((radicale, audit), ("203.0.113.3", "203.0.113.3"))
        # an obsolete folded continuation line is part of the value: invalid
        radicale, audit = self.failed_login_with(
            [("X-Real-IP", "203.0.113.3@@ 198.51.100.99")], raw_value=b"\r\n")
        self.assertEqual((radicale, audit), ("127.0.0.1", "127.0.0.1"))
        # two X-Real-IP headers: the first one wins in the backend? either way
        # the logged value must be one valid address or the peer
        radicale, audit = self.failed_login_with(
            [("X-Real-IP", "203.0.113.20"), ("X-Real-IP", "203.0.113.21")])
        self.assertEqual(radicale, audit)
        self.assertIn(radicale, ("203.0.113.20", "203.0.113.21", "127.0.0.1"))

    def test_scoped_ipv6_is_not_forwarded_finding_f3(self):
        """Finding F3, fixed: ``ipaddress.ip_address`` accepts an IPv6 scope
        id (``2001:db8::1%eth0``) from Python 3.9 on; the backend now refuses
        any value with ``%`` and falls back to the peer address."""
        radicale, audit = self.failed_login_with([("X-Real-IP", "2001:db8::1%eth0")])
        S.info("scoped IPv6 in X-Real-IP is logged as %r (audit %r)"
               % (radicale, audit))
        self.assertEqual((radicale, audit), ("127.0.0.1", "127.0.0.1"))


if __name__ == "__main__":
    unittest.main()
