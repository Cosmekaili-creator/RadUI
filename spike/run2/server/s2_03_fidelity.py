#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S2-3 (extended): what GET returns versus what was PUT, per vCard shape.

Every case is PUT as a card of its own and read back. The comparison level is
one of byte-identical, same-lines (differs only by folding), reordered (same
logical lines, other order), semantic (equal after normalising case, parameter
order and TYPE merging), different (a value or a property was changed, added or
lost). The cases that are not byte-identical list the differences: they are the
ones a RadUI 'write verification' (compare a normalised projection) must
tolerate. Anything 'different' would be a silent data change by the server.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (Checker, standard_stack, require_memory, compare_cards,  # noqa: E402
                    short, VCF, fold, same_name_order_stable, name_order)

LONG_NOTE = "NOTE:" + " ".join("word%03d" % i for i in range(40))
# (name, version, extra lines, "what it exercises")
CASES = [
    ("categories-escaped-comma", "4.0",
     ["CATEGORIES:Family\\,Friends,Work"], "K: one category contains a comma"),
    ("categories-escaped-comma-3.0", "3.0",
     ["CATEGORIES:Family\\,Friends,Work"], ""),
    ("categories-repeated-property", "4.0",
     ["CATEGORIES:Family", "CATEGORIES:Work"], ""),
    ("ablabel-new-item-group", "3.0",
     ["item1.EMAIL;type=INTERNET:jane@example.org",
      "item1.X-ABLabel:Side project", "item2.URL:https://example.org/jane",
      "item2.X-ABLabel:_$!<HomePage>!$_"], "new itemN groups with labels"),
    ("ablabel-group-names-mixed-case", "3.0",
     ["Item1.TEL;type=VOICE:+15550100", "Item1.X-ABLabel:Desk"], ""),
    ("bday-year-4.0", "4.0", ["BDAY:19840412"], ""),
    ("bday-yearless-4.0", "4.0", ["BDAY:--0412"], "RFC 6350 year-less date"),
    ("bday-text-4.0", "4.0", ["BDAY;VALUE=text:circa 1800"], "text-valued"),
    ("bday-yearless-3.0-apple", "3.0",
     ["BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-12"], "Apple convention"),
    ("bday-yearless-3.0-dashes", "3.0", ["BDAY:--0412"], "RFC 6350 form in 3.0"),
    ("bday-text-3.0", "3.0", ["BDAY;VALUE=text:circa 1800"], ""),
    ("bday-extended-3.0", "3.0", ["BDAY:1984-04-12"], ""),
    ("anniversary-4.0", "4.0", ["ANNIVERSARY:20010506"], ""),
    ("anniversary-yearless-4.0", "4.0", ["ANNIVERSARY:--0506"], ""),
    ("anniversary-x-abdate-3.0", "3.0",
     ["item1.X-ABDATE;type=pref:2001-05-06",
      "item1.X-ABLabel:_$!<Anniversary>!$_"], "Apple anniversary"),
    ("anniversary-x-anniversary-3.0", "3.0", ["X-ANNIVERSARY:2001-05-06"], ""),
    ("adr-commas-semicolons", "3.0",
     ["ADR;TYPE=home:;;12 Main St\\, Apt 4;Springfield\\; East;;12345;Exampleland"],
     "escaped comma and semicolon in components"),
    ("adr-multivalue-4.0", "4.0",
     ["ADR;TYPE=home:;;Main St,Second St;Springfield;;12345;Exampleland"],
     "unescaped commas = multi-valued component"),
    ("n-commas-semicolons", "3.0", [], "N override below"),
    ("org-commas-semicolons", "3.0",
     ["ORG:Example\\, Inc.;Dept\\; A;Team"], ""),
    ("org-commas-semicolons-4.0", "4.0",
     ["ORG:Example\\, Inc.;Dept\\; A;Team"], ""),
    ("type-comma-list", "3.0", ["TEL;TYPE=work,voice:+15550101"], "TYPE=a,b"),
    ("type-repeated", "3.0", ["TEL;TYPE=work;TYPE=voice:+15550101"],
     "repeated TYPE="),
    ("type-comma-list-4.0", "4.0", ['TEL;TYPE="work,voice":+15550101'], ""),
    ("type-repeated-4.0", "4.0", ["TEL;TYPE=work;TYPE=voice:+15550101"], ""),
    ("type-lowercase-vs-uppercase", "3.0",
     ["TEL;type=CELL:+15550102", "EMAIL;TYPE=internet,HOME:jane@example.org"],
     "case of TYPE tokens and parameter names"),
    ("pref-4.0-two-rows", "4.0",
     ["TEL;PREF=1;TYPE=cell:+15550103", "TEL;PREF=2;TYPE=work:+15550104"],
     "PREF=1 and PREF=2"),
    ("pref-3.0-two-type-pref", "3.0",
     ["TEL;TYPE=CELL,pref:+15550103", "TEL;TYPE=WORK,pref:+15550104"],
     "two rows marked TYPE=pref"),
    ("tel-value-uri-4.0", "4.0", ["TEL;VALUE=uri;TYPE=cell:tel:+15550105"], ""),
    ("tel-value-uri-3.0", "3.0", ["TEL;VALUE=uri:tel:+15550105"], ""),
    ("nickname-multi-4.0", "4.0", ["NICKNAME:Jay,Janie"], "K3"),
    ("nickname-multi-3.0", "3.0", ["NICKNAME:Jay,Janie"], "K3"),
    ("nickname-escaped-comma-4.0", "4.0", ["NICKNAME:Jay\\,Janie"],
     "one nickname that contains a comma"),
    ("nickname-single-3.0", "3.0", ["NICKNAME:Jay"], ""),
    ("n-multivalue-given-4.0", "4.0", [], "N override below: Jane,Mary"),
    ("categories-many", "3.0", ["CATEGORIES:a,b,c,d"], ""),
    ("tel-rows-order-3", "3.0",
     ["TEL;TYPE=HOME:+15550111", "EMAIL:a@example.org", "TEL;TYPE=WORK:+15550112",
      "EMAIL:b@example.org", "TEL;TYPE=CELL:+15550113"],
     "relative order of same-name rows"),
    ("long-note-folding", "3.0", [fold(LONG_NOTE)], "folded input"),
    ("long-note-unfolded-input", "3.0", [LONG_NOTE], "one 330-character line"),
    ("note-escapes", "3.0", ["NOTE:line one\\nline two\\, with comma\\; semi"], ""),
    ("unicode-values", "4.0",
     ["NOTE:café über 中文 \U0001f600", "NICKNAME:Élodie"], ""),
    ("x-properties", "3.0",
     ["X-CUSTOM-FIELD;X-PARAM=Value:some value", "X-ABRELATEDNAMES;type=pref:Pat Doe"], ""),
    ("property-order-unusual", "3.0",
     ["TEL:+15550106", "EMAIL:jane@example.org", "ORG:Example", "TITLE:Chief"],
     "order of properties as sent"),
]


