// SPDX-License-Identifier: AGPL-3.0-or-later
// Navigation helpers (app.js), the coming-soon page and the real screen modules the registry points at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAV_ITEMS, TOPBAR_ITEMS, ENABLED_SLICES, navVisible, navCurrent, applyNav, renderNotFound } from '../../../src/js/app.js';
import { renderComingSoon, comingSoonNameKey } from '../../../src/js/views/comingsoon.js';
import { parseHash, resolveRoute, LANDING_HASH } from '../../../src/js/router.js';
import { SCREENS, loadScreen } from '../../../src/js/screens.js';
import { setDocument } from '../../../src/js/ui.js';
import { createI18n } from '../_i18n-all.mjs';
import en from '../../../src/i18n/en.js';
import fr from '../../../src/i18n/fr.js';
import { fakeDocument, FakeElement, find } from './_helpers.mjs';

setDocument(fakeDocument());
const route = (hash) => resolveRoute(parseHash(hash));
const html = readFileSync(new URL('../../../src/index.html', import.meta.url), 'utf8');

const ids = (items) => items.map((n) => n.id);
const visibleIds = (opts) => ids(NAV_ITEMS.filter((n) => navVisible(n, opts)));

test('navigation entries, in desktop rail order: Calendar, Tasks, Contacts, Collections, Users, Settings, Diagnostics', () => {
  assert.deepEqual(ids(NAV_ITEMS), ['nav-calendar', 'nav-tasks', 'nav-contacts', 'nav-collections', 'nav-users', 'nav-settings', 'nav-debug']);
  assert.deepEqual(NAV_ITEMS.map((n) => n.hash), ['#/calendar', '#/tasks', '#/contacts', '#/collections', '#/users', '#/settings', '#/debug']);
  assert.equal(NAV_ITEMS.find((n) => n.id === 'nav-contacts').hash, LANDING_HASH);
  for (const n of NAV_ITEMS) {
    assert.ok(en[n.key] && fr[n.key], n.key);
    assert.match(html, new RegExp(`id="${n.id}" href="${n.hash}" data-testid="${n.id}"`), `${n.id} in index.html`);
    assert.match(html, new RegExp(`data-i18n="${n.key.replace('.', '\\.')}"`));
    assert.ok(Object.isFrozen(n), n.id);
  }
  assert.ok(Object.isFrozen(NAV_ITEMS) && Object.isFrozen(TOPBAR_ITEMS) && Object.isFrozen(ENABLED_SLICES));
  // phones: four tabs (Calendar, Tasks, Contacts, Collections); the other three are rail-only
  assert.deepEqual(ids(NAV_ITEMS.filter((n) => !n.rail)), ['nav-calendar', 'nav-tasks', 'nav-contacts', 'nav-collections']);
  assert.deepEqual(ids(TOPBAR_ITEMS), ['topbar-users', 'topbar-settings']);
  for (const n of TOPBAR_ITEMS) assert.match(html, new RegExp(`id="${n.id}" href="${n.hash}" data-testid="${n.id}"`), n.id);
});

test('ENABLED_SLICES: Calendar is on since slice 3b (E2E `calendar` passed), Tasks since slice 3c (E2E `tasks` passed); Users only for administrators', () => {
  assert.ok(['base', '3a', '3a-users', '3b', '3c'].every((x) => ENABLED_SLICES.includes(x)));
  assert.deepEqual(visibleIds({ admin: false }), ['nav-calendar', 'nav-tasks', 'nav-contacts', 'nav-collections', 'nav-settings', 'nav-debug']);
  const base = ['nav-contacts', 'nav-collections', 'nav-settings', 'nav-debug'];
  const withUsers = ['base', '3a', '3a-users'];
  assert.deepEqual(visibleIds({ admin: false, slices: withUsers }), base, 'a non-admin never gets the Users entry');
  assert.deepEqual(visibleIds({ admin: true, slices: withUsers }), ['nav-contacts', 'nav-collections', 'nav-users', 'nav-settings', 'nav-debug']);
  assert.deepEqual(visibleIds({ admin: true, slices: [...withUsers, '3b', '3c'] }), ids(NAV_ITEMS), 'every slice on: everything for an admin');
  assert.deepEqual(visibleIds({ admin: false, slices: [...withUsers, '3b', '3c'] }), ids(NAV_ITEMS.filter((n) => !n.admin)));
  assert.deepEqual(visibleIds({ admin: true, slices: [] }), [], 'no slice, no entry');
  assert.equal(navVisible(TOPBAR_ITEMS[0], { admin: true, slices: withUsers }), true);
  assert.equal(navVisible(TOPBAR_ITEMS[0], { admin: false, slices: withUsers }), false);
  assert.equal(navVisible(TOPBAR_ITEMS[1], { admin: false }), true, 'settings is for everyone');
});

