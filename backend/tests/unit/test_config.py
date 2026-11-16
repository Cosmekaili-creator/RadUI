# SPDX-License-Identifier: AGPL-3.0-or-later
"""config.py: strict TOML configuration."""
import os
import sys
import tomllib
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apihelpers  # noqa: E402
from radui_admin import config
from radui_admin.config import ConfigError

GOOD = {"allowed_hosts": ["Example.org", "127.0.0.1:5233"]}


class FromDict(unittest.TestCase):
    def test_defaults_are_neutral(self):
        c = config.from_dict(GOOD)
        self.assertEqual(c.allowed_hosts, ("example.org", "127.0.0.1:5233"))
        self.assertEqual(c.listen, "127.0.0.1:5233")
        self.assertEqual(c.radicale_url, "http://127.0.0.1:5232")
        self.assertEqual(c.trusted_proxy_header, "X-Real-IP")
        self.assertEqual(c.bcrypt_cost, 12)
        self.assertEqual(c.state_dir, "/var/lib/radui")
        self.assertEqual(c.managed_dir, "/etc/radui/managed")
        self.assertEqual(c.api_prefix, "/ui/api/")
        self.assertEqual(c.effective_origins, ("https://example.org",
                                               "https://127.0.0.1:5233"))
        self.assertEqual((c.rate_limit_failures, c.rate_limit_window_s,
                          c.rate_limit_block_s), (10, 600, 900))

    def test_allowed_hosts_required(self):
        with self.assertRaisesRegex(ConfigError, "allowed_hosts is required"):
            config.from_dict({})
        with self.assertRaises(ConfigError):
            config.from_dict({"allowed_hosts": []})

    def test_unknown_key_refused(self):
        with self.assertRaisesRegex(ConfigError, "unknown configuration key"):
            config.from_dict(dict(GOOD, nope=1))

    def test_bad_values_refused(self):
        bad = [("listen", "0.0.0.0:80"), ("listen", "example.org:80"),
               ("listen", "127.0.0.1"), ("listen", "127.0.0.1:0"),
               ("radicale_url", "ftp://x"), ("radicale_url", "http://x/p"),
               ("radicale_url", "http://u:p@x"), ("bcrypt_cost", 3),
               ("bcrypt_cost", True), ("bcrypt_cost", "12"),
               ("managed_dir", "relative"), ("state_dir", ""),
               ("allowed_origins", ["https://x/path"]),
               ("allowed_origins", ["ftp://x"]),
               ("allowed_hosts", ["a b"]), ("allowed_hosts", ["*"]),
               ("trusted_proxy_header", "bad header"),
               ("max_body_bytes", 10), ("max_accounts", 201),
               ("max_grants", 2001), ("radicale_group", "Bad Group"),
               ("extra_reserved_logins", ["BAD/NAME"]),
               ("socket_timeout_s", 0), ("base_path", "ui/api"),
               ("base_path", "/a/../b"), ("plugin_dir", "rel")]
        for key, value in bad:
            with self.assertRaises(ConfigError, msg="%s=%r" % (key, value)):
                config.from_dict(dict(GOOD, **{key: value}))

    def test_same_state_and_managed_dir_refused(self):
        with self.assertRaises(ConfigError):
            config.from_dict(dict(GOOD, state_dir="/x", managed_dir="/x"))

    def test_reserved_logins_lowercased(self):
        c = config.from_dict(dict(GOOD, extra_reserved_logins=["Billing"]))
        self.assertEqual(c.extra_reserved_logins, ("billing",))

    def test_not_a_table(self):
        with self.assertRaises(ConfigError):
            config.from_dict([])


class LoadFile(unittest.TestCase):
    def setUp(self):
        self.dir = apihelpers.make_dir(self)
        self.path = os.path.join(self.dir, "c.toml")

    def write(self, text, mode):
        with open(self.path, "w") as fh:
            fh.write(text)
        os.chmod(self.path, mode)

    def test_load_ok_and_env_path(self):
        self.write('allowed_hosts = ["example.org"]\n', 0o640)
        self.assertEqual(config.load(self.path).allowed_hosts,
                         ("example.org",))
        c = config.load(environ={config.ENV_CONFIG: self.path})
        self.assertEqual(c.allowed_hosts, ("example.org",))
        self.assertEqual(config.resolve_path(None, {}),
                         "/etc/radui/config.toml")

    def test_writable_file_refused(self):
        for mode in (0o666, 0o662, 0o620):
            self.write('allowed_hosts = ["example.org"]\n', mode)
            with self.assertRaisesRegex(ConfigError, "writable"):
                config.load(self.path)

    def test_missing_and_invalid_toml(self):
        with self.assertRaises(ConfigError):
            config.load(os.path.join(self.dir, "missing.toml"))
        self.write("allowed_hosts = [", 0o600)
        with self.assertRaisesRegex(ConfigError, "not valid TOML"):
            config.load(self.path)

    def test_example_config_loads(self):
        path = os.path.join(apihelpers.helpers.BACKEND, "config.example.toml")
        with open(path, "rb") as fh:  # repo checkouts may be group-writable
            c = config.from_dict(tomllib.load(fh))
        self.assertIn("rd.example.org", c.allowed_hosts)


if __name__ == "__main__":
    unittest.main()
