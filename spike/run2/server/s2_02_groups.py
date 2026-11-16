#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2-2: group cards through PUT -> GET.

RFC 6350 form (VERSION 4.0: KIND:group + MEMBER:urn:uuid:...) and the Apple
form (VERSION 3.0: X-ADDRESSBOOKSERVER-KIND:group + X-ADDRESSBOOKSERVER-MEMBER),
each with 50 members: preserved? reordered? folded? normalised? Also a group
card whose MEMBER is not a urn:uuid, a group with 0 and 1 member, and one with
members in a non-sorted order.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, standard_stack, require_memory, compare_cards,  # noqa: E402
                    unfold, short, VCF)

UUIDS = ["%08x-0000-4000-8000-%012x" % (0x1000 + i * 7919 % 65521, i * 104729)
         for i in range(50)]


def group40(uid, members, extra=""):
    lines = ["BEGIN:VCARD", "VERSION:4.0", "UID:urn:uuid:" + uid,
             "FN:Team Example", "KIND:group"]
    lines += ["MEMBER:" + m for m in members]
    return "\r\n".join(lines) + "\r\n" + extra + "END:VCARD\r\n"


def group_apple(uid, members, extra=""):
    lines = ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Apple Inc.//AddressBook 6.1//EN",
             "UID:" + uid, "FN:Team Example", "N:Team Example;;;;",
             "X-ADDRESSBOOKSERVER-KIND:group"]
    lines += ["X-ADDRESSBOOKSERVER-MEMBER:" + m for m in members]
    return "\r\n".join(lines) + "\r\n" + extra + "END:VCARD\r\n"


LONG = "https://example.org/contacts/" + "segment-" * 12 + "end.vcf"


def folded_group():
    """A group card whose MEMBER line (over 75 characters) is folded."""
    body = group40("12121212-1212-4121-8121-121212121212", [])
    line = "MEMBER:" + LONG
    folded = line[:75] + "\r\n " + line[75:150] + "\r\n " + line[150:]
    return body.replace("END:VCARD", folded + "\r\nEND:VCARD")


def main():
    require_memory()
    c = Checker("S2-2 group cards")
    s = standard_stack("s202")
    try:
        members = ["urn:uuid:" + u for u in UUIDS]
        cases = [
            ("rfc6350-50-members", "g1.vcf",
             group40("11111111-1111-4111-8111-111111111111", members)),
            ("apple-50-members", "g2.vcf",
             group_apple("22222222-2222-4222-8222-222222222222", members)),
            ("rfc6350-0-members", "g3.vcf",
             group40("33333333-3333-4333-8333-333333333333", [])),
            ("rfc6350-1-member", "g4.vcf",
             group40("44444444-4444-4444-8444-444444444444", members[:1])),
            ("rfc6350-reverse-order", "g5.vcf",
             group40("55555555-5555-4555-8555-555555555555", members[::-1])),
            ("rfc6350-non-uuid-members", "g6.vcf",
             group40("66666666-6666-4666-8666-666666666666",
                     ["mailto:jane@example.org",
                      "https://example.org/contacts/jane.vcf",
                      "urn:uuid:" + UUIDS[0], "MEMBER-WITHOUT-SCHEME",
                      "urn:uuid:" + UUIDS[1].upper()])),
            ("apple-non-uuid-members", "g7.vcf",
             group_apple("77777777-7777-4777-8777-777777777777",
                         ["mailto:jane@example.org", "urn:uuid:" + UUIDS[2]])),
            ("rfc6350-folded-long-member", "g9.vcf", folded_group()),
            ("rfc6350-member-with-uid-not-uuid", "g8.vcf",
             group40("88888888-8888-4888-8888-888888888888", ["urn:uid:abc-123"])),
        ]
        for name, fn, text in cases:
            p = s.req("PUT", "/alice/contacts/" + fn, "alice", text, VCF)
            if p.status not in (201, 204):
                c.expect("%s/accepted" % name, False,
                         "PUT -> %d %s" % (p.status, short(p.body)))
                continue
            g = s.req("GET", "/alice/contacts/" + fn, "alice")
            level, det = compare_cards(text, g.body.decode())
            a = [ln for ln in unfold(text) if "MEMBER:" in ln.upper()]
            b = [ln for ln in unfold(g.body.decode()) if "MEMBER:" in ln.upper()]
            ok = level in ("byte-identical", "same-lines")
            c.expect("%s/preserved" % name, ok and a == b,
                     "PUT %d; GET compare level %s; %d MEMBER lines sent, %d "
                     "back, same order: %s%s" % (
                         p.status, level, len(a), len(b), a == b,
                         ("; diffs " + short("; ".join(det), 300)) if det else ""))
            longest = max(len(ln) for ln in g.body.decode().split("\r\n"))
            c.info("%s/line-length" % name,
                   "longest physical line %d chars, folded lines in GET: %d"
                   % (longest, g.body.decode().count("\r\n ")))
        # editing one member (the group UI's only write): replace with one
        # member added, check the rest is untouched
        text = cases[0][2]
        added = group40("11111111-1111-4111-8111-111111111111",
                        members + ["urn:uuid:99999999-0000-4000-8000-000000000001"])
        g = s.req("GET", "/alice/contacts/g1.vcf", "alice")
        p = s.req("PUT", "/alice/contacts/g1.vcf", "alice", added,
                  dict(VCF, **{"If-Match": g.headers["etag"]}))
        g2 = s.req("GET", "/alice/contacts/g1.vcf", "alice")
        level, det = compare_cards(added, g2.body.decode())
        c.expect("rfc6350-add-one-member/replace",
                 p.status == 204 and level in ("byte-identical", "same-lines"),
                 "If-Match PUT -> %d, compare level %s" % (p.status, level))
        # the group card is a plain vCard member of the collection GET
        body = s.req("GET", "/alice/contacts/", "alice").body.decode()
        c.info("group-cards-in-collection-get",
               "KIND:group in whole-collection export: %s; the export carries "
               "group cards (RFC 6350 and Apple) like any other card"
               % ("KIND:group" in body))
    finally:
        s.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
