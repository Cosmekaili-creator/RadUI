#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2-6: what Radicale does with PUT bodies the UI must never create blindly.

A vCard without UID (3.0 and 4.0, and a group card without UID), a vCard 2.1,
a file with two cards, an item whose UID differs from its file name, the same
UID under two names, LF-only line endings, a non-UTF-8 body, an empty body,
a body that is not a vCard, a missing Content-Type, a very long file name.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, standard_stack, require_memory, card30, card40,  # noqa: E402
                    short, compare_cards, unfold, VCF)

NO_UID_30 = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:No Uid\r\nN:Uid;No;;;\r\nEND:VCARD\r\n"
NO_UID_40 = "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:No Uid\r\nEND:VCARD\r\n"
NO_UID_GROUP = ("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Team\r\nKIND:group\r\n"
                "MEMBER:urn:uuid:00000000-0000-4000-8000-000000000001\r\n"
                "END:VCARD\r\n")
V21 = ("BEGIN:VCARD\r\nVERSION:2.1\r\nUID:v21\r\nFN:Old Format\r\nN:Format;Old\r\n"
       "TEL;HOME;VOICE:+15550100\r\nEND:VCARD\r\n")
V21_NO_UID = V21.replace("UID:v21\r\n", "")
V21_QP = ("BEGIN:VCARD\r\nVERSION:2.1\r\nUID:v21q\r\nFN;ENCODING=QUOTED-PRINTABLE;"
          "CHARSET=UTF-8:Caf=C3=A9\r\nN:Format;Old\r\nEND:VCARD\r\n")


def line(r):
    return "%d %s" % (r.status, short(r.body, 110)) if r.body else str(r.status)