def build(name, version, extra):
    lines = ["BEGIN:VCARD", "VERSION:" + version, "UID:fid-%s" % name,
             "FN:Jane Doe"]
    if name == "n-multivalue-given-4.0":
        lines.append("N:Doe;Jane,Mary;;;")
    elif name.startswith("n-commas"):
        lines.append("N:Doe\\, Jr;Jane;Mary\\,Ann;Dr.;III\\; Esq")
    else:
        lines.append("N:Doe;Jane;;;")
    lines += extra
    return "\r\n".join(lines) + "\r\nEND:VCARD\r\n"


def main():
    require_memory()
    c = Checker("S2-3 fidelity per vCard shape")
    s = standard_stack("s203")
    tolerate, unstable, reorder_rows = [], [], []
    try:
        for name, version, extra, what in CASES:
            text = build(name, version, extra)
            path = "/alice/contacts/%s.vcf" % name
            p = s.req("PUT", path, "alice", text, VCF)
            if p.status != 201:
                c.expect("%s/accepted" % name, False, "PUT -> %d %s"
                         % (p.status, short(p.body)))
                continue
            g = s.req("GET", path, "alice")
            level, det = compare_cards(text, g.body.decode())
            ok = level != "different"
            c.expect("%s" % name, ok,
                     "%s; level %s%s" % (
                         what or "-", level,
                         ("; " + short(" | ".join(det), 400)) if det else ""))
            # a second PUT of the GET result must be stable (idempotent)
            p2 = s.req("PUT", path, "alice", g.body, dict(VCF, **{
                "If-Match": g.headers["etag"]}))
            g2 = s.req("GET", path, "alice")
            if g2.body != g.body:
                unstable.append(name)
            if level != "different" and not same_name_order_stable(
                    text, g.body.decode()):
                reorder_rows.append(name)
            if level != "byte-identical":
                tolerate.append((name, level))
        c.expect("all/second-roundtrip-stable", not unstable,
                 "re-PUT of the GET text then GET returns the same bytes for "
                 "every case; unstable: %s" % unstable)
        c.expect("all/same-name-rows-keep-order", not reorder_rows,
                 "rows of one property name (TEL, EMAIL, ...) keep their "
                 "relative order in every case; reordered: %s" % reorder_rows)
        sample = s.req("GET", "/alice/contacts/property-order-unusual.vcf",
                       "alice").body.decode()
        c.info("order/server-order-of-properties",
               "sent TEL,EMAIL,ORG,TITLE after FN,N; GET order %s (VERSION, "
               "PRODID, UID first, then alphabetical, stable per name)"
               % name_order(sample))
        by_level = {}
        for name, level in tolerate:
            by_level.setdefault(level, []).append(name)
        for level in ("same-lines", "reordered", "semantic", "different"):
            if level in by_level:
                c.info("summary/level-%s" % level, "%d cases: %s" % (
                    len(by_level[level]), by_level[level]))
        c.info("summary/byte-identical", "%d of %d cases come back byte for "
               "byte" % (len(CASES) - len(tolerate), len(CASES)))
        # lines the server itself adds or drops, over all cases
        added = dropped = 0
        for name, version, extra, _ in CASES:
            text = build(name, version, extra)
            got = s.req("GET", "/alice/contacts/%s.vcf" % name,
                        "alice").body.decode()
            a, b = set(text.split("\r\n")), set(got.split("\r\n"))
            added += len(b - a)
            dropped += len(a - b)
        c.info("summary/physical-lines", "over all cases: %d physical lines "
               "only in GET, %d only in the sent text (folding)" % (added, dropped))
    finally:
        s.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