test('navCurrent: every route of a family marks its own entry; hidden entries and other routes mark none', () => {
  for (const h of ['#/contacts', '#/contacts/new', '#/contacts/groups', '#/contacts/groups/g1', '#/contacts/u1', '#/contacts/u1/edit']) assert.equal(navCurrent(route(h)), 'nav-contacts', h);
  for (const h of ['#/collections', '#/collections/new-calendar', '#/collections/new-addressbook', '#/collections/edit?href=%2Fa%2Fb%2F']) assert.equal(navCurrent(route(h)), 'nav-collections', h);
  assert.equal(navCurrent(route('#/debug')), 'nav-debug');
  assert.equal(navCurrent(route('#/settings')), 'nav-settings');
  for (const h of ['#/calendar', '#/calendar/week/2026-11-16', '#/events/u1', '#/events/new']) assert.equal(navCurrent(route(h)), 'nav-calendar', h);
  for (const h of ['#/tasks', '#/tasks/new']) assert.equal(navCurrent(route(h)), 'nav-tasks', h);
  for (const h of ['#/login', '#/nope', '#/']) assert.equal(navCurrent(route(h)), null, h);
  for (const h of ['#/tasks', '#/tasks/new']) assert.equal(navCurrent(route(h), { slices: ['base'] }), null, `${h}: hidden entry`);
  const all = { admin: true, slices: ['base', '3a', '3a-users', '3b', '3c'] };
  for (const h of ['#/calendar', '#/calendar/month/2026-11-16', '#/events/u1', '#/events/u1/edit', '#/events/new']) assert.equal(navCurrent(route(h), all), 'nav-calendar', h);
  for (const h of ['#/tasks', '#/tasks/new', '#/tasks/t1', '#/tasks/t1/edit']) assert.equal(navCurrent(route(h), all), 'nav-tasks', h);
  for (const h of ['#/users', '#/users/new', '#/users/permissions', '#/users/bob']) {
    assert.equal(navCurrent(route(h), all), 'nav-users', h);
    assert.equal(navCurrent(route(h), { ...all, admin: false }), null, h);
  }
  assert.equal(navCurrent(null), null);
});

test('applyNav: hidden while signed out, shown and aria-current set when signed in; entries follow admin and slices', () => {
  const els = new Map(['main-nav', 'btn-sign-out', ...ids(NAV_ITEMS), ...ids(TOPBAR_ITEMS)].map((id) => [id, new FakeElement('a')]));
  const get = (id) => els.get(id) || null;
  const shown = (list) => ids(list).filter((id) => !els.get(id).hidden);
  assert.equal(applyNav(get, route('#/login'), false), null);
  assert.equal(els.get('main-nav').hidden, true);
  assert.equal(els.get('btn-sign-out').hidden, true);
  assert.deepEqual(shown(NAV_ITEMS), [], 'nothing is offered while signed out');
  assert.equal(applyNav(get, route('#/contacts/u1'), true), 'nav-contacts');
  assert.equal(els.get('main-nav').hidden, false);
  assert.equal(els.get('btn-sign-out').hidden, false);
  assert.equal(els.get('nav-contacts').getAttribute('aria-current'), 'page');
  assert.equal(els.get('nav-collections').hasAttribute('aria-current'), false);
  assert.deepEqual(shown(NAV_ITEMS), ['nav-calendar', 'nav-tasks', 'nav-contacts', 'nav-collections', 'nav-settings', 'nav-debug'], 'non-admin, slices 3a, 3b and 3c');
  assert.deepEqual(shown(TOPBAR_ITEMS), ['topbar-settings']);
  applyNav(get, route('#/collections'), true);
  assert.equal(els.get('nav-contacts').hasAttribute('aria-current'), false);
  assert.equal(els.get('nav-collections').getAttribute('aria-current'), 'page');
  assert.equal(applyNav(get, route('#/settings'), true), 'nav-settings');
  assert.equal(els.get('topbar-settings').getAttribute('aria-current'), 'page');
  assert.equal(applyNav(get, route('#/calendar'), true), 'nav-calendar'); // slice 3b is on
  assert.equal(NAV_ITEMS.filter((n) => els.get(n.id).hasAttribute('aria-current')).length, 1);
  assert.equal(applyNav(get, route('#/tasks'), true), 'nav-tasks'); // slice 3c is on
  assert.equal(NAV_ITEMS.filter((n) => els.get(n.id).hasAttribute('aria-current')).length, 1);
  assert.equal(els.get('main-nav').hidden, false);
  applyNav(get, route('#/contacts'), false);
  assert.equal(els.get('nav-contacts').hasAttribute('aria-current'), false, 'never current while signed out');
  const opts = { admin: true, slices: ['base', '3a', '3a-users', '3b', '3c'] };
  applyNav(get, route('#/users/bob'), true, opts);
  assert.deepEqual(shown(NAV_ITEMS), ids(NAV_ITEMS));
  assert.deepEqual(shown(TOPBAR_ITEMS), ['topbar-users', 'topbar-settings']);
  assert.equal(els.get('nav-users').getAttribute('aria-current'), 'page');
  assert.equal(els.get('topbar-users').getAttribute('aria-current'), 'page');
  applyNav(get, route('#/users/bob'), true, { ...opts, admin: false });
  assert.equal(els.get('nav-users').hidden, true);
  assert.equal(els.get('topbar-users').hidden, true);
  assert.doesNotThrow(() => applyNav(() => null, route('#/contacts'), true));
});

