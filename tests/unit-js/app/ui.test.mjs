// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  h,
  setDocument,
  fill,
  formField,
  createFeedback,
  createActivityLog,
  createReadiness,
  redact,
  guardDialog,
  hasBlockingDialog,
  safeGet,
  safeSet,
  safeRemove,
  readTheme,
  applyTheme,
  PREF_THEME,
  isAllowedUrl,
} from '../../../src/js/ui.js';
import { fakeDocument, FakeDialog, FakeElement, fakeStorage } from './_helpers.mjs';

setDocument(fakeDocument());

// ------------------------------------------------------------------ builder

test('h(): attributes, classes, test ids, text children only', () => {
  const evil = '<img src=x onerror=alert(1)>';
  let clicked = 0;
  const el = h('button', { class: ['btn', null, 'btn--x'], testid: 'go', 'aria-label': 'Go', disabled: true, hidden: false, on: { click: () => (clicked += 1) } }, evil, 7, null, [h('span', null, 'inner')]);
  assert.equal(el.tagName, 'BUTTON');
  assert.equal(el.className, 'btn btn--x');
  assert.equal(el.getAttribute('data-testid'), 'go');
  assert.equal(el.getAttribute('aria-label'), 'Go');
  assert.equal(el.disabled, true);
  assert.equal(el.children[0].nodeType, 3); // a text node, never parsed as HTML
  assert.equal(el.children[0].data, evil);
  assert.equal(el.textContent, evil + '7inner');
  el.dispatchEvent(new Event('click'));
  assert.equal(clicked, 1);
});

test('h(): refuses style, inline handlers, raw HTML and script URLs', () => {
  for (const props of [{ style: 'color:red' }, { onclick: 'x()' }, { onClick: 'x()' }, { onerror: 'x()' }, { innerHTML: '<b>' }, { outerHTML: 'x' }, { srcdoc: 'x' }, { href: 'javascript:alert(1)' }, { href: ' JaVa\tScript:alert(1)' }, { src: 'data:text/html,x' }]) {
    assert.throws(() => h('a', props), TypeError, JSON.stringify(props));
  }
  assert.doesNotThrow(() => h('a', { href: '#/debug' }));
  assert.doesNotThrow(() => h('a', { href: 'https://example.org/' }));
});

test('h(): href, src, action and formaction use an allowlist of schemes', () => {
  const ok = ['#/debug', '#', 'https://example.org/a?b=1#c', 'http://example.org/', 'HTTPS://EXAMPLE.ORG/', 'mailto:a@example.org', 'MailTo:a@example.org', 'tel:+41000000000', '/path/x', 'rel/path', './x', '../x', '?q=1', 'x.html#frag', 'a/b:c', '', ' #/x '];
  for (const attr of ['href', 'src', 'action', 'formaction']) {
    for (const v of ok) assert.doesNotThrow(() => h('a', { [attr]: v }), `${attr}=${JSON.stringify(v)}`);
  }
  const bad = [
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)',
    '\u0001javascript:alert(1)', 'java\u0000script:alert(1)', '\u00a0javascript:x', 'java\u200bscript:x', '\ufeffjavascript:x', 'jav&#x61;script:x'.replace('&#x61;', '\u0000a'),
    'data:text/html,<b>x</b>', 'DATA:image/png;base64,AAAA', ' data:text/html,x', 'vbscript:msgbox(1)', 'VBScript:x', 'file:///etc/passwd', 'blob:https://example.org/x', 'ftp://example.org/', 'about:blank', 'chrome://x', 'view-source:https://example.org/',
    '//evil.example.net/x', '\\\\evil.example.net/x', '/\\evil.example.net/x', 'x-unknown:y',
  ];
  for (const attr of ['href', 'src', 'action', 'formaction']) {
    for (const v of bad) assert.throws(() => h('a', { [attr]: v }), TypeError, `${attr}=${JSON.stringify(v)}`);
  }
  assert.equal(isAllowedUrl('javascript:1'), false);
  assert.equal(isAllowedUrl('#/ok'), true);
  assert.equal(h('a', { href: '#/ok' }).getAttribute('href'), '#/ok');
});

test('h(): true becomes an empty attribute, false/null/undefined are skipped', () => {
  const el = h('form', { novalidate: true, a: false, b: null, c: undefined });
  assert.equal(el.getAttribute('novalidate'), '');
  assert.equal(el.hasAttribute('a') || el.hasAttribute('b') || el.hasAttribute('c'), false);
});

test('fill() replaces children', () => {
  const el = h('div', null, 'old');
  fill(el, 'new', h('i', null, 'x'));
  assert.equal(el.textContent, 'newx');
  fill(el);
  assert.equal(el.children.length, 0);
});

