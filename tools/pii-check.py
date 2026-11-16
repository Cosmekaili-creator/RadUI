#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Detect personal data in fixtures and docs (stdlib only).

Generic checks (always run, over tests/fixtures/, tests/golden/ and docs/):
  - e-mail addresses whose domain is not example.* ;
  - phone-like numbers outside the reserved fictional ranges
    (555-01xx, +1-555, +44 20 7946 0xxx);
  - GPS coordinate pairs with more than 2 decimals.

With --snapshot DIR (a local directory holding real .ics/.vcf files, never
committed) a deny-list of words, e-mail addresses and phone
numbers is built from the values found there, and every non-binary, non-vendor
file of the tree is checked against it. Words (>= 5 letters) come only from
name-bearing properties (FN, N, ORG, NICKNAME, ADR, CN parameters, and the capitalised
non-initial words of a SUMMARY, i.e. proper nouns),
minus a stoplist of generic iCalendar/vCard words and common English/French
vocabulary; e-mail addresses and phone numbers come from every value.
A word found on 5 or more lines outside tests/fixtures/ and tests/golden/ counts as
ordinary vocabulary and is ignored there (still reported inside those two directories).
Matches are reported as file:line with the deny-list entry masked, so that no personal
data is printed.
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _treefiles  # noqa: E402

GENERIC_DIRS = ("tests/fixtures/", "tests/golden/", "docs/")
SELF_FILES = {"tools/pii-check.py", "tools/test_pii_check.py", "LICENSE"}

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})")
PHONE_RE = re.compile(r"(?<![\w.+-])(\+?\(?\d[\d ()./-]{6,}\d)(?![\w])")
ISO_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
GPS_RE = re.compile(r"-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}")
WORD_RE = re.compile(r"[^\W\d_]{4,}", re.UNICODE)
SKIP_LINE_RE = re.compile(r"^(UID|PRODID|DTSTAMP|CREATED|LAST-MODIFIED|REV|X-[A-Z-]*UID)\b", re.I)

# Property names whose values are structural, not personal data.
IGNORED_PROPS = {
    "BEGIN", "END", "VERSION", "PRODID", "CALSCALE", "METHOD", "UID", "TZID",
    "TZNAME", "TZOFFSETFROM", "TZOFFSETTO", "TZURL", "DTSTART", "DTEND",
    "DTSTAMP", "CREATED", "LAST-MODIFIED", "REV", "RRULE", "EXDATE", "RDATE",
    "SEQUENCE", "STATUS", "CLASS", "TRANSP", "PRIORITY", "PERCENT-COMPLETE",
    "DUE", "COMPLETED", "TRIGGER", "ACTION", "DURATION", "RECURRENCE-ID",
    "X-WR-TIMEZONE", "X-MICROSOFT-CDO-BUSYSTATUS",
}

STOPLIST = set("""
vcalendar vevent vtodo vjournal vfreebusy vtimezone valarm standard daylight
vcard version prodid calscale gregorian method publish request reply cancel
confirmed tentative cancelled needs-action completed in-process public
private confidential none opaque transparent display audio email action
trigger duration related start end busy free organizer attendee individual
group room resource unknown accepted declined delegated partstat rsvp cutype
role chair req-participant opt-participant non-participant mailto tel home
work voice cell pref internet type value date time date-time text uri binary
utc-offset rrule freq daily weekly monthly yearly secondly minutely hourly
interval count until byday bymonth bymonthday bysetpos wkst tzid tzname
tzoffsetfrom tzoffsetto dtstart dtend dtstamp uid summary description
location status categories class geo created last-modified sequence transp
priority percent-complete due rdate exdate recurrence-id charset utf8
encoding quoted-printable base64 inline attach comment contact resources
related-to url name kind member photo logo sound label adr note org title
role nickname birthday anniversary gender lang fburl caladruri caluri
true false false utc
""".split())

PHONE_FICTIONAL = (
    re.compile(r"^(?:\d{0,3})55501\d\d$"),   # 555-01xx with optional prefix
    re.compile(r"^1555\d*$"),                # +1-555 ...
    re.compile(r"^(?:44|0)?2079460\d{3}$"),  # +44 20 7946 0xxx
)


def phone_digits(raw):
    cleaned = raw.replace("(0)", "")
    return re.sub(r"\D", "", cleaned)


def phone_is_fictional(digits):
    return any(rx.match(digits) for rx in PHONE_FICTIONAL)


