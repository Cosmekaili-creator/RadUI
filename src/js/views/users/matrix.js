// SPDX-License-Identifier: AGPL-3.0-or-later
// `#/users/permissions` (`?dialog=change&account=&href=&level=` and `?dialog=share&href=`): the permission matrix.
// A real <table>: one row per collection (owner/name), one column per enabled non-admin account, at most 12 columns
// at a time (the filter narrows them; the per-account view is the scalable path). Every cell is a <select> (never
// click-cycling); a change opens the preview dialog (a dry run first) and only its confirm button applies it.
// Owner cells are fixed text. The rights-limits note is on the page (SPECS 10b-3).
//
// Test ids: permission-matrix, matrix-account (data-login), matrix-row (data-owner, data-uid, data-href), perm-select
// (data-login, data-coll, data-owner), perm-fixed, matrix-region, matrix-account-link, matrix-filter, matrix-status, matrix-empty, btn-share,
// rights-limits-note.

import { fill, h } from '../../ui.js';
import { isolate } from '../../widgets/avatar.js';
import { openShareDialog } from '../collections/sharedialog.js';
import { changeAccessDialog } from './dialogs.js';
import { MATRIX_MAX_COLUMNS, buildMatrix, levelOf, parseLevel, pathOf, sameHref } from './model.js';
import { levelSelect, limitsNote, tabs, typeChip } from './parts.js';

