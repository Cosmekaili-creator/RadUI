#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S14': what does Radicale (vobject) canonicalise on PUT?

PUT crafted iCalendar and vCard bodies, GET them back, and record exactly what
changed: line endings, property order, property-name and parameter-name case,
folding (by characters or octets), blank lines, escapes, X- properties, grouped
vCard properties, PHOTO folding. Also compares the text delivered by REPORT
(calendar-query, calendar-multiget, addressbook-multiget) with the GET text, and
the ETag of the PUT response with GET / PROPFIND / REPORT ETags.
"""
import base64
import difflib
import os
import re
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, Instance, XML_HDR, NS, MKCOL_BOOK,  # noqa: E402
                    mkcalendar_body)

D = "{DAV:}"
C = "{urn:ietf:params:xml:ns:caldav}"
CR = "{urn:ietf:params:xml:ns:carddav}"

LONG_ASCII = "L" * 40 + " " + "word " * 40
LONG_UTF8 = "éè€中" * 30       # 2-, 2-, 3- and 3-byte characters

ICS_CRAFTED = "\r\n".join([
    "BEGIN:VCALENDAR",
    "summary-before-version:ignored-x",           # junk property at calendar level
    "VERSION:2.0",
    "PRODID:-//Spike Crafted//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Paris",
    "BEGIN:STANDARD",
    "TZOFFSETTO:+0100",
    "TZOFFSETFROM:+0200",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "TZNAME:CET",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "summary:Lower case property name",
    "X-ZZZ-CUSTOM;x-param=KeepMe:custom value",
    "UID:crafted-1",
    "DTSTART;tzid=Europe/Paris:20260601T100000",
    "DTEND;TZID=\"Europe/Paris\":20260601T110000",
    "DTSTAMP:20260101T000000Z",
    "",
    "ATTENDEE;cn=Bob;PartStat=ACCEPTED;x-num-guests=2:mailto:bob@example.org",
    "ORGANIZER;CN=\"Alice, Quoted\":mailto:alice@example.org",
    "ATTENDEE;CN=Zed:mailto:zed@example.org",
    "ATTENDEE;CN=Amy:mailto:amy@example.org",
    "CATEGORIES:ZZ-last",
    "CATEGORIES:AA-first",
    "X-QUOTED;X-P=\"a:b;c\":needs-quotes",
    "DESCRIPTION:Line one\\nLine two with comma\\, semicolon\\; and backslash \\\\",
    "LOCATION:" + LONG_ASCII,
    "COMMENT:" + LONG_UTF8,
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "EXDATE;TZID=Europe/Paris:20260608T100000",
    "CLASS:PUBLIC",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:crafted-1",
    "RECURRENCE-ID;TZID=Europe/Paris:20260615T100000",
    "DTSTART;TZID=Europe/Paris:20260615T140000",
    "DTSTAMP:20260101T000000Z",
    "SUMMARY:Override",
    "END:VEVENT",
    "END:VCALENDAR", ""])

VCF_CRAFTED = "\r\n".join([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//Spike Crafted//EN",
    "UID:crafted-card-1",
    "N:Example;Alex;;;",
    "FN:Alex Example",
    "item1.TEL;type=pref;TYPE=VOICE:+10000000001",
    "item1.X-ABLabel:_$!<Mobile>!$_",
    "email;type=INTERNET;type=HOME:alex@example.org",
    "NOTE:" + LONG_UTF8,
    "PHOTO;ENCODING=b;TYPE=JPEG:" + base64.b64encode(bytes(range(256)) * 2).decode(),
    "X-CUSTOM-PROP;x-param=1:kept",
    "END:VCARD", ""])

VCF4_GROUP = "\r\n".join([
    "BEGIN:VCARD", "VERSION:4.0", "UID:crafted-group-1", "KIND:group",
    "FN:Example Group", "MEMBER:urn:uuid:aaaaaaaa-0000-0000-0000-000000000001",
    "END:VCARD", ""])


def unfold(text):
    """Unfold to logical lines (LF-normalised input accepted)."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out = []
    for ln in text.split("\n"):
        if ln[:1] in (" ", "\t") and out:
            out[-1] += ln[1:]
        else:
            out.append(ln)
    return out