test('applyNav also hides the list item around an entry (an empty item would take a column of the tab bar)', () => {
  const li = new FakeElement('li');
  const a = new FakeElement('a');
  a.parentElement = li;
  const get = (id) => (id === 'nav-tasks' ? a : null);
  applyNav(get, route('#/contacts'), true, { slices: ['base'] }); // a slice that is not switched on
  assert.equal(a.hidden, true);
  assert.equal(li.hidden, true);
  applyNav(get, route('#/tasks'), true, { slices: ['3c'] });
  assert.equal(a.hidden, false);
  assert.equal(li.hidden, false);
});

test('coming soon: #/calendar and #/tasks, and every placeholder screen, render the comingsoon-screen page', () => {
  const t = createI18n({ lang: 'en' }).t;
  const cases = [['#/calendar', 'Calendar'], ['#/calendar/week/2026-11-16', 'Calendar'], ['#/events/u1', 'Calendar'], ['#/tasks', 'Tasks'], ['#/tasks/new', 'Tasks'], ['#/contacts', 'Contacts'], ['#/collections/new-calendar', 'Collections'], ['#/zzz', 'This screen']];
  for (const [hash, name] of cases) {
    const root = new FakeElement('main');
    const ctl = renderComingSoon({ root, t, route: route(hash) });
    const page = find(root, 'comingsoon-screen');
    assert.ok(page, hash);
    assert.match(page.textContent, new RegExp(`${name} is not available in this version yet\\.`), hash);
    assert.equal(find(root, 'comingsoon-home').getAttribute('href'), '#/contacts');
    assert.equal(ctl.title, 'Coming soon');
  }
  assert.equal(comingSoonNameKey(null), 'comingsoon.name.generic');
  for (const k of ['comingsoon.name.calendar', 'comingsoon.name.tasks', 'comingsoon.name.generic', 'nav.contacts', 'nav.collections']) assert.ok(en[k] && fr[k], k);
});

test('not found page keeps its test ids', () => {
  const root = new FakeElement('main');
  renderNotFound({ root, t: createI18n({ lang: 'fr' }).t });
  assert.ok(find(root, 'notfound-screen'));
  assert.equal(find(root, 'notfound-home').getAttribute('href'), '#/');
});

test('the registry points at modules that exist and export what it says (the others are placeholders)', async () => {
  for (const [name, entry] of Object.entries(SCREENS)) {
    if (!entry.module) continue;
    const loaded = await loadScreen(name);
    assert.equal(typeof loaded.render, 'function', name);
    assert.equal(loaded.placeholder, false, name);
  }
  const placeholders = Object.entries(SCREENS).filter(([, e]) => !e.module).map(([n]) => n).sort();
  assert.deepEqual(placeholders, ['notfound'], 'every Run 3 screen has its module (calendar and event: WP B3a, the event form: WP B3b, tasks, task and the task form: WP C1)');
  assert.equal(SCREENS.settings.module, './views/settings/screen.js');
  assert.equal(SCREENS.users.module, './views/users/screen.js');
  const stand = await loadScreen('notfound');
  assert.equal(stand.placeholder, true);
  assert.equal(typeof stand.render, 'function');
  // the data model (and ical.js with it) is only requested by screens that need it, never by login
  assert.equal(SCREENS.login.model, undefined);
  assert.equal(SCREENS.debug.model, true);
  assert.equal(SCREENS.contacts.model, true);
  assert.equal(SCREENS['event-form'].model, true);
});

test('app.js and login.js never import the data model or ical.js statically (m13)', () => {
  for (const f of ['app.js', 'login.js', 'router.js', 'screens.js', 'session.js', 'ui.js']) {
    const code = readFileSync(new URL(`../../../src/js/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const statics = [...code.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.equal(statics.some((s) => /model\/|ical|vendor/.test(s)), false, `${f}: ${statics.join(', ')}`);
  }
  const app = readFileSync(new URL('../../../src/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /import\('\.\/model\/item\.js'\)/, 'loaded on demand');
});
