// SPDX-License-Identifier: AGPL-3.0-or-later
// Hash router: every screen is deep-linkable as `#/<path>?<query>` and survives a
// reload (SPECS 5.4). No DOM access of its own: the browser objects it needs
// (location, history, event registration) arrive through `win`, so Node tests
// can drive it with a fake.
//
// Route table entries: { name, screen, pattern, auth }
//   name     unique route name (data-route on #app)
//   screen   the screen controller that renders it; routes that share a screen
//            are served by ONE mounted controller (app.js calls update(route)
//            instead of remounting, so scroll position, search text and focus stay)
//   pattern  '/contacts/:key/edit': literal segments and `:param` segments
//   auth     true = needs a signed-in user
// Literal segments beat `:param` segments; on a tie the earlier entry wins.

export const MAX_SEGMENT = 200; // longest accepted path parameter (a UID or file name)
export const MAX_QUERY_VALUE = 2048; // longer query values are dropped
export const MAX_HREF_PARAM = 512; // collection hrefs in `href` / `ab`

const route = (name, screen, pattern, auth = true) => Object.freeze({ name, screen, pattern, auth });

export const ROUTES = Object.freeze([
  route('login', 'login', '/login', false),
  route('contacts', 'contacts', '/contacts'),
  route('contact-new', 'contact-form', '/contacts/new'),
  route('groups', 'groups', '/contacts/groups'),
  route('group', 'groups', '/contacts/groups/:key'),
  route('contact-edit', 'contact-form', '/contacts/:key/edit'),
  route('contact', 'contacts', '/contacts/:key'),
  route('collections', 'collections', '/collections'),
  route('collection-new-calendar', 'collection-form', '/collections/new-calendar'),
  route('collection-new-addressbook', 'collection-form', '/collections/new-addressbook'),
  route('collection-edit', 'collection-form', '/collections/edit'),
  // Run 3. Routes of slices that are not enabled stay on the coming-soon page: their screens have
  // `module: null` in js/screens.js until the owning work package supplies one.
  route('users', 'users', '/users'),
  route('user-new', 'users', '/users/new'),
  route('users-permissions', 'users', '/users/permissions'),
  route('user', 'users', '/users/:login'),
  route('settings', 'settings', '/settings'),
  route('calendar', 'calendar', '/calendar'),
  route('calendar-view', 'calendar', '/calendar/:view/:date'),
  route('event-new', 'event-form', '/events/new'),
  route('event-edit', 'event-form', '/events/:key/edit'),
  route('event', 'event', '/events/:key'),
  route('tasks', 'tasks', '/tasks'),
  route('task-new', 'task-form', '/tasks/new'),
  route('task-edit', 'task-form', '/tasks/:key/edit'),
  route('task', 'task', '/tasks/:key'),
  route('debug', 'debug', '/debug'),
]);

/** Kept for callers of the first release. */
export const DEFAULT_ROUTES = ROUTES;

/** Where signed-in users land (root and a successful login). */
export const LANDING_HASH = '#/contacts';

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Parse `location.hash`. Accepts '', '#', '#/', '#/a/b?x=1'. A segment that is not
 * valid percent-encoding makes the result `valid: false`. Query values longer than
 * MAX_QUERY_VALUE are dropped (the first value of a repeated key wins).
 * @returns {{path: string, segments: string[], params: Record<string,string>, valid: boolean}}
 */
export function parseHash(hash) {
  let h = typeof hash === 'string' ? hash : '';
  if (h.startsWith('#')) h = h.slice(1);
  const q = h.indexOf('?');
  const pathPart = q >= 0 ? h.slice(0, q) : h;
  const queryPart = q >= 0 ? h.slice(q + 1) : '';
  const raw = pathPart.split('/').filter((s) => s !== '');
  const segments = raw.map(safeDecode);
  const valid = segments.every((s) => s !== null);
  const params = {};
  for (const [k, v] of new URLSearchParams(queryPart)) if (!(k in params) && v.length <= MAX_QUERY_VALUE) params[k] = v;
  const decoded = valid ? segments : [];
  return { path: '/' + decoded.join('/'), segments: decoded, params, valid };
}

