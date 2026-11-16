// SPDX-License-Identifier: AGPL-3.0-or-later
// A small fake DOM for the widget tests: elements with attributes, classList, bubbling events, a selector
// engine (tag, #id, .class, [attr], [attr="v"], descendant and comma), <select>, <dialog> with the events a
// browser fires, focus tracking and style.setProperty. Enough to render the widgets and drive them like a user.
import { setDocument } from '../../../src/js/ui.js';

class Text {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
}

const BOOLEAN_ATTRS = new Set(['hidden', 'disabled', 'open', 'required', 'multiple', 'readonly']);

function parseCompound(src) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  let rest = src;
  const m0 = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (m0) {
    c.tag = m0[0].toLowerCase();
    rest = rest.slice(m0[0].length);
  }
  while (rest) {
    let m;
    if ((m = rest.match(/^#([\w-]+)/))) c.id = m[1];
    else if ((m = rest.match(/^\.([\w-]+)/))) c.classes.push(m[1]);
    else if ((m = rest.match(/^\[([\w:-]+)(?:="([^"]*)")?\]/))) c.attrs.push([m[1], m[2]]);
    else throw new Error(`fake DOM: unsupported selector part "${rest}"`);
    rest = rest.slice(m[0].length);
  }
  return c;
}

function compoundMatches(el, c) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const [name, value] of c.attrs) {
    if (!el.hasAttribute(name)) return false;
    if (value !== undefined && el.getAttribute(name) !== value) return false;
  }
  return true;
}

export class El {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.styleProps = new Map();
    this.style = { setProperty: (k, v) => this.styleProps.set(k, v) };
    this.checked = false;
    this.selected = false;
    this._value = '';
    this.returnValue = '';
    const self = this;
    this.classList = {
      add: (...cs) => self.setAttribute('class', [...new Set([...self._classes(), ...cs])].join(' ')),
      remove: (...cs) => self.setAttribute('class', self._classes().filter((c) => !cs.includes(c)).join(' ')),
      contains: (c) => self._classes().includes(c),
      toggle(c, force) {
        const on = force === undefined ? !this.contains(c) : Boolean(force);
        if (on) this.add(c);
        else this.remove(c);
        return on;
      },
    };
  }
  _classes() {
    return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }
  get className() {
    return this.getAttribute('class') || '';
  }
  set className(v) {
    this.setAttribute('class', v);
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  // boolean attributes reflect to attributes
  get hidden() {
    return this.hasAttribute('hidden');
  }
  set hidden(v) {
    if (v) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }
  get disabled() {
    return this.hasAttribute('disabled');
  }
  set disabled(v) {
    if (v) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }
  get open() {
    return this._open === true;
  }
  set open(v) {
    this._open = Boolean(v);
  }
  get value() {
    if (this.tagName === 'SELECT') {
      const opts = this.all((e) => e.tagName === 'OPTION');
      const sel = opts.find((o) => o.selected) || opts[0];
      return sel ? sel.value : '';
    }
    if (this.tagName === 'OPTION') return this._valueSet ? this._value : this._value || this.textContent; // an option set to '' keeps '' (as in a browser)
    return this._value;
  }
  set value(v) {
    if (this.tagName === 'SELECT') {
      for (const o of this.all((e) => e.tagName === 'OPTION')) o.selected = o.value === String(v);
      return;
    }
    this._value = String(v);
    this._valueSet = true;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.append(new Text(v));
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.body || n === this.ownerDocument.root;
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(n) {
    this.append(n);
    return n;
  }
  removeChild(n) {
    this.childNodes = this.childNodes.filter((c) => c !== n);
    n.parentNode = null;
    return n;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  all(pred, out = []) {
    for (const c of this.childNodes) {
      if (c.nodeType !== 1) continue;
      if (pred(c)) out.push(c);
      c.all(pred, out);
    }
    return out;
  }
  matches(sel) {
    return sel.split(',').some((part) => {
      const chain = part.trim().split(/\s+/).map(parseCompound);
      const last = chain.pop();
      if (!compoundMatches(this, last)) return false;
      let anc = this.parentNode;
      while (chain.length) {
        const want = chain.pop();
        while (anc && !(anc.nodeType === 1 && compoundMatches(anc, want))) anc = anc.parentNode;
        if (!anc) return false;
        anc = anc.parentNode;
      }
      return true;
    });
  }
  querySelectorAll(sel) {
    return this.all((e) => e.matches(sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn));
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    for (let n = this; n && !ev.stopped; n = n.parentNode) {
      if (!n.listeners) continue;
      ev.currentTarget = n;
      for (const fn of [...(n.listeners.get(ev.type) || [])]) fn(ev);
      if (ev.bubbles === false) break;
    }
    return !ev.defaultPrevented;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  scrollIntoView() {
    this.scrolled = (this.scrolled || 0) + 1;
  }
  click() {
    return fire(this, 'click');
  }
  // <dialog>
  showModal() {
    this.open = true;
  }
  close(value = '') {
    if (!this.open) return;
    this.open = false;
    this.returnValue = value;
    this.dispatchEvent(Object.assign(new Ev('close'), { bubbles: false }));
  }
}

export class Ev {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = true;
    this.cancelable = true;
    this.defaultPrevented = false;
    this.stopped = false;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

/** A fresh document installed as ui.js' document. */
export function makeDom() {
  const doc = {
    root: null,
    body: null,
    activeElement: null,
    createElement: (tag) => new El(tag, doc),
    createTextNode: (t) => new Text(t),
  };
  doc.body = new El('body', doc);
  doc.activeElement = doc.body;
  setDocument(doc);
  return doc;
}

/** Dispatch an event on an element (it bubbles). Returns the event. */
export function fire(el, type, init = {}) {
  const ev = new Ev(type, init);
  el.dispatchEvent(ev);
  return ev;
}

export const key = (el, k, init = {}) => fire(el, 'keydown', { key: k, ...init });

/** Type text into an input: sets the value and fires `input`. */
export function type(el, text) {
  el.value = text;
  return fire(el, 'input');
}

/** What leaving a field after typing does: `change`. */
export const change = (el) => fire(el, 'change');

/** Select an option of a <select> and fire `change`. */
export function choose(sel, value) {
  sel.value = value;
  return fire(sel, 'change');
}

/** Tick a radio the way a browser does (the others of its group untick) and fire `change`. */
export function chooseRadio(radio, doc) {
  const name = radio.getAttribute('name');
  for (const r of doc.body.querySelectorAll('input')) if (r !== radio && r.getAttribute('type') === 'radio' && r.getAttribute('name') === name) r.checked = false;
  radio.checked = true;
  return fire(radio, 'change');
}

/** Esc on an open modal dialog: keydown, then `cancel`, then close unless prevented. */
export function pressEscape(dlg) {
  const k = key(dlg, 'Escape');
  if (k.defaultPrevented) return 'blocked-by-keydown';
  const c = fire(dlg, 'cancel');
  if (c.defaultPrevented) return 'blocked-by-cancel';
  dlg.close();
  return 'closed';
}

export const byTestId = (root, id) => root.querySelectorAll(`[data-testid="${id}"]`);
export const one = (root, id) => root.querySelector(`[data-testid="${id}"]`);

/** Fake timers: setTimeout/clearTimeout with manual advance. */
export function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { fn, at: now + ms });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        now = due[1].at;
        pending.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
    get pending() {
      return pending.size;
    },
  };
}

/** The identity translator that shows keys and params, for tests that do not need real strings. */
export const keyT = (k, p) => (p && Object.keys(p).length ? `${k}${JSON.stringify(p)}` : k);
