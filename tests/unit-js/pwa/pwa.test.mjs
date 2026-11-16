// SPDX-License-Identifier: AGPL-3.0-or-later
// js/pwa.js with fake navigator.serviceWorker, window and document.

import test from 'node:test';
import assert from 'node:assert/strict';
import { canRegister, initPwa } from '../../../src/js/pwa.js';

class FakeEl extends EventTarget {
  constructor() {
    super();
    this.hidden = true;
    this.span = { textContent: 'A new version is available.', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  }
  querySelector(sel) {
    return sel === 'span' ? this.span : null;
  }
}

function fakeGate() {
  const reasons = {};
  return {
    reasons,
    setReason(reason, text) {
      if (text === null) delete reasons[reason];
      else reasons[reason] = text;
    },
  };
}

function fakeWorker(state = 'installing') {
  const w = new EventTarget();
  w.state = state;
  w.posted = [];
  w.postMessage = (m, transfer) => w.posted.push({ m, transfer });
  return w;
}

function fakeReg({ waiting = null, installing = null, active = null } = {}) {
  const r = new EventTarget();
  Object.assign(r, { waiting, installing, active, updates: 0 });
  r.update = async () => {
    r.updates += 1;
  };
  return r;
}

function setup({ controller = null, reg = fakeReg(), secure = true, hostname = 'example.org', readyState = 'complete', visibility = 'visible', noSw = false, registerImpl, guarded, gate = fakeGate(), ...rest } = {}) {
  const sw = new EventTarget();
  sw.controller = controller;
  sw.registered = [];
  sw.register = registerImpl || (async (url, opts) => {
    sw.registered.push({ url, opts });
    return reg;
  });
  const timers = [];
  const win = new EventTarget();
  Object.assign(win, {
    navigator: noSw ? {} : { serviceWorker: sw },
    isSecureContext: secure,
    location: { hostname, reloads: 0, reload() { this.reloads += 1; } },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
  });
  const banner = new FakeEl();
  const button = new FakeEl();
  const doc = new EventTarget();
  Object.assign(doc, {
    readyState,
    visibilityState: visibility,
    getElementById: (id) => ({ 'banner-update': banner, 'btn-reload-update': button })[id] || null,
  });
  let clock = 1_000_000;
  const prompts = [];
  const pwa = initPwa({
    win,
    doc,
    t: (k) => `[${k}]`,
    now: () => clock,
    guarded: guarded || ((fn) => fn()),
    gate,
    ...rest,
  });
  return { pwa, sw, win, doc, banner, button, reg, timers, prompts, advance: (ms) => (clock += ms), setVisible: (v) => (doc.visibilityState = v) };
}
const click = (el) => el.dispatchEvent(new Event('click'));
const tick = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------ registration

test('registers sw.js relative to the page with scope ./ and updateViaCache none', async () => {
  const s = setup();
  assert.equal(await s.pwa.ready, true);
  assert.deepEqual(s.sw.registered, [{ url: 'sw.js', opts: { scope: './', updateViaCache: 'none' } }]);
  assert.equal(s.banner.hidden, true);
});

test('waits for the load event when the document is still loading', async () => {
  const s = setup({ readyState: 'loading' });
  await tick();
  assert.equal(s.sw.registered.length, 0);
  s.win.dispatchEvent(new Event('load'));
  assert.equal(await s.pwa.ready, true);
  assert.equal(s.sw.registered.length, 1);
});

test('does nothing without service worker support', async () => {
  const s = setup({ noSw: true });
  assert.equal(s.pwa.supported, false);
  assert.equal(await s.pwa.ready, false);
  assert.equal(await s.pwa.version(), null);
  assert.equal(await s.pwa.update(), false);
});

test('registers nothing on an insecure context, except on localhost', async () => {
  const insecure = setup({ secure: false, hostname: 'example.org' });
  assert.equal(await insecure.pwa.ready, false);
  assert.equal(insecure.sw.registered.length, 0);
  for (const hostname of ['localhost', '127.0.0.1', 'app.localhost', '[::1]']) {
    const s = setup({ secure: false, hostname });
    assert.equal(await s.pwa.ready, true, hostname);
    assert.equal(s.sw.registered.length, 1, hostname);
  }
  assert.equal(canRegister(null), false);
  assert.equal(canRegister({ navigator: { serviceWorker: {} }, isSecureContext: false, location: { hostname: 'evil.localhost.example.org' } }), false);
});

test('never throws: a rejected or throwing register leaves the app running', async () => {
  const rejected = setup({ registerImpl: async () => Promise.reject(new Error('blocked')) });
  assert.equal(await rejected.pwa.ready, false);
  const thrown = setup({ registerImpl: () => { throw new Error('sync failure'); } });
  assert.equal(await thrown.pwa.ready, false);
  assert.doesNotThrow(() => initPwa({ win: {}, doc: {} }));
  assert.doesNotThrow(() => initPwa({ win: null, doc: null }));
  assert.doesNotThrow(() => initPwa());
});

// ------------------------------------------------------------------ detecting an update

test('a waiting worker with a controlling worker shows the update banner', async () => {
  const s = setup({ controller: fakeWorker('activated'), reg: fakeReg({ waiting: fakeWorker('installed') }) });
  await s.pwa.ready;
  assert.equal(s.banner.hidden, false);
});

test('a waiting worker on a page without a controller (first install) shows nothing', async () => {
  const s = setup({ controller: null, reg: fakeReg({ waiting: fakeWorker('installed') }) });
  await s.pwa.ready;
  assert.equal(s.banner.hidden, true);
});

test('updatefound: the banner appears when the new worker reaches installed, and only with a controller', async () => {
  const reg = fakeReg();
  const s = setup({ controller: fakeWorker('activated'), reg });
  await s.pwa.ready;
  const installing = fakeWorker('installing');
  reg.installing = installing;
  reg.dispatchEvent(new Event('updatefound'));
  assert.equal(s.banner.hidden, true);
  installing.state = 'installed';
  installing.dispatchEvent(new Event('statechange'));
  assert.equal(s.banner.hidden, false);

  const reg2 = fakeReg();
  const first = setup({ controller: null, reg: reg2 });
  await first.pwa.ready;
  const w = fakeWorker('installing');
  reg2.installing = w;
  reg2.dispatchEvent(new Event('updatefound'));
  w.state = 'installed';
  w.dispatchEvent(new Event('statechange'));
  assert.equal(first.banner.hidden, true);
});

test('a failed install (redundant) never shows the banner', async () => {
  const reg = fakeReg();
  const s = setup({ controller: fakeWorker('activated'), reg });
  await s.pwa.ready;
  const w = fakeWorker('installing');
  reg.installing = w;
  reg.dispatchEvent(new Event('updatefound'));
  w.state = 'redundant';
  w.dispatchEvent(new Event('statechange'));
  assert.equal(s.banner.hidden, true);
});

// ------------------------------------------------------------------ applying the update

test('the button posts SKIP_WAITING and the page reloads once the new worker controls it', async () => {
  const waiting = fakeWorker('installed');
  const s = setup({ controller: fakeWorker('activated'), reg: fakeReg({ waiting }) });
  await s.pwa.ready;
  click(s.button);
  assert.deepEqual(waiting.posted.map((p) => p.m), [{ type: 'SKIP_WAITING' }]);
  assert.equal(s.win.location.reloads, 0, 'no reload before the new worker controls the page');
  s.sw.dispatchEvent(new Event('controllerchange'));
  s.sw.dispatchEvent(new Event('controllerchange'));
  assert.equal(s.win.location.reloads, 1, 'reloads exactly once');
});

test('unsaved input: the discard confirmation comes first; keeping the form posts nothing', async () => {
  const waiting = fakeWorker('installed');
  const asked = [];
  let pending = null;
  const guarded = (fn) => {
    asked.push('confirm');
    pending = fn; // the dialog is open; the shell calls fn only on "Discard changes"
  };
  const s = setup({ controller: fakeWorker('activated'), reg: fakeReg({ waiting }), guarded });
  await s.pwa.ready;
  click(s.button);
  assert.deepEqual(asked, ['confirm']);
  assert.equal(waiting.posted.length, 0, 'nothing is posted before the user agrees');
  assert.equal(s.win.location.reloads, 0);
  // "Keep editing": the shell never calls fn. Clicking again asks again.
  click(s.button);
  assert.equal(asked.length, 2);
  assert.equal(waiting.posted.length, 0);
  // "Discard changes"
  pending();
  assert.equal(waiting.posted.length, 1);
  s.sw.dispatchEvent(new Event('controllerchange'));
  assert.equal(s.win.location.reloads, 1);
});

test('a controllerchange nobody asked for (another tab applied the update) marks the page stale: banner, closed write gate, no reload', async () => {
  const gate = fakeGate();
  const s = setup({ controller: fakeWorker('activated'), gate });
  await s.pwa.ready;
  s.sw.dispatchEvent(new Event('controllerchange'));
  assert.equal(s.banner.hidden, false);
  assert.deepEqual(gate.reasons, { update: '[pwa.stale.gate]' });
  assert.equal(s.banner.span.textContent, '[pwa.stale.text]');
  assert.equal(s.banner.span.attrs['data-i18n'], 'pwa.stale.text', 'a language switch keeps the stale text');
  assert.equal(s.win.location.reloads, 0, 'never reload under a form');
  click(s.button); // no waiting worker any more: reload to move to the new version
  assert.equal(s.win.location.reloads, 1);
});

test('a stale page with unsaved input asks the discard question before reloading', async () => {
  const gate = fakeGate();
  let pending = null;
  const s = setup({ controller: fakeWorker('activated'), gate, guarded: (fn) => (pending = fn) });
  await s.pwa.ready;
  s.sw.dispatchEvent(new Event('controllerchange'));
  click(s.button);
  assert.equal(s.win.location.reloads, 0);
  pending();
  assert.equal(s.win.location.reloads, 1);
});

test('the requested-update flow and the first install never close the write gate', async () => {
  const gate = fakeGate();
  const s = setup({ controller: fakeWorker('activated'), reg: fakeReg({ waiting: fakeWorker('installed') }), gate });
  await s.pwa.ready;
  click(s.button);
  s.sw.dispatchEvent(new Event('controllerchange'));
  assert.deepEqual(gate.reasons, {});
  const first = fakeGate();
  const f = setup({ controller: null, gate: first });
  await f.pwa.ready;
  f.sw.controller = fakeWorker('activated');
  f.sw.dispatchEvent(new Event('controllerchange'));
  assert.deepEqual(first.reasons, {});
});

test('a throwing write gate does not stop the stale banner', async () => {
  const s = setup({ controller: fakeWorker('activated'), gate: { setReason() { throw new Error('gate'); } } });
  await s.pwa.ready;
  s.sw.dispatchEvent(new Event('controllerchange'));
  assert.equal(s.banner.hidden, false);
});

test('the first install claiming the page is not an update', async () => {
  const s = setup({ controller: null });
  await s.pwa.ready;
  s.sw.controller = fakeWorker('activated');
  s.sw.dispatchEvent(new Event('controllerchange'));
  assert.equal(s.banner.hidden, true);
  assert.equal(s.win.location.reloads, 0);
});

test('if the new worker never takes control the banner says so', async () => {
  const s = setup({ controller: fakeWorker('activated'), reg: fakeReg({ waiting: fakeWorker('installed') }) });
  await s.pwa.ready;
  click(s.button);
  assert.equal(s.timers.length, 1);
  s.timers[0].fn();
  assert.equal(s.banner.span.textContent, '[pwa.update.stuck]');
});

test('a throwing postMessage or guard does not break the page', async () => {
  const waiting = fakeWorker('installed');
  waiting.postMessage = () => {
    throw new Error('dead worker');
  };
  const s = setup({ controller: fakeWorker('activated'), reg: fakeReg({ waiting }) });
  await s.pwa.ready;
  assert.doesNotThrow(() => click(s.button));
  const g = setup({ controller: fakeWorker('activated'), reg: fakeReg({ waiting: fakeWorker('installed') }), guarded: () => { throw new Error('guard'); } });
  await g.pwa.ready;
  assert.doesNotThrow(() => click(g.button));
});

// ------------------------------------------------------------------ hourly update check

test('reg.update() runs when the page becomes visible, at most once an hour', async () => {
  const s = setup({ controller: fakeWorker('activated') });
  await s.pwa.ready;
  const visible = () => s.doc.dispatchEvent(new Event('visibilitychange'));
  visible();
  assert.equal(s.reg.updates, 0, 'registration itself just checked');
  s.advance(59 * 60 * 1000);
  visible();
  assert.equal(s.reg.updates, 0);
  s.advance(2 * 60 * 1000);
  visible();
  assert.equal(s.reg.updates, 1);
  s.advance(10 * 60 * 1000);
  visible();
  assert.equal(s.reg.updates, 1, 'the next one is an hour later');
  s.advance(61 * 60 * 1000);
  s.setVisible('hidden');
  visible();
  assert.equal(s.reg.updates, 1, 'hidden pages do not check');
  s.setVisible('visible');
  visible();
  assert.equal(s.reg.updates, 2);
});

test('a failing reg.update() is swallowed', async () => {
  const reg = fakeReg();
  reg.update = async () => Promise.reject(new Error('offline'));
  const s = setup({ reg });
  await s.pwa.ready;
  s.advance(2 * 60 * 60 * 1000);
  s.doc.dispatchEvent(new Event('visibilitychange'));
  await tick();
  assert.equal(await s.pwa.update(), false);
});

// ------------------------------------------------------------------ version and dispose

test('version() asks the active worker over a message channel and returns its answer', async () => {
  const active = fakeWorker('activated');
  const s = setup({ reg: fakeReg({ active }) });
  let channel;
  s.win.MessageChannel = class {
    constructor() {
      this.port1 = {};
      this.port2 = {};
      channel = this;
    }
  };
  await s.pwa.ready;
  const pending = s.pwa.version();
  assert.deepEqual(active.posted[0].m, { type: 'GET_VERSION' });
  assert.deepEqual(active.posted[0].transfer, [channel.port2]);
  channel.port1.onmessage({ data: { type: 'VERSION', version: '0123456789abcdef' } });
  assert.equal(await pending, '0123456789abcdef');
});

test('version() is null when there is no worker or no MessageChannel', async () => {
  const s = setup();
  await s.pwa.ready;
  assert.equal(await s.pwa.version(), null);
});

test('dispose() removes the listeners', async () => {
  const waiting = fakeWorker('installed');
  const s = setup({ controller: fakeWorker('activated'), reg: fakeReg({ waiting }) });
  await s.pwa.ready;
  s.pwa.dispose();
  click(s.button);
  s.advance(2 * 60 * 60 * 1000);
  s.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(waiting.posted.length, 0);
  assert.equal(s.reg.updates, 0);
});
