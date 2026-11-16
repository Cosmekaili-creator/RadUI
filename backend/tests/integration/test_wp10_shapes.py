# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exact shapes of ``health``, ``me``, ``me/access``, ``directory`` and the
other read endpoints, per role (admin, person, bot, bot with grants).

Attacker/consumer model: the browser app and agents parse these answers. A
silent key rename, an added key (possible leak) or a changed type is a break.
Also: the spike's tautological "checks" are reported as INFO (see the last
test), never as passes.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wp10_support as W  # noqa: E402

TS = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
ACCOUNT_KEYS = {"login", "displayName", "type", "admin", "disabled",
                "ownSpace", "created", "passwordChanged"}
GRANT_KEYS = {"owner", "collection", "grantee", "level", "grantedBy",
              "created"}
ACCESS_GRANT_KEYS = {"href", "owner", "collection", "level", "grantedBy",
                     "created"}


@W.requires_radicale
class Shapes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = W.WStack("shapes").up()
        cls.addClassCleanup(s.close)
        s.make_user("bob", password="a long enough passphrase 1!")
        s.make_user("bot-2", bot=True)
        s.make_user("off-1", ownSpace=False)
        assert s.mkcalendar("bob", "bob", "cal").status == 201
        assert s.mkcalendar("bob", "bob", "book-like").status == 201
        for grantee, level in (("bot-2", "read"), ("agent-1", "readwrite")):
            r = s.api("PUT", "/grants", "bob", {
                "owner": "bob", "collection": "cal", "grantee": grantee,
                "level": level})
            assert r.status == 200, r.json

    def test_health(self):
        r = self.s.api("GET", "/health")
        self.assertEqual(r.status, 200)
        h = r.json
        self.assertEqual(set(h), {"ok", "generation", "active", "modelOk"})
        self.assertIs(type(h["ok"]), bool)
        self.assertIs(type(h["active"]), bool)
        self.assertIs(type(h["modelOk"]), bool)
        self.assertIs(type(h["generation"]), int)
        self.assertEqual(h["generation"], self.s.model().generation)
        self.assertTrue(h["ok"] and h["active"] and h["modelOk"])

    def test_me_per_role(self):
        s = self.s
        want = {
            "alice": ("person", True, True), "bob": ("person", False, True),
            "bot-2": ("bot", False, True), "agent-1": ("bot", False, True),
            "off-1": ("person", False, False)}
        for login, (typ, admin, own) in want.items():
            me = s.api("GET", "/me", login).json
            self.assertEqual(set(me), {"login", "displayName", "type", "admin",
                                       "ownSpace", "generation",
                                       "rightsActive", "ok"}, login)
            self.assertIs(me["rightsActive"], True)   # same data as health
            self.assertIs(me["ok"], True)
            self.assertEqual((me["login"], me["type"], me["admin"],
                              me["ownSpace"]), (login, typ, admin, own))
            self.assertIs(type(me["generation"]), int)
            self.assertEqual(me["generation"], s.model().generation)
            self.assertIsInstance(me["displayName"], str)

    def test_me_access_per_role(self):
        s = self.s
        a = s.api("GET", "/me/access", "alice").json
        self.assertEqual(set(a), {"login", "admin", "ownSpace", "grants",
                                  "principals"})
        self.assertEqual(a["principals"], sorted(a["principals"]))
        self.assertIn("agent-1", a["principals"])
        self.assertTrue(a["admin"])
        # an admin holds no grants (admins already reach everything)
        self.assertEqual(a["grants"], [])
        for login, expect in (("bot-2", {"/bob/cal/": "read"}),
                              ("agent-1", {"/bob/cal/": "readwrite",
                                           "/alice/cal-work/": "readwrite",
                                           "/alice/contacts/": "readwrite"}),
                              ("bob", {}), ("off-1", {})):
            r = s.api("GET", "/me/access", login).json
            self.assertEqual(set(r), {"login", "admin", "ownSpace", "grants"},
                             login)
            self.assertEqual(r["login"], login)
            got = {g["href"]: g["level"] for g in r["grants"]}
            self.assertEqual(got, expect, login)
            for g in r["grants"]:
                self.assertEqual(set(g), ACCESS_GRANT_KEYS)
                self.assertTrue(g["href"].startswith("/") and
                                g["href"].endswith("/"))
                self.assertEqual(g["href"], "/%s/%s/" % (g["owner"],
                                                         g["collection"]))
                self.assertRegex(g["created"], TS)
        # a person cannot ask for somebody else's view through a parameter
        r = s.api("GET", "/me/access", "bob", query="?login=alice")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json["login"], "bob")
        self.assertNotIn("principals", r.json)

    def test_directory_admin_only_and_shape(self):
        s = self.s
        d = s.api("GET", "/directory", "alice")
        self.assertEqual(d.status, 200)
        self.assertTrue(all(set(x) == {"login", "displayName", "type"}
                            for x in d.json))
        self.assertEqual({x["login"] for x in d.json},
                         {"alice", "agent-1", "bob", "bot-2", "off-1"})
        for login in ("bob", "bot-2", "agent-1"):
            r = s.api("GET", "/directory", login)
            self.assertEqual((r.status, r.json["error"]["code"]),
                             (403, "forbidden"))
        # a disabled account leaves the directory
        s.make_user("gone-1")
        self.assertEqual(s.api("PATCH", "/accounts/gone-1", "alice",
                               {"disabled": True}).status, 200)
        self.assertNotIn("gone-1", {x["login"] for x in
                                    s.api("GET", "/directory", "alice").json})
        self.assertNotIn("gone-1", s.api("GET", "/me/access", "alice"
                                         ).json["principals"])

    def test_admin_read_endpoints(self):
        s = self.s
        accs = s.api("GET", "/accounts", "alice").json
        self.assertTrue(all(set(a) == ACCOUNT_KEYS for a in accs))
        self.assertTrue(all(TS.match(a["created"]) and
                            TS.match(a["passwordChanged"]) for a in accs))
        one = s.api("GET", "/accounts/bob", "alice").json
        self.assertEqual(set(one), ACCOUNT_KEYS)
        blob = s.api("GET", "/accounts", "alice").raw.decode()
        self.assertNotIn("$2", blob)
        self.assertNotIn("hash", blob)
        gr = s.api("GET", "/grants", "alice").json
        self.assertTrue(all(set(g) == GRANT_KEYS for g in gr))
        self.assertEqual({(g["grantee"], g["level"]) for g in gr
                          if g["owner"] == "bob"},
                         {("bot-2", "read"), ("agent-1", "readwrite")})
        # an owner sees only the grants of his own collections
        own = s.api("GET", "/grants", "bob").json
        self.assertTrue(own and all(g["owner"] == "bob" for g in own))
        self.assertEqual(s.api("GET", "/grants", "bot-2").json, [])
        eff = s.api("GET", "/effective/agent-1", "alice").json
        self.assertTrue(all(set(e) == {"path", "level", "letters"}
                            for e in eff))
        gens = s.api("GET", "/generations", "alice").json
        self.assertTrue(all(set(g) == {"generation", "current", "baseline",
                                       "accounts", "grants", "modified"}
                            for g in gens))
        self.assertEqual(sum(1 for g in gens if g["current"]), 1)

    def test_errors_have_one_shape(self):
        s = self.s
        for r in (s.api("GET", "/me"), s.api("GET", "/directory", "bob"),
                  s.api("GET", "/nope", "alice"),
                  s.api("GET", "/accounts/nobody-1", "alice")):
            self.assertEqual(list(r.json), ["error"])
            self.assertLessEqual(set(r.json["error"]),
                                 {"code", "message", "field"})


