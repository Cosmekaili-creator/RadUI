<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Server-side spike report (S1–S9, S14', S15, S17, S18)

Environment: Radicale 3.9.0 throwaway instances (current user, loopback, temp dirs), Python 3.13, prototype rights plugin `backend/plugin/radui_rights.py` and prototype generator `spike/server/proto_generator.py` (rule layout of the plan: generation rule, root rule, admin, principal RW, own `rwDO`, grants `r` / `rwl`, final deny; `permit_delete_collection = False`, `permit_overwrite_collection = False`, auth delay 1 s). One script per spike (`s01_reload.py` … `s18_latency.py`), `run_all.sh` runs them all. Every script was run twice with identical verdicts, and re-run independently by the orchestrator (S3 and S5 re-run: all PASS). The live Radicale was never written to (same main PID before and after).

| Spike | Result | Key facts |
|---|---|---|
| S1 reload | PASS | Stock `from_file` caches rights until restart. The plugin applies a change on the next request, including 60 in-place equal-size rewrites. |
| S2 malformed files | PASS (43 checks) | Plugin keeps the old rules on a bad file and starts from `.lkg`; loading via `PYTHONPATH` works. |
| S3 letter matrix | PASS (103 cells + 7 auto-create/ownSpace checks) | Matches the planned semantics; denied requests have no side effects. |
| S4 discovery | PASS | Granted collections of other owners are not discoverable; a grantee needs the direct URL (backend `me/access` supplies it). |
| S5 probe | PASS (13) | Anonymous GET: 404 when the probe rule is active, 401 when not; polling every 300 ms gives about 3 attempts in 3 s; anonymous 401s each hold 1 of the 8 connection slots while sleeping (0.57 s for an authenticated request issued during 8 in flight vs 0.003 s idle). An admin MKCOL on the probe path makes it answer 401 forever, so the prefix must be reserved. |
| S6 bcrypt | PASS | Radicale-generated hashes are `$2b$12$`; system bcrypt 4.2.0 hashes verify in Radicale's bcrypt 5.0.0. |
| S7 users re-read | PASS | `users` is re-read on every login; no restart. |
| S8 concurrency | PASS | 250 rights rewrites under 20 clients: 0 HTTP 5xx, no inconsistent answer. |
| S9 restart cost | PASS | A restart takes about 0.2 s (not 1–3 s). |
| S14' canonical form | PASS | vobject re-serialises on PUT; folds at 75 octets without splitting a character; see script output for order/case findings. |
| S15 inventory | PASS | Aggregates only; detailed report kept outside the repository. |
| S17 sync-collection | PASS | An invalid sync token gives 403 with a `valid-sync-token` error element, the same status as a permission denial: the client must read the body. |
| S18 latency | PASS | About 16 requests/s at bcrypt cost 12 on 4 CPUs (8 connection slots). |

## Deviations from the plan's assumptions
1. Stock `from_file` starts on an **empty** rights file and silently denies everyone; on a bad regex or an unknown `{placeholder}` it **starts** and answers every request with 500. The candidate validator must compile every pattern and reject empty files.
2. Restart cost is about 0.2 s, not 1–3 s (the restart fallback is a cheap manual escape hatch).
3. vobject folds at 75 octets and never splits a character.
4. Radicale builds the rights class twice, so the plugin's "active" WARNING appears twice at startup.
5. **Admin rule:** `RW` on `^[^/]+$` lets an admin create any top-level collection name over DAV, and nobody can delete it afterwards. Recommended variant (tested): admin gets `RW` on **their own** principal only and `R` on other principals, plus `RWrwDO` on everything below. In that variant top-level MKCOL is 403, PROPFIND of own and other principals is 207, and MKCALENDAR inside another principal is 201.
6. A deleted `users` file makes every request fail with HTTP 500 until it is restored: managed files are replaced by atomic rename only, never deleted/recreated.
7. Radicale truncates passwords to 72 bytes and accepts any suffix: the backend must reject passwords over 72 bytes.
8. With `ownSpace = false`, a `RW` principal rule creates an empty principal directory at first login, while `R` or no rule creates nothing. Own-collection creation is 403 in all three variants, and grants remain usable in all three.

## Recommendation for gate G1
The **hot-reload plugin design stands**; the restart-per-change fallback is not needed (it stays documented as a manual escape hatch).
