#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""S15: read-only inventory of an existing Radicale data set (aggregates only).

Usage:
    s15_inventory.py --collections DIR [--rights FILE] [--users FILE] [--detail OUT.md]

DIR is an extracted copy of Radicale's ``collections/collection-root`` (never a
live directory; this script only reads). The stdout summary contains counts and
sizes only: no collection names, logins, item content or hostnames. The
optional --detail file is a more detailed report that may name collections; keep
it outside the repository.
"""
import argparse
import configparser
import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker  # noqa: E402

COLL_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._@~+-]{0,127}$")
LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")
RESERVED = {"root", "admin", "administrator", "radicale", "radui", "ui", "api", "web",
            "sharing", "token", "anonymous", "nobody", "system"}


def char_classes(name):
    cls = set()
    for ch in name:
        if "a" <= ch <= "z":
            cls.add("ascii-lower")
        elif "A" <= ch <= "Z":
            cls.add("ascii-upper")
        elif "0" <= ch <= "9":
            cls.add("digit")
        elif ch in "._-@~+":
            cls.add("allowed-punct(%s)" % ch)
        elif ch == " ":
            cls.add("space")
        elif ord(ch) > 127:
            cls.add("non-ascii")
        else:
            cls.add("other-ascii-punct")
    return cls


def unfold(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out = []
    for ln in text.split("\n"):
        if ln[:1] in (" ", "\t") and out:
            out[-1] += ln[1:]
        else:
            out.append(ln)
    return out


def prop_name(line):
    return re.split(r"[;:]", line, maxsplit=1)[0].upper()


def prodid_family(p):
    p = p.lower()
    for key, fam in (("apple", "apple"), ("google", "google"), ("mozilla", "mozilla"),
                     ("thunderbird", "mozilla"), ("ical4j", "ical4j"),
                     ("davx", "ical4j"), ("microsoft", "microsoft"),
                     ("outlook", "microsoft"), ("radicale", "radicale"),
                     ("python", "script"), ("vobject", "script")):
        if key in p:
            return fam
    return "other"


def walk(lines):
    """Yield (component-path tuple, line) for every property line."""
    stack = []
    for ln in lines:
        if ln.startswith("BEGIN:"):
            stack.append(ln[6:])
        elif ln.startswith("END:"):
            if stack:
                stack.pop()
        else:
            yield tuple(stack), ln


def x_family(n):
    for pre, fam in (("X-APPLE", "X-APPLE*"), ("X-WR", "X-WR*"), ("X-MOZ", "X-MOZ*"),
                     ("X-MICROSOFT", "X-MICROSOFT*"), ("X-MS", "X-MS*"),
                     ("X-GOOGLE", "X-GOOGLE*"), ("X-ABLABEL", "X-ABLabel"),
                     ("X-AB", "X-AB*"), ("X-ADDRESSBOOKSERVER", "X-ADDRESSBOOKSERVER*")):
        if n.startswith(pre):
            return fam
    return "X-(other)"


SCHED = ("VEVENT", "VTODO", "VJOURNAL")


def analyse_ics(lines, stats, text, size):
    props = list(walk(lines))
    comps = []
    depth = 0
    for ln in lines:
        if ln.startswith("BEGIN:"):
            if depth == 1:
                comps.append(ln[6:])
            depth += 1
        elif ln.startswith("END:"):
            depth -= 1
    stats["component-sets"]["+".join(sorted(set(comps))) or "(none)"] += 1
    stats["with-VTIMEZONE"] += "VTIMEZONE" in comps
    main = [(path, ln) for path, ln in props if path and path[-1] in SCHED]
    names = {prop_name(ln) for _, ln in main}
    rr = [ln for _, ln in main if prop_name(ln) == "RRULE"]
    if rr:
        stats["with-RRULE"] += 1
        for r in rr:
            m = re.search(r"FREQ=(\w+)", r)
            stats["rrule-freq"][m.group(1) if m else "?"] += 1
            for opt in ("BYSETPOS", "BYDAY", "BYMONTHDAY", "BYMONTH", "COUNT", "UNTIL", "INTERVAL"):
                if opt + "=" in r:
                    stats["rrule-has-" + opt] += 1
            if re.search(r"BYDAY=[^;]*[+-]?\d[A-Z]{2}", r):
                stats["rrule-ordinal-BYDAY"] += 1
    for nm, label in (("RDATE", "with-RDATE"), ("EXDATE", "with-EXDATE"),
                      ("RECURRENCE-ID", "with-RECURRENCE-ID"),
                      ("ATTENDEE", "with-ATTENDEE"), ("ORGANIZER", "with-ORGANIZER"),
                      ("ATTACH", "with-ATTACH"), ("GEO", "with-GEO"),
                      ("SEQUENCE", "with-SEQUENCE"), ("CATEGORIES", "with-CATEGORIES"),
                      ("RELATED-TO", "with-RELATED-TO"), ("STATUS", "with-STATUS"),
                      ("PRIORITY", "with-PRIORITY"), ("DUE", "with-DUE"),
                      ("PERCENT-COMPLETE", "with-PERCENT-COMPLETE"),
                      ("RECURRENCE-ID", "with-override-instances")):
        if nm in names:
            stats[label] += 1
    if any(path and path[-1] == "VALARM" for path, _ in props):
        stats["with-VALARM"] += 1
    xn = {prop_name(ln) for path, ln in props if prop_name(ln).startswith("X-")
          and path and path[-1] in SCHED + ("VALARM",)}
    if xn:
        stats["with-X-properties"] += 1
    stats["x-property-names"].update(xn)
    for f in {x_family(n) for n in xn}:
        stats["x-property-families"][f] += 1
    uids = {ln.split(":", 1)[1] for path, ln in main if prop_name(ln) == "UID" and ":" in ln}
    stats["distinct-UIDs-per-item"][len(uids)] += 1
    # time forms on scheduling components only (VTIMEZONE rules excluded)
    for _, ln in main:
        if prop_name(ln) in ("DTSTART", "DTEND", "DUE"):
            head, _, val = ln.partition(":")
            if "VALUE=DATE" in head.upper() and "DATE-TIME" not in head.upper():
                stats["time-form"]["all-day (VALUE=DATE)"] += 1
            elif "TZID=" in head.upper():
                stats["time-form"]["TZID"] += 1
                m = re.search(r'TZID="?([^";:]+)"?', head, re.I)
                if m:
                    tz = m.group(1)
                    stats["tzid-style"]["IANA-like (Area/City)" if re.match(
                        r"^[A-Za-z_]+(/[A-Za-z_+-]+)+$", tz) else "other (non-IANA)"] += 1
                    if re.search(r'TZID="', head):
                        stats["tzid-quoted"] += 1
            elif val.endswith("Z"):
                stats["time-form"]["UTC (Z)"] += 1
            else:
                stats["time-form"]["floating"] += 1
    stats["tzids-defined-distinct"].update(
        {ln.split(":", 1)[1] for path, ln in props
         if path and path[-1] == "VTIMEZONE" and ln.startswith("TZID:")})
    tz_used = {m.group(1) for _, ln in main for m in [re.search(r'TZID="?([^";:]+)', ln)] if m}
    defined = {ln.split(":", 1)[1] for path, ln in props
               if path and path[-1] == "VTIMEZONE" and ln.startswith("TZID:")}
    if tz_used and not tz_used <= defined:
        stats["items-using-a-TZID-without-embedded-VTIMEZONE"] += 1
    for ln in lines:
        if ln.startswith("PRODID"):
            stats["prodid-family"][prodid_family(ln)] += 1
            break
    for ph in text.replace("\r\n", "\n").split("\n"):
        if len(ph.encode("utf-8")) > 75:
            stats["items-with-physical-line-over-75-octets"] += 1
            break
    stats["line-endings"]["CRLF" if "\r\n" in text else "LF-only"] += 1


def analyse_vcf(lines, stats, text, size):
    ver = next((ln.split(":", 1)[1].strip() for ln in lines if ln.upper().startswith("VERSION:")),
               "none")
    stats["vcard-version"][ver] += 1
    names = [ln.split(":", 1)[0] for ln in lines if ":" in ln]
    grouped = [n for n in names if re.match(r"^[A-Za-z0-9-]+\.", n)]
    if grouped:
        stats["with-grouped-properties"] += 1
        stats["grouped-property-lines"] += len(grouped)
    if any(re.match(r"^KIND:group", ln, re.I) or ln.upper().startswith("X-ADDRESSBOOKSERVER-KIND:GROUP")
           for ln in lines):
        stats["group-cards (KIND:group)"] += 1
    if any(ln.upper().startswith(("MEMBER", "X-ADDRESSBOOKSERVER-MEMBER")) for ln in lines):
        stats["with-MEMBER"] += 1
    photo = [ln for ln in lines if prop_name(ln).split(".")[-1] == "PHOTO"]
    if photo:
        stats["with-PHOTO"] += 1
        stats["photo-sizes"].append(len(photo[0]))
        if re.search(r"VALUE=URI|PHOTO:http", photo[0], re.I):
            stats["photo-as-URI"] += 1
    for nm, label in (("BDAY", "with-BDAY"), ("NICKNAME", "with-NICKNAME"),
                      ("ORG", "with-ORG"), ("ADR", "with-ADR"), ("URL", "with-URL"),
                      ("NOTE", "with-NOTE"), ("REV", "with-REV"), ("CATEGORIES", "with-CATEGORIES")):
        if any(prop_name(ln).split(".")[-1] == nm for ln in lines):
            stats[label] += 1
    xn = [prop_name(ln).split(".")[-1] for ln in lines if prop_name(ln).split(".")[-1].startswith("X-")]
    if xn:
        stats["with-X-properties"] += 1
    stats["x-property-names"].update(set(xn))
    for f in {x_family(n) for n in xn}:
        stats["x-property-families"][f] += 1
    uids = {ln.split(":", 1)[1] for ln in lines if ln.upper().startswith("UID:")}
    stats["distinct-UIDs-per-item"][len(uids)] += 1
    stats["line-endings"]["CRLF" if "\r\n" in text else "LF-only"] += 1


def new_stats():
    return {k: Counter() for k in ("component-sets", "rrule-freq", "time-form", "tzid-style",
                                   "prodid-family", "x-property-names", "x-property-families",
                                   "tzids-defined-distinct", "distinct-UIDs-per-item", "vcard-version", "line-endings")} | {
        "photo-sizes": []}


class Stats(dict):
    def __missing__(self, key):
        self[key] = 0
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collections", required=True)
    ap.add_argument("--rights")
    ap.add_argument("--users")
    ap.add_argument("--detail")
    a = ap.parse_args()
    root = a.collections
    detail = []

    ics = Stats(new_stats())
    vcf = Stats(new_stats())
    coll_types = Counter()
    coll_items = []
    sizes = []
    name_rows = Counter()
    name_classes = Counter()
    principal_rows = Counter()
    bad_names = []
    non_utf8 = 0
    unknown_ext = 0
    uid_filename_mismatch = 0
    props_keys = Counter()
    n_items = 0
    total_bytes = 0

    principals = sorted(d for d in os.listdir(root) if not d.startswith("."))
    for p in principals:
        principal_rows["principal directories"] += 1
        principal_rows["match login whitelist"] += bool(LOGIN_RE.match(p))
        principal_rows["collide with reserved logins"] += p in RESERVED
        principal_rows["start with 'radui-'"] += p.startswith("radui-")
        pdir = os.path.join(root, p)
        for cname in sorted(os.listdir(pdir)):
            if cname.startswith("."):
                continue
            cdir = os.path.join(pdir, cname)
            if not os.path.isdir(cdir):
                principal_rows["non-directory entries in a principal"] += 1
                continue
            name_rows["collections"] += 1
            ok = bool(COLL_RE.match(cname))
            name_rows["match planned collection-name whitelist"] += ok
            name_rows["do NOT match"] += (not ok)
            for cl in char_classes(cname):
                name_classes[cl] += 1
            if not ok:
                bad_names.append(cname)
            try:
                with open(os.path.join(cdir, ".Radicale.props")) as fh:
                    props = json.load(fh)
            except (OSError, ValueError):
                props = {}
            for k in props:
                props_keys[k.split("}")[-1] if k.startswith("{") else k] += 1
            tag = props.get("tag", "(none)")
            if tag == "VCALENDAR":
                comp = props.get("C:supported-calendar-component-set")
                kind = "calendar (component set: %s)" % (comp if comp else "unrestricted")
            elif tag == "VADDRESSBOOK":
                kind = "address book"
            else:
                kind = "other/untyped"
            coll_types[kind] += 1
            files = [f for f in os.listdir(cdir) if not f.startswith(".")]
            coll_items.append((p, cname, kind, len(files)))
            for f in files:
                path = os.path.join(cdir, f)
                size = os.path.getsize(path)
                sizes.append(size)
                n_items += 1
                total_bytes += size
                ext = os.path.splitext(f)[1].lower()
                if ext not in (".ics", ".vcf"):
                    unknown_ext += 1
                with open(path, "rb") as fh:
                    raw = fh.read()
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    non_utf8 += 1
                    continue
                lines = [ln for ln in unfold(text) if ln]
                if tag == "VADDRESSBOOK" or ext == ".vcf":
                    analyse_vcf(lines, vcf, text, size)
                    uid = next((ln.split(":", 1)[1] for ln in lines
                                if ln.upper().startswith("UID:")), None)
                else:
                    analyse_ics(lines, ics, text, size)
                    uid = next((ln.split(":", 1)[1] for ln in lines
                                if ln.startswith("UID:")), None)
                if uid is not None and os.path.splitext(f)[0] != uid:
                    uid_filename_mismatch += 1

    def show(title, mapping):
        print("\n### %s" % title)
        for k, v in sorted(mapping.items(), key=lambda kv: (-kv[1] if isinstance(kv[1], int)
                                                           else 0, str(kv[0]))):
            print("- %s: %s" % (k, v))

    print("# S15 inventory (aggregates only)")
    show("principals", principal_rows)
    show("collections by type", coll_types)
    show("collection names against the planned whitelist", name_rows)
    show("character classes present in collection names (collections using each)", name_classes)
    print("\n### items")
    print("- items: %d, total %d bytes, largest %s bytes, median %d bytes" % (
        n_items, total_bytes, sorted(sizes, reverse=True)[:5],
        sorted(sizes)[len(sizes) // 2] if sizes else 0))
    print("- collections by item count (sorted): %s" % sorted((c[3] for c in coll_items),
                                                            reverse=True))
    print("- non-UTF-8 items: %d; files with an extension other than .ics/.vcf: %d; "
          "items whose file name differs from UID(+ext): %d" % (non_utf8, unknown_ext,
                                                               uid_filename_mismatch))
    print("- collection property keys in use: %s" % dict(props_keys))
    for title, st in (("iCalendar items", ics), ("vCard items", vcf)):
        print("\n### %s" % title)
        for k in sorted(st):
            v = st[k]
            if not v:
                continue
            if isinstance(v, Counter):
                if k in ("x-property-names", "tzids-defined-distinct"):
                    print("- %s: %d distinct" % (k, len(v)))
                else:
                    print("- %s: %s" % (k, dict(v)))
            elif k == "photo-sizes":
                if v:
                    print("- PHOTO value length (chars): count %d, largest %s" % (
                        len(v), sorted(v, reverse=True)[:3]))
            else:
                print("- %s: %s" % (k, v))

    # rights file structure, described abstractly
    if a.rights and os.path.exists(a.rights):
        cp = configparser.ConfigParser()
        cp.read(a.rights)
        letters = Counter()
        ukinds = Counter()
        ckinds = Counter()
        for s in cp.sections():
            perms = cp.get(s, "permissions", fallback="")
            for ch in perms:
                letters[ch] += 1
            u = cp.get(s, "user", fallback="")
            col = cp.get(s, "collection", fallback="")
            ukinds["any authenticated (.+)" if u == ".+" else "anybody (.*)" if u == ".*"
                   else "empty/anonymous" if u in ("", "^$") else
                   "literal login" if re.fullmatch(r"\^?[\w.-]+\$?", u) else "other regex"] += 1
            if col in ("", "^$"):
                ckinds["root (empty path)"] += 1
            elif "{user}" in col:
                ckinds["uses {user} template"] += 1
            elif re.fullmatch(r"\^?[\w.-]+\$?", col):
                ckinds["one literal principal"] += 1
            elif re.fullmatch(r"\^?[\w.-]+/[\w.-]+\$?", col):
                ckinds["one literal collection"] += 1
            else:
                ckinds["regex"] += 1
        print("\n### rights file structure")
        print("- sections: %d" % len(cp.sections()))
        print("- sections per letter set: %s" % dict(Counter(
            "".join(sorted(cp.get(s, "permissions", fallback=""))) or "(empty)"
            for s in cp.sections())))
        print("- letters used: %s" % "".join(sorted(letters)))
        print("- user pattern kinds: %s" % dict(ukinds))
        print("- collection pattern kinds: %s" % dict(ckinds))
        print("- groups key used: %s; trailing catch-all deny rule: %s" % (
            any(cp.has_option(s, "groups") for s in cp.sections()),
            bool(cp.sections()) and cp.get(cp.sections()[-1], "permissions", fallback="x") == ""))
    if a.users and os.path.exists(a.users):
        pref = Counter()
        logins = Counter()
        with open(a.users) as fh:
            for line in fh:
                if ":" in line and not line.lstrip().startswith("#"):
                    login, h = line.rstrip("\n").split(":", 1)
                    m = re.match(r"^(\$2[abxy]\$\d\d)\$", h)
                    pref[m.group(1) if m else "other"] += 1
                    logins["accounts"] += 1
                    logins["login matches whitelist"] += bool(LOGIN_RE.match(login))
                    logins["login is reserved"] += login in RESERVED
        print("\n### users file")
        print("- %s; hash prefixes: %s" % (dict(logins), dict(pref)))

    print()
    ck = Checker("S15 live inventory")
    ck.check("collection-names-match-planned-whitelist", not bad_names,
             "%d of %d collection names do not match ^[A-Za-z0-9_][A-Za-z0-9._@~+-]{0,127}$"
             % (len(bad_names), name_rows["collections"]))
    ck.check("principal-names-match-login-rule",
             principal_rows["match login whitelist"] == principal_rows["principal directories"],
             "%d of %d principal directories match the login rule"
             % (principal_rows["match login whitelist"], principal_rows["principal directories"]))
    ck.check("all-items-utf8-and-single-uid", non_utf8 == 0 and set(
        list(ics["distinct-UIDs-per-item"]) + list(vcf["distinct-UIDs-per-item"])) <= {1},
        "non-UTF-8 items: %d; every item carries exactly one UID: %s" % (non_utf8, set(
            list(ics["distinct-UIDs-per-item"]) + list(vcf["distinct-UIDs-per-item"])) <= {1}))
    rc = ck.finish()

    if a.detail:
        with open(a.detail, "w") as fh:
            fh.write("# S15 detail (contains names; keep outside the repository)\n\n")
            fh.write("## collections\n")
            for p, c, kind, n in coll_items:
                fh.write("- %s/%s: %s, %d items\n" % (p, c, kind, n))
            fh.write("\n## collection names not matching the whitelist\n")
            for n in bad_names:
                fh.write("- %r\n" % n)
            fh.write("\n## principals\n")
            for p in principals:
                fh.write("- %s\n" % p)
            fh.write("\n## x-property names (iCalendar)\n%s\n" % dict(ics["x-property-names"]))
            fh.write("\n## x-property names (vCard)\n%s\n" % dict(vcf["x-property-names"]))
            fh.write("\n## tzids\n%s\n" % dict(ics["tzids-defined-distinct"]))
        try:
            os.chmod(a.detail, 0o600)
        except OSError:
            pass
    return rc


if __name__ == "__main__":
    sys.exit(main())
