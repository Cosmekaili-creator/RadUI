// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHash,
  buildHash,
  hashFor,
  matchPattern,
  resolveRoute,
  safeNext,
  collectionForParam,
  createRouter,
  ROUTES,
  DEFAULT_ROUTES,
  LANDING_HASH,
  MAX_SEGMENT,
  MAX_QUERY_VALUE,
} from '../../../src/js/router.js';
import { familyOf, loadScreen, SCREENS } from '../../../src/js/screens.js';

const route = (hash) => resolveRoute(parseHash(hash));

test('parseHash', () => {
  assert.deepEqual(parseHash(''), { path: '/', segments: [], params: {}, valid: true });
  assert.equal(parseHash('#').path, '/');
  assert.equal(parseHash('#/').path, '/');
  assert.equal(parseHash(undefined).path, '/');
  const p = parseHash('#/debug?items=3&x=a%20b&items=9');
  assert.equal(p.path, '/debug');
  assert.deepEqual(p.segments, ['debug']);
  assert.deepEqual(p.params, { items: '3', x: 'a b' });
  assert.equal(parseHash('debug').path, '/debug');
  assert.equal(parseHash('#//a///b/').path, '/a/b');
  assert.deepEqual(parseHash('#/a%2Fb/c').segments, ['a/b', 'c']);
  assert.equal(parseHash('#/%E0%A4%A').valid, false);
});

test('parseHash drops query values longer than the cap', () => {
  const p = parseHash('#/contacts?q=' + 'a'.repeat(MAX_QUERY_VALUE + 1) + '&ab=ok');
  assert.deepEqual(p.params, { ab: 'ok' });
});

test('buildHash, hashFor and parseHash round-trip', () => {
  assert.equal(buildHash('/login'), '#/login');
  assert.equal(buildHash('login', { next: '#/debug?items=2', skip: null }), '#/login?next=%23%2Fdebug%3Fitems%3D2');
  const parsed = parseHash(buildHash('/a b/c', { q: 'x&y=z' }));
  assert.deepEqual(parsed.segments, ['a b', 'c']);
  assert.deepEqual(parsed.params, { q: 'x&y=z' });
  assert.equal(hashFor('/contacts/:key/edit', { key: 'a/b' }), '#/contacts/a%2Fb/edit');
  assert.equal(hashFor('/collections', {}, { dialog: 'import', href: '/alice/book/' }), '#/collections?dialog=import&href=%2Falice%2Fbook%2F');
});

test('matchPattern: literal and :param segments', () => {
  assert.deepEqual(matchPattern('/contacts/:key/edit', ['contacts', 'u1', 'edit']), { key: 'u1' });
  assert.equal(matchPattern('/contacts/:key', ['contacts']), null);
  assert.equal(matchPattern('/contacts/:key', ['contacts', 'a', 'b']), null);
  assert.equal(matchPattern('/a', ['b']), null);
});

test('routes: every entry has name, screen, pattern, auth; names are unique; table is frozen', () => {
  for (const r of ROUTES) {
    assert.equal(typeof r.name, 'string');
    assert.equal(typeof r.screen, 'string');
    assert.match(r.pattern, /^\/[a-z:/-]*$/);
    assert.equal(typeof r.auth, 'boolean');
    assert.ok(SCREENS[r.screen], `screen ${r.screen} is registered`);
  }
  assert.equal(new Set(ROUTES.map((r) => r.name)).size, ROUTES.length);
  assert.ok(Object.isFrozen(ROUTES));
  assert.equal(DEFAULT_ROUTES, ROUTES);
});