def phones_in(line):
    """Yield digit strings of phone-like numbers found in a line."""
    line = ISO_DATE_RE.sub(" ", line)
    for m in PHONE_RE.finditer(line):
        raw = m.group(1)
        digits = phone_digits(raw)
        if len(digits) < 8 or len(digits) > 15:
            continue
        # plain digit runs (timestamps, ids) are not phone numbers; need a
        # leading + or a visible separator
        if not raw.startswith("+") and not re.search(r"[ ()./-]", raw):
            continue
        yield digits


def generic_findings(rel, text):
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        for m in EMAIL_RE.finditer(line):
            dom = m.group(1).lower()
            if not (dom.startswith("example.") or ".example." in dom):
                out.append((rel, n, "e-mail address outside example.*"))
        if not SKIP_LINE_RE.match(line):
            for digits in phones_in(line):
                if not phone_is_fictional(digits):
                    out.append((rel, n, "phone number outside the reserved fictional ranges"))
        if GPS_RE.search(line):
            out.append((rel, n, "GPS coordinates with more than 2 decimals"))
    return out


# ---- deny-list from a local snapshot ---------------------------------------

def unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text)


# Name-bearing properties: only words from these (and from CN parameters) enter the
# word deny-list; e-mail addresses and phone numbers are collected from every value.
NAME_PROPS = {"FN", "N", "ORG", "NICKNAME", "ADR", "SUMMARY"}
MIN_NAME_WORD = 5
CN_RE = re.compile(r'(?:^|;)CN=("[^"]*"|[^;:]*)', re.I)

# Ordinary English / French vocabulary and generic address and organisation words:
# these also occur in real names and summaries but carry no personal information.
COMMON_WORDS = set("""
maintenance
about after again agenda anniversary annual another appointment april april august avenue
before between birthday board booking boulevard breakfast building business
calendar canton centre center chemin christmas church circle clinic closed college company
conference consulting contact country course dentist dinner doctor
easter english evening event events family father february flight france french friday friends
general geneva germany group guest hello holiday home hospital hotel house
important international invoice italy january journey july june
lausanne lesson limited lunch
march meeting member message monday morning mother
november number october office online order other
party payment people phone place planning please private project public
quarter
reminder report request restaurant review route saturday school service services session september
solutions spain station street studio subject summer sunday support switzerland
team thursday ticket today tomorrow training travel tuesday
update vacation wednesday weekend winter women work working yearly
adresse anniversaire apres avant bureau cabinet chemin comite commune conseil dentiste dimanche
dejeuner diner docteur ecole entreprise equipe famille fevrier france garage hopital janvier jeudi
juillet juin lundi maison mardi medecin mercredi novembre octobre ordre pharmacie place
rendez reunion samedi septembre societe suisse travail vacances vendredi voyage
paris london berlin madrid zurich geneve york washington pacific atlantic windows google apple
microsoft installation deployment digits output default status server check codes class calls
alice carol dave erin frank grace heidi ivan judy mallory oscar peggy trent victor walter maria anna
daniel robert andrew charlie jessica ashley nicole caroline cours dragon monkey shadow princess
football youtube amazon samsung iphone orange banana portable
""".split())


def build_denylist(snapshot_dir):
    words, emails, phones = set(), set(), set()
    for dirpath, dirnames, filenames in os.walk(snapshot_dir):
        for fn in filenames:
            if not fn.lower().endswith((".ics", ".vcf")):
                continue
            try:
                with open(os.path.join(dirpath, fn), "rb") as fh:
                    text = unfold(fh.read().decode("utf-8", "replace"))
            except OSError:
                continue
            for line in text.splitlines():
                head, sep, value = line.partition(":")
                if not sep:
                    continue
                prop = head.split(";", 1)[0].strip().upper().rpartition(".")[2]
                if prop in IGNORED_PROPS:
                    continue
                # Parameters may carry addresses and names too (CN=..., EMAIL=...).
                blob = head.split(";", 1)[1] + " " + value if ";" in head else value
                for m in EMAIL_RE.finditer(blob):
                    emails.add(m.group(0).lower())
                for digits in phones_in(blob):
                    phones.add(digits)
                source = ""
                if prop in NAME_PROPS and prop != "SUMMARY":
                    source = value
                for m in CN_RE.finditer(head):
                    source += " " + m.group(1)
                source = source.replace("\\n", " ").replace("\\,", ",")
                candidates = WORD_RE.findall(source)
                if prop == "SUMMARY":
                    # titles are mostly ordinary vocabulary: only capitalised words that do not
                    # start the title (proper nouns: people, places) enter the deny-list
                    value = value.replace("\\n", " ").replace("\\,", ",")
                    candidates += [m.group(0) for m in WORD_RE.finditer(value)
                                   if m.start() > 0 and m.group(0)[:1].isupper()
                                   and value[:m.start()].strip()]
                for w in candidates:
                    lw = w.lower()
                    if len(lw) >= MIN_NAME_WORD and lw not in STOPLIST and lw not in COMMON_WORDS:
                        words.add(lw)
    return words, emails, phones


