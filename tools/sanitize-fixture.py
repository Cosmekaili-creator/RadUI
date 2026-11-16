#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn real .ics / .vcf files into structure-preserving fakes (stdlib only).

    sanitize-fixture.py INPUT... -o OUT          (one input -> a file, or a directory)
    sanitize-fixture.py INPUT... -o OUTDIR --salt SECRET

Replaced by deterministic fake values (keyed by a SHA-256 of the salt and the
original value, so the same original always gives the same fake and references
between items, such as RELATED-TO and MEMBER, stay consistent): names,
nicknames, organisations, titles, e-mail addresses (example.org), phone numbers
(reserved fictional ranges), addresses, locations, descriptions, notes,
categories, URLs (example.org), UIDs, dates of birth and anniversaries,
coordinates (two decimals), photo and attachment payloads, and the values of
X- properties and of parameters such as CN.

Preserved: component structure, property order, property and parameter NAMES
(including X- names), property groups (item1.), parameter forms and quoting,
TZIDs and whole VTIMEZONE components, RRULE/EXDATE/RDATE/DURATION/TRIGGER and
every date-time of events and tasks, STATUS/CLASS/TRANSP and friends, escaping
(a backslash sequence stays one), the line-ending style, a missing final
newline, blank lines, and the line-folding layout: the fake has the same length
in characters per character class (ASCII letter for letter, digit for digit, a
character of the same UTF-8 length for a non-ASCII one), so every property line
keeps its octet length and is folded at the same places.