test('resolveRoute: the D-R2-2 route table', () => {
  const cases = [
    ['#/login', 'login', 'login'],
    ['#/contacts', 'contacts', 'contacts'],
    ['#/contacts?ab=%2Falice%2Fbook%2F&q=ann&group=g1&from=B&dialog=import', 'contacts', 'contacts'],
    ['#/contacts/new', 'contact-new', 'contact-form'],
    ['#/contacts/groups', 'groups', 'groups'],
    ['#/contacts/groups/g-1', 'group', 'groups'],
    ['#/contacts/uid-1', 'contact', 'contacts'],
    ['#/contacts/uid-1?dialog=delete', 'contact', 'contacts'],
    ['#/contacts/uid-1/edit', 'contact-edit', 'contact-form'],
    ['#/collections', 'collections', 'collections'],
    ['#/collections?dialog=delete&href=%2Fa%2Fb%2F', 'collections', 'collections'],
    ['#/collections/new-calendar', 'collection-new-calendar', 'collection-form'],
    ['#/collections/new-addressbook', 'collection-new-addressbook', 'collection-form'],
    ['#/collections/edit?href=%2Fa%2Fb%2F', 'collection-edit', 'collection-form'],
    ['#/users', 'users', 'users'],
    ['#/users/new', 'user-new', 'users'],
    ['#/users/permissions?dialog=change&account=bob&href=%2Fa%2Fb%2F&level=read', 'users-permissions', 'users'],
    ['#/users/bob', 'user', 'users'],
    ['#/users/bob?dialog=reset-password', 'user', 'users'],
    ['#/settings', 'settings', 'settings'],
    ['#/calendar', 'calendar', 'calendar'],
    ['#/calendar/week/2026-11-16', 'calendar-view', 'calendar'],
    ['#/calendar/month/2026-11-16?q=dentist', 'calendar-view', 'calendar'],
    ['#/events/new?date=2026-11-16&time=09:00&cal=%2Fa%2Fb%2F', 'event-new', 'event-form'],
    ['#/events/u1?cal=%2Fa%2Fb%2F&occ=2026-11-16T09:00:00Z&dialog=scope-delete', 'event', 'event'],
    ['#/events/u1/edit?cal=%2Fa%2Fb%2F&scope=this', 'event-edit', 'event-form'],
    ['#/tasks?filter=open&sort=due', 'tasks', 'tasks'],
    ['#/tasks/new?list=%2Fa%2Fb%2F', 'task-new', 'task-form'],
    ['#/tasks/t1', 'task', 'task'],
    ['#/tasks/t1/edit', 'task-edit', 'task-form'],
    ['#/debug', 'debug', 'debug'],
  ];
  for (const [hash, name, screen] of cases) {
    const r = route(hash);
    assert.equal(r.name, name, hash);
    assert.equal(r.screen, screen, hash);
    assert.equal(r.known, true, hash);
  }
  assert.equal(route('#/login').route.auth, false);
  assert.equal(route('#/debug').route.auth, true);
});

test('run 3 routes: literal segments beat :param segments (new, permissions), path parameters are exposed', () => {
  assert.equal(route('#/users/new').name, 'user-new');
  assert.equal(route('#/users/permissions').name, 'users-permissions');
  assert.equal(route('#/users/bob').pathParams.login, 'bob');
  assert.equal(route('#/events/new').name, 'event-new');
  assert.equal(route('#/events/new/edit').name, 'event-edit');
  assert.equal(route('#/tasks/new').name, 'task-new');
  const cal = route('#/calendar/agenda/2026-01-05');
  assert.deepEqual(cal.pathParams, { view: 'agenda', date: '2026-01-05' });
  assert.equal(route('#/users/bob/extra').known, false);
  assert.equal(route('#/calendar/week').known, false);
  assert.equal(LANDING_HASH, '#/contacts', 'the landing route moves to #/calendar only when 3b ships');
});

test('run 3 routes all need a signed-in user, and safeNext accepts them', () => {
  for (const h of ['#/users', '#/users/bob', '#/settings', '#/calendar/week/2026-11-16', '#/events/u1', '#/tasks']) {
    assert.equal(route(h).route.auth, true, h);
    assert.equal(safeNext(h), h, h);
  }
});

test('resolveRoute: literal segments beat :param segments, so "new" and "groups" are never contact keys', () => {
  assert.equal(route('#/contacts/new').name, 'contact-new');
  assert.equal(route('#/contacts/groups').name, 'groups');
  assert.equal(route('#/contacts/groups/edit').name, 'group'); // a group called "edit", not the edit form of contact "groups"
  assert.deepEqual(route('#/contacts/groups/edit').pathParams, { key: 'edit' });
});

test('resolveRoute: path parameters and query values are merged into params; query stays separate', () => {
  const r = route('#/contacts/a%20b/edit?ab=%2Fx%2F&key=ignored');
  assert.deepEqual(r.pathParams, { key: 'a b' });
  assert.deepEqual(r.query, { ab: '/x/', key: 'ignored' });
  assert.equal(r.params.key, 'a b', 'the path parameter wins');
  assert.equal(r.params.ab, '/x/');
});