test('formField links hint and error with aria-describedby and toggles aria-invalid', () => {
  const control = new FakeElement('input');
  const f = formField({ id: 'u', label: 'User', control, hint: 'Hint', testid: 'login-username' });
  assert.equal(control.getAttribute('data-testid'), 'login-username');
  assert.equal(control.getAttribute('aria-describedby'), 'u-hint u-error');
  f.setError('Required');
  assert.equal(control.getAttribute('aria-invalid'), 'true');
  const err = f.el.children[3];
  assert.equal(err.getAttribute('id'), 'u-error');
  assert.equal(err.textContent, 'Required');
  assert.equal(err.hidden, false);
  f.setError(null);
  assert.equal(control.hasAttribute('aria-invalid'), false);
  assert.equal(err.hidden, true);
  assert.equal(err.textContent, '');
});

// ----------------------------------------------------------------- feedback

test('feedback: messages persist until dismissed (no timers)', async () => {
  const fb = createFeedback();
  fb.enterScreen('debug');
  fb.setStatus('Saved');
  fb.setAlert('Failed');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fb.status.text, 'Saved');
  assert.equal(fb.alert.text, 'Failed');
  fb.dismiss('status');
  assert.equal(fb.status, null);
  assert.equal(fb.alert.text, 'Failed');
});

test('feedback scoping: messages belong to the screen that made them and are cleared on navigation', () => {
  const fb = createFeedback();
  fb.enterScreen('login');
  fb.setAlert('Wrong password');
  assert.equal(fb.alert.scope, 'login');
  fb.enterScreen('login'); // same screen again: kept
  assert.ok(fb.alert);
  fb.enterScreen('debug');
  assert.equal(fb.alert, null);

  // an explicit scope for the NEXT screen survives the navigation, then is dropped on the one after
  fb.setStatus('Signed in', { scope: 'debug' });
  fb.enterScreen('debug');
  assert.equal(fb.status.text, 'Signed in');
  fb.enterScreen('notfound');
  assert.equal(fb.status, null);

  // global messages survive navigation until dismissed
  fb.setAlert('Offline', { scope: null });
  fb.enterScreen('login');
  fb.enterScreen('debug');
  assert.equal(fb.alert.text, 'Offline');
  fb.dismiss('alert');
  assert.equal(fb.alert, null);
});

test('feedback: empty text clears, replacing keeps one slot, subscribers are told', () => {
  const fb = createFeedback();
  let n = 0;
  const off = fb.subscribe(() => (n += 1));
  fb.setStatus('a');
  fb.setStatus('b');
  assert.equal(fb.status.text, 'b');
  fb.setStatus('');
  assert.equal(fb.status, null);
  assert.equal(n, 3);
  off();
  fb.setStatus('c');
  assert.equal(n, 3);
  assert.notEqual(fb.status, fb.status); // copies, not the internal object
});

// ------------------------------------------------------------- activity log

test('activity log is a ring buffer, newest first', () => {
  let t = 0;
  const log = createActivityLog({ max: 3, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)) });
  for (let i = 1; i <= 5; i += 1) log.add({ op: 'op' + i, target: 't' + i });
  const e = log.entries();
  assert.equal(e.length, 3);
  assert.deepEqual(e.map((x) => x.op), ['op5', 'op4', 'op3']);
  assert.equal(e[0].time, '2026-01-01T00:00:04.000Z');
  assert.equal(log.size, 3);
  e[0].op = 'tampered';
  assert.equal(log.entries()[0].op, 'op5');
  log.clear();
  assert.equal(log.size, 0);
});

test('activity log: result is constrained, secrets are redacted, fields are bounded', () => {
  const log = createActivityLog();
  const entry = log.add({ op: 'x', target: 'Authorization: Basic YWxpY2U6c2VjcmV0 and Bearer abcdefgh', result: 'weird', detail: 'y'.repeat(500) });
  assert.equal(entry.result, 'info');
  assert.ok(!entry.target.includes('YWxpY2U6c2VjcmV0'));
  assert.ok(!entry.target.includes('abcdefgh'));
  assert.match(entry.target, /Basic \[hidden\]/);
  assert.equal(entry.detail.length, 200);
  assert.equal(redact(null), '');
  let n = 0;
  log.subscribe(() => (n += 1));
  log.add({ op: 'a' });
  assert.equal(n, 1);
});

// ---------------------------------------------------------------- readiness

test('readiness: loading while tasks are pending, error after a failure, ready otherwise', () => {
  const seen = [];
  const r = createReadiness((s, p) => seen.push(`${s}:${p}`));
  const a = r.begin();
  const b = r.begin();
  assert.equal(r.state, 'loading');
  a(true);
  assert.equal(r.state, 'loading');
  b(true);
  assert.equal(r.state, 'ready');
  const c = r.begin();
  c(false);
  assert.equal(r.state, 'error');
  c(true); // double finish ignored
  assert.equal(r.pending, 0);
  r.reset();
  assert.equal(r.state, 'ready');
  assert.deepEqual(seen.slice(0, 5), ['loading:1', 'loading:2', 'loading:1', 'ready:0', 'loading:1']);
});

