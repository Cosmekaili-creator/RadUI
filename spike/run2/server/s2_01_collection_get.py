#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2-1: GET on a whole collection (address book and calendar).

As owner, read-write grantee and read-only grantee: status, Content-Type,
size, structure (one concatenated body? wrapper? headers?), behaviour with 500
items, empty collection, mixed vCard versions, calendars with VTIMEZONEs.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, standard_stack, require_memory, card30, card40,  # noqa: E402
                    event, short, seed_books_calendars, VCF, ICS, XML,
                    mkcol_book, mkcalendar)


def main():
    require_memory()
    c = Checker("S2-1 GET on a whole collection")
    s = standard_stack("s201")
    try:
        # ---- address book, three cards of two versions -----------------------
        sent = {}
        for uid, txt in (("a1", card30("a1", "Anna One")),
                         ("a2", card40("a2", "Berta Two")),
                         ("a3", card30("a3", "Carla Three"))):
            r = s.req("PUT", "/alice/contacts/%s.vcf" % uid, "alice", txt, VCF)
            assert r.status == 201
            sent[uid] = txt
        bodies = {}
        for u in ("alice", "bob", "agent-1"):
            r = s.req("GET", "/alice/contacts/", u)
            bodies[u] = r
            ct = r.headers.get("content-type", "")
            c.expect("book/%s/status-and-type" % u,
                     r.status == 200 and ct.startswith("text/vcard"),
                     "status %d, Content-Type %r, size %d, ETag %s, "
                     "Content-Disposition %r" % (
                         r.status, ct, len(r.body), "etag" in r.headers,
                         r.headers.get("content-disposition")))
        same = len({r.body for r in bodies.values()}) == 1
        c.expect("book/identical-for-all-three-roles", same,
                 "owner, rw grantee and r grantee receive byte-identical bodies: %s"
                 % same)
        body = bodies["alice"].body.decode()
        n_begin = len(re.findall(r"^BEGIN:VCARD\r?$", body, re.M))
        n_end = len(re.findall(r"^END:VCARD\r?$", body, re.M))
        c.expect("book/concatenation-of-item-texts",
                 n_begin == 3 and n_end == 3 and body.startswith("BEGIN:VCARD")
                 and body.rstrip().endswith("END:VCARD"),
                 "%d BEGIN/%d END; starts with BEGIN:VCARD; no wrapper; "
                 "first 60 chars %s" % (n_begin, n_end, short(body, 60)))
        pieces = re.findall(r"BEGIN:VCARD\r\n.*?END:VCARD\r\n", body, re.S)
        per_item = sorted(pieces) == sorted(sent.values())
        c.expect("book/each-card-byte-identical-to-sent", per_item,
                 "every concatenated card equals the text that was PUT: %s"
                 % per_item)
        order = re.findall(r"^UID:(\S+?)\r?$", body, re.M)
        c.info("book/order-of-cards", "UIDs in body order %s (sent a1,a2,a3)"
               % order)
        c.info("book/mixed-versions-in-one-body",
               "VERSION lines in the body: %s -> an export mixes 3.0 and 4.0 "
               "cards in one file" % re.findall(r"^VERSION:(\S+)", body, re.M))
        c.info("book/headers", "all: %s" % sorted(bodies["alice"].headers))

        # ---- empty books and unreachable books ------------------------------
        assert s.req("MKCOL", "/alice/empty/", "alice", mkcol_book("empty"),
                     XML).status == 201
        r = s.req("GET", "/alice/empty/", "alice")
        c.info("book/empty-collection", "status %d, size %d, Content-Type %r"
               % (r.status, len(r.body), r.headers.get("content-type")))
        r_private = s.req("GET", "/alice/empty/", "bob")
        c.expect("book/ungranted-book-is-refused",
                 r_private.status in (403, 404),
                 "bob on a book without grant -> %d" % r_private.status)

        # ---- 500 cards --------------------------------------------------------
        seed_books_calendars(s, 500, "book", "bulk")
        # bob and agent-1 need a grant on the new book
        s.grant("alice", "bulk", "bob", "readwrite")
        s.grant("alice", "bulk", "agent-1", "read")
        sizes = {}
        for u in ("alice", "bob", "agent-1"):
            r = s.req("GET", "/alice/bulk/", u)
            n = len(re.findall(r"^BEGIN:VCARD\r?$", r.body.decode(), re.M))
            sizes[u] = (r.status, len(r.body), n)
            c.expect("book-500/%s" % u, r.status == 200 and n == 500,
                     "status %d, %d bytes, %d cards, one request" % (
                         r.status, len(r.body), n))
        c.info("book-500/time", "GET of 500 cards takes %.2f s as owner "
               "(single request, no paging)" % s.req(
                   "GET", "/alice/bulk/", "alice").dt)

        # ---- calendar ----------------------------------------------------------
        tz = ("BEGIN:VTIMEZONE\r\nTZID:Europe/Example\r\nBEGIN:STANDARD\r\n"
              "DTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\n"
              "TZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n")
        def ev_tz(uid):
            return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//RadUI spike//EN\r\n"
                    + tz + "BEGIN:VEVENT\r\nUID:%s\r\nDTSTAMP:20260101T000000Z\r\n"
                    "DTSTART;TZID=Europe/Example:20260601T100000\r\n"
                    "SUMMARY:Zoned %s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n" % (uid, uid))
        for uid in ("t1", "t2"):
            assert s.req("PUT", "/alice/cal-work/%s.ics" % uid, "alice",
                         ev_tz(uid), ICS).status == 201
        for uid in ("p1", "p2"):
            assert s.req("PUT", "/alice/cal-work/%s.ics" % uid, "alice",
                         event(uid), ICS).status == 201
        cal = {}
        for u in ("alice", "bob", "agent-1"):
            r = s.req("GET", "/alice/cal-work/", u)
            cal[u] = r
            ct = r.headers.get("content-type", "")
            c.expect("calendar/%s/status-and-type" % u,
                     r.status == 200 and ct.startswith("text/calendar"),
                     "status %d, Content-Type %r, size %d, Content-Disposition %r"
                     % (r.status, ct, len(r.body),
                        r.headers.get("content-disposition")))
        c.expect("calendar/identical-for-all-three-roles",
                 len({r.body for r in cal.values()}) == 1, "byte-identical")
        b = cal["alice"].body.decode()
        nv = len(re.findall(r"^BEGIN:VCALENDAR\r?$", b, re.M))
        ntz = len(re.findall(r"^BEGIN:VTIMEZONE\r?$", b, re.M))
        nev = len(re.findall(r"^BEGIN:VEVENT\r?$", b, re.M))
        c.expect("calendar/one-vcalendar-wrapper", nv == 1 and nev == 4,
                 "%d VCALENDAR, %d VEVENT, %d VTIMEZONE in one body (Radicale "
                 "MERGES the items; a plain concatenation would show 4 wrappers)"
                 % (nv, nev, ntz))
        c.expect("calendar/timezone-deduplicated", ntz == 1,
                 "two events with the same TZID -> %d VTIMEZONE block(s)" % ntz)
        c.info("calendar/head", short(b, 200))
        c.info("calendar/prodid-and-version", "PRODID lines %s, VERSION lines %s"
               % (re.findall(r"^PRODID:(.*?)\r?$", b, re.M),
                  re.findall(r"^VERSION:(\S+)", b, re.M)))

        # ---- 500 events ---------------------------------------------------------
        seed_books_calendars(s, 500, "calendar", "cal500")
        r = s.req("GET", "/alice/cal500/", "alice")
        b = r.body.decode()
        nv = len(re.findall(r"^BEGIN:VCALENDAR\r?$", b, re.M))
        nev = len(re.findall(r"^BEGIN:VEVENT\r?$", b, re.M))
        c.expect("calendar-500", r.status == 200 and nv == 1 and nev == 500,
                 "status %d, %d bytes, %d VCALENDAR, %d VEVENT, %.2f s" % (
                     r.status, len(r.body), nv, nev, r.dt))
        # an empty calendar
        assert s.req("MKCALENDAR", "/alice/cal-empty/", "alice",
                     mkcalendar("cal-empty"), XML).status == 201
        r = s.req("GET", "/alice/cal-empty/", "alice")
        c.info("calendar/empty-collection", "status %d, size %d, body %s" % (
            r.status, len(r.body), short(r.body, 120)))
    finally:
        s.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
