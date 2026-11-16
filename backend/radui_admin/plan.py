# SPDX-License-Identifier: AGPL-3.0-or-later
"""Describe a planned change (``?dryRun=1``): rights diff and access delta.

Pure functions over two models and their generated rights texts. The
effective-access delta uses the model oracle (``expected.expected``); the
candidate validator has proven that Radicale's engine gives the same answer.
"""
import collections
import dataclasses
from typing import Any, Dict, List, Optional, Set, Tuple

from . import expected as exp
from . import generator, rightsfile
from . import model as model_mod
from .model import Model

MAX_DELTA = 500
EXHAUSTIVE_PAIRS = 20000
SYNTHETIC = "radui-probe"


def _triples(rights_text: str) -> "collections.Counter":
    out: collections.Counter = collections.Counter()
    for s in rightsfile.parse_sections(rights_text):
        if s.name.startswith("g000"):  # the generation rule changes every time
            continue
        out[(s.user, s.collection, s.permissions)] += 1
    return out


def rights_diff(old_text: str, new_text: str) -> Dict[str, List[Dict[str, str]]]:
    old, new = _triples(old_text), _triples(new_text)

    def rows(counter: "collections.Counter") -> List[Dict[str, str]]:
        return [{"user": u, "collection": c, "permissions": p}
                for (u, c, p), n in sorted(counter.items()) for _ in range(n)]
    return {"added": rows(new - old), "removed": rows(old - new)}


def _touched(old: Model, new: Model) -> Set[str]:
    logins: Set[str] = set()
    for k in set(old.accounts) | set(new.accounts):
        if old.accounts.get(k) != new.accounts.get(k):
            logins.add(k)
    og, ng = set(old.grants), set(new.grants)
    for g in og ^ ng:
        logins |= {g.owner, g.grantee}
    return logins


def effective_delta(old: Model, new: Model) -> Dict[str, object]:
    users = sorted(set(old.accounts) | set(new.accounts))
    principals = users
    granted = sorted({"%s/%s" % (g.owner, g.collection)
                      for m in (old, new) for g in m.grants})
    paths = [p for p in principals] + ["%s/*" % p for p in principals] + granted
    if len(users) * len(paths) > EXHAUSTIVE_PAIRS:
        touched = _touched(old, new)
        users = sorted(touched | set(old.admins()) | set(new.admins()))
        paths = sorted(set(touched) | {"%s/*" % t for t in touched}
                       | {"%s/%s" % (g.owner, g.collection)
                          for g in set(old.grants) ^ set(new.grants)})
    entries: List[Dict[str, str]] = []
    truncated = False
    for user in users:
        for path in paths:
            real = path[:-1] + SYNTHETIC if path.endswith("/*") else path
            before = exp.expected(old, user, real)
            after = exp.expected(new, user, real)
            if before != after:
                if len(entries) >= MAX_DELTA:
                    truncated = True
                    break
                entries.append({"login": user, "path": path,
                                "before": before, "after": after})
        if truncated:
            break
    return {"changes": entries, "truncated": truncated}


def describe(old: Model, new: Model, old_rights: Optional[str] = None,
             new_rights: Optional[str] = None) -> Dict[str, object]:
    if old_rights is None:
        old_rights = generator.generate(old)[0]
    if new_rights is None:
        new_rights = generator.generate(new)[0]
    diff = rights_diff(old_rights, new_rights)
    delta = effective_delta(old, new)
    return {"rights": diff, "effective": delta["changes"],
            "effectiveTruncated": delta["truncated"]}


# -- restore -----------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Restored:
    """Result of :func:`merge_restore`: the pieces of the new model and the
    report shown by a dry run."""
    accounts: Dict[str, model_mod.Account]
    grants: Tuple[model_mod.Grant, ...]
    tombstones: Dict[str, model_mod.Tombstone]
    report: Dict[str, Any]


def _grant_row(g: model_mod.Grant) -> Dict[str, str]:
    return {"owner": g.owner, "collection": g.collection,
            "grantee": g.grantee, "level": g.level}


def merge_restore(old: Optional[Model], src: Model) -> Restored:
    """What restoring the stored model ``src`` over the current model ``old``
    gives (``old`` is ``None`` when the current model is lost: ``src`` is then
    taken as it is).

    The CURRENT state stays authoritative for everything that is a security
    action since the snapshot: tombstones (a deleted login is never revived),
    password hashes and ``passwordChanged`` (never reverted) and ``disabled``
    (never re-enabled). The snapshot contributes the grants, ``ownSpace`` and
    the ``admin`` flag. Accounts created after the snapshot are removed (that
    is what going back means); display name, type and creation time stay as
    they are now. A grant that would point to a dropped or removed login is
    dropped."""
    if old is None:
        return Restored(dict(src.accounts), src.grants, dict(src.tombstones),
                        {"accountsDropped": [], "accountsRemoved": [],
                         "grantsAdded": [], "grantsRemoved": [],
                         "flagsChanged": [], "currentModel": False})
    tombstones = dict(src.tombstones)
    tombstones.update(old.tombstones)       # current wins
    dropped: List[str] = []
    accounts: Dict[str, model_mod.Account] = {}
    flags: List[Dict[str, Any]] = []
    for login, snap in src.accounts.items():
        if login in old.tombstones:
            dropped.append(login)
            continue
        cur = old.accounts.get(login)
        if cur is None:                      # not in the current model either
            dropped.append(login)
            continue
        admin = snap.admin and cur.type == "person"
        merged = dataclasses.replace(cur, admin=admin, own_space=snap.own_space)
        accounts[login] = merged
        for field, a, b in (("admin", cur.admin, merged.admin),
                            ("ownSpace", cur.own_space, merged.own_space)):
            if a != b:
                flags.append({"login": login, "field": field,
                              "before": a, "after": b})
    removed = sorted(k for k in old.accounts if k not in accounts)
    grants = tuple(g for g in src.grants
                   if g.owner in accounts and g.grantee in accounts)
    og = {(g.key, g.level): g for g in old.grants}
    ng = {(g.key, g.level): g for g in grants}
    report = {
        "accountsDropped": sorted(dropped),
        "accountsRemoved": removed,
        "grantsAdded": [_grant_row(ng[k]) for k in sorted(set(ng) - set(og))],
        "grantsRemoved": [_grant_row(og[k]) for k in sorted(set(og) - set(ng))],
        "flagsChanged": flags,
        "currentModel": True,
    }
    return Restored(accounts, grants, tombstones, report)