def names_in_order(lines, component):
    """Property names of the first `component` block, in order."""
    out, inside, depth = [], False, 0
    for ln in lines:
        if ln.startswith("BEGIN:"):
            if ln == "BEGIN:" + component and not inside:
                inside = True
                continue
            if inside:
                depth += 1
            continue
        if ln.startswith("END:"):
            if inside and depth == 0:
                break
            if inside:
                depth -= 1
            continue
        if inside and depth == 0 and ln:
            out.append(re.split(r"[;:]", ln, maxsplit=1)[0])
    return out


def raw_lines(raw_bytes):
    return raw_bytes.decode("utf-8").split("\n")


def multistatus_data(body, tag):
    root = ET.fromstring(body)
    return {h.find(D + "href").text: (n.text if n is not None else None)
            for h in root.iter(D + "response")
            for n in [h.find(".//" + tag)]}


def multistatus_etags(body):
    root = ET.fromstring(body)
    out = {}
    for resp in root.iter(D + "response"):
        e = resp.find(".//" + D + "getetag")
        out[resp.find(D + "href").text] = e.text if e is not None else None
    return out


def main():
    c = Checker("S14' canonicalisation by Radicale")
    inst = Instance("s14", rights="radui_rights")
    inst.start()
    assert inst.make_member("alice", "cal-a").status == 201
    assert inst.req("MKCOL", "/alice/book-a/", "alice", MKCOL_BOOK, XML_HDR).status == 201

    # ------------------------------------------------------------------ iCalendar
    put = inst.req("PUT", "/alice/cal-a/crafted.ics", "alice", ICS_CRAFTED.encode(),
                   {"Content-Type": "text/calendar; charset=utf-8"})
    c.check("ics/put-accepted", put.status == 201,
            "PUT crafted item (CRLF input, odd order, lower-case names, blank line, long "
            "lines) -> %d" % put.status)
    get = inst.req("GET", "/alice/cal-a/crafted.ics", "alice")
    raw = get.body
    out_text = raw.decode("utf-8")
    crlf = out_text.count("\r\n")
    bare_lf = out_text.count("\n") - crlf
    c.check("ics/output-line-endings-crlf", crlf > 0 and bare_lf == 0,
            "GET body: %d CRLF, %d bare LF" % (crlf, bare_lf))

    # input as LF only
    ics_lf = ICS_CRAFTED.replace("\r\n", "\n").replace("crafted-1", "crafted-lf")
    put_lf = inst.req("PUT", "/alice/cal-a/crafted-lf.ics", "alice", ics_lf.encode(),
                      {"Content-Type": "text/calendar"})
    get_lf = inst.req("GET", "/alice/cal-a/crafted-lf.ics", "alice")
    same = get_lf.body.decode().replace("crafted-lf", "crafted-1") == out_text
    c.check("ics/lf-input-accepted-and-converges-to-same-output",
            put_lf.status == 201 and same,
            "PUT with bare-LF line endings -> %d; GET text identical to the CRLF-input result "
            "(after the UID swap): %s" % (put_lf.status, same))

    in_lines = [ln for ln in unfold(ICS_CRAFTED) if ln != ""]
    out_lines = [ln for ln in unfold(out_text) if ln != ""]
    c.info("input logical lines: %d, output logical lines: %d" % (len(in_lines), len(out_lines)))
    only_in = [ln for ln in in_lines if ln not in out_lines]
    only_out = [ln for ln in out_lines if ln not in in_lines]
    print("--- lines whose text changed (input -> output), after unfolding ---")
    for a in difflib.unified_diff(sorted(in_lines), sorted(out_lines), "input", "output",
                                  lineterm="", n=0):
        if a.startswith(("+", "-")) and not a.startswith(("+++", "---")):
            print("   ", a[:150])
    c.info("lines only in input: %d, only in output: %d" % (len(only_in), len(only_out)))

    # property order inside the first VEVENT
    o_in = names_in_order(in_lines, "VEVENT")
    o_out = names_in_order(out_lines, "VEVENT")
    c.info("VEVENT property order  input: %s" % o_in)
    c.info("VEVENT property order output: %s" % o_out)
    c.check("ics/property-order-recorded", True,
            "reordered by the server: %s" % (o_in != o_out))
    # property / parameter name case
    c.info("lower-case property name 'summary' appears in output as: %s" % (
        [ln.split(":")[0] for ln in out_lines if ln.lower().startswith("summary:Lower".lower())]))
    c.info("DTSTART param written 'tzid=' in input; output line: %s" % (
        [ln for ln in out_lines if ln.startswith("DTSTART") and "20260601" in ln]))
    c.info("ATTENDEE lower-case params in input (cn=, x-num-guests=); output line: %s" % (
        [ln for ln in out_lines if ln.startswith("ATTENDEE")]))
    c.info("calendar-level junk property in input; output contains it: %s" % (
        any("summary-before-version" in ln.lower() for ln in out_lines)))
    # semantic preservation of values
    def norm(lines):
        res = set()
        for ln in lines:
            m = re.match(r"^([^:;]+)((?:;[^:]*)?):(.*)$", ln)
            if not m:
                res.add(("?", (), ln))
                continue
            name, params, value = m.group(1).upper(), m.group(2), m.group(3)
            plist = tuple(sorted(p.upper().replace('"', "") if p.upper().startswith("TZID=")
                                 else p.upper() for p in params.split(";") if p))
            res.add((name, plist, value))
        return res
    n_in, n_out = norm(in_lines), norm(out_lines)
    lost = sorted(n_in - n_out)
    added = sorted(n_out - n_in)
    c.info("redundant quotes around a parameter value that needs none (TZID=\"Europe/Paris\") "
           "are removed; quotes needed for ':' ';' ',' are kept: %s" % [
               ln for ln in out_lines if ln.startswith("X-QUOTED")])
    c.info("repeated ATTENDEE / CATEGORIES order in output: %s" % [
        ln[:40] for ln in out_lines if ln.startswith(("ATTENDEE", "CATEGORIES"))])
    c.check("ics/semantic-content-preserved", not [x for x in lost if x[0] != "SUMMARY-BEFORE-VERSION"],
            "after upper-casing names and parameter names: %d input lines not found in the "
            "output (junk calendar-level property excluded), %d lines added by the server"
            % (len([x for x in lost if x[0] != "SUMMARY-BEFORE-VERSION"]), len(added)))
    if lost:
        c.info("lost: %s" % [(x[0], x[1], x[2][:30]) for x in lost][:6])
    if added:
        c.info("added: %s" % [(x[0], x[1], x[2][:30]) for x in added][:6])

    # folding
    phys = [ln for ln in out_text.split("\r\n")]
    max_chars = max(len(ln) for ln in phys)
    max_octets = max(len(ln.encode()) for ln in phys)
    folded = [i for i, ln in enumerate(phys) if ln.startswith(" ")]
    first_len = {}
    for i, ln in enumerate(phys):
        if ln.startswith("COMMENT:") or ln.startswith("LOCATION:"):
            first_len[ln.split(":")[0]] = (len(ln), len(ln.encode()))
    c.info("folding: longest physical line %d chars / %d octets; continuation lines: %d; "
           "first physical line of long properties (chars, octets): %s"
           % (max_chars, max_octets, len(folded), first_len))
    cont_lens = [(len(ln), len(ln.encode())) for ln in phys if ln.startswith(" ")]
    c.info("continuation lines (chars, octets) sample: %s" % cont_lens[:5])
    c.check("ics/folds-at-75-octets-without-splitting-characters",
            max_octets <= 75 and first_len.get("COMMENT", (0, 0))[0]
            < first_len.get("COMMENT", (0, 0))[1],
            "longest physical line %d chars / %d octets (multi-byte lines hold fewer "
            "characters): this vobject version folds by OCTETS, not by characters"
            % (max_chars, max_octets))
    # no multi-byte character split
    try:
        out_text.encode("utf-8").decode("utf-8")
        split_ok = True
    except UnicodeError:
        split_ok = False
    c.check("ics/folding-never-splits-a-character", split_ok, "output decodes as UTF-8")
    unfolded_comment = [ln for ln in unfold(out_text) if ln.startswith("COMMENT:")]
    c.check("ics/long-multibyte-value-survives-unfold",
            unfolded_comment == ["COMMENT:" + LONG_UTF8], "COMMENT value identical after unfolding")

    # etag
    put_etag = put.headers.get("etag")
    get_etag = get.headers.get("etag")
    pf = inst.req("PROPFIND", "/alice/cal-a/", "alice",
                  '<?xml version="1.0"?><D:propfind %s><D:prop><D:getetag/></D:prop>'
                  '</D:propfind>' % NS, dict(XML_HDR, Depth="1"))
    pf_etag = multistatus_etags(pf.body).get("/alice/cal-a/crafted.ics")
    c.check("ics/etag-put-equals-get-equals-propfind",
            put_etag is not None and put_etag == get_etag == pf_etag,
            "PUT %s GET %s PROPFIND %s" % (put_etag, get_etag, pf_etag))
    put_again = inst.req("PUT", "/alice/cal-a/crafted.ics", "alice", out_text.encode(),
                         {"Content-Type": "text/calendar"})
    get_again = inst.req("GET", "/alice/cal-a/crafted.ics", "alice")
    c.check("ics/reput-of-served-text-is-idempotent",
            get_again.body == raw and get_again.headers.get("etag") == get_etag,
            "PUT of the served text -> %d; GET bytes identical %s, etag identical %s"
            % (put_again.status, get_again.body == raw,
               get_again.headers.get("etag") == get_etag))

    # REPORTs
    q = ('<?xml version="1.0"?><C:calendar-query %s><D:prop><D:getetag/><C:calendar-data/>'
         '</D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter>'
         '</C:calendar-query>' % NS)
    rq = inst.req("REPORT", "/alice/cal-a/", "alice", q, dict(XML_HDR, Depth="1"))
    mg = ('<?xml version="1.0"?><C:calendar-multiget %s><D:prop><D:getetag/><C:calendar-data/>'
          '</D:prop><D:href>/alice/cal-a/crafted.ics</D:href></C:calendar-multiget>' % NS)
    rm = inst.req("REPORT", "/alice/cal-a/", "alice", mg, dict(XML_HDR, Depth="1"))
    for label, rr in (("calendar-query", rq), ("calendar-multiget", rm)):
        data = multistatus_data(rr.body, C + "calendar-data")
        txt = data.get("/alice/cal-a/crafted.ics")
        etags = multistatus_etags(rr.body)
        raw_has_cr_entity = b"&#13;" in rr.body
        eq_exact = txt == out_text
        eq_norm = txt is not None and txt.replace("\r\n", "\n") == out_text.replace("\r\n", "\n")
        c.check("report/%s-text-equals-GET-text" % label, eq_norm and etags.get(
            "/alice/cal-a/crafted.ics") == get_etag,
            "REPORT %d; calendar-data == GET after CRLF->LF normalisation: %s; byte-exact "
            "after XML parsing: %s; raw XML carries &#13; for CR: %s; etag equal: %s"
            % (rr.status, eq_norm, eq_exact, raw_has_cr_entity,
               etags.get("/alice/cal-a/crafted.ics") == get_etag))

    # rejected inputs
    for label, body in (
            ("no-UID", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\n"
                       "DTSTART:20260601T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"),
            ("two-UIDs-in-one-item", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\n"
             "BEGIN:VEVENT\r\nUID:a1\r\nDTSTART:20260601T100000Z\r\nEND:VEVENT\r\n"
             "BEGIN:VEVENT\r\nUID:a2\r\nDTSTART:20260601T100000Z\r\nEND:VEVENT\r\n"
             "END:VCALENDAR\r\n"),
            ("garbage", "this is not iCalendar\r\n"),
            ("empty", "")):
        r = inst.req("PUT", "/alice/cal-a/rej-%s.ics" % label, "alice", body.encode(),
                     {"Content-Type": "text/calendar"})
        c.info("PUT %s -> %d" % (label, r.status))

    # ------------------------------------------------------------------ vCard
    putv = inst.req("PUT", "/alice/book-a/crafted.vcf", "alice", VCF_CRAFTED.encode(),
                    {"Content-Type": "text/vcard; charset=utf-8"})
    getv = inst.req("GET", "/alice/book-a/crafted.vcf", "alice")
    vtext = getv.body.decode("utf-8")
    c.check("vcf3/put-get", putv.status == 201 and getv.status == 200,
            "PUT -> %d, GET -> %d, content-type %s" % (putv.status, getv.status,
                                                       getv.headers.get("content-type")))
    vin = [ln for ln in unfold(VCF_CRAFTED) if ln]
    vout = [ln for ln in unfold(vtext) if ln]
    c.info("vCard property order  input: %s" % [re.split(r"[;:]", ln, maxsplit=1)[0] for ln in vin])
    c.info("vCard property order output: %s" % [re.split(r"[;:]", ln, maxsplit=1)[0] for ln in vout])
    c.info("grouped property lines in output: %s" % [ln[:50] for ln in vout if "." in ln.split(":")[0].split(";")[0]])
    c.info("lower-case 'email' and 'type' params in output: %s" % [ln for ln in vout if ln.lower().startswith("email")])
    photo_in = [ln for ln in unfold(VCF_CRAFTED) if ln.startswith("PHOTO")][0]
    photo_out = [ln for ln in vout if ln.startswith("PHOTO")]
    c.check("vcf3/photo-value-preserved", photo_out and photo_out[0].split(":", 1)[1] ==
            photo_in.split(":", 1)[1],
            "PHOTO base64 payload identical after unfolding: %s; physical PHOTO lines %d"
            % (bool(photo_out) and photo_out[0].split(":", 1)[1] == photo_in.split(":", 1)[1],
               len([ln for ln in vtext.split("\r\n") if ln.startswith("PHOTO") or
                    (ln.startswith(" ") and "QUJD" in ln)])))
    nv_in, nv_out = norm(vin), norm(vout)
    c.info("vCard lines lost: %s; added: %s" % (
        [(x[0], x[1], x[2][:20]) for x in sorted(nv_in - nv_out)][:6],
        [(x[0], x[1], x[2][:20]) for x in sorted(nv_out - nv_in)][:6]))
    putg = inst.req("PUT", "/alice/book-a/group.vcf", "alice", VCF4_GROUP.encode(),
                    {"Content-Type": "text/vcard; charset=utf-8"})
    getg = inst.req("GET", "/alice/book-a/group.vcf", "alice")
    c.check("vcf4/kind-group-roundtrip",
            putg.status == 201 and b"KIND:group" in getg.body and b"VERSION:4.0" in getg.body,
            "PUT -> %d; GET keeps VERSION:4.0 and KIND:group, MEMBER kept: %s"
            % (putg.status, b"MEMBER:urn:uuid" in getg.body))
    mgv = ('<?xml version="1.0"?><CR:addressbook-multiget %s><D:prop><D:getetag/>'
           '<CR:address-data/></D:prop><D:href>/alice/book-a/crafted.vcf</D:href>'
           '</CR:addressbook-multiget>' % NS)
    rv = inst.req("REPORT", "/alice/book-a/", "alice", mgv, dict(XML_HDR, Depth="1"))
    vt = multistatus_data(rv.body, CR + "address-data").get("/alice/book-a/crafted.vcf")
    c.check("report/addressbook-multiget-text-equals-GET-text",
            vt is not None and vt.replace("\r\n", "\n") == vtext.replace("\r\n", "\n"),
            "REPORT %d; address-data == GET after CRLF->LF normalisation: %s"
            % (rv.status, vt is not None and vt.replace("\r\n", "\n") == vtext.replace("\r\n", "\n")))
    inst.stop()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
