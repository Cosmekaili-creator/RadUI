# SPDX-License-Identifier: AGPL-3.0-or-later
"""authn.py (header parsing, forwarding) and probe.py against a fake Radicale."""
import base64
import http.server
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
from radui_admin import authn, config, probe  # noqa: E402
from radui_admin.names import ApiError  # noqa: E402


def b64(text):
    return base64.b64encode(text.encode()).decode()


class ParseBasic(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(authn.parse_basic("Basic " + b64("alice:s3cret")),
                         ("alice", "s3cret"))
        self.assertEqual(authn.parse_basic("basic " + b64("a1:p:q")),
                         ("a1", "p:q"))

    def test_rejected(self):
        bad = [None, "", "Basic", "Basic ", "Bearer abc", "Basic !!!!",
               "Basic " + b64("nocolon"), "Basic " + b64("Alice:pw"),
               "Basic " + b64(":pw"), "Basic " + b64("a/b:pw"),
               "Basic " + b64("../x:pw"), "Basic " + b64("al ice:pw"),
               "Basic " + base64.b64encode(b"alice:\xff\xfe").decode(),
               "Basic " + "A" * 1100, "Basic YWxpY2U6cHc",  # bad padding
               "Basic YWxp Y2U6cHc=", "Basic é"]
        for h in bad:
            with self.assertRaises(ApiError, msg=repr(h)) as cm:
                authn.parse_basic(h)
            self.assertEqual(cm.exception.code, "unauthenticated")

    def test_password_length_limit_is_bytes(self):
        self.assertEqual(authn.parse_basic("Basic " + b64("alice:" + "x" * 72))[1],
                         "x" * 72)
        with self.assertRaises(ApiError):
            authn.parse_basic("Basic " + b64("alice:" + "x" * 73))
        with self.assertRaises(ApiError):  # 37 two-byte characters = 74 bytes
            authn.parse_basic("Basic " + b64("alice:" + "é" * 37))

    def test_header_cap_is_1_kib(self):
        pw = "x" * 70
        ok = "Basic " + b64("alice:" + pw)
        self.assertLessEqual(len(ok), 1024)
        authn.parse_basic(ok)


class ClientIp(unittest.TestCase):
    def test_trusted_header_validated(self):
        f = authn.client_ip
        self.assertEqual(f({"x-real-ip": "192.0.2.7"}, "127.0.0.1", "X-Real-IP"),
                         "192.0.2.7")
        self.assertEqual(f({"x-real-ip": "2001:db8::1"}, "127.0.0.1", "X-Real-IP"),
                         "2001:db8::1")
        for bad in ("evil, 192.0.2.4", "192.0.2.4 extra", "999.1.1.1", "' or 1=1",
                    "192.0.2.4\r\nX: y", "", "unknown"):
            self.assertEqual(f({"x-real-ip": bad}, "127.0.0.1", "X-Real-IP"),
                             "127.0.0.1", repr(bad))
        self.assertEqual(f({}, "127.0.0.1", "X-Real-IP"), "127.0.0.1")
        self.assertEqual(f({"x-client": "192.0.2.9"}, "127.0.0.1", "X-Client"),
                         "192.0.2.9")


class FakeRadicale(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    seen = []
    status = 207
    body = b""

    def do_PROPFIND(self):
        type(self).seen.append((self.path, dict(self.headers.items())))
        self.send_response(type(self).status)
        self.send_header("Content-Length", str(len(type(self).body)))
        self.end_headers()
        self.wfile.write(type(self).body)

    do_GET = do_PROPFIND

    def log_message(self, *a):
        pass


class WithFakeRadicale(unittest.TestCase):
    def setUp(self):
        FakeRadicale.seen, FakeRadicale.status, FakeRadicale.body = [], 207, b""
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                                                   FakeRadicale)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.cfg = apihelpers.make_cfg(
            apihelpers.make_dir(self), radicale_url="http://127.0.0.1:%d"
            % self.srv.server_address[1])


class ClientTests(WithFakeRadicale):
    def test_authenticate_maps_status(self):
        c = authn.RadicaleClient(self.cfg)
        hdr = "Basic " + b64("alice:pw")
        self.assertTrue(c.authenticate(hdr, "192.0.2.4"))
        path, headers = FakeRadicale.seen[0]
        self.assertEqual(path, "/")
        self.assertEqual(headers["Authorization"], hdr)
        self.assertEqual(headers["Depth"], "0")
        self.assertEqual(headers["X-Forwarded-For"], "192.0.2.4")
        FakeRadicale.status = 401
        self.assertFalse(c.authenticate(hdr, "192.0.2.4"))
        for status in (200, 403, 404, 500, 503):
            FakeRadicale.status = status
            with self.assertRaises(ApiError) as cm:
                c.authenticate(hdr, "192.0.2.4")
            self.assertEqual(cm.exception.code, "radicale_unexpected")

    def test_unreachable_radicale_is_502(self):
        cfg = apihelpers.make_cfg(apihelpers.make_dir(self),
                                  radicale_url="http://127.0.0.1:1")
        with self.assertRaises(ApiError) as cm:
            authn.RadicaleClient(cfg).authenticate("Basic " + b64("a1:p"), "x")
        self.assertEqual(cm.exception.code, "radicale_unexpected")

    def test_count_collections_and_kinds(self):
        c = authn.RadicaleClient(self.cfg)
        hdr = "Basic " + b64("alice:pw")
        FakeRadicale.body = (
            b'<?xml version="1.0"?><multistatus xmlns="DAV:">'
            b'<response><href>/bob/</href></response>'
            b'<response><href>/bob/cal/</href></response>'
            b'<response><href>/bob/book/</href></response></multistatus>')
        self.assertEqual(c.count_collections(hdr, "192.0.2.4", "bob"), 2)
        FakeRadicale.status = 404
        self.assertEqual(c.count_collections(hdr, "192.0.2.4", "bob"), 0)
        FakeRadicale.status = 207
        FakeRadicale.body = (
            b'<multistatus xmlns="DAV:" '
            b'xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/a/b/'
            b'</href><propstat><prop><resourcetype><collection/><C:calendar/>'
            b'</resourcetype></prop></propstat></response></multistatus>')
        self.assertEqual(c.collection_kind(hdr, "x", "a", "b"), "calendar")
        FakeRadicale.body = (b'<multistatus xmlns="DAV:"><response><href>/a/b/'
                             b'</href><propstat><prop><resourcetype>'
                             b'<collection/></resourcetype></prop></propstat>'
                             b'</response></multistatus>')
        self.assertEqual(c.collection_kind(hdr, "x", "a", "b"), "other")
        FakeRadicale.status = 404
        self.assertIsNone(c.collection_kind(hdr, "x", "a", "b"))
        FakeRadicale.status = 403
        with self.assertRaises(ApiError) as cm:
            c.collection_kind(hdr, "x", "a", "b")
        self.assertEqual(cm.exception.code, "forbidden")

    def test_xml_entities_refused(self):
        c = authn.RadicaleClient(self.cfg)
        FakeRadicale.body = (b'<!DOCTYPE x [<!ENTITY a "b">]><multistatus '
                             b'xmlns="DAV:"/>')
        with self.assertRaises(ApiError) as cm:
            c.count_collections("Basic " + b64("a1:p"), "x", "bob")
        self.assertEqual(cm.exception.code, "radicale_unexpected")


class ProbeTests(WithFakeRadicale):
    TOKEN = "0" * 32

    def test_active_inactive_and_path(self):
        p = probe.Prober(self.cfg)
        FakeRadicale.status = 404
        self.assertTrue(p.wait_active(self.TOKEN))
        self.assertEqual(FakeRadicale.seen[0][0], "/radui-gen-" + self.TOKEN)
        self.assertNotIn("Authorization", FakeRadicale.seen[0][1])
        FakeRadicale.status = 401
        FakeRadicale.seen.clear()
        self.assertFalse(p.wait_active(self.TOKEN, budget=0.7))
        self.assertTrue(2 <= len(FakeRadicale.seen) <= 4,
                        len(FakeRadicale.seen))

    def test_unexpected_status_is_not_active(self):
        p = probe.Prober(self.cfg)
        FakeRadicale.status = 200
        self.assertFalse(p.wait_active(self.TOKEN, budget=0.4))
        self.assertEqual(p.last_status, 200)

    def test_unreachable_is_not_active_and_bad_token_refused(self):
        p = probe.Prober(apihelpers.make_cfg(
            apihelpers.make_dir(self), radicale_url="http://127.0.0.1:1"))
        self.assertFalse(p.wait_active(self.TOKEN, budget=0.4))
        with self.assertRaises(ValueError):
            p.probe_once("../x")

    def test_one_probe_in_flight(self):
        p = probe.Prober(self.cfg)
        FakeRadicale.status = 404
        p._inflight.acquire()
        try:
            self.assertEqual(p.probe_once(self.TOKEN, timeout=0.1), 0)
        finally:
            p._inflight.release()
        self.assertEqual(p.probe_once(self.TOKEN), 404)

    def test_generation_accessor_reads_header(self):
        p = probe.Prober(self.cfg)
        self.assertIsNone(p.generation())
        os.makedirs(self.cfg.managed_dir, exist_ok=True)
        with open(self.cfg.rights_path, "w") as fh:
            fh.write("# radui-admin generated; DO NOT EDIT. generation=42\n\n")
        self.assertEqual(p.generation(), 42)
        with open(self.cfg.rights_path, "w") as fh:
            fh.write("garbage\n")
        self.assertIsNone(p.generation())


if __name__ == "__main__":
    unittest.main()
