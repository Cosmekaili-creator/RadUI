# SPDX-License-Identifier: AGPL-3.0-or-later
"""Request-level attacks on the backend: header rules, framing, body size,
JSON shape, control characters, request-target tricks.

Attacker model: a web page on another origin driving the victim's browser
(CSRF: foreign Origin, cross-site Fetch metadata, no custom header, simple
content types), or a script on the network sending malformed, oversized or
ambiguous HTTP. Every rejected request must leave the model, the rights file
and the users file byte-identical and must answer a JSON error without
``WWW-Authenticate``.
"""
import json
import os
import sys
import unicodedata
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import secsupport as S  # noqa: E402

PW = "/accounts/victim-1/password"
BODY = {"generate": True}


def code(r):
    return r.json["error"]["code"] if r.json else None


@S.requires_radicale
class Requests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("requests").up()
        cls.addClassCleanup(s.close)
        s.make_user("victim-1")
        s.make_user("person-1")

    def setUp(self):
        self.start = S.snapshot(self.s)

    def unchanged(self):
        self.assertEqual(S.snapshot(self.s), self.start)

    def no_challenge(self, r):
        self.assertNotIn("www-authenticate", r.headers)

    # -- CSRF-style header rules -------------------------------------------------
    def test_missing_or_wrong_custom_header(self):
        s = self.s
        for value in (None, "", "0", "2", "true", "1,1", "01"):
            r = s.api("POST", PW, "alice", BODY, headers={"X-RadUI": value})
            self.assertEqual((r.status, code(r)), (400, "missing_header"),
                             repr(value))
            self.no_challenge(r)
        # every mutating route, not only the password one
        for method, path, body in (
                ("POST", "/accounts", {"login": "x-1", "displayName": "X",
                                       "generate": True}),
                ("PATCH", "/accounts/victim-1", {"displayName": "Y"}),
                ("DELETE", "/accounts/victim-1", {"confirm": "victim-1"}),
                ("PUT", "/grants", {"owner": "alice", "collection": "c",
                                    "grantee": "agent-1", "level": "read"}),
                ("POST", "/generations/1/restore", {})):
            r = s.api(method, path, "alice", body, headers={"X-RadUI": None})
            self.assertEqual(code(r), "missing_header", (method, path))
        self.unchanged()

    def test_wrong_content_types_are_not_simple_requests(self):
        s = self.s
        for ctype in (None, "", "text/plain", "text/plain;charset=UTF-8",
                      "application/x-www-form-urlencoded", "multipart/form-data",
                      "application/json2", "application/jsonp", "json",
                      "application/xml", "application/json; charset=latin-1",
                      "application/json; boundary=x", "text/json",
                      "application/json, text/plain"):
            r = s.api("POST", PW, "alice", BODY, headers={"Content-Type": ctype})
            self.assertEqual((r.status, code(r)),
                             (415, "unsupported_media_type"), repr(ctype))
        self.unchanged()

    def test_foreign_origins(self):
        s = self.s
        for origin in ("https://evil.example.net", "null", "",
                       "https://example.org.evil.example.net",
                       "https://evil.example.net/https://example.org",
                       "http://example.org", "https://example.org:8443",
                       "https://example.org/", "https://example.org" + chr(64) + "evil.test",
                       "https://example.org\u0000", "file://", "https://sub.example.org"):
            r = s.api("POST", PW, "alice", BODY, headers={"Origin": origin})
            self.assertEqual((r.status, code(r)), (403, "forbidden"),
                             repr(origin))
            r = s.api("GET", "/me", "alice", headers={"Origin": origin})
            self.assertEqual(r.status, 403, repr(origin))
        self.unchanged()

    def test_sec_fetch_site(self):
        s = self.s
        for value in ("cross-site", "same-site", "", "SAME-SITE", "none, cross-site",
                      "same-origin, cross-site", "invalid"):
            r = s.api("POST", PW, "alice", BODY,
                      headers={"Sec-Fetch-Site": value})
            self.assertEqual(r.status, 403, repr(value))
        for ok in ("same-origin", "none", "SAME-ORIGIN"):
            r = s.api("GET", "/me", "alice", headers={"Sec-Fetch-Site": ok})
            self.assertEqual(r.status, 200, ok)
        self.unchanged()

    def test_bad_host_values(self):
        s = self.s
        for host in ("evil.example.net", "example.org.", "example.org:99999",
                     "example.org:", "example.org" + chr(64) + "evil.test", "example.org/x",
                     " ", "", "127.0.0.1", "localhost", "[::1]",
                     "example.org\tevil", "EVIL.example.org"):
            r = s.api("GET", "/me", "alice", host=host)
            self.assertEqual(r.status, 403, repr(host))
            r = s.api("POST", PW, "alice", BODY, host=host)
            self.assertEqual(r.status, 403, repr(host))
        # case is not significant for the allowed host
        self.assertEqual(s.api("GET", "/me", "alice", host="EXAMPLE.ORG").status,
                         200)
        # no Host header at all (HTTP/1.0 allows it)
        st, hd, body = S.raw_http(s.bport, S.request_bytes(
            "GET", S.PREFIX + "/me", [("Authorization", S.basic("alice", s.pw["alice"]))]))
        self.assertEqual(st, 403)
        # two Host headers are refused (request smuggling ambiguity)
        st, hd, body = S.raw_http(s.bport, S.request_bytes(
            "GET", S.PREFIX + "/me", [("Host", "example.org"),
                                      ("Host", "evil.test")]))
        self.assertEqual(st, 400)
        self.unchanged()

    def test_duplicate_security_headers_are_refused(self):
        s = self.s
        base = [("Host", S.HOST), ("Authorization", S.basic("alice", s.pw["alice"]))]
        for name, v1, v2 in (("Authorization", S.basic("alice", s.pw["alice"]),
                              S.basic("person-1", s.pw["person-1"])),
                             ("Origin", S.ORIGIN, "https://evil.example.net"),
                             ("Sec-Fetch-Site", "same-origin", "cross-site")):
            hs = [h for h in base if h[0] != name] + [(name, v1), (name, v2)]
            st, hd, body = S.raw_http(s.bport, S.request_bytes(
                "GET", S.PREFIX + "/me", hs))
            self.assertEqual(st, 400, name)
        for name in ("X-RadUI", "Content-Type", "Content-Length"):
            hs = S.good_headers(s, "alice", mutating=True)
            hs = [h for h in hs if h[0] != name]
            if name != "Content-Length":
                hs += [(name, "1" if name == "X-RadUI" else "application/json")] * 2
            else:
                hs += [("Content-Length", "2"), ("Content-Length", "2")]
            st, hd, body = S.raw_http(s.bport, S.request_bytes(
                "POST", S.PREFIX + PW, hs, b"{}"))
            self.assertEqual(st, 400, name)
        self.unchanged()

    # -- framing and size ---------------------------------------------------------------
    def test_body_size_and_framing(self):
        s = self.s
        # 16 KiB exactly is read (then rejected as not meaningful JSON for this
        # route), one byte more is 413 before the body is parsed
        cap = 16384
        r = s.api("POST", PW, "alice", raw=b" " * cap)
        self.assertEqual(r.status, 422)  # whitespace only = {}: nothing to do
        r = s.api("POST", PW, "alice", raw=b" " * (cap + 1))
        self.assertEqual((r.status, code(r)), (413, "too_large"))
        r = s.api("POST", PW, "alice", raw=b"x" * 300000)
        self.assertEqual(r.status, 413)
        # Content-Length lies: claims a huge body, sends nothing
        st, hd, body = S.raw_http(s.bport, S.request_bytes(
            "POST", S.PREFIX + PW, S.good_headers(s, "alice", True) + [
                ("Content-Length", "100000000")]), timeout=5)
        self.assertEqual(st, 413)
        # claims 100 bytes, sends 5: the socket times out / is refused, never accepted
        st, hd, body = S.raw_http(s.bport, S.request_bytes(
            "POST", S.PREFIX + PW, S.good_headers(s, "alice", True) + [
                ("Content-Length", "100")], b'{"a":'), timeout=20)
        self.assertIn(st, (400, None))
        for cl in ("-1", "+5", "5 5", "0x10", "1e3", "9999999999", "", " "):
            st, hd, body = S.raw_http(s.bport, S.request_bytes(
                "POST", S.PREFIX + PW, S.good_headers(s, "alice", True) + [
                    ("Content-Length", cl)], b"{}"))
            self.assertIn(st, (400, 413), repr(cl))
        # Transfer-Encoding in every shape, with and without Content-Length
        for te in ("chunked", "Chunked", "identity", "gzip, chunked", "x"):
            for with_cl in (False, True):
                hs = S.good_headers(s, "alice", True) + [("Transfer-Encoding", te)]
                if with_cl:
                    hs.append(("Content-Length", "5"))
                st, hd, body = S.raw_http(s.bport, S.request_bytes(
                    "POST", S.PREFIX + PW, hs, b"5\r\n{}\r\n0\r\n\r\n"[:5]))
                self.assertEqual(st, 400, (te, with_cl))
        # Expect: 100-continue must not make the backend read past its limit
        st, hd, body = S.raw_http(s.bport, S.request_bytes(
            "POST", S.PREFIX + PW, S.good_headers(s, "alice", True) + [
                ("Expect", "100-continue"), ("Content-Length", "50000")]),
            timeout=5)
        self.assertEqual(st, 413)
        # a body on GET / DELETE-less verbs
        r = s.api("GET", "/me", "alice", raw=b"{}")
        self.assertEqual(r.status, 400)

    def test_content_length_with_a_latin1_digit_is_a_clean_400(self):
        """Finding F1, fixed: ``str.isdigit()`` is True for the Latin-1 digits
        U+00B2 and U+00B9 but ``int()`` refuses them; the check is now the
        regular expression ``[0-9]{1,9}``."""
        s = self.s
        for digit in (b"\xb2", b"\xb9", b"\xb3"):
            raw = (b"POST " + (S.PREFIX + PW).encode() + b" HTTP/1.0\r\n"
                   + b"Host: example.org\r\nContent-Length: " + digit
                   + b"\r\n\r\n{}")
            st, hd, body = S.raw_http(s.bport, raw)
            self.assertEqual(st, 400, digit)

    def test_request_line_and_header_limits(self):
        s = self.s
        big_path = S.PREFIX + "/" + "a" * 70000
        st, hd, body = S.raw_http(s.bport, S.request_bytes(
            "GET", big_path, S.good_headers(s, "alice")))
        self.assertIn(st, (400, 414, None))
        many = S.good_headers(s, "alice") + [("X-%d" % i, "v") for i in range(500)]
        st, hd, body = S.raw_http(s.bport, S.request_bytes(
            "GET", S.PREFIX + "/me", many))
        self.assertIn(st, (400, 431, None))
        huge_value = S.good_headers(s, "alice") + [("X-Big", "v" * 200000)]
        st, hd, body = S.raw_http(s.bport, S.request_bytes(
            "GET", S.PREFIX + "/me", huge_value))
        self.assertIn(st, (400, 431, None))
        # an Authorization header over 1 KiB is refused without reaching Radicale
        r = s.api("GET", "/me", auth="Basic " + "QQ==" * 400)
        self.assertEqual(r.status, 401)
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)
        self.unchanged()

    # -- JSON ---------------------------------------------------------------------------------
    def test_malformed_json_everywhere(self):
        s = self.s
        deep = b'{"a":' * 5000 + b"1" + b"}" * 5000
        bombs = [
            b"{", b"}", b"", b"[]", b"[{}]", b"null", b"true", b'"str"', b"1",
            b'{"generate": true,}', b"{'generate': true}", b'{generate: true}',
            b'{"generate": true} x', b'{"generate": true}{"generate": true}',
            b"\xef\xbb\xbf" + b'{"generate": true}',          # BOM
            '{"generate": true}'.encode("utf-16"),             # UTF-16
            b'{"generate": true, "generate": false}',          # duplicate key
            b'{"a": {"b": 1, "b": 2}, "generate": true}',      # nested duplicate
            b'{"generate": NaN}', b'{"generate": Infinity}', b'{"generate": -Infinity}',
            b'{"generate": 1.5}', b'{"generate": 1e5}', b'{"generate": 1E400}',
            b'{"generate": ' + b"9" * 5000 + b"}",             # int digit limit
            b'{"a":{"b":{"c":{"d":{"e":1}}}},"generate":true}',  # depth 6
            b'{"generate": [[[[[1]]]]]}',
            b"[" * 16000, b'{"a":' * 3000 + b"1" + b"}" * 3000, deep[:16000],
            b'{"generate": "\\ud800"}',                         # lone surrogate
            b'{"generate": "\\udfff\\ud800"}',
            b'{"x": "' + b"y" * 129 + b'"}',                    # 129-char string
            b'{"' + b"k" * 129 + b'": 1}',                      # long key
            b'{"generate": true}\x00', b'\x00{"generate": true}',
            b'{"generate": tru\x00e}', b'\xff\xfe\xfd',
        ]
        for raw in bombs:
            r = s.api("POST", PW, "alice", raw=raw)
            self.assertIn(r.status, (400, 413, 422), raw[:40])
            self.assertTrue(r.json and "error" in r.json, raw[:40])
            self.no_challenge(r)
        self.unchanged()

    def test_unknown_and_mistyped_fields_are_422(self):
        s = self.s
        for body in ({"generate": True, "hash": "$2b$04$" + "a" * 53},
                     {"generate": True, "admin": True},
                     {"generate": 1}, {"generate": "true"}, {"generate": False},
                     {"password": 12345678901234}, {"password": None},
                     {"password": ["x"]}, {"password": {"a": 1}},
                     {"password": "a long enough passphrase 1!", "generate": True},
                     {}):
            r = s.api("POST", PW, "alice", body)
            self.assertEqual(r.status, 422, body)
        # mass assignment on account creation and update
        for extra in ({"hash": "$2b$04$" + "a" * 53}, {"created": "2020-01-01T00:00:00Z"},
                      {"passwordChanged": "2020-01-01T00:00:00Z"},
                      {"generation": 99}, {"tombstones": {}}, {"genToken": "a" * 32}):
            body = {"login": "mass-1", "displayName": "M", "generate": True}
            body.update(extra)
            r = s.api("POST", "/accounts", "alice", body)
            self.assertEqual(r.status, 422, extra)
            r = s.api("PATCH", "/accounts/victim-1", "alice",
                      dict(extra, displayName="Z"))
            self.assertEqual(r.status, 422, extra)
        # "disabled" is a real field of PATCH but not of POST /accounts
        r = s.api("POST", "/accounts", "alice", {
            "login": "mass-1", "displayName": "M", "generate": True,
            "disabled": True})
        self.assertEqual(r.status, 422)
        self.unchanged()

    def test_control_characters_and_nul_in_every_text_field(self):
        s = self.s
        bad_text = ["a\u0000b", "a\nb", "a\rb", "a\tb", "a\u001bb", "a\u007fb",
                    "a\u0085b", "a\u2028b", "a\u2029b", "a\u200bb", "a\u202eb",
                    "a\ufeffb", "a\U000e0001b"]
        for text in bad_text:
            r = s.api("POST", "/accounts", "alice", {
                "login": "ctrl-1", "displayName": text, "generate": True})
            self.assertEqual(r.status, 422, repr(text))
            r = s.api("PATCH", "/accounts/victim-1", "alice",
                      {"displayName": text})
            self.assertEqual(r.status, 422, repr(text))
            r = s.api("POST", "/accounts", "alice", {
                "login": "ctrl-" + text, "displayName": "X", "generate": True})
            self.assertEqual(r.status, 422, repr(text))
            if unicodedata.category(text[1]) == "Cc":
                r = s.api("POST", PW, "alice",
                          {"password": "a long passphrase 9!" + text})
                self.assertEqual(r.status, 422, repr(text))
            r = s.api("PUT", "/grants", "alice", {
                "owner": "alice", "collection": "c" + text, "grantee": "agent-1",
                "level": "read"})
            self.assertIn(r.status, (422,), repr(text))
        for text in ("", " ", " pad", "pad ", "x" * 65):
            r = s.api("POST", "/accounts", "alice", {
                "login": "ctrl-2", "displayName": text, "generate": True})
            self.assertEqual(r.status, 422, repr(text))
        # the JSON null / non-string forms
        for dn in (None, 5, True, ["a"], {"a": 1}):
            r = s.api("POST", "/accounts", "alice", {
                "login": "ctrl-3", "displayName": dn, "generate": True})
            self.assertEqual(r.status, 422, repr(dn))
        # a password with control characters is refused, a space is fine
        for pw in ("a long passphrase 9!\u0000", "a long\npassphrase 9!x",
                   "a long\tpassphrase 9!x", "a long passphrase\u0007 9!x"):
            r = s.api("POST", PW, "alice", {"password": pw})
            self.assertEqual(r.status, 422, repr(pw))
        self.unchanged()

    def test_huge_strings_and_many_fields(self):
        s = self.s
        r = s.api("POST", "/accounts", "alice", {
            "login": "huge-1", "displayName": "x" * 128, "generate": True})
        self.assertEqual(r.status, 422)  # 64 characters is the display limit
        r = s.api("POST", "/accounts", "alice", {
            "login": "huge-1", "displayName": "x" * 129, "generate": True})
        self.assertEqual(r.status, 400)
        r = s.api("POST", "/accounts", "alice", {"login": "l" * 128,
                                                  "displayName": "x", "generate": True})
        self.assertEqual(r.status, 422)
        fields = dict(("f%d" % i, i) for i in range(400))
        r = s.api("POST", PW, "alice", fields)
        self.assertEqual(r.status, 422)
        self.unchanged()

    # -- request target ---------------------------------------------------------------------
    def test_query_strings_and_targets(self):
        s = self.s
        for q in ("?dryRun=2", "?dryRun=", "?dryRun=1&dryRun=1", "?dryRun=true",
                  "?dryRun", "?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9", "?a=1&&b"):
            r = s.api("POST", PW, "alice", BODY, query=q)
            self.assertEqual(r.status, 400, q)
        self.unchanged()
        # unknown parameters are ignored, never an error of the server
        for q in ("?%00", "?DRYRUN=1x", "?x=%", "?x=1"):
            r = s.api("POST", PW, "alice", BODY, query=q)
            self.assertIn(r.status, (200, 400), q)
        for q in ("?dryRun=1",):
            r = s.api("GET", "/me", "alice", query=q)
            self.assertEqual(r.status, 400)
        for target in ("/ui/api/me#frag", "/ui/api/%2e%2e/me",
                       "/ui/api/me%00", "/ui/api/../api/me", "/ui/api/./me",
                       "/ui/api//me", "/ui/api/ME", "/ui/api/me/..;/x",
                       "http://example.org/ui/api/me", "//example.org/ui/api/me",
                       "*", "/", "", "/ui/apix/me", "ui/api/me"):
            st, hd, body = S.raw_http(s.bport, S.request_bytes(
                "GET", target, S.good_headers(s, "alice")))
            self.assertIn(st, (400, 404, 405, None), target)
            self.assertNotIn("www-authenticate", hd)
        # encoded slash in a login segment never reaches the account lookup
        r = s.api("GET", "/accounts/..%2Falice", "alice")
        self.assertEqual(r.status, 404)
        r = s.api("GET", "/accounts/%61lice", "alice")  # %61 = a: no decoding
        self.assertEqual(r.status, 404)

    def test_unusual_methods(self):
        s = self.s
        for method in ("TRACE", "CONNECT", "OPTIONS", "HEAD", "PROPFIND", "MKCOL",
                       "LOCK", "COPY", "PURGE", "get", "G ET"):
            st, hd, body = S.raw_http(s.bport, S.request_bytes(
                method, S.PREFIX + "/me", S.good_headers(s, "alice")))
            self.assertIn(st, (400, 405, 501, None), method)
            self.assertNotIn("access-control-allow-origin", hd)
        r = s.api("OPTIONS", "/me", "alice", mutate_headers=False)
        self.assertEqual(r.status, 405)
        self.assertNotIn("access-control-allow-origin", r.headers)

    def test_zz_responses_never_challenge_or_allow_cross_origin(self):
        self.assertNotIn("www-authenticate", self.s.seen_headers)
        self.assertNotIn("access-control-allow-origin", self.s.seen_headers)
        self.assertNotIn("set-cookie", self.s.seen_headers)


if __name__ == "__main__":
    unittest.main()
