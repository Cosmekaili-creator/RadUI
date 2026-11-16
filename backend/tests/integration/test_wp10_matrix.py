# SPDX-License-Identifier: AGPL-3.0-or-later
"""S3 letter matrix on the REAL D1 layout produced by the backend.

Attacker/actor model: every role below sends the DAV request directly to
Radicale (the production rights plugin plus the rights file the real backend
generated). The expected status of every cell is computed from the model
alone (``wp10_support.v_*``, built on the WP3 oracle ``expected()`` and
Radicale's documented ``Access.check`` rules) and compared cell by cell with
what Radicale answers. Nothing is read back from the generator.

Roles: owner, rw grantee, r grantee, non-granted account, admin, the admin
acting on the principal of an account that never logged in (before and after
the admin created that principal), the admin and another user on the
directory of a tombstoned login, and the tombstoned login itself.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wp10_support as W  # noqa: E402
from plugin import support  # noqa: E402

D_HDR = dict(support.XML_HDR, Depth="0")
PROPFIND = ('<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>'
            '<D:resourcetype/></D:prop></D:propfind>')
REPORT = ('<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" '
          'xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/>'
          '</D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter>'
          '</C:calendar-query>')
MKCOL_BOOK = ('<?xml version="1.0"?><D:mkcol xmlns:D="DAV:" '
              'xmlns:CR="urn:ietf:params:xml:ns:carddav"><D:set><D:prop>'
              '<D:resourcetype><D:collection/><CR:addressbook/>'
              '</D:resourcetype></D:prop></D:set></D:mkcol>')
PROPPATCH = ('<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set>'
             '<D:prop><D:displayname>renamed</D:displayname></D:prop></D:set>'
             '</D:propertyupdate>')
ICS = support.ICS_HDR

METHODS = ["PROPFIND", "REPORT", "GET", "PUT new", "PUT overwrite",
           "DELETE item", "MKCALENDAR", "MKCOL addressbook", "PROPPATCH",
           "DELETE collection", "PUT whole collection", "MOVE item",
           "nested MKCOL", "MOVE collection", "PROPFIND principal",
           "DELETE principal", "MKCOL top-level"]
#: where the resource is missing the answer is 404, except for methods that
#: need an existing parent (409).
MISSING_409 = {"PUT new", "PUT overwrite", "MKCALENDAR", "MKCOL addressbook",
               "PUT whole collection", "nested MKCOL"}
#: successful statuses are 2xx except these methods, whose success outcome
#: is fixed by Radicale itself (a calendar cannot hold collections; moving a
#: collection is not implemented).
FIXED_OK = {"nested MKCOL": 403, "MOVE collection": 405}


class Row:
    def __init__(self, role, user, principal, state="exists"):
        self.role, self.user, self.principal, self.state = (
            role, user, principal, state)
        self.cal = "%s/cal" % principal


_n = [0]


def build(method, row):
    """Request for one cell: ``(http_method, path, body, headers, seeds,
    verdict_fn)``. ``seeds`` are items the admin creates first."""
    _n[0] += 1
    n = _n[0]
    p, cal = row.principal, row.cal
    item = "%s/item1.ics" % cal
    if method == "PROPFIND":
        return ("PROPFIND", "/%s/" % cal, PROPFIND, dict(support.XML_HDR, Depth="0"),
                [], lambda m, u: W.v_read(m, u, cal, "tagged"))
    if method == "REPORT":
        return ("REPORT", "/%s/" % cal, REPORT, dict(support.XML_HDR, Depth="1"),
                [], lambda m, u: W.v_read(m, u, cal, "tagged"))
    if method == "GET":
        return ("GET", "/%s" % item, None, {}, ["item1"],
                lambda m, u: W.v_read(m, u, item, "item"))
    if method == "PUT new":
        path = "%s/new-%d.ics" % (cal, n)
        return ("PUT", "/" + path, support.ics_event("new-%d" % n), dict(ICS),
                [], lambda m, u: W.v_put_item(m, u, path))
    if method == "PUT overwrite":
        return ("PUT", "/" + item, support.ics_event("item1", "changed"),
                dict(ICS), ["item1"], lambda m, u: W.v_put_item(m, u, item))
    if method == "DELETE item":
        path = "%s/del-%d.ics" % (cal, n)
        return ("DELETE", "/" + path, None, {}, [("del-%d" % n)],
                lambda m, u: W.v_delete_item(m, u, path))
    if method == "MKCALENDAR":
        path = "%s/mk-%d" % (p, n)
        return ("MKCALENDAR", "/%s/" % path, support.MKCALENDAR,
                dict(support.XML_HDR), [], lambda m, u: W.v_mkcalendar(m, u, path))
    if method == "MKCOL addressbook":
        path = "%s/ab-%d" % (p, n)
        return ("MKCOL", "/%s/" % path, MKCOL_BOOK, dict(support.XML_HDR), [],
                lambda m, u: W.v_mkcol(m, u, path, tagged=True))
    if method == "PROPPATCH":
        return ("PROPPATCH", "/%s/" % cal, PROPPATCH, dict(support.XML_HDR), [],
                lambda m, u: W.v_proppatch(m, u, cal))
    if method == "DELETE collection":
        return ("DELETE", "/%s/" % cal, None, {}, [],
                lambda m, u: W.v_delete_collection(m, u, cal))
    if method == "PUT whole collection":
        return ("PUT", "/%s/" % cal, support.ics_event("whole-%d" % n),
                dict(ICS), [], lambda m, u: W.v_put_whole(m, u, cal))
    if method == "MOVE item":
        src, dst = "%s/mv-%d.ics" % (cal, n), "%s/mv2-%d.ics" % (cal, n)
        return ("MOVE", "/" + src, None, {"Destination": "/" + dst}, ["mv-%d" % n],
                lambda m, u: W.v_move(m, u, src, dst))
    if method == "nested MKCOL":
        path = "%s/sub-%d" % (cal, n)
        return ("MKCOL", "/%s/" % path, None, {}, [],
                lambda m, u: W.v_mkcol(m, u, path, tagged=False))
    if method == "MOVE collection":
        dst = "%s/cal-moved-%d" % (p, n)
        return ("MOVE", "/%s/" % cal, None, {"Destination": "/%s/" % dst}, [],
                lambda m, u: W.v_move(m, u, cal, dst, "tagged"))
    if method == "PROPFIND principal":
        return ("PROPFIND", "/%s/" % p, PROPFIND, dict(support.XML_HDR, Depth="0"),
                [], lambda m, u: W.v_read(m, u, p, "plain"))
    if method == "DELETE principal":
        return ("DELETE", "/%s/" % p, None, {}, [],
                lambda m, u: W.v_delete_collection(m, u, p, tagged=False))
    if method == "MKCOL top-level":
        path = "top-%d" % n
        return ("MKCOL", "/%s/" % path, None, {}, [],
                lambda m, u: W.v_mkcol(m, u, path, tagged=False))
    raise KeyError(method)


@W.requires_radicale
class LetterMatrix(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = cls.s = W.WStack("matrix").up()
        cls.addClassCleanup(s.close)
        for login in ("bob", "carol", "dave", "erin", "frank", "gina"):
            s.make_user(login)
        # bob, carol, dave and erin log in (their principals are created by
        # Radicale at the first authenticated request); frank never does.
        for login in ("bob", "carol", "dave", "erin"):
            assert s.dav("PROPFIND", "/", login,
                         headers={"Depth": "0"}).status == 207
        assert s.mkcalendar("bob", "bob", "cal").status == 201
        for grantee, level in (("carol", "readwrite"), ("dave", "read")):
            r = s.api("PUT", "/grants", "bob", {
                "owner": "bob", "collection": "cal", "grantee": grantee,
                "level": level})
            assert r.status == 200 and r.json["active"], r.json
        # gina: the admin creates her principal and a calendar, then deletes
        # the account (the login is tombstoned, the directory stays)
        assert s.dav("MKCOL", "/gina/", "alice").status == 201
        assert s.mkcalendar("alice", "gina", "cal").status == 201
        r = s.api("DELETE", "/accounts/gina", "alice", {"confirm": "gina"})
        assert r.status == 200, r.json
        cls.model = s.model()
        cls.cells = {}

    # -- fixtures -------------------------------------------------------------
    def ensure(self, row, seeds):
        s = self.s
        r = s.dav("PROPFIND", "/%s/" % row.cal, "alice", PROPFIND, D_HDR)
        if r.status == 404:
            self.assertEqual(s.mkcalendar("alice", row.principal, "cal").status,
                             201)
        for seed in seeds + ["item1"]:
            r = s.dav("PUT", "/%s/%s.ics" % (row.cal, seed), "alice",
                      support.ics_event(seed), ICS)
            self.assertIn(r.status, (201, 204), (seed, r.status))

    def run_row(self, row):
        s, model = self.s, self.model
        for method in METHODS:
            hm, path, body, hdr, seeds, verdict = build(method, row)
            if row.state == "exists":
                self.ensure(row, seeds)
            r = s.dav(hm, path, row.user, body, hdr)
            got = r.status
            acct = model.accounts.get(row.user)
            if acct is None or acct.disabled:
                want = 401
            else:
                v = verdict(model, row.user)
                if row.state == "missing":
                    want = (409 if method in MISSING_409 else 404) \
                        if v.pre else 403
                elif v.full:
                    want = FIXED_OK.get(method, "2xx")
                else:
                    want = 403
            ok = (200 <= got < 300) if want == "2xx" else got == want
            self.cells[(row.role, method)] = (got, want)
            self.assertTrue(ok, "%s / %s: observed %s, oracle says %s"
                            % (row.role, method, got, want))

    # -- tests ---------------------------------------------------------------------
    def test_01_roles_on_a_collection_with_grants(self):
        for role, user in (("r grantee", "dave"), ("non-granted", "erin"),
                           ("rw grantee", "carol"), ("owner", "bob"),
                           ("admin", "alice")):
            self.run_row(Row(role, user, "bob"))

    def test_02_admin_on_the_principal_of_an_account_that_never_logged_in(self):
        s = self.s
        # the principal does not exist: rights pass, the resource is missing
        self.assertEqual(s.dav("PROPFIND", "/frank/", "alice",
                               headers=D_HDR).status, 404)
        self.run_row(Row("admin / never-logged-in, no principal yet", "alice",
                         "frank", "missing"))
        # D1: the admin makes the principal with MKCOL, then everything works
        self.assertEqual(s.dav("MKCOL", "/frank/", "alice").status, 201)
        self.assertEqual(s.mkcalendar("alice", "frank", "cal").status, 201)
        self.run_row(Row("admin / never-logged-in, principal created", "alice",
                         "frank"))

    def test_03_tombstoned_login_directory(self):
        s = self.s
        self.assertNotIn("gina", self.model.accounts)
        self.assertIn("gina", self.model.tombstones)
        self.run_row(Row("admin / tombstoned directory", "alice", "gina"))
        self.run_row(Row("other user / tombstoned directory", "bob", "gina"))
        self.run_row(Row("tombstoned login itself", "gina", "gina"))
        # the tombstoned login cannot even authenticate
        self.assertEqual(s.dav("PROPFIND", "/", "gina",
                               headers=D_HDR).status, 401)

    def test_04_success_statuses_are_uniform_per_method(self):
        by = {}
        for (role, method), (got, want) in self.cells.items():
            if want in ("2xx", 405):
                by.setdefault(method, set()).add(got)
        for method, codes in sorted(by.items()):
            self.assertEqual(len(codes), 1, (method, codes))
        W.info("success status per method: %s" % ", ".join(
            "%s=%d" % (m, next(iter(c))) for m, c in sorted(by.items())))

    def test_05_rw_grantee_cannot_rename_or_delete_but_can_edit(self):
        c = self.cells
        self.assertTrue(200 <= c[("rw grantee", "PUT new")][0] < 300)
        self.assertEqual(c[("rw grantee", "PROPPATCH")][0], 403)
        self.assertEqual(c[("rw grantee", "DELETE collection")][0], 403)
        self.assertEqual(c[("rw grantee", "PUT whole collection")][0], 403)
        self.assertEqual(c[("rw grantee", "nested MKCOL")][0], 403)
        self.assertEqual(c[("rw grantee", "MKCALENDAR")][0], 403)

    def test_06_nobody_deletes_a_principal_or_makes_a_top_level_name(self):
        for (role, method), (got, want) in self.cells.items():
            if method in ("DELETE principal", "MKCOL top-level"):
                self.assertIn(got, (401, 403, 404, 409), (role, method, got))
                self.assertFalse(200 <= got < 300, (role, method, got))

    def test_07_print_matrix(self):
        rows = []
        for role in dict.fromkeys(r for r, _ in self.cells):
            rows.append("%-46s %s" % (role[:46], " ".join(
                "%3d" % self.cells[(role, m)][0] for m in METHODS
                if (role, m) in self.cells)))
        W.info("matrix columns: " + " | ".join(METHODS))
        for line in rows:
            W.info("matrix " + line)
        self.assertEqual(len(self.cells), 10 * len(METHODS))


@W.requires_radicale
class RwWithoutL(unittest.TestCase):
    """An rw grantee WITHOUT ``l`` (hand-built rule): proves ``l`` is the
    letter that blocks PROPPATCH. The generator always emits ``rwl``."""

    def test_l_is_what_blocks_proppatch(self):
        s = W.WStack("nol").up()
        self.addCleanup(s.close)
        s.make_user("bob")
        s.make_user("carol")
        assert s.dav("PROPFIND", "/", "bob", headers=D_HDR).status == 207
        assert s.mkcalendar("bob", "bob", "cal").status == 201
        r = s.api("PUT", "/grants", "bob", {
            "owner": "bob", "collection": "cal", "grantee": "carol",
            "level": "readwrite"})
        self.assertEqual(r.status, 200, r.json)
        path = os.path.join(s.managed, "rights")
        with open(path, "rb") as fh:
            original = fh.read()
        self.assertIn(b"permissions: rwl\n", original)
        self.assertEqual(s.dav("PROPPATCH", "/bob/cal/", "carol", PROPPATCH,
                               support.XML_HDR).status, 403)
        # the variant: the same file with the one rule changed from rwl to rw,
        # header, trailer and hash recomputed (the plugin checks them)
        body = original[:original.rindex(b"# radui-end")]
        gen = int(re.search(rb"generation=(\d+)", body).group(1))
        rule = (b"user: ^carol$\ncollection: ^bob/cal$\npermissions: rwl\n")
        self.assertEqual(body.count(rule), 1)
        body = body.replace(rule, rule[:-4] + b"rw\n")
        variant = body + support.trailer_for(body, gen)
        self.assertEqual(variant.count(b"collection: ^bob/cal$\npermissions: rw\n"), 1)
        tmp = path + ".variant"
        with open(tmp, "wb") as fh:
            fh.write(variant)
        os.chmod(tmp, 0o640)
        os.rename(tmp, path)
        r = s.dav("PROPPATCH", "/bob/cal/", "carol", PROPPATCH, support.XML_HDR)
        self.assertEqual(r.status, 207, r.body)
        self.assertIn(b"200 OK", r.body)
        # every other letter behaves as before: still no delete, no overwrite
        self.assertEqual(s.dav("DELETE", "/bob/cal/", "carol").status, 403)
        self.assertEqual(s.dav("PUT", "/bob/cal/", "carol",
                               support.ics_event("w1"), ICS).status, 403)
        self.assertEqual(s.put_event("carol", "bob", "cal", "e-1").status, 201)
        # put the generated file back: the next request is denied again
        tmp = path + ".back"
        with open(tmp, "wb") as fh:
            fh.write(original)
        os.chmod(tmp, 0o640)
        os.rename(tmp, path)
        self.assertEqual(s.dav("PROPPATCH", "/bob/cal/", "carol", PROPPATCH,
                               support.XML_HDR).status, 403)


if __name__ == "__main__":
    unittest.main()
