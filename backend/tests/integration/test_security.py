# SPDX-License-Identifier: AGPL-3.0-or-later
"""Negative security suite over real HTTP (bot and person calling the admin
API, header rules, body rules, hostile names, credentials, response headers)."""
import base64
import json
import os
import socket
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

ADMIN_CALLS = [
    ("GET", "/directory", None), ("GET", "/accounts", None),
    ("POST", "/accounts", {"login": "zed-1", "displayName": "Z",
                           "generate": True}),
    ("GET", "/accounts/alice", None),
    ("PATCH", "/accounts/alice", {"displayName": "X"}),
    ("DELETE", "/accounts/alice", {"confirm": "alice"}),
    ("POST", "/accounts/alice/password", {"generate": True}),
    ("GET", "/effective/alice", None), ("GET", "/generations", None),
    ("POST", "/generations/1/restore", {}),
]
HOSTILE = ["../x", "a/../b", "{0}", "{user}", "50%", "%(x)s", "a\nb", "a\r\nb",
           ".*", "(a|b)", "café", "KK", "ALICE", "Alice", " a",
           "a b", "a;b", "x" * 40, "", "-ab", "аа"]


def code(resp):
    return resp.json["error"]["code"] if resp.json else None


@H.requires_radicale
class Security(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = H.Stack("sec").up()
        cls.addClassCleanup(cls.s.close)
        r = cls.s.api("POST", "/accounts", "alice", {
            "login": "person-1", "displayName": "P", "generate": True})
        cls.s.pw["person-1"] = r.json["password"]
        cls.s.mkcalendar("agent-1", "agent-1", "mine")

    def state(self):
        with open(os.path.join(self.s.state, "model.json"), "rb") as fh:
            return fh.read()

    # -- who may call what --------------------------------------------------
    def test_bot_and_person_cannot_call_any_admin_endpoint(self):
        before = self.state()
        for login in ("agent-1", "person-1"):
            for method, path, body in ADMIN_CALLS:
                r = self.s.api(method, path, login, body)
                self.assertEqual((r.status, code(r)), (403, "forbidden"),
                                 (login, method, path))
        self.assertEqual(self.state(), before)

    def test_bot_cannot_grant_on_someone_elses_collection(self):
        r = self.s.api("PUT", "/grants", "agent-1", {
            "owner": "alice", "collection": "cal-work", "grantee": "agent-1",
            "level": "readwrite"})
        self.assertEqual(r.status, 403)
        r = self.s.api("GET", "/grants", "agent-1", query="?owner=alice")
        self.assertEqual(r.status, 403)

    def test_unauthenticated_and_bad_credentials(self):
        s = self.s
        self.assertEqual(s.api("GET", "/me").status, 401)
        self.assertEqual(s.api("GET", "/me", "alice", password="nope").status, 401)
        self.assertEqual(s.api("GET", "/me", "ghost", password="nope").status, 401)
        bad_auth = ["Basic", "Basic !!!", "Bearer abc", "Digest x=1",
                    "Basic " + "A" * 1100,
                    "Basic " + base64.b64encode(b"no-colon").decode(),
                    "Basic " + base64.b64encode(b"Alice:" + s.pw["alice"].encode()).decode(),
                    "Basic " + base64.b64encode(b"../x:pw").decode(),
                    "Basic " + base64.b64encode(b"alice:\xff\xfe").decode()]
        for h in bad_auth:
            self.assertEqual(s.api("GET", "/me", auth=h).status, 401, h[:30])

    def test_password_over_72_bytes_is_never_accepted(self):
        # Radicale would truncate and accept the 72-byte prefix: the backend
        # refuses outright. Set a 72-byte password and try with a longer one.
        s = self.s
        pw72 = "p" * 40 + "Q1" * 16  # 72 bytes, no login inside
        self.assertEqual(len(pw72), 72)
        r = s.api("POST", "/accounts/person-1/password", "alice",
                  {"password": pw72})
        self.assertEqual(r.status, 200, r.json)
        self.assertEqual(s.api("GET", "/me", "person-1", password=pw72).status,
                         200)
        self.assertEqual(s.api("GET", "/me", "person-1",
                               password=pw72 + "x").status, 401)
        r = s.api("POST", "/accounts/person-1/password", "alice",
                  {"password": pw72 + "x"})
        self.assertEqual((r.status, code(r)), (422, "validation"))
        s.pw["person-1"] = pw72

    # -- header rules -----------------------------------------------------------
    def test_header_rules(self):
        s = self.s
        body = {"generate": True}
        path = "/accounts/person-1/password"
        r = s.api("POST", path, "alice", body, headers={"X-RadUI": None})
        self.assertEqual((r.status, code(r)), (400, "missing_header"))
        r = s.api("POST", path, "alice", body, headers={"X-RadUI": "2"})
        self.assertEqual(r.status, 400)
        for ctype in ("text/plain", "application/x-www-form-urlencoded",
                      "multipart/form-data; boundary=x", None):
            r = s.api("POST", path, "alice", body,
                      headers={"Content-Type": ctype})
            self.assertEqual((r.status, code(r)),
                             (415, "unsupported_media_type"), ctype)
        r = s.api("POST", path, "alice", body, headers={
            "Origin": "https://evil.example.net"})
        self.assertEqual((r.status, code(r)), (403, "forbidden"))
        r = s.api("GET", "/me", "alice", headers={"Origin": "null"})
        self.assertEqual(r.status, 403)
        r = s.api("GET", "/me", "alice", host="evil.example.net")
        self.assertEqual((r.status, code(r)), (403, "forbidden"))
        r = s.api("GET", "/me", "alice", host="example.org.evil.example.net")
        self.assertEqual(r.status, 403)
        r = s.api("GET", "/me", "alice", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(r.status, 403)
        r = s.api("GET", "/me", "alice", headers={"Sec-Fetch-Site": "same-site"})
        self.assertEqual(r.status, 403)
        # the loopback host:port is allowed, and so are absent browser headers
        r = s.api("GET", "/me", "alice", host="127.0.0.1:%d" % s.bport,
                  headers={"Origin": None, "Sec-Fetch-Site": None})
        self.assertEqual(r.status, 200)
        # a state-changing request from a foreign site changed nothing
        self.assertEqual(s.api("GET", "/accounts/zed-1", "alice").status, 404)

    def test_methods_and_paths(self):
        s = self.s
        for method in ("HEAD", "OPTIONS", "TRACE", "PROPFIND"):
            r = s.api(method, "/me", "alice", mutate_headers=False)
            self.assertEqual(r.status, 405, method)
            self.assertNotIn("access-control-allow-origin", r.headers)
        self.assertEqual(s.api("GET", "/nope", "alice").status, 404)
        self.assertEqual(s.api("PUT", "/me", "alice", {}).status, 405)
        r = s.api("GET", "/../../etc/passwd", "alice")
        self.assertIn(r.status, (400, 404))
        r = s._request("127.0.0.1", s.bport, "GET", "http://example.org/ui/api/me",
                       None, {"Host": H.HOST})
        self.assertEqual(r.status, 400)

    # -- body rules ----------------------------------------------------------------
    def test_body_rules(self):
        s = self.s
        path = "/accounts/person-1/password"
        big = json.dumps({"generate": True, "pad": "x" * 20000}).encode()
        r = s.api("POST", path, "alice", raw=big)
        self.assertEqual((r.status, code(r)), (413, "too_large"))
        r = s.api("POST", path, "alice", raw=b"x" * 5_000_000,
                  headers={"Content-Length": "5000000"})
        self.assertEqual(r.status, 413)
        # no Content-Length on a POST
        r = s._request("127.0.0.1", s.bport, "POST", H.PREFIX + path, None,
                       {"Host": H.HOST, "X-RadUI": "1",
                        "Content-Type": "application/json",
                        "Authorization": H.basic("alice", s.pw["alice"])})
        self.assertEqual((r.status, code(r)), (400, "bad_request"))
        # chunked transfer encoding
        r = s.api("POST", path, "alice", raw=b'4\r\n{"a"\r\n0\r\n\r\n',
                  headers={"Transfer-Encoding": "chunked",
                           "Content-Length": None})
        self.assertEqual((r.status, code(r)), (400, "bad_request"))
        r = s.api("POST", path, "alice", raw=b'{"generate": true}',
                  headers={"Content-Length": "abc"})
        self.assertEqual(r.status, 400)
        for raw in (b"{", b"[]", b"null", b'{"generate": true,}', b"\xff\xfe\xfd",
                    b'{"generate": true, "generate": true}',
                    b'{"a":{"b":{"c":{"d":{}}}}}', b"[" * 4000,
                    b'{"generate": 1e999}', b'{"x": "' + b"y" * 200 + b'"}'):
            r = s.api("POST", path, "alice", raw=raw)
            self.assertEqual((r.status, code(r)), (400, "bad_request"), raw[:30])
        r = s.api("POST", path, "alice", raw=b'{"generate": true}',
                  headers={"Content-Length": "5"})
        self.assertIn(r.status, (400,))
        r = s.api("GET", "/me", "alice", raw=b"x")
        self.assertEqual(r.status, 400)

    def test_hostile_names_are_rejected_and_nothing_changes(self):
        s = self.s
        before = self.state()
        for bad in HOSTILE:
            r = s.api("POST", "/accounts", "alice", {
                "login": bad, "displayName": "X", "generate": True})
            self.assertIn(r.status, (409, 422), repr(bad))  # Alice -> alice exists? no
            if bad.lower() == "alice":
                self.assertEqual(r.status, 409)
        for bad in ("../x", "a/b", "{0}", "%", "a\nb", ".*", "café", "",
                    "c~", "x" * 129):
            r = s.api("PUT", "/grants", "agent-1", {
                "owner": "agent-1", "collection": bad, "grantee": "person-1",
                "level": "read"})
            self.assertIn(r.status, (400, 422), repr(bad))  # 400: >128 chars
        r = s.api("POST", "/accounts", "alice", {
            "login": "x-1", "displayName": "Bad\u0000name", "generate": True})
        self.assertEqual(r.status, 422)
        r = s.api("GET", "/accounts/..%2f..%2fetc", "alice")
        self.assertEqual(r.status, 404)
        self.assertEqual(self.state(), before)
        with open(os.path.join(s.managed, "rights")) as fh:
            self.assertNotIn("{0}", fh.read())

    def test_admin_true_for_bot_rejected(self):
        r = self.s.api("POST", "/accounts", "alice", {
            "login": "bot-adm", "displayName": "B", "type": "bot",
            "admin": True, "generate": True})
        self.assertEqual((r.status, r.json["error"]["field"]), (422, "admin"))

    # -- responses --------------------------------------------------------------------
    def test_every_response_has_the_security_headers_and_no_challenge(self):
        s = self.s
        calls = [("GET", "/me", "alice"), ("GET", "/me", None),
                 ("GET", "/me", "alice", "wrong"), ("GET", "/accounts", "agent-1"),
                 ("GET", "/nope", "alice"), ("GET", "/health", None)]
        for method, path, login, *pw in calls:
            r = s.api(method, path, login, password=pw[0] if pw else None)
            self.assertEqual(r.headers.get("cache-control"), "no-store")
            self.assertEqual(r.headers.get("x-content-type-options"), "nosniff")
            self.assertEqual(r.headers.get("content-security-policy"),
                             "default-src 'none'")
            self.assertTrue(r.headers["content-type"].startswith(
                "application/json"))
            self.assertNotIn("www-authenticate", r.headers)
            self.assertNotIn("server", {k for k in r.headers
                                        if "python" in r.headers[k].lower()})
        self.assertNotIn("www-authenticate", s.seen_headers)

    def test_health_is_anonymous_and_leaks_nothing(self):
        r = self.s.api("GET", "/health")
        self.assertEqual(set(r.json), {"ok", "generation", "active", "modelOk"})
        self.assertEqual(self.s.api("GET", "/health", host="evil.example.net"
                                    ).status, 403)

    def test_malformed_http_is_answered_with_json_not_a_crash(self):
        s = self.s
        for raw in (b"GARBAGE\r\n\r\n", b"GET / HTTP/1.0\r\n" + b"X: y\r\n" * 200
                    + b"\r\n", b"GET /" + b"a" * 70000 + b" HTTP/1.0\r\n\r\n"):
            with socket.create_connection(("127.0.0.1", s.bport), 5) as c:
                c.sendall(raw)
                c.settimeout(5)
                data = c.recv(4096)
            # a request without a protocol version is answered HTTP/0.9 style
            self.assertTrue(data.startswith((b"HTTP/1.0 4", b'{"error"')),
                            data[:40])
            self.assertNotIn(b"WWW-Authenticate", data)
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)

    def test_slow_client_is_dropped_by_the_socket_timeout(self):
        s = self.s
        with socket.create_connection(("127.0.0.1", s.bport), 15) as c:
            c.sendall(b"GET /ui/api/me HTTP/1.0\r\nHost: example.org\r\n")
            c.settimeout(12)
            try:
                data = c.recv(100)
            except socket.timeout:
                self.fail("connection was not closed by the server timeout")
            self.assertTrue(data == b"" or data.startswith(b"HTTP/1.0 4"))
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)

    def test_zz_logs_are_clean(self):
        text = self.s.stdout() + self.s.stderr()
        self.assertNotIn("$2b$", text)
        self.assertNotIn("Authorization", text)
        for pw in set(self.s.pw.values()) | self.s.secrets_seen:
            self.assertNotIn(pw, text)


if __name__ == "__main__":
    unittest.main()