/** Build a hash from a path and optional query values (null/undefined values are skipped). */
export function buildHash(path, params) {
  const segs = String(path)
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent);
  let out = '#/' + segs.join('/');
  if (params && typeof params === 'object') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
    const s = q.toString();
    if (s) out += '?' + s;
  }
  return out;
}

/** Fill a pattern such as '/contacts/:key/edit' from `pathParams`, add `query`. */
export function hashFor(pattern, pathParams = {}, query) {
  const segs = String(pattern)
    .split('/')
    .filter((s) => s !== '')
    .map((s) => encodeURIComponent(s.startsWith(':') ? String(pathParams[s.slice(1)] ?? '') : s));
  let out = '#/' + segs.join('/');
  if (query && typeof query === 'object') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) q.set(k, String(v));
    const text = q.toString();
    if (text) out += '?' + text;
  }
  return out;
}

function compile(entry) {
  const parts = entry.pattern.split('/').filter((s) => s !== '').map((s) => (s.startsWith(':') ? { param: s.slice(1) } : { literal: s }));
  return { entry, parts, literals: parts.filter((p) => p.literal !== undefined).length };
}

const compiledCache = new WeakMap();
function compiled(table) {
  let c = compiledCache.get(table);
  if (!c) {
    c = table.map(compile);
    compiledCache.set(table, c);
  }
  return c;
}

/**
 * Match path segments against one pattern.
 * @returns {Record<string,string>|null} path parameters, or null when it does not match
 */
export function matchPattern(pattern, segments) {
  const c = compile({ pattern });
  if (c.parts.length !== segments.length) return null;
  const out = {};
  for (let i = 0; i < c.parts.length; i += 1) {
    const p = c.parts[i];
    if (p.literal !== undefined) {
      if (p.literal !== segments[i]) return null;
    } else {
      out[p.param] = segments[i];
    }
  }
  return out;
}

/**
 * Match a parsed hash against the table.
 * @returns {{name: string, screen: string, route: object|null, params: object, pathParams: object,
 *            query: object, path: string, known: boolean, root: boolean}}
 *   `params` = query values with the path parameters on top (what screens read);
 *   `root` is true for the empty path; unknown paths (and over-long path parameters)
 *   give name/screen 'notfound'.
 */
export function resolveRoute(parsed, table = ROUTES) {
  const query = parsed.params || {};
  if (parsed.valid && parsed.path === '/') return { name: 'root', screen: 'root', route: null, params: query, pathParams: {}, query, path: '/', known: true, root: true };
  const notFound = { name: 'notfound', screen: 'notfound', route: null, params: query, pathParams: {}, query, path: parsed.valid ? parsed.path : '/', known: false, root: false };
  if (!parsed.valid) return notFound;
  let best = null;
  for (const c of compiled(table)) {
    const pathParams = matchPattern(c.entry.pattern, parsed.segments);
    if (!pathParams) continue;
    if (!best || c.literals > best.literals) best = { c, pathParams, literals: c.literals };
  }
  if (!best) return notFound;
  if (Object.values(best.pathParams).some((v) => v.length > MAX_SEGMENT || v === '')) return notFound;
  const { entry } = best.c;
  return { name: entry.name, screen: entry.screen, route: entry, params: { ...query, ...best.pathParams }, pathParams: best.pathParams, query, path: parsed.path, known: true, root: false };
}

/**
 * A `next` value is only honoured when it is a hash for a known route that
 * needs authentication (so it can never point back at login or at nothing).
 */
export function safeNext(value, table = ROUTES) {
  if (typeof value !== 'string' || !value.startsWith('#/') || value.length > 512) return null;
  const r = resolveRoute(parseHash(value), table);
  return r.known && r.route && r.route.auth ? value : null;
}

/**
 * The discovered collection a `href` / `ab` hash parameter refers to, or null
 * ("not found"). The value must be shorter than MAX_HREF_PARAM and equal (up to a
 * trailing slash) to the href of a collection the session actually discovered;
 * nothing is ever fetched from an address typed into the URL.
 * @param {string|undefined} value
 * @param {{href: string}[]} collections
 */