test('resolveRoute: root, unknown, invalid, extra segments, over-long parameters', () => {
  const root = route('');
  assert.equal(root.root, true);
  assert.equal(root.name, 'root');
  assert.equal(route('#/nope').name, 'notfound');
  assert.equal(route('#/nope').screen, 'notfound');
  assert.equal(route('#/debug/extra').name, 'notfound');
  assert.equal(route('#/%E0%A4%A').name, 'notfound');
  assert.equal(route('#/contacts/' + 'k'.repeat(MAX_SEGMENT + 1)).name, 'notfound');
  assert.equal(route('#/contacts/' + 'k'.repeat(MAX_SEGMENT)).name, 'contact');
  assert.equal(route('#/contacts//edit').name, 'contact', 'empty segments collapse');
});

test('screen families scope the feedback: contacts routes share one, collections another', () => {
  assert.equal(familyOf(route('#/contacts').screen), 'contacts');
  assert.equal(familyOf(route('#/contacts/new').screen), 'contacts');
  assert.equal(familyOf(route('#/contacts/groups').screen), 'contacts');
  assert.equal(familyOf(route('#/contacts/u/edit').screen), 'contacts');
  assert.equal(familyOf(route('#/collections/new-calendar').screen), 'collections');
  assert.equal(familyOf(route('#/debug').screen), 'debug');
  assert.equal(familyOf(route('#/zzz').screen), 'notfound');
  assert.equal(familyOf('nonsense'), 'notfound');
});

test('safeNext only accepts hashes of known authenticated routes', () => {
  assert.equal(safeNext('#/debug?items=2'), '#/debug?items=2');
  assert.equal(safeNext('#/contacts/uid-1/edit'), '#/contacts/uid-1/edit');
  assert.equal(safeNext('#/calendar'), '#/calendar');
  for (const bad of ['#/login', '#/nope', 'https://x.example/', '//x', 'javascript:alert(1)', '#debug', '', null, undefined, '#/' + 'a'.repeat(600)]) assert.equal(safeNext(bad), null, String(bad));
});

test('collectionForParam: href/ab must match a discovered collection', () => {
  const found = [{ href: '/alice/book/', name: 'Book' }, { href: '/bob/work/' }];
  assert.equal(collectionForParam('/alice/book/', found), found[0]);
  assert.equal(collectionForParam('/alice/book', found), found[0], 'a missing trailing slash is tolerated');
  for (const bad of ['/alice/other/', '/etc/passwd', 'https://x.example/alice/book/', '', undefined, null, '/' + 'a'.repeat(600) + '/']) assert.equal(collectionForParam(bad, found), null, String(bad));
  assert.equal(collectionForParam('/alice/book/', null), null);
  assert.equal(collectionForParam('/alice/book/', []), null);
});

test('loadScreen: inline renderers, registered modules and placeholders that resolve to coming soon', async () => {
  const inline = { login: () => 'L' };
  assert.equal((await loadScreen('login', { inline })).render(), 'L');
  const asked = [];
  const importer = async (p) => {
    asked.push(p);
    return { renderDebug: () => 'D', renderComingSoon: () => 'C', mount: () => 'M' };
  };
  const debug = await loadScreen('debug', { importer });
  assert.equal(debug.render(), 'D');
  assert.equal(debug.model, true);
  assert.equal(debug.placeholder, false);
  const contacts = await loadScreen('contacts', { importer });
  assert.equal(contacts.render(), 'M');
  assert.equal(contacts.placeholder, false);
  const pending = await loadScreen('contacts', { importer, table: { ...SCREENS, contacts: { family: 'contacts', module: null, export: 'mount' } } });
  assert.equal(pending.render(), 'C');
  assert.equal(pending.placeholder, true, 'no module yet: coming soon stands in');
  const soon = await loadScreen('comingsoon', { importer });
  assert.equal(soon.placeholder, false);
  assert.deepEqual(asked, ['./debug/debug.js', './views/contacts/screen.js', './views/comingsoon.js', './views/comingsoon.js']);
  // a work package only adds its module path
  const table = { ...SCREENS, contacts: { family: 'contacts', module: './views/contacts/screen.js', export: 'mount' } };
  const real = await loadScreen('contacts', { table, importer: async () => ({ mount: () => 'M' }) });
  assert.equal(real.render(), 'M');
  assert.equal(real.placeholder, false);
  await assert.rejects(loadScreen('contacts', { table, importer: async () => ({}) }), TypeError);
});

