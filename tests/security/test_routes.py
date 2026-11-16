# SPDX-License-Identifier: AGPL-3.0-or-later
"""Every route of the admin API, enumerated from the code and cross-checked
with docs/api.md, against every kind of caller.

Attacker model: (a) anyone on the network path to the backend with no
credentials or wrong ones, (b) a legitimate non-admin account, (c) a stolen
bot credential. None of them may reach an admin route; none of their attempts
may change the model, the rights file or the users file. The admin must be
able to use every route (so the 403s are not a side effect of a broken route).

A route that appears in the code but is missing from the ``OK_CALLS`` table
below fails the suite: new routes cannot slip in untested.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import secsupport as S  # noqa: E402

from radui_admin import api as api_mod  # noqa: E402
from radui_admin import config as config_mod  # noqa: E402

DOC = os.path.join(S.REPO, "docs", "api.md")


def code_routes():
    a = api_mod.Api(config_mod.Config(allowed_hosts=("example.org",)),
                    None, None, None, None, None)
    out = {}
    for r in a.routes:
        tpl = re.sub(r"\(\?P<(\w+)>[^)]*\)", lambda m: "{%s}" % m.group(1),
                     r.pattern.pattern)
        out[(r.method, tpl)] = {"admin": r.admin, "public": r.public}
    return out


def doc_routes():
    """(METHOD, path) -> who, from the Endpoints table of docs/api.md."""
    out = {}
    with open(DOC) as fh:
        text = fh.read()
    table = text.split("## Endpoints", 1)[1].split("## Errors", 1)[0]
    for line in table.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2 or "`" not in cells[0]:
            continue
        for m in re.finditer(r"`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`", cells[0]):
            out[(m.group(1), m.group(2).strip().split("?")[0])] = cells[1]
    return out


#: how an admin uses each route: (body, expected status). ``{login}`` is a
#: fresh victim account, ``{n}`` an existing generation number.
OK_CALLS = {
    ("GET", "health"): (None, 200),
    ("GET", "me"): (None, 200),
    ("GET", "me/access"): (None, 200),
    ("GET", "directory"): (None, 200),
    ("GET", "accounts"): (None, 200),
    ("POST", "accounts"): ({"login": "made-by-route", "displayName": "M",
                            "generate": True}, 201),
    ("GET", "accounts/{login}"): (None, 200),
    ("PATCH", "accounts/{login}"): ({"displayName": "Patched"}, 200),
    ("DELETE", "accounts/{login}"): ({"confirm": "{login}"}, 200),
    ("POST", "accounts/{login}/password"): ({"generate": True}, 200),
    ("GET", "grants"): (None, 200),
    ("PUT", "grants"): ({"owner": "alice", "collection": "cal-x",
                         "grantee": "agent-1", "level": "read"}, 200),
    ("GET", "effective/{login}"): (None, 200),
    ("GET", "generations"): (None, 200),
    ("POST", "generations/{n}/restore"): ({"confirm": "restore-{n}"}, 200),
}


@S.requires_radicale
class Routes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = S.WStack("routes").up()
        cls.addClassCleanup(s.close)
        s.make_user("person-1")
        s.make_user("disabled-1", admin=True)
        s.make_user("victim-0")
        s.pw["admin-2"] = "a long enough passphrase 3!"
        s.make_user("admin-2", admin=True, password=s.pw["admin-2"])
        assert s.mkcalendar("alice", "alice", "cal-x").status == 201
        assert s.api("PATCH", "/accounts/disabled-1", "alice",
                     {"disabled": True}).status == 200
        cls.code = code_routes()
        cls.doc = doc_routes()
        cls.victims = 0

    # -- enumeration -----------------------------------------------------------
    def test_00_code_and_docs_describe_the_same_routes(self):
        self.assertEqual(set(self.code), set(self.doc),
                         "docs/api.md and Api.routes disagree")
        for key, route in self.code.items():
            who = self.doc[key]
            if route["public"]:
                self.assertEqual(who, "anyone", key)
            elif route["admin"]:
                self.assertEqual(who, "admin", key)
            else:
                self.assertNotEqual(who, "admin", key)

    def test_01_every_route_has_an_admin_call_in_this_suite(self):
        self.assertEqual(set(self.code), set(OK_CALLS),
                         "route(s) not covered by OK_CALLS")

    # -- helpers -----------------------------------------------------------------
    def concrete(self, tpl, victim=None):
        n = self.s.model().generation
        return tpl.replace("{login}", victim or "agent-1").replace("{n}", str(n))

    def victim(self):
        type(self).victims += 1
        login = "victim-%d" % self.victims
        self.s.make_user(login)
        return login

    def call(self, method, tpl, login, victim=None, **kw):
        body, _ = OK_CALLS[(method, tpl)]
        if isinstance(body, dict):
            n = str(self.s.model().generation)
            body = {k: (v.replace("{login}", victim or "{login}")
                        .replace("{n}", n) if isinstance(v, str) else v)
                    for k, v in body.items()}
        path = "/" + self.concrete(tpl, victim)
        return self.s.api(method, path, login, body, **kw)

    def admin_routes(self):
        return sorted(k for k, v in self.code.items() if v["admin"])

    # -- the callers ----------------------------------------------------------------
    def test_10_no_credentials_is_401_on_every_non_public_route(self):
        s = self.s
        before = S.snapshot(s)
        for (method, tpl), meta in sorted(self.code.items()):
            if meta["public"]:
                continue
            r = self.call(method, tpl, None)
            self.assertEqual((r.status, r.json["error"]["code"]),
                             (401, "unauthenticated"), (method, tpl))
            self.assertNotIn("www-authenticate", r.headers)
        self.assertEqual(S.snapshot(s), before)

    def test_11_wrong_password_and_unknown_login_are_401_on_every_route(self):
        s = self.s
        before = S.snapshot(s)
        for (method, tpl), meta in sorted(self.code.items()):
            if meta["public"]:
                continue
            for login, pw in (("alice", "wrong-" + "x" * 12),
                              ("nobody-9", "wrong-" + "x" * 12),
                              ("alice", "")):
                r = self.call(method, tpl, login, password=pw)
                self.assertEqual(r.status, 401, (method, tpl, login))
        self.assertEqual(S.snapshot(s), before)

    def test_12_disabled_admin_is_401_not_403(self):
        # a disabled account's credentials stop working at Radicale, so the
        # backend cannot even tell who it is
        s = self.s
        for method, tpl in self.admin_routes():
            r = self.call(method, tpl, "disabled-1")
            self.assertEqual(r.status, 401, (method, tpl))

    def test_13_non_admin_person_and_bot_get_403_on_every_admin_route(self):
        s = self.s
        before = S.snapshot(s)
        for login in ("person-1", "agent-1"):
            for method, tpl in self.admin_routes():
                for q in ("", "?dryRun=1"):
                    if q and method == "GET":
                        continue
                    r = self.call(method, tpl, login, victim="victim-0",
                                  query=q)
                    self.assertEqual((r.status, r.json["error"]["code"]),
                                     (403, "forbidden"), (login, method, tpl, q))
        self.assertEqual(S.snapshot(s), before)

    def test_14_403_comes_before_body_and_validation_errors(self):
        # a non-admin must not learn anything from validation messages
        s = self.s
        for login in ("person-1", "agent-1"):
            for method, tpl in self.admin_routes():
                if method == "GET":
                    continue
                r = s.api(method, "/" + self.concrete(tpl, "victim-0"), login,
                          raw=b"{not json")
                self.assertEqual(r.status, 403, (login, method, tpl))

    def test_15_the_admin_can_use_every_route(self):
        s = self.s
        for (method, tpl) in sorted(self.code):
            if self.code[(method, tpl)]["public"]:
                r = s.api(method, "/" + tpl)
                self.assertEqual(r.status, 200)
                continue
            _, want = OK_CALLS[(method, tpl)]
            victim = None
            if "{login}" in tpl:
                victim = self.victim()
            r = self.call(method, tpl, "alice", victim=victim)
            self.assertEqual(r.status, want, (method, tpl, r.json))
            if method == "POST" and tpl == "accounts":
                self.assertTrue(r.json["password"])

    def test_16_second_admin_also_works_and_acts_as_itself(self):
        s = self.s
        me = s.api("GET", "/me", "admin-2").json
        self.assertEqual((me["login"], me["admin"]), ("admin-2", True))
        self.assertEqual(s.api("GET", "/accounts", "admin-2").status, 200)

    def test_17_wrong_methods_and_unknown_routes(self):
        s = self.s
        for method, tpl in sorted(self.code):
            others = {"GET", "POST", "PUT", "PATCH", "DELETE"} - {
                m for m, t in self.code if t == tpl}
            for m in sorted(others):
                r = s.api(m, "/" + self.concrete(tpl, "agent-1"), "alice",
                          None if m == "GET" else {})
                self.assertEqual(r.status, 405, (m, tpl))
                self.assertIn("allow", r.headers)
        for path in ("/accounts/", "/ACCOUNTS", "/accounts/alice/extra",
                     "/me/", "//me", "/generations/abc/restore",
                     "/generations/99999999999/restore", "/effective",
                     "/admin", "/"):
            r = s.api("GET", path, "alice")
            self.assertIn(r.status, (404, 405), path)

    def test_18_public_health_needs_no_credentials_but_checks_host(self):
        s = self.s
        self.assertEqual(s.api("GET", "/health").status, 200)
        self.assertEqual(s.api("GET", "/health", host="evil.test").status, 403)
        # a method other than GET on health is not a route
        self.assertEqual(s.api("POST", "/health", None, {}).status, 405)


if __name__ == "__main__":
    unittest.main()
