// SPDX-License-Identifier: AGPL-3.0-or-later
// `#/users`: the accounts table (a real <table>): login, display name, type, administrator, status, created,
// password changed and the number of collections the account owns (read afterwards, two principals at a time).
//
// Test ids: accounts-table, account-row (data-login, data-uid), account-link, own-count (data-count, aria-busy),
// accounts-region (the focusable scroll region), btn-new-account, plus chip-type / chip-admin / chip-status of parts.js. The status line `users-status` belongs
// to the screen: "6 accounts, 2 disabled".

import { h, fill } from '../../ui.js';
import { isolate } from '../../widgets/avatar.js';
import { adminChip, statusChip, tabs, typeChip } from './parts.js';
import { countAccounts, dateText } from './model.js';

export function statusText({ t, tp }, accounts) {
  const { total, disabled } = countAccounts(accounts);
  return [tp('users.count', total), disabled ? tp('users.countDisabled', disabled) : null].filter(Boolean).join(' · ');
}

/** @param {object} env screen environment (see screen.js) @param {HTMLElement} host */
export function mountAccounts(env, host) {
  const { t, tp, admin, lang } = env;
  let disposed = false;
  let abort = new AbortController();
  const body = h('div', { class: 'users__body' });
  host.append(body);

  const th = (key) => h('th', { scope: 'col' }, t(key));

  function ownCell(a, state) {
    const cell = h('td', { 'data-label': t('users.col.own'), testid: 'own-count', 'aria-busy': 'true', 'data-count': '' }, '…');
    paintCount(cell, a, state);
    return cell;
  }

  /** Fill one "own collections" cell from what is known now. */
  function paintCount(cell, a, state) {
    const list = state.collectionsByOwner[a.login];
    const failed = state.collectionErrors[a.login];
    if (a.disabled || !a.ownSpace) {
      const n = list ? list.length : 0;
      cell.setAttribute('aria-busy', 'false');
      cell.setAttribute('data-count', list ? String(n) : '');
      fill(cell, a.ownSpace ? '–' : [h('span', { class: 'muted' }, t('users.ownSpaceOffShort'))]);
      return;
    }
    if (failed) {
      cell.setAttribute('aria-busy', 'false');
      cell.setAttribute('data-count', '');
      fill(cell, h('span', { class: 'muted', title: t('users.countFailed') }, '?'));
      return;
    }
    if (!list) return;
    cell.setAttribute('aria-busy', 'false');
    cell.setAttribute('data-count', String(list.length));
    fill(cell, String(list.length));
  }

  function render(accounts, state) {
    const cells = new Map();
    const rows = accounts.map((a) => {
      const td = (labelKey, ...kids) => h('td', { 'data-label': t(labelKey) }, ...kids);
      const own = ownCell(a, state);
      cells.set(a.login, own);
      return h(
        'tr',
        { testid: 'account-row', 'data-login': a.login, 'data-uid': a.login, class: a.disabled ? 'is-disabled' : null },
        h('th', { scope: 'row', 'data-label': t('users.col.login') }, h('a', { class: 'link-strong link-login', title: a.login, href: `#/users/${encodeURIComponent(a.login)}`, testid: 'account-link', 'aria-label': t('users.open', { login: isolate(a.login) }) }, isolate(a.login))),
        td('users.col.name', isolate(a.displayName)),
        td('users.col.type', typeChip(a, t)),
        td('users.col.admin', adminChip(a, t)),
        td('users.col.status', statusChip(a, t)),
        td('users.col.created', dateText(a.created, lang)),
        td('users.col.pwChanged', dateText(a.passwordChanged, lang) || t('users.never')),
        own,
      );
    });
    fill(
      body,
      h('div', { class: 'toolbar' }, tabs('accounts', t), h('div', { class: 'toolbar__end' }, h('a', { class: 'btn btn--primary', href: '#/users/new', testid: 'btn-new-account' }, t('users.new')))),
      h(
        'div',
        { class: 'table-wrap', role: 'region', tabindex: '0', 'aria-label': t('users.tableRegion'), testid: 'accounts-region' },
        h(
          'table',
          { class: 'table table--stack', testid: 'accounts-table' },
          h('caption', { class: 'visually-hidden' }, t('users.caption')),
          h('thead', null, h('tr', null, th('users.col.login'), th('users.col.name'), th('users.col.type'), th('users.col.admin'), th('users.col.status'), th('users.col.created'), th('users.col.pwChanged'), th('users.col.own'))),
          h('tbody', null, rows),
        ),
      ),
      h('p', { class: 'muted small' }, t('users.listNote')),
    );
    return cells;
  }

  async function load() {
    abort.abort();
    abort = new AbortController();
    const mine = abort.signal;
    const res = await admin.load();
    if (disposed || mine.aborted) return { ok: true };
    if (!res.ok) return res;
    const cells = render(res.accounts, res);
    env.setLine(statusText(env, res.accounts));
    // The collection counts come afterwards: the table is usable at once.
    admin.load({ collections: true }).then((full) => {
      if (disposed || mine.aborted) return;
      if (!full.ok) {
        // the whole second read failed: no cell may stay "busy" for ever
        for (const cell of cells.values()) {
          if (cell.getAttribute('aria-busy') !== 'true') continue;
          cell.setAttribute('aria-busy', 'false');
          cell.setAttribute('data-count', '');
          fill(cell, h('span', { class: 'muted', title: t('users.countFailed') }, '?'));
        }
        return;
      }
      for (const a of full.accounts) {
        const cell = cells.get(a.login);
        if (cell) paintCount(cell, a, full);
      }
    });
    return { ok: true };
  }

  return {
    load,
    update() {},
    dispose() {
      disposed = true;
      abort.abort();
    },
  };
}