// A window-like fake: setting location.hash fires 'hashchange' asynchronously like a browser, and history
// entries are real: back()/forward() move through them.
function fakeWin(initial = '') {
  const listeners = new Set();
  const entries = [{ hash: initial, state: null }];
  let pos = 0;
  const win = {
    replaced: [],
    stamps: [],
    walked: [],
    entries,
    get pos() {
      return pos;
    },
    location: {
      get hash() {
        return entries[pos].hash;
      },
      set hash(v) {
        entries.splice(pos + 1);
        entries.push({ hash: v, state: null });
        pos += 1;
        queueMicrotask(() => listeners.forEach((fn) => fn()));
      },
    },
    history: {
      get state() {
        return entries[pos].state;
      },
      replaceState(state, _t, url) {
        entries[pos].state = state;
        if (url !== undefined) {
          entries[pos].hash = url;
          win.replaced.push(url);
        } else win.stamps.push(state);
      },
      back() {
        win.walked.push('back');
        pos -= 1;
        queueMicrotask(() => listeners.forEach((fn) => fn()));
      },
      forward() {
        win.walked.push('forward');
        pos += 1;
        queueMicrotask(() => listeners.forEach((fn) => fn()));
      },
    },
    addEventListener: (t, fn) => t === 'hashchange' && listeners.add(fn),
    removeEventListener: (t, fn) => t === 'hashchange' && listeners.delete(fn),
    listenerCount: () => listeners.size,
    /** the user presses Back/Forward */
    userGo(delta) {
      pos += delta;
      queueMicrotask(() => listeners.forEach((fn) => fn()));
    },
  };
  return win;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('router: start renders the current route and listens for changes', async () => {
  const win = fakeWin('#/login');
  const seen = [];
  const r = createRouter({ win, onRoute: (rt) => seen.push([rt.name, rt.hash]) });
  await r.start();
  assert.deepEqual(seen, [['login', '#/login']]);
  assert.equal(win.listenerCount(), 1);
  await r.navigate('#/debug');
  await tick();
  assert.deepEqual(seen.at(-1), ['debug', '#/debug']);
  win.location.hash = '#/unknown';
  await tick();
  assert.deepEqual(seen.at(-1), ['notfound', '#/unknown']);
  r.stop();
  assert.equal(win.listenerCount(), 0);
});

test('router: the route handed to onRoute carries name, screen, params, query and hash', async () => {
  const win = fakeWin('#/contacts/u1/edit?ab=%2Fa%2F');
  const seen = [];
  const r = createRouter({ win, onRoute: (rt) => seen.push(rt) });
  await r.start();
  assert.equal(seen[0].name, 'contact-edit');
  assert.equal(seen[0].screen, 'contact-form');
  assert.deepEqual(seen[0].pathParams, { key: 'u1' });
  assert.deepEqual(seen[0].query, { ab: '/a/' });
  assert.equal(seen[0].hash, '#/contacts/u1/edit?ab=%2Fa%2F');
});

test('router: root and login land on #/contacts, signed-out visits go to login with next', async () => {
  const win = fakeWin('');
  const seen = [];
  let signedIn = true;
  const guard = (rt) => {
    if (rt.root) return signedIn ? LANDING_HASH : '#/login';
    if (rt.route && rt.route.auth && !signedIn) return buildHash('/login', { next: buildHash(rt.path, rt.query) });
    if (rt.name === 'login' && signedIn) return safeNext(rt.params.next) || LANDING_HASH;
    return null;
  };
  assert.equal(LANDING_HASH, '#/contacts');
  const r = createRouter({ win, guard, onRoute: (rt) => seen.push(rt.hash) });
  await r.start();
  assert.deepEqual(seen, ['#/contacts']);
  await r.navigate('#/login', { replace: true });
  assert.equal(seen.at(-1), '#/contacts');
  signedIn = false;
  await r.navigate('#/contacts/u1/edit?ab=%2Fa%2F', { replace: true });
  assert.equal(seen.at(-1), '#/login?next=%23%2Fcontacts%2Fu1%2Fedit%3Fab%3D%252Fa%252F');
  assert.equal(safeNext(parseHash(seen.at(-1)).params.next), '#/contacts/u1/edit?ab=%2Fa%2F');
});

test('router: the guard redirects (replace) and chains are bounded', async () => {
  const win = fakeWin('');
  const seen = [];
  let signedIn = false;
  const guard = (rt) => {
    if (rt.root) return signedIn ? '#/debug' : '#/login';
    if (rt.route && rt.route.auth && !signedIn) return buildHash('/login', { next: buildHash(rt.path, rt.query) });
    return null;
  };
  const r = createRouter({ win, guard, onRoute: (rt) => seen.push(rt.hash) });
  await r.start();
  assert.deepEqual(seen, ['#/login']);
  assert.deepEqual(win.replaced, ['#/login']);
  await r.navigate('#/debug?items=2', { replace: true });
  assert.equal(seen.at(-1), '#/login?next=%23%2Fdebug%3Fitems%3D2');
  signedIn = true;
  await r.navigate('#/debug', { replace: true });
  assert.equal(seen.at(-1), '#/debug');

  let calls = 0;
  const loopy = createRouter({ win: fakeWin('#/a'), guard: () => '#/b' + calls++, onRoute: () => {} });
  await loopy.start();
  assert.ok(calls <= 4);
});

test('router: canLeave vetoes a link navigation and puts the URL back WITHOUT a duplicate history entry (m8)', async () => {
  const win = fakeWin('#/contacts/u1/edit');
  const seen = [];
  const asked = [];
  let allowed = false;
  const r = createRouter({ win, canLeave: (c) => (asked.push([c.from, c.to, c.route.name]), allowed), onRoute: (rt) => seen.push(rt.name) });
  await r.start();
  win.location.hash = '#/collections'; // a link click: a new entry
  await tick();
  assert.deepEqual(seen, ['contact-edit']);
  assert.deepEqual(asked, [['#/contacts/u1/edit', '#/collections', 'collections']]);
  assert.equal(win.location.hash, '#/contacts/u1/edit');
  assert.deepEqual(win.walked, ['back']);
  assert.equal(win.pos, 0, 'we are on the original entry, not on a copy of it');
  assert.equal(win.entries.filter((e, i) => i <= win.pos && e.hash === '#/contacts/u1/edit').length, 1, 'no duplicate entry below the current one');
  assert.equal(win.replaced.length, 0, 'replaceState was not used to fake the veto');
  allowed = true;
  win.location.hash = '#/collections';
  await tick();
  assert.deepEqual(seen, ['contact-edit', 'collections']);
});

test('router: a vetoed Back press goes forward again; the vetoed hashchange does not re-render', async () => {
  const win = fakeWin('#/contacts');
  const seen = [];
  let allowed = true;
  const r = createRouter({ win, canLeave: () => allowed, onRoute: (rt) => seen.push(rt.name) });
  await r.start();
  await r.navigate('#/contacts/u1/edit');
  await tick();
  assert.deepEqual(seen, ['contacts', 'contact-edit']);
  allowed = false;
  win.userGo(-1); // the Back button
  await tick();
  await tick();
  assert.deepEqual(win.walked, ['forward']);
  assert.equal(win.location.hash, '#/contacts/u1/edit');
  assert.deepEqual(seen, ['contacts', 'contact-edit'], 'nothing was rendered for the vetoed move or for the revert');
  allowed = true;
  win.userGo(-1);
  await tick();
  assert.equal(seen.at(-1), 'contacts');
});

test('router: navigate(..., {force: true}) skips canLeave (after "Discard changes")', async () => {
  const win = fakeWin('#/contacts/new');
  const seen = [];
  const r = createRouter({ win, canLeave: () => false, onRoute: (rt) => seen.push(rt.name) });
  await r.start();
  await r.navigate('#/contacts');
  await tick();
  assert.deepEqual(seen, ['contact-new'], 'vetoed');
  await r.navigate('#/contacts', { force: true });
  await tick();
  assert.deepEqual(seen, ['contact-new', 'contacts']);
  await r.navigate('#/debug'); // force does not stick
  await tick();
  assert.equal(seen.at(-1), 'contacts');
});

test('router: without history.back/forward a veto falls back to replaceState', async () => {
  const win = fakeWin('#/debug');
  delete win.history.back;
  delete win.history.forward;
  const seen = [];
  const r = createRouter({ win, canLeave: () => false, onRoute: (rt) => seen.push(rt.name) });
  await r.start();
  win.location.hash = '#/login';
  await tick();
  assert.deepEqual(seen, ['debug']);
  assert.equal(win.location.hash, '#/debug');
});

test('router: refresh re-renders the current URL; routes are deep-linkable', async () => {
  const win = fakeWin('#/debug?items=7');
  const seen = [];
  const r = createRouter({ win, routes: ROUTES, onRoute: (rt) => seen.push(rt.params.items) });
  await r.start();
  await r.refresh();
  assert.deepEqual(seen, ['7', '7']);
  assert.equal(r.current, '#/debug?items=7');
});