class SpikeTautologies(unittest.TestCase):
    """The spike scripts contain checks that cannot fail. Reported as INFO
    (never as a pass): each one is listed with the reason."""

    def test_report_tautological_spike_checks(self):
        spike = os.path.join(W.REPO, "spike", "server")
        pattern = re.compile(r'\.check\(\s*"([^"]+)",\s*True\b')
        found = []
        for name in sorted(os.listdir(spike)):
            if name.endswith(".py"):
                with open(os.path.join(spike, name)) as fh:
                    for m in pattern.finditer(fh.read()):
                        found.append("%s: %s (condition is the literal True)"
                                     % (name, m.group(1)))
        known = [
            "s07_users_reread.py: no-restart-needed (pid compared with itself: "
            "the script never restarts the process)",
            "s18_latency.py: throughput-bounded-by-cpu-not-by-slots (an upper "
            "bound: a slower server passes)",
            "s08_concurrency.py: transport-errors-explained-by-baseline (passes "
            "whenever the baseline run also had errors)",
            "s06_bcrypt.py: live-cost/read-from-prefix (passes when any cost "
            "field was read)"]
        for line in found + known:
            W.info("tautology or weak spike check: " + line)
        # informational only: reported as a skip so it is never counted as a pass
        self.skipTest("INFO only: %d tautological/weak spike checks listed above"
                      % (len(found) + len(known)))


if __name__ == "__main__":
    unittest.main()
