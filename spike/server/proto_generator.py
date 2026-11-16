# SPDX-License-Identifier: AGPL-3.0-or-later
"""PROTOTYPE rights/users generator for the spike experiments (plan 2.4).

Not the production generator: it only has to emit the planned rule layout so
that the spikes test the real planned rights. Pure functions, standard library
only (bcrypt is imported lazily by ``users_text``).

Model (a plain dict)::

    {"generation": 7, "genToken": "<32 hex>",
     "accounts": {"alice": {"admin": False, "disabled": False, "ownSpace": True}},
     "grants": [{"owner": "alice", "collection": "cal-a",
                 "grantee": "bob", "level": "read" | "readwrite"}]}
"""

import configparser
import hashlib
import io
import json
import re
import secrets

LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")
COLL_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._@~+-]{0,127}$")
FORBIDDEN_CHARS = "{}%\r\n"

LEVEL_LETTERS = {"read": "r", "readwrite": "rwl"}


def new_token():
    return secrets.token_hex(16)


def _check(value, regex, what):
    if not regex.match(value):
        raise ValueError("invalid %s: %r" % (what, value))
    return value


def rules(model, ownspace_false_principal="RW", admin_other_principals="RW"):
    """Return the ordered rule list [(section, user_re, collection_re, letters)].

    ``admin_other_principals``: letters an admin gets on other users' principal
    paths. "RW" is the literal plan 2.4 layout (one rule ``^[^/]+$``); "R" is
    the variant tested in S5/S3 (``RW`` only on the admin's own principal).

    ``ownspace_false_principal``: what a non-admin with ownSpace=false gets on
    its own principal path: "RW" (literal plan 2.4 layout: the principal is
    created at first login, no own collections can be made), "R" or "none".
    """
    out = []
    out.append(("g000-generation", "^$",
                "^radui-gen-%s$" % model["genToken"], "i"))
    out.append(("g010-root", ".+", "^$", "R"))
    accounts = {k: v for k, v in model["accounts"].items()
                if not v.get("disabled")}
    for login in sorted(accounts):
        _check(login, LOGIN_RE, "login")
    admins = sorted(k for k, v in accounts.items() if v.get("admin"))
    for a in admins:
        ea = re.escape(a)
        if admin_other_principals == "RW":
            out.append(("a-%s-principals" % a, "^%s$" % ea, "^[^/]+$", "RW"))
        else:
            out.append(("a-%s-principal" % a, "^%s$" % ea, "^%s$" % ea, "RW"))
            out.append(("a-%s-principals" % a, "^%s$" % ea, "^[^/]+$",
                        admin_other_principals))
        out.append(("a-%s-all" % a, "^%s$" % ea, "^[^/]+/.+$", "RWrwDO"))
    for login in sorted(k for k in accounts if k not in admins):
        el = re.escape(login)
        own = accounts[login].get("ownSpace", True)
        if own:
            out.append(("u-%s-principal" % login, "^%s$" % el, "^%s$" % el, "RW"))
            out.append(("u-%s-own" % login, "^%s$" % el,
                        "^%s/[^/]+$" % el, "rwDO"))
        elif ownspace_false_principal != "none":
            out.append(("u-%s-principal" % login, "^%s$" % el, "^%s$" % el,
                        ownspace_false_principal))
    grants = sorted(model.get("grants", []),
                    key=lambda g: (g["grantee"], g["owner"], g["collection"]))
    for i, g in enumerate(grants, 1):
        _check(g["grantee"], LOGIN_RE, "login")
        _check(g["owner"], LOGIN_RE, "login")
        _check(g["collection"], COLL_RE, "collection name")
        out.append(("gr-%04d" % i, "^%s$" % re.escape(g["grantee"]),
                    "^%s/%s$" % (re.escape(g["owner"]),
                                 re.escape(g["collection"])),
                    LEVEL_LETTERS[g["level"]]))
    out.append(("zzz-deny", ".*", ".*", ""))
    return out


def rights_text(model, ownspace_false_principal="RW", admin_other_principals="RW"):
    rs = rules(model, ownspace_false_principal, admin_other_principals)
    digest = hashlib.sha256(json.dumps(model, sort_keys=True).encode()).hexdigest()
    lines = ["# radui-admin generated (PROTOTYPE) - DO NOT EDIT. generation=%d "
             "model-sha256=%s" % (model["generation"], digest), ""]
    for section, user, coll, letters in rs:
        for field in (section, user, coll, letters):
            if any(c in field for c in FORBIDDEN_CHARS):
                raise ValueError("forbidden character in %r" % field)
        lines += ["[%s]" % section, "user: %s" % user,
                  "collection: %s" % coll, "permissions: %s" % letters, ""]
    text = "\n".join(lines)
    _roundtrip(text, rs)
    return text


def _roundtrip(text, rs):
    """A ConfigParser round-trip must reproduce exactly the intended tuples."""
    cp = configparser.ConfigParser()
    cp.read_file(io.StringIO(text))
    got = [(s, cp.get(s, "user"), cp.get(s, "collection"),
            cp.get(s, "permissions")) for s in cp.sections()]
    if got != [tuple(r) for r in rs]:
        raise ValueError("rights round-trip mismatch")


def users_text(logins_to_hash):
    """logins_to_hash: {login: bcrypt-hash-string}; returns htpasswd text."""
    pat = re.compile(r"^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$")
    lines = ["# radui-admin generated (PROTOTYPE)"]
    for login in sorted(logins_to_hash):
        h = logins_to_hash[login]
        if not pat.match(h):
            raise ValueError("not a bcrypt hash for %r" % login)
        lines.append("%s:%s" % (login, h))
    return "\n".join(lines) + "\n"


def default_model(generation=1, with_grants=True):
    """The standard spike population: alice owns, bob rw, agent-1 r, eve none."""
    accounts = {
        "adm-1": {"admin": True, "ownSpace": True},
        "alice": {"admin": False, "ownSpace": True},
        "bob": {"admin": False, "ownSpace": True},
        "agent-1": {"admin": False, "ownSpace": False},
        "eve": {"admin": False, "ownSpace": True},
    }
    grants = []
    if with_grants:
        grants = [
            {"owner": "alice", "collection": "cal-a", "grantee": "bob",
             "level": "readwrite"},
            {"owner": "alice", "collection": "cal-a", "grantee": "agent-1",
             "level": "read"},
            {"owner": "alice", "collection": "book-a", "grantee": "bob",
             "level": "read"},
        ]
    return {"generation": generation, "genToken": new_token(),
            "accounts": accounts, "grants": grants}
