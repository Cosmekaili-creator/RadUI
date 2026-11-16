# SPDX-License-Identifier: AGPL-3.0-or-later
"""End-to-end lifecycle on a throwaway Radicale (production plugin) + backend.

One shared stack, tests run in numeric order and build on each other:
import of synthetic legacy files, bot creation, DAV access, grants, revocation,
disable, password reset, delete + tombstone, restore, lockout, own space,
dryRun, effective access, concurrency and the log scan.
"""
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402


def code(resp):
    return resp.json["error"]["code"]


@H.requires_radicale
class Lifecycle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = H.Stack("life").up()
        cls.addClassCleanup(cls.s.close)

    @classmethod
    def tearDownClass(cls):
        cls.s.close()

    def snapshot(self):
        s = self.s
        out = {}
        for name, path in (("model", os.path.join(s.state, "model.json")),
                           ("rights", os.path.join(s.managed, "rights")),
                           ("users", os.path.join(s.managed, "users"))):
            with open(path, "rb") as fh:
                out[name] = fh.read()
        return out

    def create(self, login, **kw):
        body = {"login": login, "displayName": login.title(), "generate": True}
        body.update(kw)
        body = {k: v for k, v in body.items() if v is not None}
        r = self.s.api("POST", "/accounts", "alice", body)
        self.assertIn(r.status, (201,), r.json)
        if "password" in r.json:
            self.s.pw[login] = r.json["password"]
        return r

    # ------------------------------------------------------------------
    def test_01_import_state(self):
        s = self.s
        self.assertIn("unexplained=0", s.import_output)
        self.assertIn("generation 1 written", s.import_output)
        self.assertEqual(s.api("GET", "/health").json,
                         {"ok": True, "generation": 1, "active": True,
                          "modelOk": True})
        me = s.api("GET", "/me", "alice").json
        self.assertEqual((me["admin"], me["type"], me["generation"]),
                         (True, "person", 1))
        r = s.api("GET", "/me", "agent-1").json
        self.assertEqual((r["admin"], r["type"]), (False, "bot"))
        hrefs = {g["href"] for g in
                 s.api("GET", "/me/access", "agent-1").json["grants"]}
        self.assertEqual(hrefs, {"/alice/cal-work/", "/alice/contacts/"})
        self.assertEqual(s.radicale_probe(s.read_json(
            os.path.join(s.state, "model.json"))["genToken"]), 404)

    def test_02_create_bot_with_generated_password_and_login(self):
        s = self.s
        r = self.create("agent-2", type="bot")
        self.assertEqual(len(r.json["password"]), 20)
        self.assertTrue(r.json["active"])
        self.assertEqual(s.dav("PROPFIND", "/", "agent-2",
                               headers={"Depth": "0"}).status, 207)
        self.assertEqual(s.api("GET", "/me", "agent-2").json["type"], "bot")
        # the bot's own principal now exists; it creates its own calendar
        self.assertEqual(s.mkcalendar("agent-2", "agent-2", "own-cal").status,
                         201)
        self.assertEqual(s.mkcalendar("agent-2", "alice", "x").status, 403)
        self.assertEqual(s.api("POST", "/accounts", "agent-2", {}).status, 403)

    def test_03_admin_creates_calendar_in_never_logged_in_space(self):
        s = self.s
        self.create("agent-3", type="bot")
        # D1: the admin creates the principal first (MKCOL), then the calendar
        self.assertEqual(s.mkcalendar("alice", "agent-3", "cal-a").status, 409)
        self.assertEqual(s.dav("MKCOL", "/agent-3/", "alice").status, 201)
        self.assertEqual(s.mkcalendar("alice", "agent-3", "cal-a").status, 201)
        # the bot sees it (own space) and may write to it
        self.assertEqual(s.put_event("agent-3", "agent-3", "cal-a",
                                     "e1").status, 201)
        self.assertEqual(s.level("agent-3", "agent-3", "cal-a"), "W")
        # nobody can delete a principal over DAV, admin included
        self.assertEqual(s.dav("DELETE", "/agent-3/", "alice").status, 403)
        # no top-level collection can be created by the admin
        self.assertEqual(s.dav("MKCOL", "/just-a-name/", "alice").status, 403)

    def test_04_grants_visibility_and_revocation(self):
        s = self.s
        self.create("bob", admin=False, generate=None, password="a long enough passphrase 9!")
        s.pw["bob"] = "a long enough passphrase 9!"
        self.assertEqual(s.level("bob", "agent-2", "own-cal"), "-")
        # only the owner (or an admin) may grant; collection must exist
        r = s.api("PUT", "/grants", "bob", {
            "owner": "agent-2", "collection": "own-cal", "grantee": "bob",
            "level": "read"})
        self.assertEqual((r.status, code(r)), (403, "forbidden"))
        grant = {"owner": "agent-2", "collection": "own-cal", "grantee": "bob",
                 "level": "readwrite"}
        r = s.api("PUT", "/grants", "agent-2", dict(grant, collection="nope"))
        self.assertEqual((r.status, code(r)), (404, "collection_not_found"))
        r = s.api("PUT", "/grants", "agent-2", dict(grant, grantee="alice"))
        self.assertEqual(r.status, 422)
        r = s.api("PUT", "/grants", "agent-2", grant)
        self.assertEqual((r.status, r.json["active"]), (200, True))
        self.assertEqual(r.json["grant"]["level"], "readwrite")
        # effective on the very next request
        self.assertEqual(s.level("bob", "agent-2", "own-cal"), "W")
        self.assertEqual(s.put_event("bob", "agent-2", "own-cal", "g1").status,
                         201)
        # the grantee sees only what is granted
        self.assertEqual(s.dav("PROPFIND", "/agent-2/", "bob",
                               headers={"Depth": "0"}).status, 403)
        self.assertEqual(s.level("bob", "agent-3", "cal-a"), "-")
        self.assertEqual(s.level("bob", "alice", "cal-work"), "-")
        # an rw grantee cannot rename the collection or delete it
        self.assertEqual(s.dav("PROPPATCH", "/agent-2/own-cal/", "bob", (
            '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set>'
            '<D:prop><D:displayname>x</D:displayname></D:prop></D:set>'
            '</D:propertyupdate>'), {"Content-Type": "application/xml"}
        ).status, 403)
        self.assertEqual(s.dav("DELETE", "/agent-2/own-cal/", "bob").status, 403)
        # read-only: GET works, PUT does not
        r = s.api("PUT", "/grants", "agent-2", dict(grant, level="read"))
        self.assertEqual(r.json["grant"]["level"], "read")
        self.assertEqual(s.level("bob", "agent-2", "own-cal"), "R")
        self.assertEqual(s.put_event("bob", "agent-2", "own-cal", "g2").status,
                         403)
        self.assertEqual(s.dav("GET", "/agent-2/own-cal/g1.ics", "bob").status,
                         200)
        self.assertEqual(s.dav("DELETE", "/agent-2/own-cal/g1.ics",
                               "bob").status, 403)
        # revoke: gone on the next request
        r = s.api("PUT", "/grants", "agent-2", dict(grant, level="none"))
        self.assertIsNone(r.json["grant"])
        self.assertEqual(s.level("bob", "agent-2", "own-cal"), "-")
        self.assertEqual(s.dav("GET", "/agent-2/own-cal/g1.ics", "bob").status,
                         403)
        # re-grant for later steps
        s.api("PUT", "/grants", "agent-2", dict(grant, level="readwrite"))

    def test_05_legacy_grants_work(self):
        s = self.s
        self.assertEqual(s.mkcalendar("alice", "alice", "cal-work").status, 201)
        self.assertEqual(s.level("agent-1", "alice", "cal-work"), "W")
        self.assertEqual(s.put_event("agent-1", "alice", "cal-work",
                                     "l1").status, 201)

    def test_06_disable_is_immediate_and_enable_restores(self):
        s = self.s
        self.assertEqual(s.dav("PROPFIND", "/", "agent-2",
                               headers={"Depth": "0"}).status, 207)
        r = s.api("PATCH", "/accounts/agent-2", "alice", {"disabled": True})
        self.assertEqual(r.status, 200)
        self.assertEqual(s.dav("PROPFIND", "/", "agent-2",
                               headers={"Depth": "0"}).status, 401)
        self.assertEqual(s.api("GET", "/me", "agent-2").status, 401)
        # a disabled owner's grants keep working (data is not taken down)
        self.assertEqual(s.level("bob", "agent-2", "own-cal"), "W")
        self.assertEqual(s.api("PATCH", "/accounts/agent-2", "alice",
                               {"disabled": False}).status, 200)
        self.assertEqual(s.api("GET", "/me", "agent-2").status, 200)

    def test_07_reset_password(self):
        s = self.s
        old = s.pw["agent-2"]
        r = s.api("POST", "/accounts/agent-2/password", "alice",
                  {"generate": True})
        new = r.json["password"]
        s.secrets_seen.add(old)
        self.assertNotEqual(old, new)
        self.assertEqual(s.api("GET", "/me", "agent-2", password=old).status, 401)
        self.assertEqual(s.api("GET", "/me", "agent-2", password=new).status, 200)
        self.assertEqual(s.dav("PROPFIND", "/", "agent-2", password=old,
                               headers={"Depth": "0"}).status, 401)
        s.pw["agent-2"] = new

    def test_08_delete_tombstones_and_leaves_data(self):
        s = self.s
        r = s.api("DELETE", "/accounts/agent-3", "alice", {"confirm": "x"})
        self.assertEqual(r.status, 422)
        r = s.api("DELETE", "/accounts/agent-3", "alice",
                  {"confirm": "agent-3"})
        self.assertEqual((r.status, r.json["deleted"]), (200, "agent-3"))
        self.assertEqual(s.dav("PROPFIND", "/", "agent-3",
                               headers={"Depth": "0"}).status, 401)
        r = s.api("POST", "/accounts", "alice", {
            "login": "agent-3", "displayName": "Again", "generate": True})
        self.assertEqual((r.status, code(r)), (409, "tombstoned"))
        # the data is untouched and the admin still reaches it
        self.assertEqual(s.level("alice", "agent-3", "cal-a"), "W")

    def test_09_restore_a_previous_generation(self):
        s = self.s
        gens = s.api("GET", "/generations", "alice").json
        keep = [g["generation"] for g in gens]
        self.assertLessEqual(len([g for g in gens if not g["baseline"]]), 3)
        self.assertTrue(any(g["baseline"] for g in gens))
        base = s.api("GET", "/me", "alice").json["generation"]
        self.create("temp-1")
        r = s.api("POST", "/generations/%d/restore" % base, "alice",
                  {"confirm": "restore-%d" % base})
        self.assertEqual((r.status, r.json["restoredFrom"]), (200, base))
        self.assertEqual(r.json["generation"], base + 2)
        self.assertEqual(s.api("GET", "/accounts/temp-1", "alice").status, 404)
        self.assertEqual(s.dav("PROPFIND", "/", "temp-1",
                               headers={"Depth": "0"}).status, 401)
        # tombstones accumulate: agent-3 stays reserved
        r = s.api("POST", "/accounts", "alice", {
            "login": "agent-3", "displayName": "Again", "generate": True})
        self.assertEqual(code(r), "tombstoned")
        r = s.api("POST", "/generations/424242/restore", "alice",
                  {"confirm": "restore-424242"})
        self.assertEqual(r.status, 404)
        self.assertTrue(keep)

    def test_10_lockout_rules(self):
        s = self.s
        r = s.api("PATCH", "/accounts/alice", "alice", {"disabled": True})
        self.assertEqual((r.status, code(r)), (409, "lockout_last_admin"))
        r = s.api("DELETE", "/accounts/alice", "alice", {"confirm": "alice"})
        self.assertEqual(r.status, 409)
        r = s.api("PATCH", "/accounts/alice", "alice", {"admin": False})
        self.assertEqual(r.status, 409)
        self.create("root-2", admin=True)
        for body in ({"disabled": True}, {"admin": False}):
            r = s.api("PATCH", "/accounts/alice", "alice", body)
            self.assertEqual((r.status, code(r)), (409, "lockout_self"))
        r = s.api("DELETE", "/accounts/alice", "alice", {"confirm": "alice"})
        self.assertEqual(code(r), "lockout_self")
        r = s.api("PATCH", "/accounts/root-2", "alice", {"type": "bot"})
        self.assertEqual(r.status, 422)  # a bot cannot be an admin
        r = s.api("POST", "/accounts", "alice", {
            "login": "bot-x", "displayName": "B", "type": "bot",
            "admin": True, "generate": True})
        self.assertEqual((r.status, r.json["error"]["field"]), (422, "admin"))
        # another admin may disable alice, and alice's login stops at once
        self.assertEqual(s.api("PATCH", "/accounts/alice", "root-2",
                               {"disabled": True}).status, 200)
        self.assertEqual(s.api("GET", "/me", "alice").status, 401)
        self.assertEqual(s.api("PATCH", "/accounts/alice", "root-2",
                               {"disabled": False}).status, 200)
        self.assertEqual(s.api("GET", "/me", "alice").status, 200)

    def test_11_own_space_off_needs_confirmation(self):
        s = self.s
        self.assertEqual(s.mkcalendar("bob", "bob", "bob-cal").status, 201)
        r = s.api("PATCH", "/accounts/bob", "alice", {"ownSpace": False})
        self.assertEqual((r.status, r.json["error"]["field"]), (422, "confirm"))
        r = s.api("PATCH", "/accounts/bob", "alice", {"ownSpace": False},
                  query="?dryRun=1")
        self.assertTrue(r.json["confirmRequired"])
        self.assertEqual(s.level("bob", "bob", "bob-cal"), "W")
        r = s.api("PATCH", "/accounts/bob", "alice",
                  {"ownSpace": False, "confirm": "bob"})
        self.assertEqual(r.status, 200)
        self.assertFalse(r.json["account"]["ownSpace"])
        self.assertEqual(s.level("bob", "bob", "bob-cal"), "-")
        self.assertEqual(s.mkcalendar("bob", "bob", "another").status, 403)
        # the admin still manages the data; granted access is unaffected
        self.assertEqual(s.level("alice", "bob", "bob-cal"), "W")
        self.assertEqual(s.level("bob", "agent-2", "own-cal"), "W")
        # a new account without any collections needs no confirmation
        self.create("quiet", ownSpace=True)
        r = s.api("PATCH", "/accounts/quiet", "alice", {"ownSpace": False})
        self.assertEqual(r.status, 200)

    def test_12_me_access_shapes(self):
        s = self.s
        r = s.api("GET", "/me/access", "bob").json
        self.assertEqual(set(r), {"login", "admin", "ownSpace", "grants"})
        self.assertFalse(r["ownSpace"])
        self.assertEqual([g["href"] for g in r["grants"]], ["/agent-2/own-cal/"])
        self.assertEqual(set(r["grants"][0]), {
            "href", "owner", "collection", "level", "grantedBy", "created"})
        a = s.api("GET", "/me/access", "alice").json
        self.assertIn("principals", a)
        self.assertIn("agent-2", a["principals"])
        self.assertNotIn("agent-3", a["principals"])   # deleted
        self.assertEqual(s.api("GET", "/directory", "bob").status, 403)
        self.assertTrue(all(set(d) == {"login", "displayName", "type"}
                            for d in s.api("GET", "/directory", "alice").json))

    def test_13_dry_run_never_writes(self):
        s = self.s
        before = self.snapshot()
        gen = s.api("GET", "/me", "alice").json["generation"]
        cases = [
            ("POST", "/accounts", "alice", {"login": "dry-1",
                                            "displayName": "D",
                                            "generate": True}),
            ("PATCH", "/accounts/bob", "alice", {"displayName": "Other"}),
            ("POST", "/accounts/bob/password", "alice", {"generate": True}),
            ("DELETE", "/accounts/quiet", "alice", {"confirm": "quiet"}),
            ("PUT", "/grants", "agent-2", {"owner": "agent-2",
                                           "collection": "own-cal",
                                           "grantee": "agent-1",
                                           "level": "read"}),
            ("POST", "/generations/1/restore", "alice", {}),
        ]
        for method, path, login, body in cases:
            r = s.api(method, path, login, body, query="?dryRun=1")
            self.assertEqual(r.status, 200, (path, r.json))
            self.assertTrue(r.json["dryRun"])
            self.assertTrue(r.json["summary"])
            self.assertEqual(r.json["generation"], gen)
            self.assertNotIn("password", r.json)
            self.assertIn("added", r.json["rights"])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(s.api("GET", "/me", "alice").json["generation"], gen)
        self.assertEqual(s.api("GET", "/accounts/dry-1", "alice").status, 404)
        # dry-run errors still show: lockout and validation
        r = s.api("PATCH", "/accounts/root-2", "root-2", {"disabled": True},
                  query="?dryRun=1")
        self.assertEqual(r.status, 409)

    def test_14_effective_access(self):
        s = self.s
        r = s.api("GET", "/effective/agent-1", "alice")
        self.assertEqual(r.status, 200, r.json)
        by = {e["path"]: e for e in r.json}
        self.assertEqual(by["/alice/cal-work"]["letters"], "rwl")
        self.assertEqual(by["/agent-1/*"]["level"], "own")
        r = s.api("GET", "/effective/alice", "alice").json
        by = {e["path"]: e for e in r}
        self.assertEqual(by["/agent-2/*"]["level"], "admin")
        self.assertEqual(by["/radui-probe-top"]["letters"], "R")
        self.assertEqual(s.api("GET", "/effective/ghost", "alice").status, 404)
        self.assertEqual(s.api("GET", "/effective/agent-1", "bob").status, 403)

    def test_15_concurrent_admin_calls_give_consecutive_generations(self):
        s = self.s
        start = s.api("GET", "/me", "alice").json["generation"]
        results = []

        def work(i):
            results.append(s.api("POST", "/accounts", "alice", {
                "login": "par-%d" % i, "displayName": "P", "generate": True},
                timeout=60))
        threads = [threading.Thread(target=work, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual([r.status for r in results], [201] * 10)
        for r in results:
            s.secrets_seen.add(r.json["password"])
        self.assertEqual(sorted(r.json["generation"] for r in results),
                         list(range(start + 1, start + 11)))
        self.assertEqual(s.api("GET", "/health").json["generation"], start + 10)

    def test_16_health_matches_probe_and_lkg_follows(self):
        s = self.s
        h = s.api("GET", "/health").json
        self.assertTrue(h["ok"] and h["active"] and h["modelOk"])
        token = s.read_json(os.path.join(s.state, "model.json"))["genToken"]
        self.assertEqual(s.radicale_probe(token), 404)
        with open(os.path.join(s.managed, "rights"), "rb") as a, \
                open(os.path.join(s.managed, "rights.lkg"), "rb") as b:
            self.assertEqual(a.read(), b.read())
        self.assertEqual(oct(os.stat(os.path.join(
            s.managed, "rights")).st_mode & 0o777), "0o640")

    def test_99_logs_hold_no_passwords_or_hashes(self):
        s = self.s
        text = s.stdout() + s.stderr()
        self.assertIn('"event":"account.create"', text)
        self.assertIn('"event":"grant.put"', text)
        self.assertNotIn("$2b$", text)
        self.assertNotIn("$2a$", text)
        self.assertNotIn("Authorization", text)
        self.assertNotIn("Basic ", text)
        secrets_ = set(s.pw.values()) | s.secrets_seen
        self.assertGreater(len(secrets_), 8)
        for pw in secrets_:
            self.assertNotIn(pw, text)
        for line in s.stdout().splitlines():
            self.assertEqual(list(__import__("json").loads(line)), [
                "ts", "event", "actor", "ip", "target", "result",
                "generation"])
        self.assertNotIn("www-authenticate", s.seen_headers)


if __name__ == "__main__":
    unittest.main()
