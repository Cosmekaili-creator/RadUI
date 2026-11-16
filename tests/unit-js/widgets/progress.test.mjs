// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, one, fakeTimers } from './_dom.mjs';
import { createProgress, percentOf } from '../../../src/js/widgets/progress.js';
import { createI18n } from '../_i18n-all.mjs';

makeDom();
const t = createI18n({ lang: 'en' }).t;

function make(extra = {}) {
  const timers = fakeTimers();
  const cancels = [];
  const p = createProgress({ name: 'import', label: 'Importing contacts', t, max: 40, timers, cancelable: true, onCancel: () => cancels.push(1), ...extra });
  return { p, timers, cancels };
}

test('percentOf clamps and handles unknown totals', () => {
  assert.equal(percentOf(10, 40), 25);
  assert.equal(percentOf(50, 40), 100);
  assert.equal(percentOf(-5, 40), 0);
  assert.equal(percentOf(1, 0), null);
  assert.equal(percentOf(NaN, 10), null);
  assert.equal(percentOf(1, 3), 33);
});

test('structure: progressbar role, name, value attributes, visible text, fill through a CSS variable', () => {
  const { p } = make();
  const bar = one(p.el, 'import-progress');
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuemin'), '0');
  assert.equal(bar.getAttribute('aria-valuemax'), '40');
  assert.equal(bar.getAttribute('aria-valuenow'), '0');
  assert.equal(bar.getAttribute('aria-valuetext'), '0 of 40 (0%)');
  const label = p.el.querySelector(`#${bar.getAttribute('aria-labelledby')}`);
  assert.equal(label.textContent, 'Importing contacts');
  assert.equal(one(p.el, 'import-progress-text').textContent, '0 of 40 (0%)');
  assert.equal(p.el.getAttribute('data-testid'), 'import-progress-box');
  assert.equal(p.el.getAttribute('data-state'), 'running');
  const fill = bar.querySelector('.progress__fill');
  assert.equal(fill.styleProps.get('--progress'), '0%');
  assert.equal(p.el.querySelectorAll('[style]').length, 0, 'no style attribute');
  assert.equal(one(p.el, 'btn-import-cancel').textContent, 'Cancel');
});

test('set: numbers and visible text update at once; the polite status is throttled', () => {
  const { p, timers } = make({ announceMs: 2000 });
  const status = one(p.el, 'import-progress-status');
  assert.equal(status.getAttribute('role'), 'status');
  p.set({ value: 10 });
  p.set({ value: 20 });
  p.set({ value: 30 });
  const bar = one(p.el, 'import-progress');
  assert.equal(bar.getAttribute('aria-valuenow'), '30');
  assert.equal(one(p.el, 'import-progress-text').textContent, '30 of 40 (75%)');
  assert.equal(bar.querySelector('.progress__fill').styleProps.get('--progress'), '75%');
  assert.equal(status.textContent, '0 of 40 (0%)', 'not announced yet');
  timers.advance(2000);
  assert.equal(status.textContent, '30 of 40 (75%)', 'only the latest value is announced');
});

test('complete: bar full, final text announced immediately, cancel button hidden', () => {
  const { p } = make();
  p.set({ value: 12 });
  p.complete();
  assert.equal(p.state, 'done');
  assert.equal(p.el.getAttribute('data-state'), 'done');
  assert.equal(one(p.el, 'import-progress').getAttribute('aria-valuenow'), '40');
  assert.equal(one(p.el, 'import-progress-status').textContent, 'Done.');
  assert.equal(one(p.el, 'btn-import-cancel').hidden, true);
  p.set({ value: 1 });
  assert.equal(one(p.el, 'import-progress').getAttribute('aria-valuenow'), '40', 'ignored after the end');
});

test('cancel: one request, the state moves to cancelling then cancelled', () => {
  const { p, cancels } = make();
  const btn = one(p.el, 'btn-import-cancel');
  btn.click();
  btn.click();
  assert.equal(cancels.length, 1);
  assert.equal(p.state, 'cancelling');
  assert.equal(btn.hidden, true);
  assert.match(one(p.el, 'import-progress-status').textContent, /Cancelling/);
  p.markCancelled();
  assert.equal(p.state, 'cancelled');
  assert.equal(one(p.el, 'import-progress-text').textContent, 'Cancelled.');
  assert.equal(one(p.el, 'import-progress-status').textContent, 'Cancelled.');
});

test('fail keeps the numbers and announces the failure', () => {
  const { p } = make();
  p.set({ value: 5 });
  p.fail('3 items failed.');
  assert.equal(p.el.getAttribute('data-state'), 'error');
  assert.equal(one(p.el, 'import-progress').getAttribute('aria-valuenow'), '5');
  assert.equal(one(p.el, 'import-progress-text').textContent, '3 items failed.');
});

test('without a total the bar is indeterminate (no aria-valuenow) and without cancel there is no button', () => {
  const { p } = make({ max: 0, cancelable: false });
  const bar = one(p.el, 'import-progress');
  assert.equal(bar.getAttribute('aria-valuenow'), null);
  assert.ok(p.el.classList.contains('progress--indeterminate'));
  assert.equal(one(p.el, 'import-progress-text').textContent, 'Working…');
  assert.equal(one(p.el, 'btn-import-cancel'), null);
  p.set({ value: 3, max: 10 });
  assert.equal(bar.getAttribute('aria-valuenow'), '3');
  assert.ok(!p.el.classList.contains('progress--indeterminate'));
});

test('a custom text format is used', () => {
  const { p } = make({ format: ({ value, max }) => `${value}/${max} items` });
  p.set({ value: 7 });
  assert.equal(one(p.el, 'import-progress-text').textContent, '7/40 items');
});
