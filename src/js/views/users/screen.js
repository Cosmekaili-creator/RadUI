// SPDX-License-Identifier: AGPL-3.0-or-later
// The Users section (administrators only): `#/users` (accounts), `#/users/new` (create), `#/users/permissions`
// (matrix) and `#/users/:login` (one account). ONE mounted controller serves all four routes (the registry maps
// them to this module); it reads `route.name`. A non-administrator sees `access-required` (role=alert) whatever
// the navigation shows: the page never relies on the hidden nav entry, and the account service refuses anyway.
//
// mount(ctx) -> {title, update(ctx), snapshot(), dispose()}
//
// Test ids: users-screen (data-state, aria-busy), users-title, users-status (role=status), users-error (+
// users-error-text, btn-retry), access-required, plus the ids of accounts.js, form.js, account.js and matrix.js.

import { fill, h } from '../../ui.js';
import { mountAccount } from './account.js';
import { mountAccounts } from './accounts.js';
import { adminStoreFor } from './adminstore.js';
import { mountForm } from './form.js';
import { mountMatrix } from './matrix.js';
import { accessRequired } from './parts.js';

const TITLES = { users: 'nav.users', 'user-new': 'users.new', 'users-permissions': 'users.tab.permissions' };

export function mount(ctx) {
  const { root, t, app, signal } = ctx;
  let current = ctx;
  let disposed = false;
  let store = null;
  let admin = null;
  let me = null;
  let view = null;
  let viewKey = null;
  let seq = 0; // a newer navigation makes an older load stop touching the page

  const titleEl = h('h1', { class: 'page-title', id: 'users-title', tabindex: '-1' });
  const line = h('p', { class: 'page-sub muted', role: 'status', testid: 'users-status' });
  const errorText = h('p', { testid: 'users-error-text' });
  const retry = h('button', { type: 'button', class: 'btn', testid: 'btn-retry', on: { click: () => reload() } }, t('users.retry'));
  const errorBox = h('div', { class: 'notice notice--warn', role: 'alert', testid: 'users-error', hidden: true }, errorText, retry);
  const host = h('div', { class: 'users__host' });
  const screenEl = h('section', { class: 'users', testid: 'users-screen', 'data-state': 'loading', 'aria-busy': 'true', 'aria-labelledby': 'users-title' }, titleEl, line, errorBox, host);
  root.append(screenEl);

  const setState = (state) => {
    screenEl.setAttribute('data-state', state);
    screenEl.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  };
  const env = {
    t,
    tp: ctx.tp,
    app,
    get lang() {
      return app.lang || 'en';
    },
    feedback: app.feedback,
    win: typeof globalThis.window === 'object' ? globalThis.window : undefined,
    route: () => current.route || {},
    restore: ctx.restore,
    setLine: (text) => {
      line.textContent = text || '';
    },
    get store() {
      return store;
    },
    get admin() {
      return admin;
    },
    get login() {
      return (me && me.login) || (store && store.session && store.session.login) || '';
    },
  };

  function titleFor(route) {
    if (route.name === 'user') return (route.params && route.params.login) || (current.params && current.params.login) || t('nav.users');
    return t(TITLES[route.name] || 'nav.users');
  }

  function showError(res) {
    errorText.textContent = (res && res.message) || t('users.error');
    errorBox.hidden = false;
    setState('error');
  }

  function showDenied() {
    if (view) {
      view.dispose();
      view = null;
    }
    errorBox.hidden = true;
    env.setLine('');
    fill(host, accessRequired({ t, login: me && me.login }));
    setState('ready');
  }

  async function isAdminNow() {
    try {
      me = typeof app.getMe === 'function' ? await app.getMe() : null;
    } catch {
      me = null;
    }
    if (me) return me.admin === true;
    return typeof app.isAdmin === 'function' ? app.isAdmin() === true : false;
  }

  function buildView(route) {
    if (route.name === 'user-new') return mountForm(env, host);
    if (route.name === 'users-permissions') return mountMatrix(env, host);
    if (route.name === 'user') return mountAccount(env, host, String((route.params && route.params.login) || (current.params && current.params.login) || ''));
    return mountAccounts(env, host);
  }

  async function start() {
    const mine = ++seq;
    const route = current.route || { name: 'users' };
    const key = `${route.name}:${(route.params && route.params.login) || ''}`;
    titleEl.textContent = titleFor(route);
    errorBox.hidden = true;
    setState('loading');
    const end = app.readiness.begin();
    try {
      if (!(await isAdminNow())) {
        if (disposed || mine !== seq) return end(true);
        showDenied();
        return end(true);
      }
      store = store || (await app.getStore());
      if (disposed || mine !== seq) return end(true);
      admin = admin || adminStoreFor({ app, store });
      if (view) view.dispose();
      fill(host);
      view = buildView(route);
      viewKey = key;
      const res = await view.load();
      if (disposed || mine !== seq || signal.aborted) return end(true);
      if (!res.ok) {
        if (res.kind === 'auth' || res.status === 'unauthenticated') return end(true); // the shell's session-expiry path takes over
        if (res.status === 'forbidden' || res.kind === 'forbidden') {
          showDenied();
          return end(true);
        }
        showError(res);
        return end(false);
      }
      setState('ready');
      if (view.focus && !current.restore) view.focus();
      end(true);
    } catch (e) {
      if (disposed || mine !== seq) return end(true);
      if (e && (e.kind === 'auth' || e.name === 'AbortedError')) return end(true);
      showError(null);
      end(false);
    }
  }

  function reload() {
    return start();
  }

  start();

  return {
    get title() {
      return titleFor(current.route || { name: 'users' });
    },
    update(next) {
      current = next;
      env.restore = next.restore;
      const route = next.route || { name: 'users' };
      const key = `${route.name}:${(route.params && route.params.login) || ''}`;
      if (view && key === viewKey) {
        titleEl.textContent = titleFor(route);
        view.update(route);
        return;
      }
      start();
    },
    snapshot: () => (view && typeof view.snapshot === 'function' ? view.snapshot() : null),
    dispose() {
      disposed = true;
      seq++;
      if (view) view.dispose();
      view = null;
    },
  };
}

