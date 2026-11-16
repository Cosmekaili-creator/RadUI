// SPDX-License-Identifier: AGPL-3.0-or-later
// Screen registry: which module renders which screen, and which "family" a screen
// belongs to. Pure data plus one lazy loader, so a work package that delivers a
// screen only replaces `module: null` with its module path (relative to this file).
//
// Screen controller contract (what a module's exported function returns):
//   mount(ctx) -> { title?, update?(ctx), snapshot?(), restoreFrom?, dispose?(), canLeave?(to) }
//   - `update(ctx)` is called instead of a remount when the next route has the same `screen`;
//     the screen keeps its DOM (scroll position, search text, focus).
//   - `snapshot()` returns plain data handed back as `ctx.restore` after a language switch (m11).
//   - `canLeave(to)` returning true lets the user leave although the form is dirty.
//   - `dispose()` runs before another screen is mounted and on sign-out.
// ctx: { root, t, tp, params, route, host, restore, signal, app }.
// `model: true` makes the shell load the data model (and with it ical.js) BEFORE the screen is
// mounted, so `app.openItem` is ready; the login route never loads it (m13). Screens that need the
// model later can `await app.loadModel()`.

/** Feedback scope = screen family: messages survive moves inside one family. */
export const SCREENS = Object.freeze({
  login: Object.freeze({ family: 'login', module: './login.js', export: 'renderLogin' }),
  debug: Object.freeze({ family: 'debug', module: './debug/debug.js', export: 'renderDebug', model: true }),
  comingsoon: Object.freeze({ family: 'comingsoon', module: './views/comingsoon.js', export: 'renderComingSoon' }),
  notfound: Object.freeze({ family: 'notfound', module: null, export: null }),
  // Placeholders until the owning work package supplies its module (then set `module` and `export`).
  contacts: Object.freeze({ family: 'contacts', module: './views/contacts/screen.js', export: 'mount', model: true }),
  'contact-form': Object.freeze({ family: 'contacts', module: './views/contacts/form.js', export: 'mount', model: true }),
  groups: Object.freeze({ family: 'contacts', module: './views/contacts/groups.js', export: 'mount', model: true }),
  collections: Object.freeze({ family: 'collections', module: './views/collections/screen.js', export: 'mount' }),
  'collection-form': Object.freeze({ family: 'collections', module: './views/collections/form.js', export: 'mount' }),
  // Run 3, slice 3a. `users` serves all four #/users routes (one mounted controller; it reads route.name).
  // Its module is delivered by WP A2; the shell offers the entry only when ENABLED_SLICES lists '3a-users'.
  users: Object.freeze({ family: 'users', module: './views/users/screen.js', export: 'mount' }),
  settings: Object.freeze({ family: 'settings', module: './views/settings/screen.js', export: 'mount' }),
  // Run 3, slices 3b and 3c: no module yet, so the coming-soon page stands in. The owning work
  // package replaces `module: null` (and adds the slice to ENABLED_SLICES in js/app.js).
  // Slice 3b, WP B3a: the calendar screen and the event detail page. The nav entry stays hidden until '3b' is in ENABLED_SLICES.
  calendar: Object.freeze({ family: 'calendar', module: './views/calendar/screen.js', export: 'mount', model: true }),
  event: Object.freeze({ family: 'calendar', module: './views/calendar/screen.js', export: 'mountEvent', model: true }),
  // Slice 3b, WP B3b: the event form (new and edit are one controller; it reads route.name).
  'event-form': Object.freeze({ family: 'calendar', module: './views/calendar/form.js', export: 'mount', model: true }),
  // Slice 3c, WP C1: the merged task list, the task detail and the task form. The nav entry stays hidden until '3c' is in ENABLED_SLICES.
  tasks: Object.freeze({ family: 'tasks', module: './views/tasks/screen.js', export: 'mount', model: true }),
  task: Object.freeze({ family: 'tasks', module: './views/tasks/screen.js', export: 'mountTask', model: true }),
  'task-form': Object.freeze({ family: 'tasks', module: './views/tasks/form.js', export: 'mount', model: true }),
});

/** Feedback family of a screen ('notfound' for unknown names). */
export function familyOf(screen) {
  const s = SCREENS[screen];
  return s ? s.family : 'notfound';
}

/**
 * Resolve a screen name to its render function.
 * @param {string} screen
 * @param {object} [o]
 * @param {Record<string, Function>} [o.inline] renderers that are already loaded (login, notfound)
 * @param {(path: string) => Promise<object>} [o.importer] dynamic import, relative to this file
 * @param {Record<string, object>} [o.table]
 * @returns {Promise<{render: Function, placeholder: boolean, model: boolean}>}
 *   `placeholder` is true when the screen has no module yet and the coming-soon page stands in.
 */
export async function loadScreen(screen, { inline = {}, importer = (p) => import(p), table = SCREENS } = {}) {
  if (inline[screen]) return { render: inline[screen], placeholder: false, model: Boolean(table[screen] && table[screen].model) };
  const entry = table[screen] || table.notfound;
  if (!entry.module) {
    const soon = table.comingsoon;
    if (inline.comingsoon) return { render: inline.comingsoon, placeholder: screen !== 'notfound', model: false };
    const mod = await importer(soon.module);
    return { render: mod[soon.export], placeholder: true, model: false };
  }
  const mod = await importer(entry.module);
  const render = mod[entry.export];
  if (typeof render !== 'function') throw new TypeError(`screen module ${entry.module} has no export "${entry.export}"`);
  return { render, placeholder: false, model: Boolean(entry.model) };
}
