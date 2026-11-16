// SPDX-License-Identifier: AGPL-3.0-or-later
// Contact groups (RUN2 D-R2-12, addendum M10), no DOM. Membership lives ONLY in the group card
// (KIND:group + MEMBER, or the Apple form); adding or removing a member is one `membersDelta`
// change for ONE PUT on the group card; member cards are never written. A member that cannot be
// resolved against the book (another book, a deleted contact, `mailto:` ...) is shown as an
// unknown member and always passed through unchanged.
//
//   readGroups(entries, contacts)    group list/detail data from [{href, etag, text}]
//   addMemberPatch / removeMemberPatch / renamePatch    patches for `item.update()`
//   newGroup(name, opts)             a NEW group card (Item) in the right form for the book
//   groupsOf / affectedGroups        groups of a contact; text data for "delete contact"
//   memberCandidates                 the member picker (at most 50, no list of every contact)

import { createGroupItem, openItem } from "../model/item.js";
import { isGroupCard, memberUri, pickGroupForm } from "../model/vcard.js";
import { keyFor, matches, memberKey, parseQuery } from "./index.js";

export const MAX_GROUP_NAME = 1000;
export const PICKER_LIMIT = 50;

function scheme(uri) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(uri);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Group list/detail data. `entries` are the group cards as served ([{href, etag, text}]; items
 * that are not group cards are skipped), `contacts` the contact summaries of the same book.
 * Each group: {href, etag, uid, key, name, form: 'apple'|'rfc6350', version, readOnly, reason,
 * members: [{kind: 'contact', uri, uid, summary} | {kind: 'unknown', uri, scheme}],
 * memberCount, resolvedCount, unknownCount}. `key` is the `#/contacts/groups/<key>` key.
 */
export function readGroups(entries, contacts = []) {
  const byKey = new Map();
  for (const c of contacts) {
    if (c.isGroup || !c.uid) continue;
    const k = memberKey(c.uid);
    if (!byKey.has(k)) byKey.set(k, c);
  }
  const groups = [];
  const cards = [];
  for (const e of entries || []) {
    let item;
    try {
      item = openItem(e.text, "contact");
    } catch {
      continue;
    }
    if (!item.ok || !isGroupCard(item)) continue;
    const f = item.fields();
    const members = [];
    const seen = new Set();
    for (const uri of f.group.members) {
      if (seen.has(uri)) continue;
      seen.add(uri);
      const hit = byKey.get(memberKey(uri));
      members.push(hit ? { kind: "contact", uri, uid: hit.uid, summary: hit } : { kind: "unknown", uri, scheme: scheme(uri) });
    }
    const resolvedCount = members.filter((m) => m.kind === "contact").length;
    groups.push({
      href: e.href || "",
      etag: e.etag === undefined ? null : e.etag,
      uid: item.uid || null,
      key: "",
      name: (f.fn || "").trim(),
      form: f.group.form,
      version: f.version,
      readOnly: !!item.readOnly,
      reason: item.readOnly ? item.readOnlyReason : null,
      members,
      memberCount: members.length,
      resolvedCount,
      unknownCount: members.length - resolvedCount,
    });
    cards.push({ uid: item.uid || null, href: e.href || "" });
  }
  for (let i = 0; i < groups.length; i++) groups[i].key = keyFor(cards[i], cards);
  return groups;
}

/** Member keys of a group (for index.js `filterByMembers`). */
export function memberKeys(group) {
  return new Set(group.members.map((m) => memberKey(m.uri)));
}

/** Groups a contact belongs to. */
export function groupsOf(groups, uid) {
  if (!uid) return [];
  const k = memberKey(uid);
  return groups.filter((g) => g.members.some((m) => memberKey(m.uri) === k));
}

/**
 * Text data for the delete-contact dialog ("Also removed from 2 groups: Family, Book club") and
 * the cleanup list: {count, names, groups: [{href, etag, uid, name}]}.
 */
export function affectedGroups(groups, uid) {
  const list = groupsOf(groups, uid);
  return { count: list.length, names: list.map((g) => g.name), groups: list.map((g) => ({ href: g.href, etag: g.etag, uid: g.uid, name: g.name })) };
}

const refuse = (reason) => ({ ok: false, reason, key: `groups.err.${reason}` });

