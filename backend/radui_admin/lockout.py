# SPDX-License-Identifier: AGPL-3.0-or-later
"""Lockout protection (pure): refuse changes that could cut admins off.

``check_change(old, new, actor)`` raises ``ApiError`` when moving from ``old``
to ``new`` would

* leave no enabled admin (``lockout_last_admin``): removing, disabling or
  demoting the last enabled admin, or any change that ends with none;
* remove the acting admin's own admin access (``lockout_self``): the actor
  disabling, deleting or demoting themself;
* make an admin bot or non-account (``validation``, bot cannot be admin);
* leave any enabled admin below admin level on the admin probes
  (``lockout_last_admin`` reason ``admin_probe``), using the model oracle or an
  evaluator that reads the REAL generated file (see ``admin_probe_violations``).
"""
from typing import Callable, List, Optional, Tuple

from . import expected as exp
from .model import Model
from .names import ApiError

Evaluator = Callable[[str, str], str]  # (user, path) -> permission letters


def admin_probes(model: Model) -> List[Tuple[str, str, str]]:
    """``(admin, path, required_letters)`` for every enabled admin: the root,
    own principal, every other principal and top-level name, and below every
    principal (a synthetic collection and item)."""
    out: List[Tuple[str, str, str]] = []
    principals = sorted(set(model.accounts) | set(model.tombstones)
                        | {"radui-probe-user"})
    for admin in model.admins():
        out.append((admin, "", "R"))
        out.append((admin, admin, "RW"))
        out.append((admin, "radui-probe-top", "R"))
        for p in principals:
            if p != admin:
                other = model.accounts.get(p)
                need = "RW" if (other is not None and not other.disabled
                                and other.own_space) else "R"
                out.append((admin, p, need))
            out.append((admin, p + "/radui-probe", "RWrwDO"))
            out.append((admin, p + "/radui-probe/x", "RWrwDO"))
        for g in model.grants:
            out.append((admin, "%s/%s" % (g.owner, g.collection), "RWrwDO"))
    return out


def admin_probe_violations(model: Model, evaluator: Optional[Evaluator] = None
                           ) -> List[Tuple[str, str, str, str]]:
    """Probes where an enabled admin has fewer letters than required.

    ``evaluator`` defaults to the model oracle; pass a function backed by
    Radicale's matcher over the candidate rights text to test the real file.
    Returns ``[(admin, path, got, required), ...]``.
    """
    if evaluator is None:
        def evaluator(user: str, path: str) -> str:
            return exp.expected_letters(model, user, path)
    bad = []
    for admin, path, need in admin_probes(model):
        got = evaluator(admin, path)
        if not frozenset(need) <= frozenset(got):
            bad.append((admin, path, got, need))
    return bad


def check_change(old: Model, new: Model, actor: Optional[str] = None, *,
                 evaluator: Optional[Evaluator] = None) -> None:
    """Raise ``ApiError`` if ``old -> new`` violates a lockout rule.

    ``actor`` is the login of the acting admin (``None`` for the local CLI,
    which skips only the self-protection rule).
    """
    for login, acc in new.accounts.items():
        if acc.admin and acc.type == "bot":
            raise ApiError("validation", "a bot account cannot be an admin",
                           field="admin", reason="bot_cannot_be_admin")
    if not new.admins():
        raise ApiError("lockout_last_admin",
                       "at least one enabled admin account must remain",
                       reason="no_admin_left")
    if actor is not None and actor in old.accounts:
        was = old.accounts[actor]
        now = new.accounts.get(actor)
        if was.admin and not was.disabled and (
                now is None or now.disabled or not now.admin):
            raise ApiError("lockout_self",
                           "you cannot remove your own admin access",
                           reason="self_lockout")
    bad = admin_probe_violations(new, evaluator)
    if bad:
        admin, path, got, need = bad[0]
        raise ApiError("lockout_last_admin",
                       "admin %s would lose access to %r" % (admin, path),
                       reason="admin_probe")
