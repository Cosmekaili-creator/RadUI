// SPDX-License-Identifier: AGPL-3.0-or-later
// The groups screens (`#/contacts/groups`, `#/contacts/groups/<key>`). Membership lives only in the group
// card: adding or removing a member is ONE PUT on that card (writes.putGroupMembers); member cards are never
// written. Members that cannot be resolved are shown as "unknown" and always passed through unchanged.
//
// Test ids: groups-screen, group-list, group-row (data-uid, data-href), btn-new-group, dialog-new-group,
// field-group-name, dialog-create-group, group-detail, field-group-rename, btn-rename-group, group-format-note,
// member-list, member-row, member-unknown-row, btn-remove-member, btn-add-member, member-picker,
// field-member-search, member-option, btn-delete-group, dialog-delete-group, dialog-confirm-delete, dialog-cancel.

import { clear, fill, h, openDialog } from '../../ui.js';
import { classify, davErrorKey } from '../../store/errors.js';
import { addMemberPatch, checkGroupName, memberCandidates, removeMemberPatch, renamePatch } from '../../contacts/groups.js';
import { confirmDialog } from '../../widgets/dialogs.js';
import { createAnnouncer, debounce } from '../../widgets/timing.js';
import { buildField, uniqueId } from '../../widgets/fieldkit.js';
import { isolate } from '../../widgets/avatar.js';
import { bookParams, createBookData, isReadOnlyBook, pickBook } from './bookdata.js';
import { cleanQuery, contactHash, fmtNumber, groupHash, listHash, makeKeyer, nameOf, resolveDeps } from './common.js';

const groupsHash = (q) => {
  const s = new URLSearchParams(cleanQuery(q || {})).toString();
  return `#/contacts/groups${s ? `?${s}` : ''}`;
};

