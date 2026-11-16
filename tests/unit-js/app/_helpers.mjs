// SPDX-License-Identifier: AGPL-3.0-or-later
// Test helpers for the app shell: a fake fetch, fake storages and a tiny fake DOM.

/** Fake fetch. handler({url, path, method, headers, body}) returns {status, headers, body} or throws. */
export function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    const u = new URL(url, 'http://placeholder.invalid');
    const call = { url: String(url), path: u.pathname, search: u.search, method: init.method || 'GET', headers, body: init.body, init };
    calls.push(call);
    const r = await handler(call);
    if (r instanceof Response) return r;
    const status = r.status === undefined ? 200 : r.status;
    const nullBody = status === 204 || r.body === undefined || r.body === '';
    return new Response(nullBody ? null : r.body, { status, headers: r.headers || {} });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

export const json = (status, value, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });

/** A Storage-like object. `throwOn` lists methods that throw (e.g. ['setItem']). */
export function fakeStorage({ throwOn = [] } = {}) {
  const data = new Map();
  const guard = (name) => {
    if (throwOn.includes(name)) throw new DOMException('storage blocked', 'SecurityError');
  };
  return {
    data,
    getItem(k) {
      guard('getItem');
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      guard('setItem');
      data.set(k, String(v));
    },
    removeItem(k) {
      guard('removeItem');
      data.delete(k);
    },
  };
}

// ------------------------------------------------------------------ fake DOM

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
  }
  get textContent() {
    return this.data;
  }
}

export class FakeElement extends EventTarget {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.className = '';
    this.isConnected = true;
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
    this.children.push(...nodes);
  }
  removeChild(n) {
    this.children = this.children.filter((c) => c !== n);
  }
  focus() {
    FakeElement.focused = this;
  }
  select() {
    this.selectCount = (this.selectCount || 0) + 1;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get textContent() {
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children = v === '' ? [] : [new FakeText(v)];
  }
}

export function fakeDocument() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (t) => new FakeText(t),
  };
}

/** Fake <dialog>: showModal/close with the same events a browser fires. */
export class FakeDialog extends EventTarget {
  constructor() {
    super();
    this.open = false;
    this.isConnected = true;
    this.returnValue = '';
    this.showCount = 0;
  }
  showModal() {
    this.open = true;
    this.showCount += 1;
  }
  close(value = '') {
    if (!this.open) return;
    this.open = false;
    this.returnValue = value;
    this.dispatchEvent(new Event('close'));
  }
  /** What Esc does in a browser: a cancelable `cancel` event, then close unless prevented. */
  pressEscape() {
    const key = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    this.dispatchEvent(key);
    if (key.defaultPrevented) return 'blocked-by-keydown';
    const cancel = new Event('cancel', { cancelable: true });
    this.dispatchEvent(cancel);
    if (cancel.defaultPrevented) return 'blocked-by-cancel';
    this.close();
    return 'closed';
  }
}

/** Depth-first search for elements by data-testid. */
export function findAll(root, testid, out = []) {
  if (root.nodeType === 1) {
    if (root.getAttribute('data-testid') === testid) out.push(root);
    for (const c of root.children) findAll(c, testid, out);
  }
  return out;
}
export const find = (root, testid) => findAll(root, testid)[0] || null;
