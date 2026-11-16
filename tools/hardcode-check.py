#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fail when the tree contains deployment-specific values (stdlib only).

Rules: IPv4 / IPv6 addresses, e-mail addresses, absolute home-directory paths,
and forbidden tokens from a git-ignored local file
(tools/.forbidden-tokens.local, one token per line, case-insensitive
substring). The only exception to the token rule is PUBLIC_IDENTITY: exact,
owner-approved strings in README.md. A line holding the marker ``hardcode-ok`` is exempt from the
generic rules (never from the forbidden-token rule).

Skipped: this script itself and binary files; vendored files (any vendor/
directory) and the explicit GENERIC_ALLOWLIST are exempt from the generic
rules only (forbidden tokens apply everywhere). tests/fixtures/ is NOT
exempt. A zero-padded IPv4-looking token such as 010.1.1.1 is a finding.
Exit status 1 on any finding, with file:line printed.
"""
import argparse
import ipaddress
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _treefiles  # noqa: E402

MARKER = "hardcode-ok"
SELF = "tools/hardcode-check.py"
TOKENS_REL = "tools/.forbidden-tokens.local"

IPV4_RE = re.compile(r"(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?![\w]|\.\d)")
IPV6_RE = re.compile(r"(?<![\w:])([0-9A-Fa-f:]*:[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*)(?![\w:])")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})")
PATH_RE = re.compile(r"(?<![\w.~-])/(?:home|Users)/[^\s/'\"`:;,)]+")

ALLOWED_EMAIL_DOMAINS = ("example.org", "example.com", "example.net")
ALLOWED_V4_NETS = [ipaddress.ip_network(n) for n in (
    "127.0.0.1/32", "0.0.0.0/32", "192.0.2.0/24", "198.51.100.0/24",
    "203.0.113.0/24")]
DOC_V6 = ipaddress.ip_network("2001:db8::/32")


# Owner-approved public identity (maintainer name, company site, public repository).
# These exact strings, and only them, are removed from a line of the listed file
# before the forbidden-token check; any other occurrence of the same tokens (another
# file, another host name, another path) is still a finding. Keep it to README.md.
PUBLIC_IDENTITY = {
    "README.md": (
        re.compile(r"Majorum Network"),
        re.compile(r"https://www\.majorum\.net(?![\w./:@-])"),
        re.compile(r"https://github\.com/Cosmekaili-creator/RadUI(?:/issues)?(?![\w./:@-])"),
    ),
}


def strip_public_identity(rel, line):
    for pat in PUBLIC_IDENTITY.get(rel, ()):
        line = pat.sub(" ", line)
    return line


# Files exempt from the generic rules besides vendored code. Keep this list
# empty unless a corpus file truly cannot be written with documentation
# values; every entry needs a comment and a test.
GENERIC_ALLOWLIST = ()


def skip_generic(rel):
    parts = rel.split("/")
    return "vendor" in parts[:-1] or rel in GENERIC_ALLOWLIST


def check_ipv4(line):
    out = []
    for m in IPV4_RE.finditer(line):
        octets = m.group(1).split(".")
        if any(int(o) > 255 for o in octets):
            continue
        if any(len(o) > 1 and o.startswith("0") for o in octets):
            # ipaddress rejects zero-padded octets; they are ambiguous
            # (octal vs decimal) and would hide an address, so report them.
            out.append("IPv4-looking address with zero-padded octet "
                       + m.group(1))
            continue
        try:
            ip = ipaddress.ip_address(m.group(1))
        except ValueError:
            # e.g. fullwidth or other non-ASCII digits: never silently skip
            out.append("IPv4-looking address with unusual digits "
                       + m.group(1))
            continue
        if not any(ip in net for net in ALLOWED_V4_NETS):
            out.append("IPv4 address " + m.group(1))
    return out


def check_ipv6(line):
    out = []
    for m in IPV6_RE.finditer(line):
        cand = m.group(1).rstrip(":.") if not m.group(1).endswith("::") else m.group(1)
        try:
            ip = ipaddress.IPv6Address(cand)
        except ValueError:
            continue
        hextets = [h for h in cand.split(":") if h]
        if len(hextets) < 2 and cand != "::1":
            continue  # "::" / "::2" style non-addresses (slices, scopes)
        if ip == ipaddress.IPv6Address("::1") or ip in DOC_V6 or ip.is_unspecified:
            continue
        out.append("IPv6 address " + cand)
    return out


def check_email(line):
    out = []
    for m in EMAIL_RE.finditer(line):
        domain = m.group(1).lower()
        if any(domain == d or domain.endswith("." + d)
               for d in ALLOWED_EMAIL_DOMAINS):
            continue
        out.append("e-mail address " + m.group(0))
    return out


def check_path(line):
    return ["absolute home path " + m.group(0) for m in PATH_RE.finditer(line)]


def load_tokens(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return [ln.strip().lower() for ln in fh
                    if ln.strip() and not ln.lstrip().startswith("#")]
    except OSError:
        return None


def scan(root, tokens):
    findings = []
    for rel in _treefiles.list_files(root):
        if rel == SELF or rel == TOKENS_REL:
            continue
        path = os.path.join(root, rel)
        low_rel = rel.lower()
        for tok in tokens:
            if tok in low_rel:
                findings.append((rel, 0, "forbidden token in file name"))
        if _treefiles.is_binary(path):
            continue
        generic = not skip_generic(rel)
        for n, line in enumerate(_treefiles.read_text(path).splitlines(), 1):
            low = strip_public_identity(rel, line).lower()
            for tok in tokens:
                if tok in low:
                    findings.append((rel, n, "forbidden token (list entry hidden)"))
                    break
            if generic and MARKER not in line:
                for check in (check_ipv4, check_ipv6, check_email, check_path):
                    for msg in check(line):
                        findings.append((rel, n, msg))
    return findings


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.path.dirname(here))
    ap.add_argument("--tokens", default=None,
                    help="forbidden-token file (default: <root>/%s)" % TOKENS_REL)
    args = ap.parse_args(argv)
    token_file = args.tokens or os.path.join(args.root, TOKENS_REL)
    tokens = load_tokens(token_file)
    if tokens is None:
        print("warning: forbidden-token file not found (%s); "
              "only the generic rules run" % TOKENS_REL, file=sys.stderr)
        tokens = []
    findings = scan(args.root, tokens)
    for rel, n, msg in findings:
        print("%s:%d: %s" % (rel, n, msg))
    if findings:
        print("hardcode-check: %d finding(s)" % len(findings))
        return 1
    print("hardcode-check: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
