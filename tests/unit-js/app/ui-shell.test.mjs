// SPDX-License-Identifier: AGPL-3.0-or-later
// Run 2 additions to ui.js: vars, setDataImage, markWrite and the write gate, the dialog focus option,
// the unsaved-input guard, form snapshot/restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  h,
  setDocument,
  vars,
  setDataImage,
  base64Size,
  IMAGE_MIMES,
  MAX_DATA_IMAGE_BYTES,
  createWriteGate,
  writeGate,
  markWrite,
  openDialog,
  closeAllDialogs,
  openDialogCount,
  disableWhileBusy,
  createLeaveGuard,
  hasBlockingDialog,
  snapshotForm,
  restoreForm,
  guardDialog,
} from '../../../src/js/ui.js';
import { FakeElement, FakeDialog } from './_helpers.mjs';

/** A fake element that also knows a few selectors and the dialog methods openDialog needs. */
class El extends FakeElement {
  constructor(tag) {
    super(tag);
    this.style = {
      props: new Map(),
      setProperty(k, v) {
        this.props.set(k, v);
      },
    };
    this.open = false;
    this.returnValue = '';
  }
  all(pred, out = []) {
    for (const c of this.children) {
      if (c.nodeType !== 1) continue;
      if (pred(c)) out.push(c);
      c.all(pred, out);
    }
    return out;
  }
  querySelectorAll(sel) {
    const parts = sel.split(',').map((s) => s.trim());
    return this.all((el) => parts.some((p) => matches(el, p)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  contains(other) {
    return other === this || this.all((e) => e === other).length > 0;
  }
  showModal() {
    this.open = true;
  }
  close(v = '') {
    this.open = false;
    this.returnValue = v;
    this.dispatchEvent(new Event('close'));
  }
  remove() {
    this.removed = true;
  }
  get value() {
    return this._value ?? '';
  }
  set value(v) {
    this._value = String(v);
  }
}
function matches(el, sel) {
  let m = sel.match(/^\[data-testid="([^"]+)"\]$/);
  if (m) return el.getAttribute('data-testid') === m[1];
  if (sel === '[data-autofocus]') return el.hasAttribute('data-autofocus');
  return el.tagName.toLowerCase() === sel;
}
function makeDoc() {
  const body = new El('body');
  const doc = {
    body,
    activeElement: null,
    createElement: (tag) => new El(tag),
    createTextNode: (t) => ({ nodeType: 3, data: String(t), textContent: String(t) }),
  };
  El.prototype.focus = function () {
    doc.activeElement = this;
  };
  return doc;
}
const doc = makeDoc();
setDocument(doc);
const el = (tag = 'div') => new El(tag);

// -------------------------------------------------------------------- vars

test('vars: values matching the whitelist are set through setProperty, never as a style attribute', () => {
  const e = el();
  const rejected = vars(e, { '--cal': '#aabbcc', '--cal2': '#AABBCC80' }, /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);
  assert.deepEqual(rejected, []);
  assert.equal(e.style.props.get('--cal'), '#aabbcc');
  assert.equal(e.style.props.get('--cal2'), '#AABBCC80');
  assert.equal(e.hasAttribute('style'), false);
});

test('vars: anything not matching the whole whitelist is rejected and not applied', () => {
  const allow = /^#[0-9a-f]{6}$/i;
  for (const bad of ['red', 'red;background:url(x)', '#aabbcc;x', '#aabbcc\n', 'url(javascript:1)', '#abc', '', ' #aabbcc', 5, null, undefined, '#aabbcc'.repeat(40)]) {
    const e = el();
    assert.deepEqual(vars(e, { '--cal': bad }, allow), ['--cal'], String(bad));
    assert.equal(e.style.props.size, 0, String(bad));
  }
  // an unanchored whitelist cannot be abused: the match must cover the whole value
  const e = el();
  assert.deepEqual(vars(e, { '--cal': 'xx#aabbccxx' }, /#[0-9a-f]{6}/i), ['--cal']);
  // a global/sticky regex has no lastIndex surprises
  const g = /^#[0-9a-f]{6}$/gi;
  const e2 = el();
  assert.deepEqual(vars(e2, { '--a': '#aabbcc' }, g), []);
  assert.deepEqual(vars(e2, { '--b': '#aabbcc' }, g), []);
});

test('vars: custom property names are validated and a whitelist is mandatory', () => {
  assert.throws(() => vars(el(), { color: 'red' }, /.*/), TypeError);
  assert.throws(() => vars(el(), { '--a;b': 'x' }, /.*/), TypeError);
  assert.throws(() => vars(el(), { '--a': 'x' }), TypeError);
  assert.throws(() => vars(el(), { '--a': 'x' }, 'x'), TypeError);
});

test('h(): the vars prop applies the same rules; the other forbidden props stay forbidden', () => {
  const ok = h('span', { vars: { allow: /^#[0-9a-f]{6}$/i, values: { '--cal': '#112233' } } });
  assert.equal(ok.style.props.get('--cal'), '#112233');
  const bad = h('span', { vars: { allow: /^#[0-9a-f]{6}$/i, values: { '--cal': 'red;background:url(x)' } } });
  assert.equal(bad.style.props.size, 0);
  assert.throws(() => h('span', { style: 'color:red' }), TypeError);
  assert.throws(() => h('img', { src: 'data:image/png;base64,AAAA' }), TypeError);
});

// ------------------------------------------------------------ setDataImage

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');

test('setDataImage: sets a data: URL for the four whitelisted types only', () => {
  for (const mime of IMAGE_MIMES) {
    const img = el('img');
    assert.equal(setDataImage(img, mime, PNG_B64), true, mime);
    assert.equal(img.getAttribute('src'), `data:${mime};base64,${PNG_B64}`);
  }
  const img = el('img');
  assert.equal(setDataImage(img, ' IMAGE/PNG ', PNG_B64), true);
  assert.match(img.getAttribute('src'), /^data:image\/png;base64,/);
  assert.deepEqual([...IMAGE_MIMES], ['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
});

test('setDataImage: refuses svg and other types, and clears any previous source', () => {
  for (const mime of ['image/svg+xml', 'image/svg', 'text/html', 'application/javascript', 'image/png;charset=x', 'image/', '', null, undefined, 'image/x-icon', 'image/bmp']) {
    const img = el('img');
    img.setAttribute('src', 'old');
    assert.equal(setDataImage(img, mime, PNG_B64), false, String(mime));
    assert.equal(img.hasAttribute('src'), false, String(mime));
  }
});

test('setDataImage: refuses malformed base64', () => {
  for (const bad of ['', 'not base64!', 'AAA', 'AAAA=', '====', 'AA=A', 'A'.repeat(7), '<svg/>', 'data:image/png;base64,AAAA', null, undefined, 12]) {
    const img = el('img');
    assert.equal(setDataImage(img, 'image/png', bad), false, String(bad));
    assert.equal(img.hasAttribute('src'), false);
  }
  assert.equal(base64Size('AAAA'), 3);
  assert.equal(base64Size('AAA='), 2);
  assert.equal(base64Size('AA=='), 1);
  assert.equal(base64Size('AA\r\nAA'), 3, 'line breaks inside vCard payloads are tolerated');
});

test('setDataImage: payload cap of 1.5 MB', () => {
  assert.equal(MAX_DATA_IMAGE_BYTES, 1.5 * 1024 * 1024);
  const atCap = 'A'.repeat((MAX_DATA_IMAGE_BYTES / 3) * 4);
  assert.equal(base64Size(atCap), MAX_DATA_IMAGE_BYTES);
  const ok = el('img');
  assert.equal(setDataImage(ok, 'image/jpeg', atCap), true);
  const big = el('img');
  assert.equal(setDataImage(big, 'image/jpeg', atCap + 'AAAA'), false);
  assert.equal(big.hasAttribute('src'), false);
});

// --------------------------------------------------------------- write gate

test('markWrite + gate: offline disables the control and appends the suffix to its accessible name; reopening restores both', () => {
  const gate = createWriteGate();
  const save = el('button');
  save.textContent = 'Save';
  gate.mark(save);
  assert.equal(save.disabled === true, false);
  gate.setReason('offline', 'offline: changes disabled');
  assert.equal(gate.blocked, true);
  assert.equal(save.disabled, true);
  assert.equal(save.getAttribute('aria-label'), 'Save (offline: changes disabled)');
  gate.setReason('offline', null);
  assert.equal(gate.blocked, false);
  assert.equal(save.disabled, false);
  assert.equal(save.hasAttribute('aria-label'), false, 'the original (no aria-label) is restored');
});

test('write gate: controls marked while blocked are gated at once; an existing aria-label is the base of the name', () => {
  const gate = createWriteGate();
  gate.setReason('readonly', 'read-only: changes disabled');
  const del = el('button');
  del.setAttribute('aria-label', 'Delete « Ann »');
  gate.mark(del);
  assert.equal(del.disabled, true);
  assert.equal(del.getAttribute('aria-label'), 'Delete « Ann » (read-only: changes disabled)');
  gate.setReason('offline', 'offline: changes disabled');
  assert.equal(del.getAttribute('aria-label'), 'Delete « Ann » (read-only: changes disabled; offline: changes disabled)');
  gate.setReason('readonly', null);
  assert.equal(del.disabled, true, 'still offline');
  gate.setReason('offline', null);
  assert.equal(del.disabled, false);
  assert.equal(del.getAttribute('aria-label'), 'Delete « Ann »');
});

test('write gate: a control that was disabled for its own reasons stays disabled after the gate opens', () => {
  const gate = createWriteGate();
  const b = el('button');
  b.textContent = 'Delete';
  b.disabled = true;
  gate.mark(b);
  gate.setReason('offline', 'x');
  gate.setReason('offline', null);
  assert.equal(b.disabled, true);
});

test('write gate: subscribers are told, detached controls are pruned', () => {
  const gate = createWriteGate();
  const seen = [];
  const off = gate.subscribe((blocked) => seen.push(blocked));
  const b = el('button');
  b.textContent = 'Go';
  gate.mark(b);
  gate.setReason('offline', 'o');
  gate.setReason('offline', null);
  assert.deepEqual(seen, [true, false]);
  b.isConnected = false;
  assert.equal(gate.size, 0);
  off();
  gate.setReason('offline', 'o');
  assert.equal(seen.length, 2);
  assert.deepEqual(gate.reasons, ['offline']);
});

test('the application-wide gate: markWrite() and the h() write prop register controls', () => {
  const a = h('button', { write: true }, 'Create');
  const b = markWrite(el('button'));
  b.textContent = 'Import';
  writeGate.setReason('offline', 'offline: changes disabled');
  assert.equal(a.disabled, true);
  assert.equal(a.getAttribute('aria-label'), 'Create (offline: changes disabled)');
  writeGate.setReason('offline', null);
  assert.equal(a.disabled, false);
  assert.equal(h('button', { write: false }, 'x').disabled === true, false);
});

// ------------------------------------------------------------ dialog focus

const labels = (focusSeen) => focusSeen.getAttribute('data-testid');

test('openDialog: default focus is the first footer button', () => {
  const d = openDialog({ testid: 'dialog-x', title: 'T', win: null, actions: [{ testid: 'a-first', label: 'A' }, { testid: 'a-second', label: 'B' }] });
  assert.equal(labels(doc.activeElement), 'a-first');
  d.close();
});

test('openDialog: focus "cancel" lands on the action marked cancel (m7), or on dialog-cancel', () => {
  const d = openDialog({
    testid: 'dialog-del',
    title: 'Delete',
    win: null,
    focus: 'cancel',
    actions: [{ testid: 'dialog-confirm-delete', label: 'Delete', kind: 'danger' }, { testid: 'keep', label: 'Keep', cancel: true }],
  });
  assert.equal(labels(doc.activeElement), 'keep');
  d.close();
  const d2 = openDialog({ testid: 'dialog-del2', title: 'Delete', win: null, focus: 'cancel', actions: [{ testid: 'dialog-confirm-delete', label: 'Delete' }, { testid: 'dialog-cancel', label: 'Cancel' }] });
  assert.equal(labels(doc.activeElement), 'dialog-cancel');
  d2.close();
  const d3 = openDialog({ testid: 'dialog-del3', title: 'Delete', win: null, focus: 'cancel', actions: [{ testid: 'only', label: 'Only' }] });
  assert.equal(labels(doc.activeElement), 'only', 'no cancel button: the first button');
  d3.close();
});

test('openDialog: focus can name a field of the body (typed-name confirm) or an element', () => {
  const field = h('input', { type: 'text', testid: 'field-confirm-name' });
  const d = openDialog({ testid: 'dialog-typed', title: 'Delete', win: null, body: [field], focus: 'field-confirm-name', actions: [{ testid: 'dialog-cancel', label: 'Cancel' }] });
  assert.equal(doc.activeElement, field);
  d.close();
  const other = h('input', { type: 'text', testid: 'f2' });
  const d2 = openDialog({ testid: 'dialog-typed2', title: 'D', win: null, body: [other], focus: other, actions: [{ testid: 'dialog-cancel', label: 'Cancel' }] });
  assert.equal(doc.activeElement, other);
  d2.close();
  const d3 = openDialog({ testid: 'dialog-typed3', title: 'D', win: null, focus: 'no-such-field', actions: [{ testid: 'b1', label: 'B' }] });
  assert.equal(labels(doc.activeElement), 'b1', 'an unknown target falls back to the first button');
  d3.close();
});

test('openDialog: a write action is registered with the gate; a non-dismissible dialog still blocks (SPECS 10b-4)', () => {
  const d = openDialog({ testid: 'dialog-w', title: 'W', win: null, actions: [{ testid: 'go', label: 'Go', write: true }] });
  writeGate.setReason('offline', 'offline: changes disabled');
  assert.equal(d.buttons.go.disabled, true);
  writeGate.setReason('offline', null);
  d.close();
  const fakeWin = { addEventListener() {}, removeEventListener() {} };
  const once = openDialog({ testid: 'dialog-once', title: 'Once', win: fakeWin, dismissible: false, actions: [{ testid: 'ok', label: 'OK' }] });
  assert.equal(hasBlockingDialog(), true);
  once.close();
  assert.equal(hasBlockingDialog(), false);
});

// --------------------------------------------------------- unsaved-input guard

function guardSetup({ hook } = {}) {
  const listeners = new Map();
  const win = { addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t), listeners };
  const asks = [];
  const navigations = [];
  const guard = createLeaveGuard({ win, confirmDiscard: (a) => asks.push(a), navigate: (h2) => navigations.push(h2) });
  if (hook) guard.setHook(hook);
  return { guard, win, asks, navigations };
}

test('leave guard: clean state lets navigation through, dirty state vetoes and asks once; beforeunload follows the dirty flag', () => {
  const s = guardSetup();
  assert.equal(s.guard.canLeave({ to: '#/collections' }), true);
  s.guard.setDirty(true);
  assert.ok(s.win.listeners.has('beforeunload'), 'armed while dirty');
  assert.equal(s.guard.canLeave({ to: '#/collections' }), false);
  assert.equal(s.guard.canLeave({ to: '#/debug' }), false, 'still asking: no second dialog');
  assert.equal(s.asks.length, 1);
  assert.equal(s.asks[0].to, '#/collections');
  s.guard.setDirty(false);
  assert.equal(s.win.listeners.has('beforeunload'), false);
  assert.equal(s.guard.canLeave({ to: '#/x' }), true);
});

test('leave guard: Discard clears the flag and navigates to the vetoed target; Keep editing leaves everything alone', () => {
  const s = guardSetup();
  s.guard.setDirty(true);
  s.guard.canLeave({ to: '#/collections' });
  s.asks[0].cancel(); // Keep editing
  assert.equal(s.guard.dirty, true);
  assert.deepEqual(s.navigations, []);
  s.guard.canLeave({ to: '#/collections' });
  assert.equal(s.asks.length, 2, 'asks again after the dialog was closed');
  s.asks[1].discard();
  assert.equal(s.guard.dirty, false);
  assert.deepEqual(s.navigations, ['#/collections']);
  assert.equal(s.win.listeners.has('beforeunload'), false);
});

test('leave guard: a screen hook can allow moves it handles itself; reset() forgets the screen state', () => {
  const s = guardSetup({ hook: (to) => to.startsWith('#/contacts/') });
  s.guard.setDirty(true);
  assert.equal(s.guard.canLeave({ to: '#/contacts/u2/edit' }), true);
  assert.equal(s.guard.canLeave({ to: '#/collections' }), false);
  s.guard.reset();
  assert.equal(s.guard.dirty, false);
  assert.equal(s.guard.canLeave({ to: '#/collections' }), true);
});

test('leave guard: guarded() runs at once when clean and after the discard confirmation when dirty (sign-out)', () => {
  const s = guardSetup();
  let ran = 0;
  assert.equal(s.guard.guarded(() => (ran += 1)), true);
  assert.equal(ran, 1);
  s.guard.setDirty(true);
  assert.equal(s.guard.guarded(() => (ran += 1)), false);
  assert.equal(ran, 1);
  assert.equal(s.asks[0].to, null);
  s.asks[0].discard();
  assert.equal(ran, 2);
  assert.equal(s.guard.dirty, false);
});

test('leave guard: a blocking dialog vetoes without a question; a dirty form and a blocking dialog share one beforeunload handler', () => {
  const s = guardSetup();
  const dlg = new FakeDialog();
  const g = guardDialog(dlg, { dismissible: false, win: s.win });
  dlg.showModal();
  assert.equal(s.guard.canLeave({ to: '#/x' }), false);
  assert.equal(s.asks.length, 0);
  s.guard.setDirty(true);
  g.allowClose();
  dlg.close();
  assert.ok(s.win.listeners.has('beforeunload'), 'still armed by the dirty form');
  s.guard.dispose();
  assert.equal(s.win.listeners.has('beforeunload'), false);
});

// --------------------------------------------------- form snapshot / restore

test('snapshotForm / restoreForm keep typed input across a redraw (language switch, m11)', () => {
  const build = () => {
    const root = el('main');
    const given = el('input');
    given.setAttribute('data-testid', 'field-given');
    const phone1 = el('input');
    phone1.setAttribute('data-testid', 'field-phone');
    const phone2 = el('input');
    phone2.setAttribute('data-testid', 'field-phone');
    const pref = el('input');
    pref.setAttribute('type', 'checkbox');
    pref.setAttribute('data-testid', 'field-pref');
    const pw = el('input');
    pw.setAttribute('type', 'password');
    pw.setAttribute('data-testid', 'field-secret');
    const note = el('textarea');
    note.setAttribute('data-testid', 'field-note');
    root.append(given, phone1, phone2, pref, pw, note);
    return { root, given, phone1, phone2, pref, pw, note };
  };
  const a = build();
  a.given.value = 'Ann';
  a.phone1.value = '+1 555 0100';
  a.phone2.value = '+1 555 0101';
  a.pref.checked = true;
  a.pw.value = 'hunter2';
  a.note.value = 'line1\nline2';
  doc.activeElement = a.phone2;
  const snap = snapshotForm(a.root, doc);
  assert.equal(JSON.stringify(snap).includes('hunter2'), false, 'passwords are never captured');
  assert.equal(snap.focus, 'field-phone');
  const b = build();
  assert.equal(restoreForm(b.root, snap), 5);
  assert.equal(b.given.value, 'Ann');
  assert.equal(b.phone1.value, '+1 555 0100');
  assert.equal(b.phone2.value, '+1 555 0101');
  assert.equal(b.pref.checked, true);
  assert.equal(b.note.value, 'line1\nline2');
  assert.equal(b.pw.value, '');
  assert.equal(restoreForm(b.root, null), 0);
  // fields that vanished are skipped
  const c = el('main');
  assert.equal(restoreForm(c, snap), 0);
});

// ------------------------------------------------- M1: dialogs end with the session

test('closeAllDialogs closes every open dialog as CANCELLED and its buttons can no longer act', () => {
  const calls = [];
  const closed = [];
  const a = openDialog({ testid: 'dialog-conflict', title: 'C', win: null, actions: [{ testid: 'conflict-overwrite', label: 'Overwrite', onClick: () => calls.push('overwrite') }], onClose: (v) => closed.push(['a', v]) });
  const b = openDialog({ testid: 'dialog-import', title: 'I', win: null, actions: [{ testid: 'dialog-import-confirm', label: 'Import', onClick: () => calls.push('import') }], onClose: (v) => closed.push(['b', v]) });
  const c = openDialog({ testid: 'dialog-once', title: 'O', win: null, dismissible: false, actions: [{ testid: 'dialog-ack', label: 'OK' }], onClose: (v) => closed.push(['c', v]) });
  assert.equal(openDialogCount(), 3);
  assert.equal(hasBlockingDialog(), true);
  assert.equal(closeAllDialogs(), 3);
  assert.equal(openDialogCount(), 0);
  assert.equal(hasBlockingDialog(), false);
  assert.deepEqual(closed.map((x) => x[0]).sort(), ['a', 'b', 'c']);
  assert.ok(closed.every(([, v]) => v === 'session-ended')); // never a confirm button's test id
  assert.equal(a.dialog.open || b.dialog.open || c.dialog.open, false);
  assert.equal(a.dialog.removed, true);
  // a click that still reaches a button after the session ended does nothing
  a.buttons['conflict-overwrite'].dispatchEvent(new Event('click'));
  b.buttons['dialog-import-confirm'].dispatchEvent(new Event('click'));
  assert.deepEqual(calls, []);
  assert.equal(closeAllDialogs(), 0);
});

test('a dialog closed normally leaves the registry; a throwing dialog does not keep the others open', () => {
  const a = openDialog({ testid: 'dialog-a', title: 'A', win: null, actions: [{ testid: 'a-ok', label: 'OK' }] });
  const b = openDialog({ testid: 'dialog-b', title: 'B', win: null, actions: [{ testid: 'b-ok', label: 'OK' }] });
  a.close('a-ok');
  assert.equal(openDialogCount(), 1);
  const origClose = b.close;
  b.close = () => {
    throw new Error('stuck');
  };
  assert.equal(closeAllDialogs(), 1);
  b.close = origClose;
  b.close();
  assert.equal(openDialogCount(), 0);
});

test('the ready-made confirm dialog resolves as cancelled when the session ends', async () => {
  const { confirmDialog } = await import('../../../src/js/widgets/dialogs.js');
  const p = confirmDialog({ title: 'Delete', confirmLabel: 'Delete', danger: true, win: null });
  closeAllDialogs();
  assert.equal(await p, false);
});

test('app.js: the session end closes the dialogs BEFORE the screen is unmounted, on every end path', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../../src/js/app.js', import.meta.url), 'utf8');
  const onEnd = src.slice(src.indexOf('onEnd()'), src.indexOf('onEnd()') + 400);
  assert.ok(onEnd.indexOf('closeAllDialogs()') > 0 && onEnd.indexOf('closeAllDialogs()') < onEnd.indexOf('unmountScreen()'));
  // expiry (401), sign-out and the storage event all end the session through the holder
  assert.match(src, /auth\.logout\(\); \/\/ ends the session container/);
  assert.equal((src.match(/sessions\.end\(/g) || []).length >= 2, true);
});

// --------------------------------------------- minor 6: language select while busy

test('disableWhileBusy: the control is disabled while a form reports aria-busy and enabled again after', () => {
  const root = el('main');
  const select = el('select');
  let callback = null;
  class FakeObserver {
    constructor(cb) {
      callback = cb;
    }
    observe(target, opts) {
      this.opts = opts;
    }
    disconnect() {
      this.gone = true;
    }
  }
  const form = el('form');
  form.setAttribute('aria-busy', 'false');
  root.append(form);
  root.querySelector = (sel) => (sel === 'form[aria-busy="true"]' && form.getAttribute('aria-busy') === 'true' ? form : null);
  const stop = disableWhileBusy(root, select, { Observer: FakeObserver });
  assert.equal(select.disabled, false);
  form.setAttribute('aria-busy', 'true');
  callback();
  assert.equal(select.disabled, true);
  assert.equal(select.getAttribute('aria-disabled'), 'true');
  form.setAttribute('aria-busy', 'false');
  callback();
  assert.equal(select.disabled, false);
  assert.equal(select.hasAttribute('aria-disabled'), false);
  stop();
  assert.equal(typeof disableWhileBusy(root, select, { Observer: undefined }), 'function'); // no observer: harmless
});
