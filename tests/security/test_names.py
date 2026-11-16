# SPDX-License-Identifier: AGPL-3.0-or-later
"""Hostile logins, collection names and grant targets.

Attacker model: an administrator's browser (or a script holding an admin
credential) is tricked into submitting names that would change what the rights
file means (regex or ``str.format`` injection, path traversal, look-alike
logins, reserved names), and an ordinary account owner choosing collection
names or grant targets. Rejected input must change nothing; accepted input
must be matched LITERALLY by the generated rules.
"""
import os
import sys
import unittest
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import secsupport as S  # noqa: E402
from plugin import support  # noqa: E402

BAD_LOGINS = [
    "../x", "..", ".", "a/b", "a\\b", "%2e%2e", "%2e%2e%2f", "..%2fx", "{0}",
    "{user}", "{}", "%", "%(x)s", "%s%s", "a\nb", "a\r\nb", "a b", "a\tb", ".*",
    "a|b", "(a)", "^a$", "a*", "[a]", "a+", "a?", "a,b", "a:b", "a@b", "a;b",
    "a'b", 'a"b', "a`b", "a$b", "a#b", "a&b", "a=b", "a<b>", "bob~", "-bob",
    ".bob", "_bob", "b", "x" * 33, "bob\u0000", "bob\u0000x",
    # look-alikes: Cyrillic a, fullwidth a, Kelvin sign, dotless i, long s,
    # combining dot, right-to-left override, zero width space
    "\u0430lice", "\uff41lice", "\u212aelvin-user", "\u0131x-user",
    "\u017fam", "a\u0307ca", "a\u202eb", "a\u200bb", "caf\u00e9", "\u2160-x",
    # reserved
    "root", "admin", "administrator", "radicale", "radui", "ui", "api", "web",
    "sharing", "token", "anonymous", "nobody", "system", "radui-x",
    "radui-gen-abc", "radui-gen-", "radui-", "ROOT", "Admin", "RADUI-X", "Ui",
]

BAD_COLLECTIONS = [
    "../x", "a/b", "/abs", "..", ".", "%2e%2e", "{0}", "{user}", "%", "%(x)s",
    "a\nb", "a\r\nb", ".*", "(a|b)", "a b", "caf\u00e9", "\u043ac", "c~", "~c",
    "x" * 129, "", ".hidden", "-x", "a\u0000b", "a\\b", "a?b", "a#b", "a:b",
    "a,b", "a;b", "a=b", "a'b", "a*b", "a[b]", ".Radicale.props", "a\u202eb",
]
#: valid names that contain regex metacharacters: the rule must match them
#: literally (re.escape), never as a pattern
SPECIAL_VALID = ["a.b", "a+b", "a@b", "a~b", "a-b", "a_b", "A.B"]
DECOYS = ["aXb", "aab", "a-b-", "aXB"]


def code(r):
    return r.json["error"]["code"] if r.json else None


