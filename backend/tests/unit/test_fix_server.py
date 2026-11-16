# SPDX-License-Identifier: AGPL-3.0-or-later
"""m1: ``Content-Length`` is parsed with ``[0-9]{1,9}``; anything else is a
clean 400 ``bad_request`` (no traceback, no dropped connection)."""
import json
import os
import socket
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
import test_fix_common as C  # noqa: E402
from radui_admin import server  # noqa: E402


def raw(port, data, timeout=5):
    with socket.create_connection(("127.0.0.1", port), timeout) as c:
        c.sendall(data)
        c.shutdown(socket.SHUT_WR)
        chunks = []
        try:
            while True:
                chunk = c.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        except (socket.timeout, ConnectionResetError):
            pass
    blob = b"".join(chunks)
    head, _, body = blob.partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1]) if head.startswith(b"HTTP/") else None
    return status, body


class ContentLength(unittest.TestCase):
    def setUp(self):
        root = C.tmp_root(self)
        self.port = C.free_port()
        self.fx = apihelpers.ApiFixture(
            root, listen="127.0.0.1:%d" % self.port, socket_timeout_s=2)
        self.errors = []
        patcher = mock.patch.object(
            server.Server, "handle_error",
            lambda srv, request, addr: self.errors.append(addr))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.srv = server.Server(self.fx.store.cfg, self.fx.api)
        self.thread = threading.Thread(target=self.srv.serve_forever,
                                       daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 5)
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)

    def post(self, length_bytes, body=b"{}"):
        head = (b"POST /ui/api/accounts HTTP/1.0\r\nHost: example.org\r\n"
                b"X-RadUI: 1\r\nContent-Type: application/json\r\n"
                b"Content-Length: " + length_bytes + b"\r\n\r\n")
        return raw(self.port, head + body)

    def test_latin1_digits_are_a_clean_400(self):
        for digit in (b"\xb2", b"\xb9", b"\xb3", b"2\xb2", b"\xb2\xb2"):
            status, body = self.post(digit)
            self.assertEqual(status, 400, digit)
            self.assertEqual(json.loads(body)["error"]["code"], "bad_request")
        self.assertEqual(self.errors, [])          # nothing raised in a handler

    def test_other_malformed_lengths_are_400_too(self):
        for value in (b"", b"+2", b"-2", b"2.0", b"0x2", b"1e3", b"1 2",
                      b"1234567890", b"00000000002", b"\xef\xbc\x92",
                      b"\xd9\xa2"):          # fullwidth and Arabic-Indic digits
            status, body = self.post(value)
            self.assertEqual(status, 400, value)
            self.assertEqual(json.loads(body)["error"]["code"], "bad_request",
                             value)
        self.assertEqual(self.errors, [])

    def test_a_valid_length_still_reaches_the_api(self):
        status, body = self.post(b"2")
        self.assertEqual(status, 401)               # no credentials: the API
        self.assertEqual(json.loads(body)["error"]["code"], "unauthenticated")
        status, body = self.post(b"123456789", b"")   # 9 digits: size cap
        self.assertEqual(status, 413)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