test('readiness: tasks of a previous screen cannot corrupt the next one', () => {
  const r = createReadiness(() => {});
  const stale = r.begin();
  r.reset();
  const fresh = r.begin();
  stale(false); // late failure of the old screen: ignored
  assert.equal(r.state, 'loading');
  assert.equal(r.pending, 1);
  fresh(true);
  assert.equal(r.state, 'ready');
  r.fail();
  assert.equal(r.state, 'error');
});

// ------------------------------------------------------------------ dialogs

function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener: (t, fn) => listeners.set(t, fn),
    removeEventListener: (t) => listeners.delete(t),
    listeners,
  };
}

test('dismissible dialog: Esc closes it', () => {
  const dlg = new FakeDialog();
  let closed = 0;
  guardDialog(dlg, { dismissible: true, win: fakeWindow(), onClosed: () => (closed += 1) });
  dlg.showModal();
  assert.equal(dlg.pressEscape(), 'closed');
  assert.equal(closed, 1);
  assert.equal(hasBlockingDialog(), false);
});

test('non-dismissible dialog: Esc (keydown and cancel) cannot close it, blocking until allowClose()', () => {
  const dlg = new FakeDialog();
  const win = fakeWindow();
  let closed = 0;
  const g = guardDialog(dlg, { dismissible: false, win, onClosed: () => (closed += 1) });
  dlg.showModal();
  assert.equal(hasBlockingDialog(), true);
  assert.ok(win.listeners.has('beforeunload'));
  assert.equal(dlg.pressEscape(), 'blocked-by-keydown');
  assert.equal(dlg.open, true);

  // beforeunload guard asks the browser to confirm leaving
  const ev = { prevented: false, preventDefault() { this.prevented = true; }, returnValue: undefined };
  win.listeners.get('beforeunload')(ev);
  assert.equal(ev.prevented, true);

  // The second-Esc leak: a browser that ignores preventDefault on `cancel` closes the dialog anyway.
  dlg.close();
  assert.equal(dlg.open, true, 'the dialog is shown again');
  assert.equal(dlg.showCount, 2);
  assert.equal(closed, 0);
  assert.equal(hasBlockingDialog(), true);

  // Only an explicit confirm lets it go.
  g.allowClose();
  dlg.close('confirm');
  assert.equal(dlg.open, false);
  assert.equal(closed, 1);
  assert.equal(hasBlockingDialog(), false);
  assert.equal(win.listeners.has('beforeunload'), false);
});

test('non-dismissible dialog: the cancel event alone is prevented', () => {
  const dlg = new FakeDialog();
  const g = guardDialog(dlg, { dismissible: false, win: fakeWindow() });
  dlg.showModal();
  const cancel = new Event('cancel', { cancelable: true });
  dlg.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  dlg.close();
  assert.equal(dlg.open, true);
  g.allowClose(); // the unload guard is module state: release it for the next test
  dlg.close();
  assert.equal(hasBlockingDialog(), false);
});

test('two blocking dialogs keep the unload guard until both are gone', () => {
  const win = fakeWindow();
  const a = new FakeDialog();
  const b = new FakeDialog();
  const ga = guardDialog(a, { dismissible: false, win });
  const gb = guardDialog(b, { dismissible: false, win });
  a.showModal();
  b.showModal();
  ga.allowClose();
  a.close();
  assert.equal(hasBlockingDialog(), true);
  assert.ok(win.listeners.has('beforeunload'));
  gb.allowClose();
  b.close();
  assert.equal(hasBlockingDialog(), false);
  assert.equal(win.listeners.size, 0);
});

// ------------------------------------------------------------- preferences

test('safe storage helpers never throw', () => {
  const bad = fakeStorage({ throwOn: ['getItem', 'setItem', 'removeItem'] });
  assert.equal(safeGet(bad, 'k'), null);
  assert.equal(safeSet(bad, 'k', 'v'), false);
  assert.doesNotThrow(() => safeRemove(bad, 'k'));
  assert.equal(safeGet(null, 'k'), null);
  assert.equal(safeSet(null, 'k', 'v'), false);
  const good = fakeStorage();
  assert.equal(safeSet(good, 'k', 'v'), true);
  assert.equal(safeGet(good, 'k'), 'v');
});

test('theme preference: stored value, fallback to auto, data-theme only for light/dark', () => {
  const st = fakeStorage();
  assert.equal(readTheme(st), 'auto');
  st.setItem(PREF_THEME, 'dark');
  assert.equal(readTheme(st), 'dark');
  st.setItem(PREF_THEME, 'purple');
  assert.equal(readTheme(st), 'auto');
  assert.equal(readTheme(fakeStorage({ throwOn: ['getItem'] })), 'auto');
  const root = new FakeElement('html');
  applyTheme(root, 'dark');
  assert.equal(root.getAttribute('data-theme'), 'dark');
  applyTheme(root, 'light');
  assert.equal(root.getAttribute('data-theme'), 'light');
  applyTheme(root, 'auto');
  assert.equal(root.hasAttribute('data-theme'), false);
});