@S.requires_radicale
class Names(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("names").up()
        cls.addClassCleanup(s.close)
        for login in ("bob", "carol", "bot-b"):
            s.make_user(login, bot=(login == "bot-b"))
        s.make_user("admin-2", admin=True)
        s.make_user("off-1")
        assert s.api("PATCH", "/accounts/off-1", "alice",
                     {"disabled": True}).status == 200
        for login in ("bob", "carol", "bot-b"):
            assert s.dav("PROPFIND", "/", login, headers={"Depth": "0"}).status == 207
        assert s.mkcalendar("bob", "bob", "cal").status == 201
        # a tombstoned login
        s.make_user("tomb-1")
        assert s.api("DELETE", "/accounts/tomb-1", "alice",
                     {"confirm": "tomb-1"}).status == 200

    def setUp(self):
        self.start = S.snapshot(self.s)

    def unchanged(self):
        self.assertEqual(S.snapshot(self.s), self.start)

    # -- logins ----------------------------------------------------------------------
    def test_hostile_logins_are_rejected_and_change_nothing(self):
        s = self.s
        for bad in BAD_LOGINS:
            r = s.api("POST", "/accounts", "alice", {
                "login": bad, "displayName": "X", "generate": True})
            self.assertEqual(r.status, 422, repr(bad))
            self.assertEqual(r.json["error"]["field"], "login", repr(bad))
            # the same text in a URL segment never reaches an account lookup
            r = s.api("GET", "/accounts/" + urllib.parse.quote(bad, safe=""),
                      "alice")
            self.assertIn(r.status, (400, 404), repr(bad))
        self.unchanged()

    def test_existing_and_tombstoned_logins_are_conflicts(self):
        s = self.s
        for login, want in (("bob", "exists"), ("BOB", "exists"),
                            ("tomb-1", "tombstoned"), ("TOMB-1", "tombstoned"),
                            ("Tomb-1", "tombstoned"), ("alice", "exists")):
            r = s.api("POST", "/accounts", "alice", {
                "login": login, "displayName": "X", "generate": True})
            self.assertEqual((r.status, code(r)), (409, want), login)
        self.unchanged()
        # a tombstoned login cannot authenticate and owns no rights
        self.assertEqual(s.dav("PROPFIND", "/", "tomb-1",
                               headers={"Depth": "0"}).status, 401)

    def test_uppercase_input_is_folded_never_stored_as_typed(self):
        s = self.s
        r = s.api("POST", "/accounts", "alice", {
            "login": "UPPER-1", "displayName": "U", "generate": True})
        self.assertEqual(r.status, 201)
        self.assertEqual(r.json["account"]["login"], "upper-1")
        s.pw["upper-1"] = r.json["password"]
        self.assertEqual(s.api("GET", "/accounts/UPPER-1", "alice").status, 404)
        self.assertEqual(s.api("GET", "/me", "upper-1").status, 200)
        # logging in with the upper-case spelling is refused (strict lookup)
        self.assertEqual(s.api("GET", "/me", auth=S.basic(
            "UPPER-1", s.pw["upper-1"])).status, 401)

    def test_trailing_dot_login_is_matched_literally(self):
        # ``dotty.`` is allowed by the login rule: the regex dot must not make
        # it match ``dottyx``, and the account must work end to end
        s = self.s
        s.make_user("dotty.")
        s.make_user("dottyx")
        for login in ("dotty.", "dottyx"):
            self.assertEqual(s.dav("PROPFIND", "/", login,
                                   headers={"Depth": "0"}).status, 207)
        self.assertEqual(s.mkcalendar("dotty.", "dotty.", "c").status, 201)
        self.assertEqual(s.mkcalendar("dottyx", "dotty.", "c2").status, 403)
        self.assertEqual(s.mkcalendar("dotty.", "dottyx", "c2").status, 403)
        with open(os.path.join(s.managed, "rights")) as fh:
            self.assertIn("^dotty\\.$", fh.read())

    # -- collection names ---------------------------------------------------------------
    def test_hostile_collection_names_in_grants(self):
        s = self.s
        for bad in BAD_COLLECTIONS:
            r = s.api("PUT", "/grants", "bob", {
                "owner": "bob", "collection": bad, "grantee": "carol",
                "level": "read"})
            self.assertIn(r.status, (400, 422), repr(bad))
            r = s.api("PUT", "/grants", "alice", {
                "owner": "bob", "collection": bad, "grantee": "carol",
                "level": "none"})
            self.assertIn(r.status, (400, 422), repr(bad))
        self.unchanged()
        with open(os.path.join(s.managed, "rights")) as fh:
            text = fh.read()
        for token in ("{0}", "{user}", "%(", "..", "\\n"):
            self.assertNotIn(token, text.replace("\\.", ""))

    def test_special_but_valid_names_match_literally(self):
        s = self.s
        for name in SPECIAL_VALID + DECOYS:
            self.assertEqual(s.mkcalendar("bob", "bob", name).status, 201, name)
        for name in SPECIAL_VALID:
            r = s.api("PUT", "/grants", "bob", {
                "owner": "bob", "collection": name, "grantee": "carol",
                "level": "read"})
            self.assertEqual(r.status, 200, (name, r.json))
        for name in SPECIAL_VALID:
            self.assertEqual(s.level("carol", "bob", name), "R", name)
        for name in DECOYS:     # look like regex matches of the granted names
            self.assertEqual(s.level("carol", "bob", name), "-", name)
        for name in SPECIAL_VALID:
            r = s.api("PUT", "/grants", "bob", {
                "owner": "bob", "collection": name, "grantee": "carol",
                "level": "none"})
            self.assertEqual(r.status, 200)

    def test_radui_gen_prefix_cannot_move_the_probe(self):
        s = self.s
        token = s.model().gen_token
        # nobody can create a top-level name over DAV, so the probe path stays
        # empty: the admin's MKCOL and MKCALENDAR at the top level are refused
        for method in ("MKCOL", "MKCALENDAR"):
            r = s.dav(method, "/radui-gen-%s/" % token, "alice",
                      support.MKCALENDAR if method == "MKCALENDAR" else None,
                      support.XML_HDR)
            self.assertEqual(r.status, 403, method)
        self.assertEqual(s.dav("PUT", "/radui-gen-%s" % token, "alice", b"x").status,
                         403)
        self.assertEqual(s.radicale_probe(token), 404)
        # a login cannot start with the prefix
        r = s.api("POST", "/accounts", "alice", {
            "login": "radui-gen-" + token[:8], "displayName": "G",
            "generate": True})
        self.assertEqual(r.status, 422)
        self.assertTrue(s.api("GET", "/health").json["ok"])

    # -- grant targets ------------------------------------------------------------------------
    def grant(self, actor, owner, coll, grantee, level="read"):
        return self.s.api("PUT", "/grants", actor, {
            "owner": owner, "collection": coll, "grantee": grantee,
            "level": level})

    def test_grant_target_rules(self):
        s = self.s
        # to an admin (nothing to grant), to himself, to a disabled account
        for grantee, want in (("alice", (422, "validation")),
                              ("admin-2", (422, "validation")),
                              ("bob", (422, "validation")),
                              ("off-1", (422, "validation")),
                              ("ghost-1", (404, "not_found")),
                              ("tomb-1", (404, "not_found"))):
            r = self.grant("bob", "bob", "cal", grantee)
            # an owner gets one answer for every unusable grantee (M5)
            self.assertEqual((r.status, code(r)), (422, "validation"), grantee)
            r = self.grant("alice", "bob", "cal", grantee)
            self.assertEqual((r.status, code(r)), want, ("admin", grantee))
        # nonexistent collection, nonexistent owner
        r = self.grant("bob", "bob", "nope", "carol")
        self.assertEqual((r.status, code(r)), (404, "collection_not_found"))
        r = self.grant("alice", "ghost-1", "cal", "carol")
        self.assertEqual((r.status, code(r)), (404, "not_found"))
        # a non-admin naming somebody else's collection or a nonexistent owner
        # gets the same 403: no existence oracle on owners
        for owner in ("alice", "carol", "ghost-1", "tomb-1", "admin-2"):
            r = self.grant("bob", owner, "cal", "carol")
            self.assertEqual((r.status, code(r)), (403, "forbidden"), owner)
        # junk levels
        for level in ("write", "rw", "admin", "READ", "", None, 1, True, "none "):
            r = self.s.api("PUT", "/grants", "bob", {
                "owner": "bob", "collection": "cal", "grantee": "carol",
                "level": level})
            self.assertEqual(r.status, 422, repr(level))
        self.unchanged()

    def test_grant_lookup_is_not_a_login_oracle_for_an_owner_finding_f2(self):
        # Finding F2, fixed (M5): a bot that owns a collection cannot tell
        # apart an admin, a disabled and a nonexistent grantee (one 422
        # ``grantee_unavailable``); only an existing enabled non-admin works.
        s = self.s
        self.assertEqual(s.mkcalendar("bot-b", "bot-b", "mine").status, 201)
        seen = {}
        for grantee in ("alice", "admin-2", "off-1", "carol", "ghost-1"):
            r = self.grant("bot-b", "bot-b", "mine", grantee, "read")
            seen[grantee] = r.status
        S.info("grant endpoint as login oracle, seen by a non-admin owner: %s"
               % seen)
        self.assertEqual(seen["carol"], 200)
        for login in ("alice", "admin-2", "off-1", "ghost-1"):
            self.assertEqual(seen[login], 422, login)
        # the answers are identical, body included
        bodies = {self.grant("bot-b", "bot-b", "mine", g, "read").json["error"]
                  .get("message") for g in ("alice", "off-1", "ghost-1")}
        self.assertEqual(len(bodies), 1)
        self.grant("bot-b", "bot-b", "mine", "carol", "none")


if __name__ == "__main__":
    unittest.main()
