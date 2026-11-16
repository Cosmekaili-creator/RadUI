// SPDX-License-Identifier: AGPL-3.0-or-later
// Small UI toolkit: DOM builder, feedback regions (status/alert) with screen
// scoping, Activity log (ring buffer), readiness tracking, safe preference
// storage and the dialog helper.
//
// Rules this file enforces for every screen:
//  - text goes in with textContent / text nodes only; there is no innerHTML path;
//  - no `style` attribute and no on* attribute (CSP `default-src 'self'`);
//    listeners are attached with addEventListener through the `on` property;
//  - only the pure parts (store factories, guards) are DOM-free; the builder and
//    the mount functions need a document, which can be injected for tests.

// ------------------------------------------------------------ safe storage

/** localStorage/sessionStorage reads and writes that never throw. */
export function safeGet(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

export function safeSet(storage, key, value) {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemove(storage, key) {
  try {
    if (storage) storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const PREF_LANG = 'radui.lang';
export const PREF_THEME = 'radui.theme';
export const THEMES = Object.freeze(['auto', 'light', 'dark']);

/** The stored theme preference, 'auto' when none or invalid. */
export function readTheme(storage) {
  const v = safeGet(storage, PREF_THEME);
  return THEMES.includes(v) ? v : 'auto';
}

/** Apply a theme preference to the root element: data-theme is only set for light/dark. */
export function applyTheme(rootEl, theme) {
  if (theme === 'light' || theme === 'dark') rootEl.setAttribute('data-theme', theme);
  else rootEl.removeAttribute('data-theme');
}

// --------------------------------------------------------------- DOM builder

let injectedDoc = null;
/** Use another document (tests). Pass null to go back to the global one. */
export function setDocument(doc) {
  injectedDoc = doc;
}
const getDoc = () => injectedDoc || globalThis.document;

const FORBIDDEN_PROPS = new Set(['style', 'innerhtml', 'outerhtml', 'srcdoc', 'insertadjacenthtml']);
const PROPERTY_PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'open', 'required', 'multiple', 'readOnly']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
// URL attributes use an ALLOWLIST: http, https, mailto, tel, fragments (#...), and relative references.
// Browsers drop tabs, newlines and leading/trailing control characters inside a URL, so every control,
// space and invisible character is removed before the scheme is read.
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const URL_NOISE_RE = /[\u0000-\u0020\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/g;

/** True when `value` is safe to put in href, src, action or formaction. */
export function isAllowedUrl(value) {
  const v = String(value).replace(URL_NOISE_RE, '');
  if (v === '') return true;
  if (v.startsWith('//') || v.startsWith('\\') || v.startsWith('/\\')) return false; // network-path reference
  const m = /^([^:/?#\\]*):/.exec(v);
  if (!m) return true; // no scheme: '#...', '/path', 'path', '?query'
  return /^[a-z][a-z0-9+.-]*$/i.test(m[1]) && ALLOWED_SCHEMES.has(m[1].toLowerCase());
}

function isNode(x) {
  return x !== null && typeof x === 'object' && typeof x.nodeType === 'number';
}

/**
 * Create an element.
 *   h('button', {class: 'btn', testid: 'x', on: {click: fn}, 'aria-label': 'Y'}, 'Text', childEl)
 * Props: `class` (string or array), `text`, `testid` (-> data-testid), `on`
 * ({event: listener}), DOM properties (value, checked, disabled, hidden, ...),
 * anything else becomes an attribute (`true` -> empty attribute, false/null/
 * undefined are skipped). Children: strings and numbers become text nodes,
 * arrays are flattened, null/false are skipped.
 * `vars: {allow: /^#[0-9a-f]{6}$/i, values: {'--cal': value}}` sets CSS custom
 * properties through CSSOM (see vars()); `write: true` registers the element with the
 * write gate (see markWrite()).
 * Throws TypeError for style, on* attributes, innerHTML-like props and
 * URLs outside the allowlist (see isAllowedUrl).
 */
export function h(tag, props, ...kids) {
  const el = getDoc().createElement(tag);
  setProps(el, props);
  append(el, kids);
  return el;
}

export function setProps(el, props) {
  if (!props) return el;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    const lower = key.toLowerCase();
    if (FORBIDDEN_PROPS.has(lower)) throw new TypeError(`"${key}" is not allowed (CSP / no raw HTML)`);
    if (key === 'on') {
      for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
    } else if (key === 'vars') {
      // {allow: RegExp, values: {'--name': 'value'}}: see vars()
      vars(el, value.values, value.allow);
    } else if (key === 'write') {
      markWrite(el);
    } else if (lower.startsWith('on')) {
      throw new TypeError(`inline handler attribute "${key}" is not allowed; use the "on" property`);
    } else if (key === 'class') {
      el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'testid') {
      el.setAttribute('data-testid', String(value));
    } else if (PROPERTY_PROPS.has(key)) {
      el[key] = value;
    } else {
      if (URL_ATTRS.has(lower) && !isAllowedUrl(value)) {
        throw new TypeError(`unsafe URL in "${key}"`);
      }
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  return el;
}

export function append(el, kids) {
  const doc = getDoc();
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(isNode(kid) ? kid : doc.createTextNode(String(kid)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replace the content of `el` with `kids`. */
export function fill(el, ...kids) {
  clear(el);
  return append(el, kids);
}

// ------------------------------------------------------------ feedback store

/**
 * Persistent messages for the two live regions. There is one status slot and one
 * alert slot; a message stays until it is dismissed or replaced. Every message
 * belongs to a screen (by default the current one) and is dropped when another
 * screen is entered; `scope: null` makes a message global (survives navigation).
 * No timers: nothing disappears by itself.
 */
export function createFeedback() {
  let screen = null;
  let seq = 0;
  const slots = { status: null, alert: null };
  const listeners = new Set();
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  const set = (kind, text, scope) => {
    slots[kind] = text === null || text === undefined || text === '' ? null : { id: ++seq, text: String(text), scope: scope === undefined ? screen : scope };
    emit();
  };
  return {
    setStatus: (text, { scope } = {}) => set('status', text, scope),
    setAlert: (text, { scope } = {}) => set('alert', text, scope),
    dismiss(kind) {
      if (slots[kind]) {
        slots[kind] = null;
        emit();
      }
    },
    clear() {
      slots.status = null;
      slots.alert = null;
      emit();
    },
    /** Called by the router before a screen renders: drops the messages of other screens. */
    enterScreen(name) {
      screen = name;
      for (const kind of ['status', 'alert']) {
        const m = slots[kind];
        if (m && m.scope !== null && m.scope !== name) slots[kind] = null;
      }
      emit();
    },
    get screen() {
      return screen;
    },
    get status() {
      return slots.status ? { ...slots.status } : null;
    },
    get alert() {
      return slots.alert ? { ...slots.alert } : null;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ------------------------------------------------------------- activity log

const MAX_FIELD = 200;
const SECRET_RE = /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{6,}/gi;

/** Remove anything that looks like a credential before it is stored or shown. */
export function redact(text) {
  return String(text ?? '')
    .replace(SECRET_RE, '$1 [hidden]')
    .slice(0, MAX_FIELD);
}

export const ACTIVITY_RESULTS = Object.freeze(['ok', 'error', 'info']);

/**
 * Ring buffer of the last operations (op, target, result, time): the only audit
 * trail of calendar/contact work (SPECS section 10). Newest entry first.
 */
export function createActivityLog({ max = 50, now = () => new Date() } = {}) {
  let entries = [];
  let seq = 0;
  const listeners = new Set();
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  return {
    /** @returns the stored entry {id, time (ISO), op, target, result, detail} */
    add({ op, target = '', result = 'ok', detail = '' }) {
      const entry = {
        id: ++seq,
        time: now().toISOString(),
        op: redact(op),
        target: redact(target),
        result: ACTIVITY_RESULTS.includes(result) ? result : 'info',
        detail: redact(detail),
      };
      entries.unshift(entry);
      if (entries.length > max) entries = entries.slice(0, max);
      emit();
      return entry;
    },
    entries: () => entries.map((e) => ({ ...e })),
    clear() {
      entries = [];
      emit();
    },
    get size() {
      return entries.length;
    },
    max,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ----------------------------------------------------------------- readiness

/**
 * Deterministic readiness for `data-state` / `aria-busy` on the root element:
 * 'loading' while any task is pending, 'error' once a task failed, else 'ready'.
 * `reset()` (on navigation) discards the pending tasks of the previous screen:
 * a late finish of such a task is ignored.
 * @param {(state: 'loading'|'ready'|'error', pending: number) => void} apply
 */
export function createReadiness(apply) {
  let epoch = 0;
  let pending = 0;
  let failed = false;
  let state = 'loading';
  const update = () => {
    const next = pending > 0 ? 'loading' : failed ? 'error' : 'ready';
    state = next;
    apply(next, pending);
  };
  return {
    /** Start a task; call the returned function with ok=false when it failed. */
    begin() {
      const mine = epoch;
      let done = false;
      pending += 1;
      update();
      return (ok = true) => {
        if (done || mine !== epoch) return;
        done = true;
        pending -= 1;
        if (!ok) failed = true;
        update();
      };
    },
    /** Mark the whole screen failed without a task. */
    fail() {
      failed = true;
      update();
    },
    reset() {
      epoch += 1;
      pending = 0;
      failed = false;
      update();
    },
    get state() {
      return state;
    },
    get pending() {
      return pending;
    },
  };
}

// ------------------------------------------------------------------- dialogs

const blocking = new Set();
const unloadTokens = new Set(); // blocking dialogs and dirty forms: each keeps beforeunload armed
let unloadHandler = null;
let unloadWin = null;

/** True while a non-dismissible dialog is open: navigation must not leave. */
export function hasBlockingDialog() {
  return blocking.size > 0;
}

function armUnload(token, win) {
  unloadTokens.add(token);
  if (!unloadHandler && win && typeof win.addEventListener === 'function') {
    unloadHandler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    unloadWin = win;
    win.addEventListener('beforeunload', unloadHandler);
  }
}

function disarmUnload(token) {
  unloadTokens.delete(token);
  if (unloadTokens.size === 0 && unloadHandler) {
    unloadWin.removeEventListener('beforeunload', unloadHandler);
    unloadHandler = null;
    unloadWin = null;
  }
}

function trackBlocking(token, win) {
  blocking.add(token);
  armUnload(token, win);
}

function untrackBlocking(token) {
  blocking.delete(token);
  disarmUnload(token);
}

/**
 * Unsaved-input guard of the shell (D-R2-22). A form screen calls `setDirty(true)` while it holds
 * changes: beforeunload is armed, and the router's canLeave() vetoes the navigation and asks
 * `confirmDiscard({to, discard})` (the shell opens dialog-discard-changes); `discard()` clears the
 * flag and navigates to the vetoed target. A screen may whitelist moves it handles itself with
 * `setHook((to) => true)`. A non-dismissible dialog always vetoes, without a question.
 * @param {object} o
 * @param {object} [o.win]
 * @param {(ask: {to: string, discard: () => void}) => void} o.confirmDiscard
 * @param {(hash: string) => void} o.navigate   forced navigation (skips canLeave)
 */
export function createLeaveGuard({ win = globalThis.window, confirmDiscard, navigate }) {
  const token = {};
  let dirty = false;
  let hook = null;
  let asking = false;
  const guard = {
    get dirty() {
      return dirty;
    },
    setDirty(value) {
      const next = Boolean(value);
      if (next === dirty) return;
      dirty = next;
      if (dirty) armUnload(token, win);
      else disarmUnload(token);
    },
    setHook(fn) {
      hook = typeof fn === 'function' ? fn : null;
    },
    /** Forget the state of the screen that is going away. */
    reset() {
      guard.setDirty(false);
      hook = null;
    },
    /** Router hook: true = leave now. */
    canLeave({ to }) {
      if (hasBlockingDialog()) return false;
      if (!dirty) return true;
      if (hook && hook(to) === true) return true;
      if (!asking) {
        asking = true;
        confirmDiscard({
          to,
          discard: () => {
            asking = false;
            guard.reset();
            navigate(to);
          },
          cancel: () => {
            asking = false;
          },
        });
      }
      return false;
    },
    /** Run `fn` now, or after the user agreed to discard unsaved input (sign-out button). */
    guarded(fn) {
      if (hasBlockingDialog()) return false;
      if (!dirty) {
        fn();
        return true;
      }
      if (!asking) {
        asking = true;
        confirmDiscard({
          to: null,
          discard: () => {
            asking = false;
            guard.reset();
            fn();
          },
          cancel: () => {
            asking = false;
          },
        });
      }
      return false;
    },
    dispose() {
      guard.reset();
    },
  };
  return guard;
}

/**
 * Close handling of a <dialog> (SPECS 10b item 4). For a non-dismissible dialog
 * (the one-time password dialog):
 *  - the `cancel` event is prevented (Esc),
 *  - the Escape keydown is prevented (some browsers close on a second Esc even
 *    when `cancel` was prevented),
 *  - if the dialog still gets closed without allowClose(), it is shown again,
 *  - a beforeunload guard and hasBlockingDialog() stop navigation away.
 * Backdrop clicks never close it (they are not handled at all).
 * @returns {{allowClose(): void, dispose(): void}}
 */
export function guardDialog(dlg, { dismissible = true, win = globalThis.window, onClosed } = {}) {
  const token = {};
  let allowed = dismissible;
  let disposed = false;
  if (!dismissible) trackBlocking(token, win);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    untrackBlocking(token);
  };
  dlg.addEventListener('cancel', (e) => {
    if (!allowed) e.preventDefault();
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !allowed) e.preventDefault();
  });
  dlg.addEventListener('close', () => {
    if (!allowed && !disposed && dlg.isConnected !== false && typeof dlg.showModal === 'function') {
      dlg.showModal(); // closed by something other than an explicit confirm: put it back
      return;
    }
    dispose();
    if (onClosed) onClosed();
  });
  return {
    allowClose() {
      allowed = true;
    },
    dispose,
  };
}

/** Controllers of the dialogs that are open now, so the end of a session can close them all (M1). */
const openDialogs = new Set();

/**
 * Close every open dialog (session expiry, sign-out in this or another tab). Each dialog closes as CANCELLED: its
 * promise or `onClose` gets a return value that is never a confirm button's test id, and its buttons do nothing
 * from then on. Dialogs never outlive the session that opened them.
 * @returns {number} how many were closed
 */
export function closeAllDialogs() {
  const list = [...openDialogs];
  for (const ctrl of list) {
    try {
      ctrl.close('session-ended');
    } catch {
      /* a dialog that fails to close must not keep the others open */
    }
  }
  return list.length;
}

/**
 * Keep `control` (the language select) disabled while a form inside `root` reports busy (`form[aria-busy="true"]`:
 * a save or create is in flight). A redraw for a language change during that time would drop the pending request
 * state and could make a second create a duplicate. Returns a function that stops watching.
 * @param {HTMLElement} root @param {HTMLElement} control
 * @param {{Observer?: typeof MutationObserver}} [o]
 */
export function disableWhileBusy(root, control, { Observer = globalThis.MutationObserver } = {}) {
  const sync = () => {
    const busy = Boolean(root.querySelector('form[aria-busy="true"]'));
    control.disabled = busy;
    if (busy) control.setAttribute('aria-disabled', 'true');
    else control.removeAttribute('aria-disabled');
  };
  if (typeof Observer !== 'function') return () => {};
  const obs = new Observer(sync);
  obs.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });
  sync();
  return () => obs.disconnect();
}

/** How many dialogs are open (tests, diagnostics). */
export const openDialogCount = () => openDialogs.size;

/**
 * Open a modal dialog.
 * @param {object} o
 * @param {string} o.testid       data-testid of the dialog (also prefixes the title/description ids)
 * @param {string} o.title
 * @param {string} [o.description]
 * @param {Node[]} [o.body]
 * @param {{testid: string, label: string, kind?: 'primary'|'danger'|'quiet', disabled?: boolean,
 *          onClick?: (ctrl) => (void|false)}[]} [o.actions]
 *        Every action button closes the dialog unless its onClick returns false.
 *        An action may carry `cancel: true` (the safe button) and `write: true` (registered with the write gate).
 * @param {boolean} [o.dismissible=true] false: Esc, backdrop and navigation cannot close it
 * @param {'cancel'|'first'|string|HTMLElement} [o.focus] what gets focus first (m7): 'cancel' = the action marked
 *        `cancel: true` (else the testid 'dialog-cancel', else the first button), a data-testid of a field inside
 *        the dialog, or an element. Default: [data-autofocus], else the first button.
 * @param {(returnValue: string) => void} [o.onClose]
 * @returns {{dialog: HTMLDialogElement, buttons: Record<string, HTMLButtonElement>, close(value?: string): void}}
 */
export function openDialog({ testid, title, description, body = [], actions = [], dismissible = true, focus, onClose, win } = {}) {
  const doc = getDoc();
  const returnTo = doc.activeElement;
  const titleId = `${testid}-title`;
  const descId = description ? `${testid}-desc` : null;
  const dlg = h('dialog', {
    class: 'dialog',
    testid,
    'aria-labelledby': titleId,
    'aria-describedby': descId,
    'data-dismissible': dismissible ? 'true' : 'false',
  });
  const buttons = {};
  let closed = false;
  const guard = guardDialog(dlg, {
    dismissible,
    win: win || globalThis.window,
    onClosed() {
      closed = true;
      openDialogs.delete(ctrl);
      dlg.remove();
      if (returnTo && returnTo.isConnected && typeof returnTo.focus === 'function') returnTo.focus();
      if (onClose) onClose(dlg.returnValue);
    },
  });
  const ctrl = {
    dialog: dlg,
    buttons,
    close(value = '') {
      guard.allowClose();
      if (dlg.open) dlg.close(String(value));
    },
  };
  const footer = h('div', { class: 'dialog__actions' });
  for (const a of actions) {
    const btn = h(
      'button',
      {
        type: 'button',
        class: ['btn', a.kind ? `btn--${a.kind}` : null],
        testid: a.testid,
        disabled: a.disabled,
        write: a.write,
        on: {
          click: () => {
            if (closed) return; // a closed dialog (for instance by the end of the session) can no longer act
            const keep = a.onClick ? a.onClick(ctrl) : undefined;
            if (keep !== false) ctrl.close(a.testid);
          },
        },
      },
      a.label,
    );
    buttons[a.testid] = btn;
    footer.append(btn);
  }
  append(dlg, [
    h('div', { class: 'dialog__body' }, h('h2', { class: 'dialog__title', id: titleId }, title), description ? h('p', { class: 'dialog__desc', id: descId }, description) : null, ...body, footer),
  ]);
  doc.body.append(dlg);
  dlg.showModal();
  openDialogs.add(ctrl);
  let first = null;
  if (focus && typeof focus === 'object') first = focus;
  else if (focus === 'cancel') {
    const safe = actions.find((a) => a.cancel) || actions.find((a) => a.testid === 'dialog-cancel');
    first = safe ? buttons[safe.testid] : null;
  } else if (typeof focus === 'string' && focus !== 'first') first = dlg.querySelector(`[data-testid="${focus.replace(/["\\]/g, '')}"]`);
  if (!first) first = dlg.querySelector('[data-autofocus]') || footer.querySelector('button');
  if (first) first.focus();
  return ctrl;
}

// ---------------------------------------------------------------- form field

/**
 * A labelled form control with a hint and a visible, programmatically linked
 * error line (SPECS 5.9: nothing is validated by colour alone).
 * `testid` goes on the control; the error line gets `<testid>-error`.
 * @returns {{el: HTMLElement, control: HTMLElement, setError(message: string|null): void}}
 */
export function formField({ id, label, control, hint, testid }) {
  control.id = id;
  if (testid) control.setAttribute('data-testid', testid);
  const hintEl = hint ? h('p', { class: 'field__hint', id: `${id}-hint` }, hint) : null;
  const errEl = h('p', { class: 'field__error', id: `${id}-error`, hidden: true, 'data-testid': testid ? `${testid}-error` : null });
  control.setAttribute('aria-describedby', [hintEl ? hintEl.getAttribute('id') : null, errEl.getAttribute('id')].filter(Boolean).join(' '));
  return {
    el: h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), control, hintEl, errEl),
    control,
    setError(message) {
      if (message) {
        control.setAttribute('aria-invalid', 'true');
        errEl.textContent = message;
        errEl.hidden = false;
      } else {
        control.removeAttribute('aria-invalid');
        errEl.textContent = '';
        errEl.hidden = true;
      }
    },
  };
}

// ------------------------------------------------------------- DOM renderers

/**
 * Render the two feedback slots into their persistent live regions. The region
 * elements stay in the DOM (so assistive technology announces changes); only
 * their content changes. Returns {render} to call again after a language change.
 */
export function mountFeedback(feedback, { statusEl, alertEl, t }) {
  const one = (kind, el, message) => {
    if (!message) return fill(el);
    return fill(
      el,
      h(
        'div',
        { class: ['feedback', `feedback--${kind}`], testid: `${kind}-message`, 'data-screen': message.scope || '' },
        h('span', { class: 'feedback__text', testid: `${kind}-text` }, message.text),
        h('button', { type: 'button', class: 'feedback__close', testid: `${kind}-dismiss`, 'aria-label': t('shell.dismiss'), on: { click: () => feedback.dismiss(kind) } }, '×'),
      ),
    );
  };
  const render = () => {
    one('status', statusEl, feedback.status);
    one('alert', alertEl, feedback.alert);
  };
  feedback.subscribe(render);
  render();
  return { render };
}

/**
 * Render the Activity log into a list element. Operation and result labels are
 * translated for display; the raw English op and result stay in data attributes.
 */
export function mountActivity(log, { listEl, emptyEl, t, formatTime }) {
  const render = () => {
    const entries = log.entries();
    if (emptyEl) emptyEl.hidden = entries.length > 0;
    fill(
      listEl,
      entries.map((e) =>
        h(
          'li',
          { class: ['activity__row', `is-${e.result}`], testid: 'activity-row', 'data-op': e.op, 'data-result': e.result },
          h('time', { class: 'activity__time', datetime: e.time }, formatTime(e.time)),
          h('span', { class: 'activity__op' }, t(`activity.op.${e.op}`) === `activity.op.${e.op}` ? e.op : t(`activity.op.${e.op}`)),
          h('span', { class: 'activity__target' }, e.target),
          h('span', { class: ['activity__result', `activity__result--${e.result}`] }, t(`activity.result.${e.result}`)),
          e.detail ? h('span', { class: 'activity__detail' }, e.detail) : null,
        ),
      ),
    );
  };
  log.subscribe(render);
  render();
  return { render };
}

// ------------------------------------------------------- CSS custom properties

const VAR_NAME_RE = /^--[A-Za-z][A-Za-z0-9-]{0,40}$/;
const MAX_VAR_VALUE = 200;

/**
 * Set CSS custom properties through the CSSOM (`el.style.setProperty`, which a strict
 * `style-src 'self'` allows; a `style` attribute is never written). Every value must match
 * the caller's whitelist regex IN FULL, so data from the server (a calendar colour, say)
 * can only ever be what the caller expects: `vars(el, {'--cal': v}, /^#[0-9a-f]{6}$/i)`.
 * A value that does not match is skipped, never applied.
 * @param {HTMLElement} el
 * @param {Record<string, string>} values custom property name -> value
 * @param {RegExp} allow whitelist for the values
 * @returns {string[]} the names whose value was rejected (empty when everything was applied)
 */
export function vars(el, values, allow) {
  if (!(allow instanceof RegExp)) throw new TypeError('vars() needs a whitelist RegExp');
  const re = new RegExp(allow.source, allow.flags.replace(/[gy]/g, ''));
  const rejected = [];
  for (const [name, value] of Object.entries(values || {})) {
    if (!VAR_NAME_RE.test(name)) throw new TypeError(`"${name}" is not a custom property name`);
    const text = typeof value === 'string' ? value : '';
    const m = text.length > 0 && text.length <= MAX_VAR_VALUE ? text.match(re) : null;
    if (!m || m[0] !== text) {
      rejected.push(name);
      continue;
    }
    el.style.setProperty(name, text);
  }
  return rejected;
}

// -------------------------------------------------------------- data: images

export const IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const MAX_DATA_IMAGE_BYTES = 1.5 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded size of a base64 payload, or null when it is not valid base64. */
export function base64Size(b64) {
  if (typeof b64 !== 'string') return null;
  const clean = b64.replace(/[\r\n\t ]/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0 || !BASE64_RE.test(clean)) return null;
  return (clean.length / 4) * 3 - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
}

/**
 * The ONLY place a `data:` image source is set (h() refuses data: URLs). Accepts jpeg, png, webp and
 * gif (never svg), well-formed base64 and at most MAX_DATA_IMAGE_BYTES of decoded payload.
 * @returns {boolean} true when the image was set; false when it was refused (the caller shows initials)
 */
export function setDataImage(img, mime, b64) {
  const type = typeof mime === 'string' ? mime.trim().toLowerCase() : '';
  const size = base64Size(b64);
  if (!IMAGE_MIMES.includes(type) || size === null || size > MAX_DATA_IMAGE_BYTES) {
    img.removeAttribute('src');
    return false;
  }
  img.setAttribute('src', `data:${type};base64,${b64.replace(/[\r\n\t ]/g, '')}`);
  return true;
}

// ---------------------------------------------------------------- write gate

/**
 * Global write gate (D-R2-19): while the app is offline or the account cannot write, every control
 * registered with markWrite() is `disabled` and its accessible name gains a suffix explaining why
 * ("Save (offline: changes disabled)"). Screens register their write buttons; the shell (or the
 * PWA module) flips the reasons. Controls that were disabled for other reasons stay disabled
 * after the gate opens again.
 */
export function createWriteGate() {
  const reasons = new Map(); // reason -> suffix text
  const marked = new Map(); // element -> {label: string|null, disabled: boolean}
  const listeners = new Set();
  const nameOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim();

  function apply(el) {
    const rec = marked.get(el);
    if (!rec) return;
    if (reasons.size > 0) {
      if (!rec.blocked) {
        rec.blocked = true;
        rec.disabled = Boolean(el.disabled);
        rec.label = el.getAttribute('aria-label');
        rec.base = nameOf(el);
      }
      el.disabled = true;
      el.setAttribute('aria-label', `${rec.base} (${[...reasons.values()].join('; ')})`);
    } else if (rec.blocked) {
      rec.blocked = false;
      el.disabled = rec.disabled;
      if (rec.label === null) el.removeAttribute('aria-label');
      else el.setAttribute('aria-label', rec.label);
    }
  }

  function prune() {
    for (const el of [...marked.keys()]) if (el.isConnected === false) marked.delete(el);
  }

  const gate = {
    /** Register a write control; returns it. */
    mark(el) {
      if (marked.size > 200) prune();
      if (!marked.has(el)) marked.set(el, { blocked: false, disabled: false, label: null, base: '' });
      apply(el);
      return el;
    },
    /**
     * Turn one reason on (`text` = the suffix, already translated) or off (`text` = null).
     * Reasons used by the app: 'offline', 'readonly'.
     */
    setReason(reason, text) {
      if (text === null || text === undefined || text === false) reasons.delete(reason);
      else reasons.set(reason, String(text));
      for (const el of [...marked.keys()]) apply(el);
      for (const fn of [...listeners]) fn(gate.blocked);
    },
    get blocked() {
      return reasons.size > 0;
    },
    get reasons() {
      return [...reasons.keys()];
    },
    get size() {
      prune();
      return marked.size;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return gate;
}

/** The application-wide gate. */
export const writeGate = createWriteGate();

/** Register a write control (save, delete, import, ...) with the application-wide gate. */
export function markWrite(el) {
  return writeGate.mark(el);
}

// -------------------------------------------------- form snapshot / restore (m11)

const FIELD_SELECTOR = 'input, select, textarea';

/**
 * Plain-data copy of what the user typed into the fields inside `root`, so a language switch (which
 * redraws the screen) does not lose it. Fields are keyed by data-testid plus their position among
 * fields sharing that id; password and file inputs are never captured.
 * @returns {{fields: {id: string, i: number, value?: string, checked?: boolean}[], focus: string|null, scroll: number}}
 */
export function snapshotForm(root, doc = getDoc()) {
  const seen = new Map();
  const fields = [];
  for (const el of root.querySelectorAll(FIELD_SELECTOR)) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const id = el.getAttribute('data-testid');
    if (!id || type === 'password' || type === 'file' || type === 'hidden') continue;
    const i = seen.get(id) || 0;
    seen.set(id, i + 1);
    if (type === 'checkbox' || type === 'radio') fields.push({ id, i, checked: Boolean(el.checked) });
    else fields.push({ id, i, value: String(el.value ?? '') });
  }
  const active = doc && doc.activeElement && root.contains && root.contains(doc.activeElement) ? doc.activeElement.getAttribute('data-testid') : null;
  return { fields, focus: active || null, scroll: typeof root.scrollTop === 'number' ? root.scrollTop : 0 };
}

/** Put a snapshotForm() result back into the redrawn `root`; fields that no longer exist are skipped. */
export function restoreForm(root, snap) {
  if (!snap || !Array.isArray(snap.fields)) return 0;
  const byId = new Map();
  for (const el of root.querySelectorAll(FIELD_SELECTOR)) {
    const id = el.getAttribute('data-testid');
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(el);
  }
  let n = 0;
  for (const f of snap.fields) {
    const el = (byId.get(f.id) || [])[f.i];
    if (!el) continue;
    if (f.checked !== undefined) el.checked = f.checked;
    else el.value = f.value;
    n += 1;
  }
  if (snap.focus) {
    const el = (byId.get(snap.focus) || [])[0];
    if (el && typeof el.focus === 'function') el.focus();
  }
  return n;
}