def main():
    require_memory()
    c = Checker("S2-6 PUT shapes: no UID, vCard 2.1, two cards, UID vs name")
    s = standard_stack("s206")
    base = "/alice/contacts/"
    try:
        # ---- without UID -------------------------------------------------------
        for name, text in (("no-uid-3.0", NO_UID_30), ("no-uid-4.0", NO_UID_40),
                           ("no-uid-group", NO_UID_GROUP)):
            p = s.req("PUT", base + name + ".vcf", "alice", text, VCF)
            g = s.req("GET", base + name + ".vcf", "alice")
            c.expect("%s/refused-not-added" % name,
                     p.status == 400 and g.status == 404,
                     "PUT -> %s; GET afterwards %d: Radicale does NOT add a "
                     "UID, it refuses the card" % (line(p), g.status))
        # a UID-less file that got into the storage behind Radicale's back
        with open(os.path.join(s.storage_root(), "alice", "contacts",
                               "seeded-no-uid.vcf"), "wb") as fh:
            fh.write(NO_UID_30.encode())
        r = s.req("GET", base + "seeded-no-uid.vcf", "alice")
        coll = s.req("GET", base, "alice")
        c.expect("no-uid/seeded-file-invisible",
                 r.status == 404 and b"No Uid" not in coll.body,
                 "a UID-less card placed in the storage directory: GET %d, "
                 "absent from the collection GET (%d bytes): such a card can "
                 "neither be listed nor edited over DAV" % (r.status, len(coll.body)))
        r = s.req("PUT", base + "seeded-no-uid.vcf", "alice", NO_UID_30.replace(
            "No Uid", "Edited"), VCF)
        c.info("no-uid/seeded-file-edit", "PUT over it without UID -> %d" % r.status)
        # ---- 2.1 ----------------------------------------------------------------
        for name, text in (("v21", V21), ("v21-no-uid", V21_NO_UID),
                           ("v21-quoted-printable", V21_QP)):
            p = s.req("PUT", base + name + ".vcf", "alice", text, VCF)
            g = s.req("GET", base + name + ".vcf", "alice") if p.status in (
                201, 204) else None
            if g is not None:
                lvl, det = compare_cards(text, g.body.decode())
                c.info("%s" % name, "PUT -> %d, stored; GET compare level %s%s; "
                       "VERSION line back: %s" % (
                           p.status, lvl, (" " + short(" | ".join(det), 200))
                           if det else "",
                           [ln for ln in unfold(g.body.decode())
                            if ln.startswith("VERSION")]))
            else:
                c.info("%s" % name, "PUT -> %s" % line(p))
        p = s.req("PUT", base + "v21.vcf", "alice", V21, VCF)
        c.expect("vcard-2.1/accepted-by-server",
                 s.req("GET", base + "v21.vcf", "alice").status == 200,
                 "the server stores a 2.1 card: a client-side refusal (Q3) is "
                 "the only guard; Radicale does not enforce a version")
        # ---- two cards in one file --------------------------------------------
        two = card30("two-a", "First Card") + card30("two-b", "Second Card")
        p = s.req("PUT", base + "two.vcf", "alice", two, VCF)
        c.expect("two-cards/rejected", p.status in (400, 409, 415, 422),
                 "PUT of a file with two cards at one name -> %s" % line(p))
        g = s.req("GET", base + "two.vcf", "alice")
        c.info("two-cards/stored", "GET afterwards -> %d" % g.status)
        # ---- UID differs from the file name --------------------------------------
        p = s.req("PUT", base + "named-x.vcf", "alice", card30("uid-y"), VCF)
        g = s.req("GET", base + "named-x.vcf", "alice")
        c.expect("uid-vs-name/accepted-and-kept",
                 p.status == 201 and b"UID:uid-y" in g.body,
                 "PUT named-x.vcf with UID:uid-y -> %d; GET shows UID:uid-y: %s "
                 "(the file name and the UID are independent)" % (
                     p.status, b"UID:uid-y" in g.body))
        r = s.req("GET", base + "uid-y.vcf", "alice")
        c.info("uid-vs-name/no-lookup-by-uid", "GET by .../uid-y.vcf -> %d "
               "(nothing resolves a UID to a name)" % r.status)
        # same UID under two names
        p = s.req("PUT", base + "dup-1.vcf", "alice", card30("dup"), VCF)
        p2 = s.req("PUT", base + "dup-2.vcf", "alice", card30("dup"), VCF)
        c.expect("duplicate-uid/second-name-refused", p.status == 201
                 and p2.status == 409, "same UID under dup-1 -> %d, dup-2 -> %s"
                 % (p.status, line(p2)))
        # same UID replaced under the same name (allowed)
        p3 = s.req("PUT", base + "dup-1.vcf", "alice", card30("dup", "Changed"), VCF)
        c.info("duplicate-uid/same-name-replace", "re-PUT under dup-1 (no If-Match) "
               "-> %d" % p3.status)
        # changing the UID of an existing item
        p4 = s.req("PUT", base + "dup-1.vcf", "alice", card30("dup-new"), VCF)
        g4 = s.req("GET", base + "dup-1.vcf", "alice")
        c.info("uid-change/existing-item", "PUT of a changed UID under the same "
               "name -> %d; stored UID line: %s" % (p4.status, [
                   ln for ln in unfold(g4.body.decode()) if ln.startswith("UID")]))
        # UID with odd characters
        for uid in ("urn:uuid:5a1bd6c4-0000-4000-8000-0000000000aa",
                    "a/b", "a b", "ünï"):
            nm = "u%d.vcf" % abs(hash(uid) % 9999)
            p = s.req("PUT", base + nm, "alice", card30(uid), VCF)
            c.info("uid-chars/%s" % uid.replace("/", "slash"), "UID %r -> %d"
                   % (uid, p.status))
        # ---- misc encodings --------------------------------------------------------
        lf = card30("lf-only").replace("\r\n", "\n")
        p = s.req("PUT", base + "lf.vcf", "alice", lf, VCF)
        g = s.req("GET", base + "lf.vcf", "alice")
        c.info("lf-only", "PUT -> %d; GET uses CRLF: %s" % (
            p.status, g.status == 200 and b"\r\n" in g.body and b"\n" not in
            g.body.replace(b"\r\n", b"")))
        cp = card30("cp1252", "Caf\u00e9 Ren\u00e9 \u20ac5").encode("cp1252")
        p = s.req("PUT", base + "cp.vcf", "alice", cp, VCF)
        g = s.req("GET", base + "cp.vcf", "alice")
        txt = g.body.decode("utf-8", "replace")
        c.info("non-utf8-body", "Windows-1252 bytes (e-acute, euro sign) -> "
               "PUT %s; stored text is valid UTF-8: %s; euro sign survived: "
               "%s; e-acute survived: %s; euro sign came back as U+0080 (the "
               "body was decoded as ISO-8859-1): %s" % (
                   line(p), g.body.decode("utf-8", "ignore") == txt and
                   "\ufffd" not in txt, "\u20ac" in txt, "\u00e9" in txt, "\u0080" in txt))
        c.expect("non-utf8-body/not-stored-as-garbage",
                 p.status in (400, 415) or "\u20ac5" in txt,
                 "the server either refuses a non-UTF-8 body or decodes it "
                 "correctly; the UI refuses non-UTF-8 files before upload "
                 "anyway")
        p = s.req("PUT", base + "bom.vcf", "alice",
                  b"\xef\xbb\xbf" + card30("bom").encode(), VCF)
        c.info("utf8-bom", "UTF-8 BOM before BEGIN -> %s" % line(p))
        p = s.req("PUT", base + "empty.vcf", "alice", b"", VCF)
        c.expect("empty-body/refused", p.status in (400, 415),
                 "empty PUT -> %s" % line(p))
        p = s.req("PUT", base + "junk.vcf", "alice", "hello world", VCF)
        c.expect("not-a-vcard/refused", p.status in (400, 415),
                 "plain text PUT -> %s" % line(p))
        p = s.req("PUT", base + "ics-in-book.vcf", "alice",
                  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", VCF)
        c.info("calendar-in-book", "VCALENDAR PUT into an address book -> %s"
               % line(p))
        p = s.req("PUT", base + "noct.vcf", "alice", card30("noct"),
                  {"Content-Type": "application/octet-stream"})
        c.info("content-type-octet-stream", "PUT with a wrong Content-Type -> "
               "%d (the type is not checked)" % p.status)
        p = s.req("PUT", base + ("n" * 200) + ".vcf", "alice", card30("longname"), VCF)
        c.info("file-name-200-chars", "PUT with a 200-character name -> %d" % p.status)
        p = s.req("PUT", base + "sp%20ace.vcf", "alice", card30("space"), VCF)
        c.info("file-name-percent-encoded", "PUT .../sp%%20ace.vcf -> %d" % p.status)
        p = s.req("PUT", base + "sub/dir.vcf", "alice", card30("deep"), VCF)
        c.info("file-name-subpath", "PUT .../sub/dir.vcf -> %s" % line(p))
        p = s.req("PUT", base + "big.vcf", "alice",
                  card30("big", extra="NOTE:" + "x" * 3_000_000 + "\r\n"), VCF)
        c.info("3-megabyte-card", "PUT of a 3 MB card -> %d" % p.status)
    finally:
        s.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
