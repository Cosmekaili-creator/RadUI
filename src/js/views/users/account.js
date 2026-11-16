// SPDX-License-Identifier: AGPL-3.0-or-later
// `#/users/:login` (`?dialog=reset-password|delete`): one account. Details and the switches that change it (own
// space, administrator, disabled), the password reset, the delete (with "keep data" or "delete data"), what the
// account owns, the access it was granted (a level menu per row, a form to add more) and the effective access the
// service computed. Every change is previewed and confirmed; the lock-out cases (yourself, the last administrator)
// are disabled WITH their explanation, not hidden.
//
// Test ids: account-view (data-login), account-details (acct-name, acct-type, acct-admin, acct-status, acct-created,
// acct-pwchanged), field-ownspace, field-acct-admin, account-actions, btn-reset-password, btn-toggle-disabled,
// btn-delete-account, acct-guard, btn-own-settings, access-section, access-title, rights-limits-note, own-collection
// (+ btn-share, own-shared), own-none, grants-table, grant-row, grant-select, grants-none, add-access-form,
// field-add-coll, field-add-level, btn-add-access, add-access-loading, effective-summary, effective-table,
// effective-row (data-level, data-why), account-missing.

import { clear, fill, h } from '../../ui.js';
import { isolate } from '../../widgets/avatar.js';
import { openShareDialog } from '../collections/sharedialog.js';
import { changeAccessDialog, confirmAdminChange, confirmOwnSpaceOff, deleteAccountDialog, resetPasswordFlow } from './dialogs.js';
import { dateText, effectiveRows, guardFor, nameOfHref, pathOf, reachableCount } from './model.js';
import { adminChip, levelSelect, limitsNote, statusChip, tabs, typeChip } from './parts.js';

