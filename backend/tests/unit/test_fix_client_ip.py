# SPDX-License-Identifier: AGPL-3.0-or-later
"""M4: the trusted proxy header is honoured only from a trusted TCP peer, only
when it is one plain address, and the address used for the per-IP limiter and
forwarded to Radicale is always a validated one."""
import http.server
import ipaddress
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
import test_fix_common as C  # noqa: E402
from radui_admin import authn, config  # noqa: E402
from radui_admin.api import Request  # noqa: E402

H = "X-Real-IP"
MAPPED = "::ffff:"  # IPv4-mapped IPv6 prefix, joined to the address below
SCOPED = "2001:db8::1%a') x (forwarded for '198.51.100.99"


def ip(headers, peer, nets=None):
    return authn.client_ip({k.lower(): v for k, v in headers.items()}, peer, H,
                           nets)


class ClientIp(unittest.TestCase):
    def test_scoped_ipv6_injection_falls_back_to_the_peer(self):
        self.assertEqual(ip({H: SCOPED}, "127.0.0.1"), "127.0.0.1")
        self.assertEqual(ip({H: "2001:db8::1%eth0"}, "127.0.0.1"), "127.0.0.1")
        self.assertEqual(ip({H: "2001:db8::1%1"}, "::1"), "::1")

    def test_header_from_a_peer_that_is_not_trusted_is_ignored(self):
        for peer in ("192.0.2.9", "198.51.100.7", "2001:db8::5"):
            self.assertEqual(ip({H: "203.0.113.1"}, peer), peer)
            self.assertEqual(ip({H: SCOPED}, peer), peer)

    def test_header_from_a_trusted_peer_is_used(self):
        self.assertEqual(ip({H: "203.0.113.1"}, "127.0.0.1"), "203.0.113.1")
        self.assertEqual(ip({H: "2001:db8::1"}, "::1"), "2001:db8::1")
        self.assertEqual(ip({H: "2001:DB8:0:0::1"}, "::1"), "2001:db8::1")
        self.assertEqual(ip({H: " 203.0.113.1 "}, "127.0.0.1"), "203.0.113.1")

    def test_trusted_networks_can_be_configured(self):
        nets = tuple(ipaddress.ip_network(n) for n in ("192.0.2.0/24",
                                                       "2001:db8::/32"))
        self.assertEqual(ip({H: "203.0.113.1"}, "192.0.2.77", nets),
                         "203.0.113.1")
        self.assertEqual(ip({H: "203.0.113.1"}, "2001:db8::9", nets),
                         "203.0.113.1")
        # loopback is no longer trusted when it is not in the list
        self.assertEqual(ip({H: "203.0.113.1"}, "127.0.0.1", nets), "127.0.0.1")
        self.assertEqual(ip({H: "203.0.113.1"}, "127.0.0.1", ()), "127.0.0.1")

    def test_ipv4_mapped_peer_is_matched_as_ipv4(self):
        self.assertEqual(ip({H: "203.0.113.1"}, MAPPED + "127.0.0.1"),
                         "203.0.113.1")
        self.assertEqual(ip({H: "203.0.113.1"}, MAPPED + "192.0.2.9"),
                         MAPPED + "192.0.2.9")

    def test_multiple_values_and_junk_are_refused(self):
        for bad in ("203.0.113.1, 203.0.113.2", "203.0.113.1,203.0.113.2",
                    "203.0.113.1 203.0.113.2", "203.0.113.1;x", "evil",
                    "' or 1=1", "unknown", "999.1.1.1", "203.0.113",
                    "0x7f.1", "203.000" + ".113.001", "-198.51.100.99", "[2001:db8::1]",
                    "203.0.113.1:80", "2001:db8::1/64", "::1%", "%",
                    "198.51.100.99" + chr(0xb2), chr(0xff11) + ".2.3.4", "a" * 2000, ""):
            self.assertEqual(ip({H: bad}, "127.0.0.1"), "127.0.0.1", repr(bad))

    def test_control_characters_and_crlf_are_refused(self):
        for bad in ("203.0.113.1\r\nX-Evil: 1", "\r\n",
                    "203.0.113.1\x00", "203.0.113.1\t203.0.113.2",
                    "203.0.113.1\r\n(forwarded for '198.51.100.77')"):
            self.assertEqual(ip({H: bad}, "127.0.0.1"), "127.0.0.1", repr(bad))

    def test_a_peer_that_is_not_an_address_never_comes_out_raw(self):
        self.assertEqual(ip({}, "2001:db8::1%eth0"), "2001:db8::1")
        junk = ip({}, "x') (forwarded for '198.51.100.99")
        self.assertEqual(junk, authn.UNKNOWN_ADDRESS)
        self.assertEqual(ip({H: "203.0.113.1"}, "garbage"), "0.0.0.0")

    def test_the_result_is_always_a_plain_address(self):
        cases = [({H: SCOPED}, "127.0.0.1"), ({H: "203.0.113.1"}, "127.0.0.1"),
                 ({}, "::1"), ({H: "198.51.100.99%x"}, "198.51.100.1"),
                 ({H: MAPPED + "198.51.100.99"}, "127.0.0.1")]
        for headers, peer in cases:
            out = ip(headers, peer)
            self.assertEqual(str(ipaddress.ip_address(out)), out)
            self.assertNotIn("%", out)

    def test_the_header_name_is_configurable(self):
        self.assertEqual(authn.client_ip({"x-client": "203.0.113.9"},
                                         "127.0.0.1", "X-Client"),
                         "203.0.113.9")
        self.assertEqual(authn.client_ip({"x-real-ip": "203.0.113.9"},
                                         "127.0.0.1", "X-Client"), "127.0.0.1")