export function mount(ctx, deps = {}) {
  const d = resolveDeps(deps);
  const app = ctx.app;
  let { t, tp } = ctx;
  const lang = app.lang || 'en';
  const root = h('section', { class: 'groups', testid: 'groups-screen', 'data-state': 'loading', 'data-view': ctx.params && ctx.params.key ? 'group' : 'list' });
  const endLoad = app.readiness ? app.readiness.begin() : () => {};
  let disposed = false;
  let current = ctx;
  let S = { storeCtx: null, pick: null, data: null, status: 'loading', errorText: '' };
  let off = null;
  ctx.root.append(root);

  const params = () => current.params || {};
  const key = () => (typeof params().key === 'string' ? params().key : '');
  const linkQuery = () => (S.pick && S.pick.state === 'ok' ? bookParams(S.pick.book, S.pick.books) : {});
  const say = (kind, text) => (kind === 'alert' ? app.feedback.setAlert(text) : app.feedback.setStatus(text));
  const readOnly = () => !S.pick || S.pick.state !== 'ok' || isReadOnlyBook(S.pick.book);
  const writes = () => S.storeCtx.writes;

  // ------------------------------------------------------------------ writes

  /** Show the conflict dialog for a refused write; returns the final result. */
  async function resolve(res, label) {
    if (res && (res.status === 'conflict' || res.status === 'deleted-elsewhere' || res.status === 'changed-elsewhere')) {
      return d.openConflictDialog({ conflict: res, t, writes: writes(), label, feedback: app.feedback, win: d.win });
    }
    return res;
  }

  function newGroupDialog() {
    if (readOnly()) return;
    const id = uniqueId('group-name');
    const input = h('input', { class: 'input', type: 'text', id, testid: 'field-group-name', autocomplete: 'off', maxlength: '1000', 'data-autofocus': true });
    const field = buildField({ id, label: t('groups.name'), control: input, hint: t('groups.name.hint'), required: true });
    let busy = false;
    const ctrl = openDialog({
      testid: 'dialog-new-group',
      title: t('groups.new.title'),
      description: t('groups.new.text'),
      body: [field.el],
      focus: input,
      win: d.win,
      actions: [
        { testid: 'dialog-cancel', label: t('dialog.cancel'), cancel: true },
        {
          testid: 'dialog-create-group',
          label: t('groups.create'),
          kind: 'primary',
          write: true,
          onClick: () => {
            if (busy) return false;
            const check = checkGroupName(input.value, S.data.groups());
            if (!check.ok || check.duplicate) {
              field.setError(t(check.ok ? 'groups.err.nameDuplicate' : check.key, check.params));
              input.focus();
              return false;
            }
            busy = true;
            const btn = ctrl.buttons['dialog-create-group'];
            btn.disabled = true;
            writes()
              .createItem({ collection: S.pick.book.href, group: { name: check.name, memberUids: [] } })
              .then((res) => {
                if (res && res.ok) {
                  ctrl.close('created');
                  nav(groupHash(res.uid, cleanQuery(linkQuery())));
                } else {
                  busy = false;
                  btn.disabled = false;
                  field.setError(res && res.message ? res.message : t('contacts.err.generic'));
                  input.focus();
                }
              });
            return false;
          },
        },
      ],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        ctrl.buttons['dialog-create-group'].click();
      }
    });
    return ctrl;
  }

  const nav = (hash, opts) => app.navigate(hash, opts);

  /** `base` is the {text, etag} captured when the rename field was drawn, never the store's copy at Save time. */
  async function renameGroup(group, input, field, base) {
    if (!base) return;
    const check = checkGroupName(input.value, S.data.groups(), { except: group });
    if (!check.ok || check.duplicate) {
      field.setError(t(check.ok ? 'groups.err.nameDuplicate' : check.key, check.params));
      input.focus();
      return;
    }
    field.setError(null);
    const r = app.openItem(base.text, 'contact');
    if (!r.ok) return;
    const baseFields = r.fields();
    const patch = renamePatch(baseFields, check.name);
    if (!Object.keys(patch).length) {
      say('status', t('store.status.unchanged'));
      return;
    }
    let res = await writes().saveItem({ collection: S.pick.book.href, href: group.href, patch, base, baseFields });
    res = await resolve(res, group.name);
    if (res && res.ok) await refreshAndRender();
  }

  async function removeMember(group, member) {
    const p = removeMemberPatch(group, member);
    if (!p.ok) return say('alert', t(p.key));
    if (p.noop) return undefined;
    const e = S.data.entry(group.href);
    const res = await writes().putGroupMembers({ collection: S.pick.book.href, href: group.href, delta: p.patch.membersDelta, base: e ? { text: e.text, etag: e.etag } : undefined });
    if (res && res.status === 'deleted-elsewhere') await resolve(res, group.name);
    return res;
  }

  async function addMember(group, summary) {
    const p = addMemberPatch(group, summary);
    if (!p.ok) return say('alert', t(p.key));
    if (p.noop) return say('status', t('groups.member.already'));
    const e = S.data.entry(group.href);
    return writes().putGroupMembers({ collection: S.pick.book.href, href: group.href, delta: p.patch.membersDelta, base: e ? { text: e.text, etag: e.etag } : undefined });
  }

  function memberPicker(group) {
    if (readOnly() || group.readOnly) return;
    const id = uniqueId('member-search');
    const input = h('input', { class: 'input', type: 'text', id, testid: 'field-member-search', role: 'searchbox', autocomplete: 'off', spellcheck: 'false', 'data-autofocus': true, 'aria-describedby': `${id}-count` });
    const count = h('p', { class: 'field__hint', id: `${id}-count`, role: 'status', testid: 'member-result-count' });
    const results = h('ul', { class: 'picker__list', testid: 'member-results', 'aria-label': t('groups.picker.results') });
    const announcer = createAnnouncer({ apply: (x) => (count.textContent = x), ms: 500, timers: d.timers });
    const contacts = S.data.contacts;
    let ctrl;
    function draw() {
      const found = memberCandidates(contacts, group, input.value);
      fill(
        results,
        found.map((c) => {
          const name = nameOf(c.summary, t);
          return h(
            'li',
            { class: 'picker__item' },
            h(
              'button',
              {
                type: 'button',
                class: 'picker__option picker__option--button',
                testid: 'member-option',
                'data-uid': c.summary.uid || null,
                disabled: !c.canAdd,
                'aria-label': c.canAdd ? t('groups.member.addNamed', { name: isolate(name), group: isolate(group.name) }) : t('groups.member.noUid', { name: isolate(name) }),
                on: {
                  click: () => {
                    ctrl.close('add');
                    addMember(group, c.summary);
                  },
                },
              },
              h('span', { class: 'picker__label' }, h('bdi', null, name)),
              h('span', { class: 'picker__sub' }, h('bdi', null, c.summary.org || c.summary.emails[0] || c.summary.phones[0] || ''), c.canAdd ? '' : ` ${t('groups.member.noUidShort')}`),
            ),
          );
        }),
      );
      announcer.flush(found.length === 0 ? t('widget.picker.none') : found.length >= 50 ? t('groups.picker.limit', { n: 50 }) : tp('widget.picker.count', found.length, { n: found.length }));
    }
    const redraw = debounce(draw, 120, d.timers);
    input.addEventListener('input', () => redraw());
    ctrl = openDialog({
      testid: 'member-picker',
      title: t('groups.picker.title', { group: isolate(group.name) }),
      description: t('groups.picker.text'),
      body: [h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, t('groups.picker.search')), input, count), results],
      focus: input,
      win: d.win,
      actions: [{ testid: 'dialog-cancel', label: t('dialog.cancel'), cancel: true }],
      onClose: () => {
        redraw.cancel();
        announcer.cancel();
      },
    });
    draw();
  }

  async function deleteGroup(group) {
    if (readOnly()) return;
    const named = isolate(group.name);
    const yes = await confirmDialog({
      testid: 'dialog-delete-group',
      confirmTestid: 'dialog-confirm-delete',
      cancelTestid: 'dialog-cancel',
      title: t('groups.delete.title', { name: named }),
      message: t('groups.delete.text'),
      confirmLabel: t('groups.deleteNamed', { name: named }),
      danger: true,
      write: true,
      t,
      win: d.win,
    });
    if (!yes) return;
    let res = await writes().deleteItem({ collection: S.pick.book.href, href: group.href, etag: group.etag, uid: group.uid });
    res = await resolve(res, group.name);
    if (res && res.ok && (res.status === 'deleted' || res.status === 'already-deleted')) nav(groupsHash(linkQuery()));
    else if (res && res.status === 'reloaded') await refreshAndRender();
  }

  // ------------------------------------------------------------------ rendering

  function stateBox(testid, title, text, actions = []) {
    return h('div', { class: 'state', testid }, h('h2', { class: 'state__title' }, title), text ? h('p', { class: 'muted' }, text) : null, actions.length ? h('div', { class: 'state__actions' }, actions) : null);
  }
  const backToContacts = () => h('a', { class: 'btn btn--small', href: listHash(cleanQuery(linkQuery())), testid: 'btn-back-contacts' }, t('groups.backToContacts'));

  function renderList(groups) {
    const ro = readOnly();
    const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name, lang, { sensitivity: 'base', numeric: true }));
    const head = h(
      'div',
      { class: 'groups__head' },
      backToContacts(),
      ro ? null : h('button', { type: 'button', class: 'btn btn--primary', testid: 'btn-new-group', write: true, on: { click: () => newGroupDialog() } }, t('groups.new')),
    );
    const list = sorted.length
      ? h(
          'ul',
          { class: 'rows', testid: 'group-list' },
          sorted.map((g) =>
            h(
              'li',
              null,
              h(
                'a',
                { class: 'row', href: groupHash(g.key, cleanQuery(linkQuery())), testid: 'group-row', 'data-uid': g.uid || null, 'data-href': g.href, 'data-readonly': g.readOnly ? 'true' : 'false' },
                h('span', { class: 'row__main' }, h('bdi', { class: 'row__title' }, g.name || t('groups.unnamed')), h('span', { class: 'row__sub' }, tp('groups.members', g.memberCount, { n: fmtNumber(lang, g.memberCount) }))),
                h('span', { class: 'tag tag--quiet' }, t(`groups.format.${g.form}`)),
              ),
            ),
          ),
        )
      : stateBox('groups-empty', t('groups.empty.title'), ro ? t('groups.empty.textReadonly') : t('groups.empty.text'));
    fill(
      root,
      h('h1', { class: 'page-title', id: 'groups-title', tabindex: '-1' }, t('groups.title')),
      head,
      ro ? h('p', { class: 'notice', role: 'note', testid: 'groups-readonly' }, t('contacts.readonly.text')) : null,
      h('p', { class: 'muted small', role: 'status', testid: 'groups-count' }, tp('groups.count', groups.length, { n: fmtNumber(lang, groups.length) })),
      list,
    );
  }

  function renderDetail(groups) {
    const g = groups.find((x) => x.key === key());
    if (!g) {
      fill(root, h('h1', { class: 'page-title', tabindex: '-1' }, t('groups.title')), h('a', { class: 'btn btn--small', href: groupsHash(linkQuery()), testid: 'btn-back-groups' }, t('groups.back')), stateBox('group-notfound', t('groups.notfound.title'), t('groups.notfound.text')));
      return;
    }
    const ro = readOnly() || g.readOnly;
    const keyer = makeKeyer(S.data.all);
    const q = cleanQuery(linkQuery());
    const named = isolate(g.name);
    const renameEntry = S.data.entry(g.href);
    const renameBase = renameEntry ? { text: renameEntry.text, etag: renameEntry.etag } : null;
    const renameId = uniqueId('group-rename');
    const renameInput = h('input', { class: 'input', type: 'text', id: renameId, testid: 'field-group-rename', autocomplete: 'off', maxlength: '1000', disabled: ro });
    renameInput.value = g.name;
    const renameField = buildField({ id: renameId, label: t('groups.name'), control: renameInput });
    const renameBtn = h('button', { type: 'submit', class: 'btn', testid: 'btn-rename-group', write: true, 'aria-label': t('groups.renameNamed', { name: named }) }, t('groups.rename'));
    const renameForm = h('form', { class: 'inline-form', novalidate: true, on: { submit: (e) => { e.preventDefault(); renameGroup(g, renameInput, renameField, renameBase); } } }, renameField.el, ro ? null : renameBtn);
    const members = g.members.map((m) => {
      if (m.kind === 'contact') {
        const name = nameOf(m.summary, t);
        return h(
          'li',
          { class: 'row row--static', testid: 'member-row', 'data-uid': m.uid || null },
          h('a', { class: 'row__main link-plain', href: contactHash(keyer(m.summary), q), testid: 'group-member-link' }, h('bdi', { class: 'row__title' }, name), h('span', { class: 'row__sub' }, h('bdi', null, m.summary.org || m.summary.emails[0] || m.summary.phones[0] || ''))),
          ro ? null : h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-remove-member', write: true, 'aria-label': t('groups.member.removeNamed', { name: isolate(name), group: named }), on: { click: () => removeMember(g, m) } }, t('groups.member.remove')),
        );
      }
      return h(
        'li',
        { class: 'row row--static', testid: 'member-unknown-row', 'data-uri': m.uri.length > 200 ? null : m.uri },
        h('span', { class: 'row__main' }, h('span', { class: 'row__title' }, t('groups.member.unknown')), h('span', { class: 'row__sub' }, h('bdi', null, m.uri.length > 120 ? `${m.uri.slice(0, 120)}…` : m.uri), ' ', t('groups.member.unknownNote'))),
        ro ? null : h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-remove-member', write: true, 'aria-label': t('groups.member.removeUnknown', { group: named }), on: { click: () => removeMember(g, m) } }, t('groups.member.remove')),
      );
    });
    fill(
      root,
      h('h1', { class: 'page-title', id: 'groups-title', tabindex: '-1' }, h('bdi', null, g.name || t('groups.unnamed'))),
      h('a', { class: 'btn btn--small', href: groupsHash(q), testid: 'btn-back-groups' }, t('groups.back')),
      h(
        'div',
        { class: 'group-detail', testid: 'group-detail', 'data-uid': g.uid || null, 'data-href': g.href, 'data-form': g.form },
        g.readOnly ? h('p', { class: 'notice notice--warn', role: 'note', testid: 'group-readonly-reason' }, t('contact.readonly.lead'), ' ', t(`contact.readonly.${g.reason}`) !== `contact.readonly.${g.reason}` ? t(`contact.readonly.${g.reason}`) : t('contact.readonly.unknown')) : null,
        renameForm,
        h('p', { class: 'meta-line', testid: 'group-format-note' }, t(`groups.formatNote.${g.form}`, { version: g.version })),
        h('h2', { class: 'section-title' }, tp('groups.members', g.memberCount, { n: fmtNumber(lang, g.memberCount) })),
        members.length ? h('ul', { class: 'rows', testid: 'member-list' }, members) : h('p', { class: 'muted', testid: 'member-empty' }, t('groups.member.none')),
        ro ? null : h('button', { type: 'button', class: 'btn btn--primary', testid: 'btn-add-member', write: true, 'aria-label': t('groups.member.addTo', { group: named }), on: { click: () => memberPicker(g) } }, t('groups.member.add')),
        readOnly() ? null : h('div', { class: 'danger-zone' }, h('button', { type: 'button', class: 'btn btn--danger-quiet', testid: 'btn-delete-group', write: true, 'aria-label': t('groups.deleteNamed', { name: named }), on: { click: () => deleteGroup(g) } }, t('groups.delete'))),
      ),
    );
  }

  function renderAll() {
    if (disposed) return;
    root.setAttribute('data-view', key() ? 'group' : 'list');
    if (S.status === 'loading') {
      fill(root, h('h1', { class: 'page-title' }, t('groups.title')), h('p', { class: 'muted' }, t('contacts.loading')));
    } else if (S.status === 'ready') {
      const groups = S.data.groups();
      if (key()) renderDetail(groups);
      else renderList(groups);
    } else {
      const map = { nobook: ['contacts-nobook', 'contacts.nobook.title', 'contacts.nobook.text'], noaccess: ['contacts-noaccess', 'contacts.noaccess.title', 'contacts.noaccess.text'], notfound: ['contacts-notfound', 'contacts.notfound.title', 'contacts.notfound.text'], offline: ['contacts-offline', 'contacts.offline.title', 'contacts.offline.text'], error: ['contacts-error', 'contacts.error.title', null] }[S.status];
      fill(root, h('h1', { class: 'page-title' }, t('groups.title')), stateBox(map[0], t(map[1]), map[2] ? t(map[2]) : S.errorText, [h('a', { class: 'btn', href: '#/contacts', testid: 'btn-back-contacts' }, t('contacts.notfound.back'))]));
    }
    root.setAttribute('data-state', S.status === 'loading' ? 'loading' : ['ready', 'nobook', 'noaccess'].includes(S.status) ? 'ready' : 'error');
  }

  async function refreshAndRender() {
    if (S.data) await S.data.refresh();
    renderAll();
  }

  async function load() {
    try {
      if (!S.storeCtx) S.storeCtx = await app.getStore();
      await S.storeCtx.access.load();
      if (disposed) return;
      S.pick = pickBook(S.storeCtx.access, params());
      if (S.pick.state === 'error') throw S.pick.error;
      if (S.pick.state !== 'ok') {
        S.status = S.pick.state;
        renderAll();
        return endLoad(true);
      }
      if (off) off();
      if (S.data) S.data.dispose();
      S.data = createBookData({ storeCtx: S.storeCtx, session: app.session, book: S.pick.book, yieldFn: d.yieldFn });
      if (!S.data.store.loaded) {
        const res = await S.data.store.sync({ reason: 'load' });
        if (disposed) return;
        if (!res.ok && S.data.store.size === 0) throw res.error || res;
      }
      await S.data.refresh();
      if (disposed) return;
      off = S.data.subscribe(() => refreshAndRender());
      S.status = 'ready';
      renderAll();
      endLoad(true);
    } catch (e) {
      if (disposed) return;
      const kind = e && typeof e.kind === 'string' && !e.name ? e.kind : classify(e).kind;
      S.status = d.isOnline() ? 'error' : 'offline';
      S.errorText = t(davErrorKey(kind));
      renderAll();
      endLoad(false);
    }
  }

  renderAll();
  let loading = load();

  return {
    get title() {
      if (S.status === 'ready' && key()) {
        const g = S.data.groups().find((x) => x.key === key());
        if (g) return g.name || t('groups.title');
      }
      return t('groups.title');
    },
    async update(next) {
      current = next;
      t = next.t || t;
      await loading;
      renderAll();
    },
    dispose() {
      disposed = true;
      if (off) off();
      if (S.data) S.data.dispose();
      clear(root);
      root.remove();
    },
  };
}