/** @param {object} env screen environment @param {HTMLElement} host */
export function mountMatrix(env, host) {
  const { t, admin, app, feedback } = env;
  let disposed = false;
  let activeDialog = null;
  let filter = '';
  let state = null;
  const tableHost = h('div', { class: 'matrix-host' });
  const status = h('p', { class: 'muted small', role: 'status', testid: 'matrix-status' });
  const filterIn = h('input', { type: 'search', class: 'input input--compact', id: 'matrix-filter', testid: 'matrix-filter', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'matrix-status-hint' });
  const filterBox = h('div', { class: 'field matrix__filter' }, h('label', { class: 'field__label', for: 'matrix-filter' }, t('perm.filterLabel')), filterIn, h('p', { class: 'field__hint', id: 'matrix-status-hint' }, t('perm.filterHint', { n: MATRIX_MAX_COLUMNS })));
  const body = h('div', { class: 'users__body' }, h('div', { class: 'toolbar' }, tabs('permissions', t)), h('p', { class: 'muted' }, t('perm.matrixIntro')), limitsNote(t), filterBox, status, tableHost);
  host.append(body);

  const model = () => buildMatrix({ accounts: state.accounts, collectionsByOwner: state.collectionsByOwner, filter, cap: MATRIX_MAX_COLUMNS });

  function renderTable() {
    const m = model();
    const shown = m.columns.length;
    status.textContent = m.hiddenColumns > 0 ? t('perm.matrixCapped', { shown, total: m.matchingColumns }) : t('perm.matrixShown', { shown, rows: m.rows.length });
    env.setLine(`${t('perm.matrixSummary', { rows: m.rows.length, accounts: m.totalColumns })}`);
    if (!m.rows.length) {
      fill(tableHost, h('p', { class: 'muted', testid: 'matrix-empty' }, t('perm.matrixEmpty')));
      return;
    }
    if (!m.columns.length) {
      fill(tableHost, h('p', { class: 'muted', testid: 'matrix-empty' }, t(m.totalColumns ? 'perm.matrixNoMatch' : 'perm.matrixNoAccounts')));
      return;
    }
    const head = h(
      'tr',
      null,
      h('th', { scope: 'col', class: 'matrix__corner' }, t('perm.collection')),
      m.columns.map((a) =>
        h(
          'th',
          { scope: 'col', class: 'matrix__acct', testid: 'matrix-account', 'data-login': a.login },
          h('a', { class: 'link-strong', href: `#/users/${encodeURIComponent(a.login)}`, testid: 'matrix-account-link', 'aria-label': t('users.open', { login: isolate(a.login) }) }, isolate(a.login)),
          h('span', { class: 'matrix__chips' }, typeChip(a, t)),
        ),
      ),
    );
    const rows = m.rows.map((r) =>
      h(
        'tr',
        { testid: 'matrix-row', 'data-owner': r.owner, 'data-uid': r.name, 'data-href': r.href },
        h(
          'th',
          { scope: 'row', class: 'matrix__coll' },
          h('span', { class: 'matrix__name' }, isolate(r.displayName || r.name)),
          h('span', { class: 'matrix__path' }, r.path),
          h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-share', 'aria-label': t('share.openNamed', { name: isolate(r.displayName || r.path) }), on: { click: () => shareFor(r) } }, t('share.open')),
        ),
        m.columns.map((a) => {
          const cell = (kid) => h('td', { class: 'matrix__cell', 'data-label': a.login, 'data-login': a.login, 'data-coll': r.name }, kid);
          if (a.login === r.owner) return cell(h('span', { class: 'perm-fixed', testid: 'perm-fixed', 'data-why': 'owner' }, t('perm.fixed.owner')));
          return cell(
            levelSelect({
              t,
              login: a.login,
              owner: r.owner,
              coll: r.name,
              label: r.path,
              value: levelOf(state.grants, r.owner, r.name, a.login),
              onChange: (value, sel) => change({ row: r, login: a.login, level: value, sel }),
            }),
          );
        }),
      ),
    );
    fill(
      tableHost,
      h(
        'div',
        { class: 'table-wrap matrix-wrap', role: 'region', tabindex: '0', 'aria-label': t('perm.matrixRegion'), testid: 'matrix-region' },
        h('table', { class: 'matrix', testid: 'permission-matrix' }, h('caption', { class: 'visually-hidden' }, t('perm.matrixCaption')), h('thead', null, head), h('tbody', null, rows)),
      ),
    );
  }

  /** One change: preview dialog, then apply; the select goes back to the old value unless it was applied. */
  async function change({ row, login, level, sel }) {
    const before = (sel && sel.getAttribute('data-prev')) || levelOf(state.grants, row.owner, row.name, login);
    activeDialog = 'change';
    let out;
    try {
      out = await changeAccessDialog({ t, admin, grant: { owner: row.owner, collection: row.name, grantee: login, level }, before, label: row.path, win: env.win });
    } finally {
      activeDialog = null;
    }
    if (disposed) return;
    if (out.applied) {
      state = admin.state;
      if (sel) sel.setAttribute('data-prev', level);
      feedback.setStatus(out.result.status === 'pending' ? out.result.message : level === 'none' ? t('perm.removed', { login: isolate(login), path: row.path }) : t('perm.applied', { login: isolate(login), path: row.path, level: t(`perm.phrase.${level}`) }));
    } else if (sel) sel.value = before;
    closeRoute();
  }

  async function shareFor(row) {
    activeDialog = 'share';
    let out;
    try {
      out = await openShareDialog({ t, tp: env.tp, app, store: env.store, admin, isAdmin: true, win: env.win, collection: { owner: row.owner, name: row.name, href: row.href, displayName: row.displayName } });
    } finally {
      activeDialog = null;
    }
    if (disposed) return;
    if (out && out.applied) {
      state = admin.state;
      renderTable();
    }
    closeRoute();
  }

  function closeRoute() {
    const q = (env.route() && env.route().query) || {};
    if (q.dialog && !disposed) app.navigate('#/users/permissions', { replace: true });
  }

  function findRow(href) {
    return model().rows.find((r) => sameHref(r.href, href)) || null;
  }

  function applyRoute() {
    const q = (env.route() && env.route().query) || {};
    if (!q.dialog || activeDialog || !state) return;
    if (q.dialog === 'change') {
      const row = findRow(q.href);
      const acct = state.accounts.find((a) => a.login === q.account);
      const level = parseLevel(q.level);
      if (!row || !acct || acct.admin || acct.disabled || acct.login === row.owner || !level) {
        feedback.setAlert(t('perm.badLink'));
        return closeRoute();
      }
      if (levelOf(state.grants, row.owner, row.name, acct.login) === level) {
        feedback.setStatus(t('perm.noChange', { login: isolate(acct.login), path: row.path }));
        return closeRoute();
      }
      change({ row, login: acct.login, level, sel: null });
    } else if (q.dialog === 'share') {
      const row = findRow(q.href);
      if (!row) {
        feedback.setAlert(t('perm.badLink'));
        return closeRoute();
      }
      shareFor(row);
    } else closeRoute();
  }

  filterIn.addEventListener('input', () => {
    filter = filterIn.value;
    if (state) renderTable();
  });

  return {
    async load() {
      const res = await admin.load({ collections: true });
      if (disposed) return { ok: true };
      if (!res.ok) return res;
      state = admin.state;
      renderTable();
      applyRoute();
      return { ok: true };
    },
    update() {
      applyRoute();
    },
    snapshot: () => ({ kind: 'matrix', filter }),
    dispose() {
      disposed = true;
    },
  };
}