def snapshot_readable(snapshot_dir):
    """True when the snapshot holds at least one readable .ics/.vcf file and no
    directory of it failed to open."""
    errors = []
    found = False
    for dirpath, _dirs, filenames in os.walk(snapshot_dir, onerror=errors.append):
        for fn in filenames:
            if fn.lower().endswith((".ics", ".vcf")) and os.access(
                    os.path.join(dirpath, fn), os.R_OK):
                found = True
    return found and not errors


def mask(tok):
    return tok[:1] + "*" * 3 + "(%d)" % len(tok)


def denylist_findings(rel, text, words, emails, phones):
    """[(rel, line, message, kind, token)]; kind is 'word', 'email' or 'phone'."""
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        low = line.lower()
        hit = None
        kind = "word"
        for tok in set(WORD_RE.findall(low)) & words:
            hit = tok
            break
        if hit is None:
            for e in emails:
                if e in low:
                    hit, kind = e, "email"
                    break
        if hit is None and phones:
            for digits in phones_in(line):
                if digits in phones:
                    hit, kind = digits, "phone"
                    break
        if hit is not None:
            out.append((rel, n, "deny-list match " + mask(hit), kind, hit))
    return out


# A snapshot word that occurs on this many lines OUTSIDE the fixture-like directories
# is ordinary vocabulary (a title word such as "status"), not a leaked value; it is
# ignored there, but still reported inside tests/fixtures/ and tests/golden/.
VOCABULARY_LINES = 5
STRICT_DIRS = ("tests/fixtures/", "tests/golden/")


def run(root, snapshot=None, allow=()):
    findings = []
    deny = None
    if snapshot:
        deny = build_denylist(snapshot)
        deny = (deny[0] - {a.lower() for a in allow}, deny[1], deny[2])
        print("pii-check: deny-list holds %d words, %d e-mails, %d phone numbers"
              % (len(deny[0]), len(deny[1]), len(deny[2])))
    deny_hits = []
    for rel in _treefiles.list_files(root):
        if rel in SELF_FILES or "vendor" in rel.split("/")[:-1]:
            continue
        path = os.path.join(root, rel)
        if _treefiles.is_binary(path):
            continue
        text = _treefiles.read_text(path)
        if rel.startswith(GENERIC_DIRS):
            findings += generic_findings(rel, text)
        if deny:
            deny_hits += denylist_findings(rel, text, *deny)
    outside = {}
    for rel, n, msg, kind, tok in deny_hits:
        if kind == "word" and not rel.startswith(STRICT_DIRS):
            outside[tok] = outside.get(tok, 0) + 1
    vocabulary = {t for t, c in outside.items() if c >= VOCABULARY_LINES}
    for rel, n, msg, kind, tok in deny_hits:
        if kind == "word" and tok in vocabulary and not rel.startswith(STRICT_DIRS):
            continue
        findings.append((rel, n, msg))
    if deny:
        print("pii-check: %d frequent word(s) treated as ordinary vocabulary outside fixtures"
              % len(vocabulary))
    return findings


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--snapshot", default=None,
                    help="local directory with real .ics/.vcf files (deny-list source)")
    ap.add_argument("--allow", action="append", default=[],
                    help="word to drop from the deny-list (known false positive)")
    args = ap.parse_args(argv)
    if args.snapshot and not os.path.isdir(args.snapshot):
        print("pii-check: snapshot directory not found", file=sys.stderr)
        return 2
    if args.snapshot and not snapshot_readable(args.snapshot):
        # an unreadable or empty snapshot would yield an empty deny-list and a false "ok"
        print("pii-check: snapshot holds no readable .ics/.vcf file (or a directory "
              "could not be read)", file=sys.stderr)
        return 2
    findings = run(args.root, args.snapshot, args.allow)
    for rel, n, msg in findings:
        print("%s:%d: %s" % (rel, n, msg))
    if findings:
        print("pii-check: %d finding(s)" % len(findings))
        return 1
    print("pii-check: ok" + ("" if args.snapshot else " (generic checks only)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