/** @param {object} env screen environment @param {HTMLElement} host @param {string} login */
export function mountAccount(env, host, login) {
  const { t, tp, app, admin, feedback, lang } = env;
  const who = isolate(login);
  let disposed = false;
  let activeDialog = null;
  let effective = { state: 'loading', rows: [] };
  let allLoaded = false;
  let account = null;
  let ownHost = null;
  let addHost = null;
  let effHost = null;
  const body = h('div', { class: 'users__body account', testid: 'account-view', 'data-login': login });
  host.append(body);

  const snap = () => admin.state;
  const myLogin = () => env.login;

  const guardText = (g) => (g.self ? t('users.guardSelf') : t('users.guardLast'));

  function accountDetails(a) {
    const kv = (label, val, testid) => h('div', { class: 'kv__row' }, h('dt', { class: 'kv__k' }, label), h('dd', { class: 'kv__v', testid }, val));
    return h(
      'dl',
      { class: 'kv', testid: 'account-details' },
      kv(t('users.col.name'), isolate(a.displayName), 'acct-name'),
      kv(t('users.col.type'), typeChip(a, t), 'acct-type'),
      kv(t('users.col.admin'), adminChip(a, t), 'acct-admin'),
      kv(t('users.col.status'), statusChip(a, t), 'acct-status'),
      kv(t('users.col.created'), dateText(a.created, lang), 'acct-created'),
      kv(t('users.col.pwChanged'), dateText(a.passwordChanged, lang) || t('users.never'), 'acct-pwchanged'),
    );
  }

  // ----------------------------------------------------------------- switches

  async function changeOwnSpace(a, box) {
    const want = box.checked;
    const revert = () => {
      box.checked = !want;
    };
    const patch = { ownSpace: want };
    if (!want) {
      const pre = await admin.previewAccountChange({ login, patch });
      if (disposed) return;
      if (!pre.ok) {
        revert();
        return feedback.setAlert(pre.message);
      }
      if (pre.confirmRequired) {
        const count = typeof pre.confirmRequired === 'number' ? pre.confirmRequired : (snap().collectionsByOwner[login] || []).length;
        const yes = await confirmOwnSpaceOff({ t, login, count, win: env.win });
        if (!yes) return revert();
        patch.confirm = login;
      }
    }
    const res = await admin.applyAccountChange({ login, patch });
    if (disposed) return;
    if (!res.ok) revert();
    else feedback.setStatus(res.status === 'pending' ? res.message : t(want ? 'users.ownSpaceOn' : 'users.ownSpaceOffDone', { login: who }));
    await refresh('field-ownspace');
  }

  async function changeAdmin(a, box) {
    const want = box.checked;
    const yes = await confirmAdminChange({ t, login, makeAdmin: want, win: env.win });
    if (!yes) {
      box.checked = !want;
      return;
    }
    const res = await admin.applyAccountChange({ login, patch: { admin: want } });
    if (disposed) return;
    if (res.ok) feedback.setStatus(res.status === 'pending' ? res.message : t(want ? 'users.adminOnDone' : 'users.adminOffDone', { login: who }));
    await refresh('field-acct-admin');
  }

  async function toggleDisabled(a) {
    const next = !a.disabled;
    const res = await admin.applyAccountChange({ login, patch: { disabled: next } });
    if (disposed) return;
    if (res.ok) feedback.setStatus(res.status === 'pending' ? res.message : t(next ? 'users.disabledDone' : 'users.enabledDone', { login: who }));
    await refresh('btn-toggle-disabled');
  }

  async function runReset() {
    activeDialog = 'reset-password';
    let out;
    try {
      out = await resetPasswordFlow({ t, admin, login, win: env.win });
    } finally {
      activeDialog = null;
    }
    if (disposed) return;
    if (out.ok) feedback.setStatus(out.status === 'pending' ? out.message : t('users.resetDone', { login: who }));
    closeRoute();
    await refresh('btn-reset-password');
  }

  async function runDelete(a) {
    activeDialog = 'delete';
    const listed = await admin.loadCollections(login);
    if (disposed) return;
    const grants = snap().grants;
    const counts = { held: grants.filter((g) => g.grantee === login).length, given: grants.filter((g) => g.owner === login).length };
    let choice;
    try {
      choice = await deleteAccountDialog({ t, store: env.store, login, collections: listed.ok ? listed.collections : null, grants: counts, win: env.win });
    } finally {
      activeDialog = null;
    }
    if (disposed) return;
    if (!choice.confirmed) return closeRoute();
    const end = app.readiness.begin();
    const res = await admin.deleteAccount({
      login,
      deleteData: choice.deleteData,
      expected: listed.ok ? listed.collections.map((c) => ({ href: c.href, etag: c.etag || null })) : null,
      onProgress: (p) => {
        if (disposed) return;
        env.setLine(p.phase === 'delete' ? t('users.deleting', { login: who, done: p.done, total: p.total }) : p.phase === 'account' ? t('users.deletingAccount', { login: who }) : t('users.deletingList', { login: who }));
      },
    });
    if (disposed) return end(true);
    if (res.ok) {
      feedback.setStatus(res.status === 'pending' ? res.message : t(choice.deleteData ? 'users.deletedData' : 'users.deletedKept', { login: who }));
      end(true);
      return app.navigate('#/users');
    }
    end(false);
    closeRoute();
    await refresh('btn-delete-account');
  }

  function closeRoute() {
    const q = (env.route() && env.route().query) || {};
    if (q.dialog && !disposed) app.navigate(`#/users/${encodeURIComponent(login)}`, { replace: true });
  }

  // ----------------------------------------------------------------- access

  async function changeLevel({ owner, collection, level, before, sel }) {
    const out = await changeAccessDialog({ t, admin, grant: { owner, collection, grantee: login, level }, before, win: env.win });
    if (disposed) return;
    if (!out.applied) {
      if (sel) {
        sel.value = before;
      }
      return;
    }
    feedback.setStatus(out.result && out.result.status === 'pending' ? out.result.message : level === 'none' ? t('perm.removed', { login: who, path: pathOf(owner, collection) }) : t('perm.applied', { login: who, path: pathOf(owner, collection), level: t(`perm.phrase.${level}`) }));
    await refresh(sel ? null : 'btn-add-access', { focusSel: sel ? `[data-testid="grant-select"][data-owner="${owner}"][data-coll="${collection}"]` : null });
  }

  function ownSection(a, state) {
    const own = state.collectionsByOwner[login] || [];
    if (!own.length) return h('p', { class: 'muted', testid: 'own-none' }, t(a.ownSpace ? 'users.ownNone' : 'users.ownDisabledNone'));
    return h(
      'ul',
      { class: 'rows' },
      own.map((c) => {
        const name = nameOfHref(c.href);
        const grantees = state.grants.filter((g) => g.owner === login && g.collection === name).map((g) => `${g.grantee} (${t(`perm.phrase.${g.level}`)})`);
        return h(
          'li',
          null,
          h(
            'div',
            { class: 'row', testid: 'own-collection', 'data-href': c.href, 'data-uid': name },
            h('span', { class: 'row__main' }, h('span', { class: 'row__title' }, isolate(c.displayName || name)), h('span', { class: 'row__sub' }, pathOf(login, name)), h('span', { class: 'row__sub', testid: 'own-shared' }, grantees.length ? t('users.sharedWith', { list: grantees.join(', ') }) : t('users.private'))),
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                testid: 'btn-share',
                'aria-label': t('share.openNamed', { name: isolate(c.displayName || name) }),
                on: { click: () => shareFor(c) },
              },
              t('share.open'),
            ),
          ),
        );
      }),
    );
  }

  async function shareFor(c) {
    const out = await openShareDialog({ t, tp, app, store: env.store, admin, isAdmin: true, win: env.win, collection: { owner: login, name: nameOfHref(c.href), href: c.href, displayName: c.displayName || '' } });
    if (!disposed && out && out.applied) await refresh('btn-share');
  }

  function grantsSection(a, state) {
    const mine = state.grants.filter((g) => g.grantee === login);
    if (!mine.length) return h('p', { class: 'muted', testid: 'grants-none' }, t('users.grantsNone', { login: who }));
    const rows = mine.map((g) =>
      h(
        'tr',
        { testid: 'grant-row', 'data-owner': g.owner, 'data-coll': g.collection },
        h('th', { scope: 'row', 'data-label': t('perm.collection') }, g.collection, h('span', { class: 'matrix__path' }, pathOf(g.owner, g.collection))),
        h(
          'td',
          { 'data-label': t('perm.access') },
          levelSelect({
            t,
            login,
            owner: g.owner,
            coll: g.collection,
            value: g.level,
            testid: 'grant-select',
            onChange: (value, sel) => {
              const before = sel.getAttribute('data-prev') || g.level;
              changeLevel({ owner: g.owner, collection: g.collection, level: value, before, sel });
            },
          }),
        ),
      ),
    );
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'table table--stack', testid: 'grants-table' },
        h('caption', { class: 'visually-hidden' }, t('users.grantsCaption', { login: who })),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('perm.collection')), h('th', { scope: 'col' }, t('perm.access')))),
        h('tbody', null, rows),
      ),
    );
  }

  function addAccessSection(a, state) {
    if (a.admin) return h('p', { class: 'muted small' }, t('users.adminFull'));
    if (a.disabled) return h('p', { class: 'muted small', testid: 'add-access-disabled' }, t('users.disabledNoGrant', { login: who }));
    if (!allLoaded) return h('p', { class: 'muted small', role: 'status', testid: 'add-access-loading' }, t('users.addLoading'));
    const options = [];
    for (const owner of Object.keys(state.collectionsByOwner).sort()) {
      if (owner === login) continue;
      for (const c of state.collectionsByOwner[owner]) {
        const name = nameOfHref(c.href);
        if (state.grants.some((g) => g.owner === owner && g.collection === name && g.grantee === login)) continue;
        options.push({ owner, name, label: c.displayName ? `${c.displayName} (${pathOf(owner, name)})` : pathOf(owner, name) });
      }
    }
    if (!options.length) return h('p', { class: 'muted small', testid: 'add-access-none' }, t('users.allGranted'));
    const coll = h('select', { class: 'input', id: 'add-coll', testid: 'field-add-coll' }, options.map((o) => h('option', { value: `${o.owner}/${o.name}` }, o.label)));
    const level = h('select', { class: 'input', id: 'add-level', testid: 'field-add-level' }, ['read', 'readwrite'].map((l) => h('option', { value: l }, t(`perm.${l}`))));
    const submit = h('button', { type: 'submit', class: 'btn btn--primary', testid: 'btn-add-access', write: true, 'aria-label': t('users.addAccessNamed', { login: who }) }, t('users.addAccess'));
    const form = h(
      'form',
      { class: 'inline-form', novalidate: true, testid: 'add-access-form' },
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'add-coll' }, t('perm.collection')), coll),
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'add-level' }, t('perm.access')), level),
      submit,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const [owner, ...rest] = String(coll.value).split('/');
      changeLevel({ owner, collection: rest.join('/'), level: level.value, before: 'none', sel: null });
    });
    return form;
  }

  function effectiveSection(a) {
    if (effective.state === 'loading') return h('p', { class: 'muted small', role: 'status', testid: 'effective-summary' }, t('perm.effectiveLoading'));
    if (effective.state === 'failed') return h('p', { class: 'muted small', role: 'alert', testid: 'effective-summary' }, t('perm.effectiveFailed'));
    const rows = effectiveRows(effective.rows);
    const yes = (ok) => h('span', { class: ['yn', ok ? 'is-yes' : 'is-no'] }, ok ? t('users.yes') : t('users.no'));
    const summary = a.disabled ? t('perm.effectiveDisabled', { login: who }) : t('perm.effectiveIntro', { login: who, n: tp('users.nColls', reachableCount(effective.rows)) });
    return h(
      'div',
      null,
      h('p', { class: 'muted small', testid: 'effective-summary' }, summary),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'table table--stack', testid: 'effective-table' },
          h('caption', { class: 'visually-hidden' }, t('perm.effectiveCaption', { login: who })),
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('perm.collection')), h('th', { scope: 'col' }, t('perm.canView')), h('th', { scope: 'col' }, t('perm.canChange')), h('th', { scope: 'col' }, t('perm.because')))),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                { testid: 'effective-row', 'data-path': r.path, 'data-level': r.level, 'data-why': r.why },
                h('th', { scope: 'row', 'data-label': t('perm.collection') }, h('span', { class: 'matrix__path' }, r.path)),
                h('td', { 'data-label': t('perm.canView') }, yes(r.canView)),
                h('td', { 'data-label': t('perm.canChange') }, yes(r.canChange)),
                h('td', { 'data-label': t('perm.because') }, t(`perm.why.${r.why}`)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ render

  function render(focusTestid = null, { focusSel = null } = {}) {
    const state = snap();
    account = state.accounts.find((a) => a.login === login) || null;
    if (!account) {
      fill(
        body,
        h('div', { class: 'toolbar' }, tabs('accounts', t)),
        h('section', { class: 'empty', testid: 'account-missing', role: 'alert' }, h('h2', { class: 'section-title' }, t('users.missing')), h('a', { class: 'btn btn--primary', href: '#/users', testid: 'btn-back-users' }, t('nav.users'))),
      );
      env.setLine(t('users.missing'));
      return;
    }
    const a = account;
    const g = guardFor(a, state.accounts, myLogin());
    ownHost = h('div', { testid: 'own-host' });
    addHost = h('div', { testid: 'add-access-host' });
    effHost = h('div', { testid: 'effective-host' });
    const ownBox = h('input', { type: 'checkbox', id: 'acct-ownspace-toggle', testid: 'field-ownspace', checked: a.ownSpace, write: true });
    ownBox.addEventListener('change', () => changeOwnSpace(a, ownBox));
    const adminBox = h('input', { type: 'checkbox', id: 'acct-admin-toggle', testid: 'field-acct-admin', checked: a.admin, 'aria-describedby': g.locked ? 'acct-guard' : null, disabled: g.locked || null, write: true });
    adminBox.addEventListener('change', () => changeAdmin(a, adminBox));
    const guardEl = g.locked ? h('p', { class: 'field__hint', id: 'acct-guard', testid: 'acct-guard', 'data-reason': g.reason }, guardText(g)) : null;
    const lock = (props) => (g.locked ? { ...props, 'aria-disabled': 'true', 'aria-describedby': 'acct-guard' } : props);
    const guarded = (fn) => () => {
      if (g.locked) return;
      fn();
    };
    const resetBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn',
        testid: 'btn-reset-password',
        write: true,
        ...(g.self ? { 'aria-disabled': 'true', 'aria-describedby': 'acct-self-pw' } : {}),
        'aria-label': t('users.resetNamed', { login: who }),
        on: {
          click: () => {
            if (g.self) return;
            runReset();
          },
        },
      },
      t('users.reset'),
    );
    const actions = h(
      'div',
      { class: 'detail__actions', testid: 'account-actions' },
      resetBtn,
      h('button', { type: 'button', class: 'btn', ...lock({ testid: 'btn-toggle-disabled', write: true, 'aria-label': t(a.disabled ? 'users.enableNamed' : 'users.disableNamed', { login: who }) }), on: { click: guarded(() => toggleDisabled(a)) } }, t(a.disabled ? 'users.enable' : 'users.disable')),
      h('button', { type: 'button', class: 'btn btn--danger-quiet', ...lock({ testid: 'btn-delete-account', write: true, 'aria-label': t('users.deleteNamed', { login: who }) }), on: { click: guarded(() => runDelete(a)) } }, t('users.delete')),
    );
    const selfPw = g.self ? h('p', { class: 'field__hint', id: 'acct-self-pw', testid: 'acct-self-pw' }, t('users.selfPassword'), ' ', h('a', { href: '#/settings', testid: 'btn-own-settings' }, t('users.selfPasswordLink'))) : null;
    const adminBlock = a.type === 'bot' ? h('p', { class: 'field__hint', testid: 'acct-admin-bot' }, t('users.adminBotHint')) : h('div', { class: 'check-block' }, h('div', { class: 'check' }, adminBox, h('label', { for: 'acct-admin-toggle' }, t('users.adminLabel'))), h('p', { class: 'field__hint' }, t('users.adminHint')));
    fill(
      body,
      h('div', { class: 'toolbar' }, tabs('accounts', t)),
      h(
        'section',
        { class: 'card-section', 'aria-labelledby': 'acct-h' },
        h('h2', { class: 'section-title', id: 'acct-h' }, t('users.account')),
        accountDetails(a),
        h('div', { class: 'check-block' }, h('div', { class: 'check' }, ownBox, h('label', { for: 'acct-ownspace-toggle' }, t('users.ownSpaceLabel'))), h('p', { class: 'field__hint' }, t('users.ownSpaceHint'))),
        adminBlock,
        actions,
        guardEl,
        selfPw,
      ),
      h(
        'section',
        { class: 'card-section', 'aria-labelledby': 'access-h', testid: 'access-section' },
        h('h2', { class: 'section-title section-title--lg', id: 'access-h', testid: 'access-title' }, t('users.whatCanAccess', { login: who })),
        limitsNote(t),
        h('h3', { class: 'sub-title' }, t('users.ownSpace')),
        ownHost,
        h('h3', { class: 'sub-title' }, t('users.grantedBy')),
        grantsSection(a, state),
        addHost,
        h('h3', { class: 'sub-title' }, t('perm.effectiveTitle')),
        effHost,
      ),
    );
    fillHosts();
    env.setLine(t('users.accountStatus', { login: who, state: t(a.disabled ? 'users.disabled' : 'users.active') }));
    const sel = focusSel ? body.querySelector(focusSel) : null;
    const target = sel || (focusTestid ? body.querySelector(`[data-testid="${focusTestid}"]`) : null);
    if (target && typeof target.focus === 'function') target.focus();
  }

  /** The parts that arrive after the first draw are filled in place: nothing else moves, no focus is stolen. */
  function fillHosts() {
    if (!account || !ownHost) return;
    const state = snap();
    fill(ownHost, ownSection(account, state));
    fill(addHost, addAccessSection(account, state));
    fill(effHost, effectiveSection(account));
  }

  async function loadEffective() {
    effective = { state: 'loading', rows: [] };
    const res = await admin.effective(login);
    if (disposed) return;
    effective = res.ok ? { state: 'ready', rows: res.effective } : { state: 'failed', rows: [] };
  }

  /** Read the model again (cheap) and redraw, keeping the focus on `focusTestid`. */
  async function refresh(focusTestid, opts) {
    const res = await admin.load();
    if (disposed) return;
    if (!res.ok) return;
    await loadEffective();
    if (disposed) return;
    render(focusTestid, opts);
  }

  function applyRoute() {
    const route = env.route();
    const q = (route && route.query) || {};
    if (!q.dialog || activeDialog || !account) return;
    if (q.dialog === 'reset-password') {
      if (guardFor(account, snap().accounts, myLogin()).self) return closeRoute();
      runReset();
    } else if (q.dialog === 'delete') {
      if (guardFor(account, snap().accounts, myLogin()).locked) return closeRoute();
      runDelete(account);
    } else closeRoute();
  }

  async function load() {
    const res = await admin.load();
    if (disposed) return { ok: true };
    if (!res.ok) return res;
    allLoaded = false;
    effective = { state: 'loading', rows: [] };
    render();
    // the rest arrives without holding the screen: own collections, effective access, every collection to choose from
    const [, eff] = await Promise.all([admin.loadCollections(login), admin.effective(login)]);
    if (disposed) return { ok: true };
    effective = eff.ok ? { state: 'ready', rows: eff.effective } : { state: 'failed', rows: [] };
    fillHosts();
    applyRoute();
    admin.load({ collections: true }).then((full) => {
      if (disposed || !full.ok) return;
      allLoaded = true;
      fillHosts();
    });
    return { ok: true };
  }

  return {
    load,
    update() {
      applyRoute();
    },
    dispose() {
      disposed = true;
      clear(body);
    },
  };
}