class TrustedProxiesConfig(unittest.TestCase):
    base = {"allowed_hosts": ["example.org"]}

    def load(self, **kw):
        return config.from_dict(dict(self.base, **kw))

    def test_default_is_loopback_only(self):
        c = self.load()
        self.assertEqual(c.trusted_proxies, ("127.0.0.1", "::1"))
        self.assertEqual([str(n) for n in c.trusted_networks],
                         ["127.0.0.1/32", "::1/128"])

    def test_addresses_and_networks_are_accepted_and_normalised(self):
        c = self.load(trusted_proxies=["192.0.2.0/24", "2001:DB8::1", "::1"])
        self.assertEqual(c.trusted_proxies,
                         ("192.0.2.0/24", "2001:db8::1/128", "::1/128"))
        self.assertEqual(self.load(trusted_proxies=[]).trusted_networks, ())

    def test_bad_entries_are_refused(self):
        for bad in ("2001:db8::1%eth0", "localhost", "192.0.2.0/33", "1.2.3",
                    "192.0.2.1, 192.0.2.2", "", "::1%", "a'b", "198.51.100.99 "):
            with self.assertRaises(config.ConfigError, msg=repr(bad)):
                self.load(trusted_proxies=[bad])
        for bad in ("127.0.0.1", 5, [5], None):
            with self.assertRaises(config.ConfigError, msg=repr(bad)):
                self.load(trusted_proxies=bad)


class FakeRadicale(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_PROPFIND(self):
        type(self).seen.append(self.headers.get("X-Forwarded-For"))
        self.send_response(207)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a):
        pass


class Forwarding(unittest.TestCase):
    def setUp(self):
        FakeRadicale.seen = []
        self.port = C.free_port()
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", self.port),
                                                   FakeRadicale)
        self.thread = threading.Thread(target=self.srv.serve_forever,
                                       daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 5)
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.cfg = apihelpers.make_cfg(C.tmp_root(self), radicale_url=(
            "http://127.0.0.1:%d" % self.port))

    def test_the_forwarded_value_is_validated_by_the_client_too(self):
        client = authn.RadicaleClient(self.cfg)
        for raw in (SCOPED, "2001:db8::1%eth0", "198.51.100.99\r\nX-Evil: 1", "evil",
                    "'; --"):
            client.authenticate("Basic QTpC", raw)
        client.authenticate("Basic QTpC", "203.0.113.4")
        client.authenticate("Basic QTpC", "2001:db8::1")
        self.assertEqual(FakeRadicale.seen, ["0.0.0.0"] * 5
                         + ["203.0.113.4", "2001:db8::1"])


class ApiKeysTheLimiterOnTheValidatedAddress(unittest.TestCase):
    """Limiter: 3 failures per window (``ApiFixture``)."""

    def setUp(self):
        self.fx = apihelpers.ApiFixture(C.tmp_root(self))

    def login(self, peer, header=None, password="wrong"):
        import base64
        h = {"host": "example.org", "origin": "https://example.org",
             "sec-fetch-site": "same-origin",
             "authorization": "Basic " + base64.b64encode(
                 ("bob:" + password).encode()).decode()}
        if header is not None:
            h["x-real-ip"] = header
        return self.fx.api.dispatch(Request("GET", "/ui/api/me", h, b"", peer))

    def test_spoofed_header_from_an_untrusted_peer_cannot_dodge_the_limiter(self):
        for i in range(3):
            r = self.login("198.51.100.5", "203.0.113.%d" % (i + 1))
            self.assertEqual(r.status, 401)
        r = self.login("198.51.100.5", "203.0.113.99")      # a "new" address
        self.assertEqual(r.status, 429)
        # a different peer is a different key
        self.assertEqual(self.login("198.51.100.6", "203.0.113.1").status, 401)
        self.assertEqual({c[2] for c in self.fx.dav.calls
                          if c[0] == "authenticate"},
                         {"198.51.100.5", "198.51.100.6"})

    def test_header_from_the_trusted_peer_keys_the_limiter(self):
        for _ in range(3):
            self.assertEqual(self.login("127.0.0.1", "203.0.113.1").status, 401)
        self.assertEqual(self.login("127.0.0.1", "203.0.113.1").status, 429)
        self.assertEqual(self.login("127.0.0.1", "203.0.113.2").status, 401)
        # the right password of a blocked address is refused as well
        r = self.login("127.0.0.1", "203.0.113.1", password="pw-bob")
        self.assertEqual(r.status, 429)

    def test_scoped_value_is_not_a_key_and_not_forwarded(self):
        for _ in range(3):
            self.assertEqual(self.login("127.0.0.1", SCOPED).status, 401)
        self.assertEqual(self.login("127.0.0.1", SCOPED).status, 429)
        # it was counted against the peer, so a header-less request from the
        # same peer is blocked too
        self.assertEqual(self.login("127.0.0.1").status, 429)
        sent = {c[2] for c in self.fx.dav.calls if c[0] == "authenticate"}
        self.assertEqual(sent, {"127.0.0.1"})

    def test_audit_lines_carry_the_validated_address_only(self):
        self.login("127.0.0.1", SCOPED)
        self.login("127.0.0.1", "203.0.113.8")
        ips = [e["ip"] for e in self.fx.store.test_stream.events()
               if e["event"] == "auth.failed"]
        self.assertEqual(ips, ["127.0.0.1", "203.0.113.8"])


if __name__ == "__main__":
    unittest.main()