/**
 * The single change to add a contact to a group: {ok:true, patch: {membersDelta: {add: [uri]}},
 * noop} (noop and an empty patch when the contact is already a member) or {ok:false, reason, key}
 * with reason 'no-uid' (a contact without UID cannot be added) or 'group-read-only'.
 * `contact` is a summary (or {uid}); `group` an entry of readGroups.
 */
export function addMemberPatch(group, contact) {
  if (group.readOnly) return refuse("group-read-only");
  const uid = contact && typeof contact.uid === "string" ? contact.uid.trim() : "";
  if (!uid) return refuse("no-uid");
  const k = memberKey(uid);
  if (group.members.some((m) => memberKey(m.uri) === k)) return { ok: true, noop: true, patch: {} };
  return { ok: true, noop: false, patch: { membersDelta: { add: [memberUri(uid)] } } };
}

/**
 * The single change to remove one member: `member` is an entry of `group.members` (a contact or an
 * unknown member, removed by its exact URI) or a contact UID. Nothing else is ever removed.
 */
export function removeMemberPatch(group, member) {
  if (group.readOnly) return refuse("group-read-only");
  const uri = typeof member === "string" ? (group.members.find((m) => memberKey(m.uri) === memberKey(member)) || {}).uri : member && member.uri;
  if (!uri || !group.members.some((m) => m.uri === uri)) return { ok: true, noop: true, patch: {} };
  return { ok: true, noop: false, patch: { membersDelta: { remove: [uri] } } };
}

/** Validate a group name: {ok, name} or {ok:false, key}. */
export function checkGroupName(name, groups = [], { except } = {}) {
  const t = String(name === undefined || name === null ? "" : name).trim();
  if (!t) return { ok: false, key: "groups.err.nameRequired" };
  if (t.length > MAX_GROUP_NAME) return { ok: false, key: "groups.err.nameTooLong", params: { max: MAX_GROUP_NAME } };
  const twin = groups.some((g) => g !== except && g.name.trim().toLowerCase() === t.toLowerCase());
  return { ok: true, name: t, duplicate: twin };
}

/**
 * The patch that renames a group: FN, and in the Apple form also N when N is the old name as
 * createGroup wrote it (family only). {} when the name is unchanged. `fields` = `item.fields()`.
 */
export function renamePatch(fields, newName) {
  const name = String(newName === undefined || newName === null ? "" : newName).trim();
  const old = String(fields.fn || "");
  if (!name || name === old.trim()) return {};
  const patch = { fn: name };
  const n = fields.n;
  if (fields.group && fields.group.form === "apple" && n) {
    const rest = ["given", "additional", "prefix", "suffix"].every((k) => !n[k]);
    if (rest && n.family === old) patch.n = { ...n, family: name };
  }
  return patch;
}

/**
 * A NEW group card (an Item, ready for `save()` and a PUT with If-None-Match). The form is the
 * one the book's existing group cards use (pickGroupForm: groups first, then the majority
 * VERSION, an empty book gives Apple). `cards` are item fields, Items or summaries-with-version;
 * `form` overrides. {ok:true, item, form} or {ok:false, key}.
 */
export function newGroup(name, { cards = [], form, uid, memberUids = [], prodid } = {}) {
  const check = checkGroupName(name);
  if (!check.ok) return check;
  const chosen = form || pickGroupForm(cards);
  const item = createGroupItem(check.name, memberUids, { uid, form: chosen, ...(prodid ? { prodid } : {}) });
  return { ok: true, item, form: chosen };
}

/**
 * Candidates for the member picker: contacts that are not members yet and match `query`, at most
 * `limit` (50). A contact without UID is listed but disabled: {summary, canAdd, reason}.
 */
export function memberCandidates(contacts, group, query, { limit = PICKER_LIMIT } = {}) {
  const have = memberKeys(group);
  const pq = parseQuery(query);
  const out = [];
  for (const c of contacts) {
    if (c.isGroup || c.readOnly) continue;
    if (c.uid && have.has(memberKey(c.uid))) continue;
    if (!matches(c, pq)) continue;
    out.push({ summary: c, canAdd: !!c.uid, reason: c.uid ? null : "no-uid" });
    if (out.length >= Math.min(limit, PICKER_LIMIT)) break;
  }
  return out;
}