export function collectionForParam(value, collections) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_HREF_PARAM || !Array.isArray(collections)) return null;
  const norm = (s) => (s.endsWith('/') ? s : s + '/');
  const want = norm(value);
  return collections.find((c) => c && typeof c.href === 'string' && norm(c.href) === want) || null;
}

const STATE_KEY = 'radui';

/**
 * @param {object} o
 * @param {object} o.win window-like: location.hash (get/set), history.replaceState (+ state, back, forward),
 *                       addEventListener/removeEventListener for 'hashchange'
 * @param {(route: object) => void|Promise<void>} o.onRoute called with the resolved route
 * @param {(route: object) => string|null} [o.guard] returns a hash to redirect to, or null to proceed
 * @param {(change: {from: string, to: string, route: object}) => boolean} [o.canLeave]
 *        false vetoes a navigation made by the browser (link, Back, typed hash): the URL is put back
 *        WITHOUT adding a history entry (history.back()/forward() by the stamped entry order; replaceState
 *        when the window cannot do that). Not asked for navigate(..., {force: true}).
 * @param {object[]} [o.routes]
 */
export function createRouter({ win, onRoute, guard, canLeave, routes = ROUTES }) {
  let current = null; // the hash currently shown
  let started = false;
  let stamp = 0; // highest history-entry index handed out
  let currentIndex = null;
  let reverting = false; // a history.back()/forward() put the URL back: its hashchange is not a navigation
  let force = false;

  const read = () => win.location.hash || '';
  const entryIndex = () => {
    const st = win.history && win.history.state;
    return st && typeof st === 'object' && Number.isInteger(st[STATE_KEY]) ? st[STATE_KEY] : null;
  };

  function revert() {
    const idx = entryIndex();
    const h = win.history;
    const canWalk = typeof h.back === 'function' && typeof h.forward === 'function';
    if (!canWalk) {
      h.replaceState(null, '', current); // no way to walk history: put the URL back in place
      return;
    }
    reverting = true;
    if (idx !== null && currentIndex !== null && idx < currentIndex) h.forward();
    else h.back();
  }

  async function handle(hash, { fromEvent = false } = {}) {
    if (fromEvent && reverting && hash === current) {
      reverting = false; // the hashchange caused by revert()
      return;
    }
    reverting = false;
    let route = resolveRoute(parseHash(hash), routes);
    if (fromEvent && !force && canLeave && current !== null && hash !== current && !canLeave({ from: current, to: hash, route })) {
      revert();
      return;
    }
    force = false;
    // Bounded redirect chain: root -> landing/login -> (guard) -> login.
    for (let i = 0; i < 4; i += 1) {
      const target = guard ? guard(route) : null;
      if (!target || target === hash) break;
      hash = target;
      win.history.replaceState(null, '', hash);
      route = resolveRoute(parseHash(hash), routes);
    }
    current = hash;
    // Stamp the history entry (no URL change) so a later veto knows which way to walk.
    let idx = entryIndex();
    if (idx === null) {
      idx = ++stamp;
      win.history.replaceState({ [STATE_KEY]: idx }, '');
    } else if (idx > stamp) stamp = idx;
    currentIndex = idx;
    await onRoute({ ...route, hash });
  }

  const listener = () => handle(read(), { fromEvent: true });

  return {
    /** Render the route for the current URL and start listening for changes. */
    start() {
      if (!started) {
        started = true;
        win.addEventListener('hashchange', listener);
      }
      return handle(read());
    },
    stop() {
      if (started) win.removeEventListener('hashchange', listener);
      started = false;
    },
    /**
     * Go to a hash. `replace` rewrites the history entry and renders at once.
     * `force` skips canLeave (used after the user confirmed discarding changes).
     */
    navigate(hash, { replace = false, force: skipLeave = false } = {}) {
      if (replace) {
        win.history.replaceState(null, '', hash);
        return handle(hash);
      }
      if (hash === read()) return handle(hash);
      force = skipLeave;
      win.location.hash = hash; // fires hashchange
      return Promise.resolve();
    },
    /** Render the current URL again (language change, retry). */
    refresh() {
      return handle(read());
    },
    get current() {
      return current;
    },
  };
}
