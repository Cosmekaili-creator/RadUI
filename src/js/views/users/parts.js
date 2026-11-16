// SPDX-License-Identifier: AGPL-3.0-or-later
// Small pieces shared by the Users screens and the dialogs: chips, the rights-limits note, the section tabs, the
// level <select> of the matrix, the account view and the sharing dialog, the password strength meter, and the
// "administrator access required" state. DOM through h() only; every name that comes from the server is text.
//
// Test ids: chip-type, chip-admin, chip-status, rights-limits-note, users-tab-accounts, users-tab-permissions,
// perm-select (+ perm-option-none|r|rw), pw-strength (+ pw-strength-text), access-required, btn-home.

import { h } from '../../ui.js';
import { LEVELS, LEVEL_OPTION_ID, strength } from './model.js';

export const typeChip = (a, t) => h('span', { class: 'tag tag--quiet', testid: 'chip-type', 'data-type': a.type || '' }, a.type === 'bot' ? t('users.type.bot') : t('users.type.person'));
export const statusChip = (a, t) => h('span', { class: ['tag', a.disabled ? 'tag--warn' : 'tag--ok'], testid: 'chip-status', 'data-status': a.disabled ? 'disabled' : 'active' }, a.disabled ? t('users.disabled') : t('users.active'));
export const adminChip = (a, t) => h('span', { class: ['tag', a.admin && 'tag--accent'], testid: 'chip-admin', 'data-admin': a.admin ? 'yes' : 'no' }, a.admin ? t('users.adminYes') : t('users.adminNo'));

/** The "two levels only" note (SPECS 10b-3), on every permission screen and in the sharing dialog. */
export const limitsNote = (t) => h('aside', { class: 'notice notice--quiet', testid: 'rights-limits-note' }, h('span', null, t('perm.limits')));

/** Accounts / Permissions tabs. `active` is 'accounts' or 'permissions'. */
export function tabs(active, t) {
  return h(
    'nav',
    { class: 'seg users__tabs', 'aria-label': t('users.sections') },
    h('a', { class: 'seg__item', href: '#/users', testid: 'users-tab-accounts', 'aria-current': active === 'accounts' ? 'page' : null }, t('users.tab.accounts')),
    h('a', { class: 'seg__item', href: '#/users/permissions', testid: 'users-tab-permissions', 'aria-current': active === 'permissions' ? 'page' : null }, t('users.tab.permissions')),
  );
}

/** What a non-admin sees on any `#/users*` route. */
export function accessRequired({ t, login }) {
  return h(
    'section',
    { class: 'users__denied', role: 'alert', testid: 'access-required' },
    h('h2', { class: 'section-title' }, t('users.denied.title')),
    h('p', null, login ? t('users.denied.text', { user: login }) : t('users.denied.textAnon')),
    h('a', { class: 'btn btn--primary', href: '#/collections', testid: 'btn-home' }, t('nav.collections')),
  );
}

/**
 * A <select> with the three levels. The select's name is a full sentence ("Access of bob to alice/cal"), and each
 * option carries the sentence it stands for as `aria-label`, so a screen reader or an agent never has to guess.
 * @param {object} o
 * @param {(key: string, p?: object) => string} o.t
 * @param {string} o.login grantee   @param {string} o.owner @param {string} o.coll  technical collection name
 * @param {string} [o.label] how the collection is named in sentences (default `owner/coll`)
 * @param {'none'|'read'|'readwrite'} o.value
 * @param {string} [o.testid='perm-select']
 * @param {(value: string, el: HTMLElement) => void} [o.onChange]
 */
export function levelSelect({ t, login, owner, coll, label, value, testid = 'perm-select', onChange, disabled = false }) {
  const name = label || `${owner}/${coll}`;
  const sel = h(
    'select',
    { class: 'input input--compact perm-select', testid, 'data-login': login, 'data-coll': coll, 'data-owner': owner, 'data-prev': value, 'aria-label': t('perm.selectName', { login, coll: name }), disabled: disabled || null },
    LEVELS.map((l) =>
      h(
        'option',
        {
          value: l,
          selected: l === value,
          testid: `perm-option-${LEVEL_OPTION_ID[l]}`,
          'aria-label': l === 'none' ? t('perm.opt.none', { login, coll: name }) : t('perm.opt.give', { login, coll: name, level: t(`perm.phrase.${l}`) }),
        },
        t(`perm.${l}`),
      ),
    ),
  );
  if (onChange) sel.addEventListener('change', () => onChange(sel.value, sel));
  return sel;
}

/** Password strength meter: a bar and the word (never colour alone). `meter.set(score)`. */
export function strengthMeter(t) {
  const segs = [0, 1, 2, 3].map(() => h('span', { class: 'strength__seg' }));
  const text = h('span', { class: 'strength__text', testid: 'pw-strength-text' });
  const el = h('div', { class: 'strength', role: 'meter', 'aria-label': t('pw.strength'), 'aria-valuemin': '0', 'aria-valuemax': '4', 'aria-valuenow': '0', testid: 'pw-strength' }, h('span', { class: 'strength__bar', 'aria-hidden': 'true' }, segs), text);
  el.set = (score) => {
    const label = t(`pw.score.${score}`);
    el.setAttribute('aria-valuenow', String(score));
    el.setAttribute('aria-valuetext', label);
    el.setAttribute('data-score', String(score));
    text.textContent = `${t('pw.strength')}: ${label}`;
    segs.forEach((seg, i) => seg.classList.toggle('is-on', i < score));
  };
  el.measure = (pw, login) => el.set(strength(pw, login));
  el.set(0);
  return el;
}