The output is a candidate for tests/fixtures/: read it, then run
tools/pii-check.py (with --snapshot) before committing anything.
"""
import argparse
import hashlib
import os
import re
import sys

DEFAULT_SALT = "radui-sanitize-v1"

# ---------------------------------------------------------------------------
# Property tables

KEEP = {
    "BEGIN", "END", "VERSION", "PRODID", "CALSCALE", "METHOD", "DTSTART", "DTEND", "DTSTAMP",
    "CREATED", "LAST-MODIFIED", "REV", "RRULE", "EXDATE", "RDATE", "EXRULE", "DURATION", "TRIGGER",
    "ACTION", "STATUS", "TRANSP", "CLASS", "PRIORITY", "SEQUENCE", "PERCENT-COMPLETE", "DUE",
    "COMPLETED", "RECURRENCE-ID", "TZID", "TZNAME", "TZOFFSETFROM", "TZOFFSETTO", "X-WR-TIMEZONE",
    "KIND", "X-ADDRESSBOOKSERVER-KIND", "REPEAT", "FREEBUSY", "REQUEST-STATUS", "ACKNOWLEDGED",
    "LANG", "TZURL",
}
DATE_PROPS = {"BDAY", "ANNIVERSARY", "X-ABDATE", "DEATHDATE"}
EMAIL_PROPS = {"EMAIL", "ORGANIZER", "ATTENDEE"}
PHONE_PROPS = {"TEL"}
URL_PROPS = {"URL", "SOURCE", "CALADRURI", "CALURI", "FBURL", "IMPP", "X-SOCIALPROFILE", "TZURL", "DIR", "CONFERENCE"}
UID_PROPS = {"UID", "RELATED-TO", "MEMBER", "X-ADDRESSBOOKSERVER-MEMBER", "X-ABUID", "CLIENTPIDMAP"}
GEO_PROPS = {"GEO"}
BINARY_PROPS = {"PHOTO", "LOGO", "SOUND", "KEY", "ATTACH"}
STRUCT_TOKENS = {"TRUE", "FALSE", "BUSY", "FREE", "TENTATIVE", "OOF", "OPAQUE", "TRANSPARENT", "AUTOMATIC",
                 "PUBLIC", "PRIVATE", "CONFIDENTIAL", "DISPLAY", "AUDIO", "EMAIL", "GROUP", "INDIVIDUAL", "ORG"}

KEEP_PARAMS = {
    "TYPE", "VALUE", "ENCODING", "CHARSET", "TZID", "PARTSTAT", "ROLE", "CUTYPE", "RSVP", "RELATED",
    "RELTYPE", "FMTTYPE", "MEDIATYPE", "LANGUAGE", "PREF", "ALTID", "PID", "FBTYPE", "RANGE", "DISPLAY",
    "FEATURE", "SCHEDULE-AGENT", "SCHEDULE-STATUS", "X-APPLE-OMIT-YEAR", "X-SERVICE-TYPE", "X-APPLE-RADIUS",
    "X-NUM-GUESTS", "X-VERSION", "SORT-AS",
}
ADDR_PARAMS = {"SENT-BY", "DELEGATED-TO", "DELEGATED-FROM", "MEMBER", "DIR", "ALTREP"}
GEO_PARAMS = {"GEO"}

LATIN = "àáâãäåçèéêëìíîïñòóôõöùúûüý"
LATIN_UP = "ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ"
KANA = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ"
EMOJI = "😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏"
LABEL_RE = re.compile(r"^_\$!<[^>]*>!\$_$")


class Stream:
    """Deterministic byte stream keyed by (salt, kind, original value)."""

    def __init__(self, salt, kind, value):
        self.seed = ("%s\x00%s\x00%s" % (salt, kind, value)).encode("utf-8", "surrogatepass")
        self.buf = b""
        self.n = 0

    def byte(self):
        if not self.buf:
            self.buf = hashlib.sha256(self.seed + b"\x00" + str(self.n).encode()).digest()
            self.n += 1
        b, self.buf = self.buf[0], self.buf[1:]
        return b

    def pick(self, seq):
        return seq[self.byte() % len(seq)]


# ---------------------------------------------------------------------------
# Value fakes (all keyed, all deterministic)

def fake_text(value, salt, kind="text"):
    """Same length per character class; punctuation, spaces and backslash escapes are kept."""
    s = Stream(salt, kind, value)
    out = []
    i = 0
    while i < len(value):
        c = value[i]
        if c == "\\" and i + 1 < len(value):
            out.append(c + value[i + 1])
            i += 2
            continue
        o = ord(c)
        if o < 128:
            if "a" <= c <= "z":
                out.append(chr(97 + s.byte() % 26))
            elif "A" <= c <= "Z":
                out.append(chr(65 + s.byte() % 26))
            elif "0" <= c <= "9":
                out.append(chr(48 + s.byte() % 10))
            else:
                out.append(c)
        else:
            n = len(c.encode("utf-8"))
            if n == 2:
                out.append(s.pick(LATIN_UP if c.isupper() else LATIN))
            elif n == 3:
                out.append(s.pick(KANA))
            else:
                out.append(s.pick(EMOJI))
        i += 1
    return "".join(out)


def fake_alnum(value, salt, kind):
    return fake_text(value, salt, kind)


def fake_email(value, salt):
    m = re.match(r"^(mailto:)?(.*)$", value, re.I)
    prefix, rest = m.group(1) or "", m.group(2)
    if "@" not in rest:
        return prefix + fake_text(rest, salt, "email")
    s = Stream(salt, "email", rest)
    n = max(3, len(rest) - len("@example.org"))
    local = "".join(chr(97 + s.byte() % 26) for _ in range(n))
    return prefix + local + "@example.org"


def fake_phone(value, salt):
    m = re.match(r"^(tel:)?(.*)$", value, re.I)
    prefix, rest = m.group(1) or "", m.group(2)
    s = Stream(salt, "phone", rest)
    digits = [c for c in rest if c.isdigit()]
    n = len(digits)
    new = list("1555") if n >= 4 else []
    new += [str(s.byte() % 10) for _ in range(n - len(new))]
    it = iter(new)
    return prefix + "".join(next(it) if c.isdigit() else c for c in rest)


def fake_uid(value, salt):
    m = re.match(r"^(urn:uuid:|mailto:)?(.*)$", value, re.I)
    prefix, rest = m.group(1) or "", m.group(2)
    if prefix.lower() == "mailto:":
        return fake_email(value, salt)
    if "@" in rest:
        local = rest.split("@", 1)[0]
        return prefix + fake_alnum(local, salt, "uid") + "@example.org"
    if re.fullmatch(r"[0-9A-Fa-f-]+", rest):
        s = Stream(salt, "hexuid", rest)
        hexd = "0123456789abcdef"
        return prefix + "".join(c if c == "-" else (s.pick(hexd).upper() if c.isupper() else s.pick(hexd)) for c in rest)
    return prefix + fake_alnum(rest, salt, "uid")


def fake_url(value, salt):
    m = re.match(r"^([A-Za-z][A-Za-z0-9+.-]*):(//)?([^/?#]*)(.*)$", value)
    if not m:
        return fake_text(value, salt, "url")
    scheme, slashes, host, rest = m.groups()
    if scheme.lower() == "mailto":
        return fake_email(value, salt)
    if scheme.lower() == "tel":
        return fake_phone(value, salt)
    if scheme.lower() == "geo":
        return fake_geo(value, salt)
    if scheme.lower() == "data":
        return value if len(value) < 40 else fake_binary(value, salt)
    if slashes:
        new = scheme + ":" + slashes + "example.org" + fake_text(rest, salt, "urlpath")
    else:
        new = scheme + ":" + fake_text(host + rest, salt, "urlopaque")
    pad = len(value) - len(new)
    if pad > 0 and new.rstrip("/"):
        s = Stream(salt, "urlpad", value)
        new += "".join(chr(97 + s.byte() % 26) for _ in range(pad))
    return new


FLOAT_RE = re.compile(r"-?\d+\.\d{3,}")


def fake_geo(value, salt):
    s = Stream(salt, "geo", value)

    def repl(m):
        whole = s.byte() % 80
        frac = s.byte() % 100
        return ("-" if m.group(0).startswith("-") else "") + "%d.%02d" % (whole + 1, frac)

    return FLOAT_RE.sub(repl, value)


def fake_date(value, salt):
    s = Stream(salt, "date", value)
    year = 1900 + s.byte() % 100
    month = 1 + s.byte() % 12
    day = 1 + s.byte() % 28
    m = re.match(r"^(\D*)(\d{4})(-?)(\d{2})(-?)(\d{2})(.*)$", value, re.S)
    if m:
        if int(m.group(2)) in (1604, 1900, 1904):  # "no year" conventions stay
            year = int(m.group(2))
        return "%s%04d%s%02d%s%02d%s" % (m.group(1), year, m.group(3), month, m.group(5), day, m.group(7))
    m = re.match(r"^(--)(\d{2})(-?)(\d{2})(.*)$", value, re.S)
    if m:
        return "%s%02d%s%02d%s" % (m.group(1), month, m.group(3), day, m.group(5))
    return fake_text(value, salt, "date")


def fake_binary(value, salt):
    """Base64 payload (optionally behind a data: URI prefix) replaced by pseudo-random base64 of the same length."""
    prefix = ""
    m = re.match(r"^(data:[^,]*,)(.*)$", value, re.I | re.S)
    body = value
    if m:
        prefix, body = m.group(1), m.group(2)
    pad = len(body) - len(body.rstrip("="))
    core = body[: len(body) - pad]
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    s = Stream(salt, "bin", body[:64] + str(len(body)))
    return prefix + "".join(s.pick(alphabet) for _ in range(len(core))) + "=" * pad


# ---------------------------------------------------------------------------
# Line parsing

def split_params(text):
    """Split ';'-separated parameters, respecting double quotes. text starts after the first ';'."""
    parts, cur, q = [], "", False
    for c in text:
        if c == '"':
            q = not q
        if c == ";" and not q:
            parts.append(cur)
            cur = ""
        else:
            cur += c
    parts.append(cur)
    return parts


def split_commas(text):
    """Split on commas outside double quotes (empty segments are kept)."""
    parts, cur, q = [], "", False
    for c in text:
        if c == '"':
            q = not q
        if c == "," and not q:
            parts.append(cur)
            cur = ""
        else:
            cur += c
    parts.append(cur)
    return parts


def split_line(line):
    """(group, name, [param tokens], value) or None. A parameter token is 'NAME=raw' or 'NAME'."""
    q = False
    for i, c in enumerate(line):
        if c == '"':
            q = not q
        elif c == ":" and not q:
            head, value = line[:i], line[i + 1:]
            break
    else:
        return None
    pieces = split_params(head)
    ident = pieces[0]
    if not re.fullmatch(r"(?:[A-Za-z0-9-]+\.)?[A-Za-z0-9-]+", ident):
        return None
    group, _, name = ident.rpartition(".")
    return group, name, pieces[1:], value


def sanitize_param(tok, salt):
    if "=" not in tok:
        return tok
    name, _, raw = tok.partition("=")
    up = name.upper()
    if up in KEEP_PARAMS:
        return tok
    values = split_commas(raw)
    out = []
    for v in values:
        quoted = v.startswith('"') and v.endswith('"') and len(v) >= 2
        inner = v[1:-1] if quoted else v
        if up in ADDR_PARAMS:
            new = fake_url(inner, salt) if not inner.lower().startswith("mailto:") else fake_email(inner, salt)
        elif up in GEO_PARAMS:
            new = fake_geo(inner, salt)
        elif re.fullmatch(r"\d{1,4}", inner) or inner.upper() in STRUCT_TOKENS:
            new = inner
        else:
            new = fake_text(inner, salt, "param:" + up)
        out.append('"%s"' % new if quoted else new)
    return name + "=" + ",".join(out)


def sanitize_value(group, name, params, value, salt):
    up = name.upper()
    if up in KEEP or value == "":
        return value
    pnames = {t.split("=", 1)[0].upper(): (t.split("=", 1)[1] if "=" in t else "") for t in params}
    enc = pnames.get("ENCODING", "").strip('"').upper()
    if up in BINARY_PROPS and (enc in ("B", "BASE64") or value[:5].lower() == "data:"):
        return fake_binary(value, salt)
    if up in EMAIL_PROPS:
        return fake_email(value, salt)
    if up in PHONE_PROPS:
        return fake_phone(value, salt)
    if up in UID_PROPS:
        return fake_uid(value, salt)
    if up in GEO_PROPS:
        return fake_geo(value, salt)
    if up in DATE_PROPS:
        return fake_date(value, salt)
    if up in URL_PROPS or up in BINARY_PROPS:
        return fake_url(value, salt)
    if up == "X-APPLE-STRUCTURED-LOCATION":
        return fake_geo(value, salt)
    if LABEL_RE.match(value) or value.upper() in STRUCT_TOKENS:
        return value
    if re.search(r"[A-Za-z][A-Za-z0-9+.-]*://", value) and " " not in value:
        return fake_url(value, salt)
    return fake_text(value, salt, up)


def sanitize_logical(line, salt):
    parsed = split_line(line)
    if parsed is None:
        return line if line.upper().startswith(("BEGIN", "END")) else fake_text(line, salt, "line")
    group, name, params, value = parsed
    up = name.upper()
    if up in ("BEGIN", "END"):
        return line
    new_params = [sanitize_param(t, salt) for t in params]
    new_value = sanitize_value(group, name, params, value, salt)
    head = (group + "." if group else "") + name
    return head + "".join(";" + t for t in new_params) + ":" + new_value


# ---------------------------------------------------------------------------
# File level: unfold, sanitise, refold with the original layout

def octets(s):
    return len(s.encode("utf-8", "surrogatepass"))


def fold_like(new, layout):
    """Re-fold `new` (unfolded) with the original physical layout (list of (lead, nchars)), or at 75 octets."""
    if len(layout) == 1 and octets(new) <= 75:
        return [new]
    if sum(n for _, n in layout) == len(new):
        out, pos = [], 0
        for k, (lead, n) in enumerate(layout):
            out.append(lead + new[pos:pos + n])
            pos += n
        return out
    out, cur, used, limit = [], "", 0, 75
    for ch in new:
        b = octets(ch)
        if used + b > limit:
            out.append(cur)
            cur, used, limit = " ", 1, 75
        cur += ch
        used += b
    out.append(cur)
    return out


def sanitize_text(text, salt=DEFAULT_SALT):
    bom = "﻿" if text.startswith("﻿") else ""
    if bom:
        text = text[1:]
    eol = "\r\n" if "\r\n" in text else ("\r" if "\r" in text else "\n")
    final_eol = text.endswith(("\r", "\n"))
    phys = re.split(r"\r\n|\r|\n", text)
    if final_eol:
        phys = phys[:-1]
    logical = []  # each: (layout [(lead, nchars)], unfolded text) ; blank lines have layout None
    for ln in phys:
        if ln[:1] in (" ", "\t") and logical and logical[-1][0] is not None and ln.strip() != "":
            lay, txt = logical[-1]
            lay.append((ln[0], len(ln) - 1))
            logical[-1] = (lay, txt + ln[1:])
        elif ln == "":
            logical.append((None, ""))
        else:
            logical.append(([("", len(ln))], ln))
    out = []
    for lay, txt in logical:
        if lay is None:
            out.append("")
            continue
        new = sanitize_logical(txt, salt)
        out.extend(fold_like(new, lay))
    body = eol.join(out)
    return bom + body + (eol if final_eol else "")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Structure-preserving fake of .ics/.vcf files")
    ap.add_argument("inputs", nargs="+", help="input .ics/.vcf files")
    ap.add_argument("-o", "--out", required=True, help="output file (one input) or output directory")
    ap.add_argument("--salt", default=DEFAULT_SALT, help="key of the fake values (default: a fixed public string)")
    a = ap.parse_args(argv)
    single = len(a.inputs) == 1 and not os.path.isdir(a.out)
    if not single:
        os.makedirs(a.out, exist_ok=True)
    for path in a.inputs:
        with open(path, "r", encoding="utf-8", newline="") as fh:
            text = fh.read()
        result = sanitize_text(text, a.salt)
        dest = a.out if single else os.path.join(a.out, os.path.basename(path))
        with open(dest, "w", encoding="utf-8", newline="") as fh:
            fh.write(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
