# SPDX-License-Identifier: AGPL-3.0-or-later
"""Rights and users generator: ``generate(model) -> (rights, users, meta)``.

Pure and deterministic: the same model always yields byte-identical output.
Layout (decision D1; see docs/rights-model.md for the ordering argument)::

    [g000-generation]  user ^$   collection ^radui-gen-<token>$        i
    [g010-root]        user .+   collection ^$                         R
    per enabled admin A (sorted):
        user ^A$  collection ^A$                 RW
        user ^A$  collection ^L$                 RW   (each enabled L != A with ownSpace, sorted)
        user ^A$  collection ^[^/]+$             R
        user ^A$  collection ^[^/]+/.+$          RWrwDO
    per enabled non-admin L (sorted):
        user ^L$  collection ^L$                 RW
        user ^L$  collection ^L/[^/]+$           rwDO  (only with ownSpace)
    grants (sorted by grantee, owner, collection):
        user ^G$  collection ^O/C$               r | rwl
    [zzz-deny]         user .*   collection .*                         (empty)

Disabled accounts and tombstoned logins get no rules (and no ``users`` line).
A grant is emitted only if the grantee is an enabled non-admin account (an
admin's rules already match first). The owner's state does not matter:
disabling an owner freezes its credentials, it does not take its data down.
Deleting either side removes the grant from the model.
"""
import hashlib
import re
from typing import Dict, List, Tuple

from . import names, rightsfile
from .model import Model
from .rightsfile import Section

ADMIN_LETTERS = "RWrwDO"
PRINCIPAL_LETTERS = "RW"
OWN_LETTERS = "rwDO"
GRANT_LETTERS = {"read": "r", "readwrite": "rwl"}
USERS_HEADER = "# radui-admin generated; DO NOT EDIT. generation=%d\n"


def _esc_login(login: str) -> str:
    if not names.is_valid_login(login):  # defence in depth (model is validated)
        raise ValueError("unsafe login %r" % login)
    return re.escape(login)


def _esc_name(name: str) -> str:
    if not names.is_valid_collection_name(name):
        raise ValueError("unsafe collection name %r" % name)
    return re.escape(name)


def rule_list(model: Model) -> List[Section]:
    """The ordered rule list, section names unique by construction (every
    name after g010 carries a running four-digit counter)."""
    out: List[Section] = []
    counter = [0]

    def add(kind: str, login: str, user: str, coll: str, letters: str) -> None:
        counter[0] += 1
        out.append(Section("s%04d-%s-%s" % (counter[0], kind, login),
                           user, coll, letters))

    out.append(Section("g000-generation", "^$",
                       "^%s%s$" % (names.GENERATION_PREFIX, model.gen_token),
                       "i"))
    out.append(Section("g010-root", ".+", "^$", "R"))
    enabled = {k: a for k, a in model.accounts.items() if not a.disabled}
    admins = [k for k in sorted(enabled) if enabled[k].admin]
    plain = [k for k in sorted(enabled) if not enabled[k].admin]
    with_space = [k for k in sorted(enabled) if enabled[k].own_space]
    for a in admins:
        ea = _esc_login(a)
        add("admin-principal", a, "^%s$" % ea, "^%s$" % ea, PRINCIPAL_LETTERS)
        for other in with_space:
            if other != a:
                add("admin-home-%s" % other, a, "^%s$" % ea,
                    "^%s$" % _esc_login(other), PRINCIPAL_LETTERS)
        add("admin-toplevel", a, "^%s$" % ea, "^[^/]+$", "R")
        add("admin-all", a, "^%s$" % ea, "^[^/]+/.+$", ADMIN_LETTERS)
    for login in plain:
        el = _esc_login(login)
        add("user-principal", login, "^%s$" % el, "^%s$" % el,
            PRINCIPAL_LETTERS)
        if enabled[login].own_space:
            add("user-own", login, "^%s$" % el, "^%s/[^/]+$" % el, OWN_LETTERS)
    for g in model.grants:  # already sorted (grantee, owner, collection)
        if g.grantee not in enabled:
            continue
        if enabled[g.grantee].admin:
            continue
        add("grant", g.grantee, "^%s$" % _esc_login(g.grantee),
            "^%s/%s$" % (_esc_login(g.owner), _esc_name(g.collection)),
            GRANT_LETTERS[g.level])
    out.append(Section(rightsfile.DENY_SECTION, ".*", ".*", ""))
    return out


def users_text(model: Model) -> str:
    """htpasswd text: header comment and ``login:hash`` for enabled accounts."""
    lines = [USERS_HEADER % model.generation]
    for login in sorted(model.accounts):
        acc = model.accounts[login]
        if acc.disabled:
            continue
        if not names.is_valid_login(login) \
                or names.BCRYPT_HASH_RE.fullmatch(acc.hash) is None:
            raise ValueError("unsafe users entry for %r" % login)
        lines.append("%s:%s\n" % (login, acc.hash))
    text = "".join(lines)
    if not text.isascii() or "\r" in text:
        raise ValueError("users text must be ASCII with LF line ends")
    return text


def generate(model: Model) -> Tuple[str, str, Dict[str, object]]:
    """Return ``(rights_text, users_text, meta)`` for a validated model."""
    rules = rule_list(model)
    rights = rightsfile.render(rules, model.generation)
    users = users_text(model)
    meta: Dict[str, object] = {
        "generation": model.generation,
        "genToken": model.gen_token,
        "sections": [r.name for r in rules],
        "rightsSha256": hashlib.sha256(rights.encode("ascii")).hexdigest(),
        "usersSha256": hashlib.sha256(users.encode("ascii")).hexdigest(),
        "enabledAccounts": sorted(k for k, a in model.accounts.items()
                                  if not a.disabled),
    }
    return rights, users, meta
