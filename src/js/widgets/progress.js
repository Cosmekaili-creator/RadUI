// SPDX-License-Identifier: AGPL-3.0-or-later
// Progress bar for long operations (import, bulk delete): `role="progressbar"` with aria-valuenow and a
// readable aria-valuetext, visible text next to it, an optional Cancel button, and a polite status region
// that is updated at most every `announceMs` (the final states are announced at once).
// The fill width is a CSS custom property set through the audited `vars` helper: no style attribute.
//
// Test ids (x = `name`): wrapper `<x>-progress-box` (data-state running|cancelling|cancelled|done|error),
// the bar `<x>-progress` (the progressbar), text `<x>-progress-text`, status `<x>-progress-status`,
// cancel `btn-<x>-cancel`.

import { h, vars } from '../ui.js';
import { identityT, uniqueId } from './fieldkit.js';
import { createAnnouncer } from './timing.js';

const PERCENT_RE = /^(?:100|\d{1,2})(?:\.\d{1,2})?%$/;

/** Whole percent 0-100, or null when the total is unknown or not positive. */
export function percentOf(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
  return Math.round(Math.max(0, Math.min(1, value / max)) * 100);
}

/**
 * @param {object} o
 * @param {string} o.name  test id family
 * @param {string} o.label  accessible name of the bar ('Importing contacts')
 * @param {(key: string, params?: object) => string} o.t
 * @param {number} [o.value=0] @param {number} [o.max=100]  max <= 0 or null: indeterminate (no aria-valuenow)
 * @param {boolean} [o.cancelable] @param {() => void} [o.onCancel]  called once when Cancel is pressed
 * @param {string} [o.cancelLabel]
 * @param {(state: {value: number, max: number|null, percent: number|null}) => string} [o.format]  visible text
 * @param {number} [o.announceMs=2000] @param {object} [o.timers]
 */
export function createProgress({ name, label, t = identityT, value = 0, max = 100, cancelable = false, onCancel, cancelLabel, format, announceMs = 2000, timers } = {}) {
  const id = uniqueId(`pg-${name}`);
  let state = 'running';
  let cur = { value, max: max > 0 ? max : null };
  const textOf = () => {
    const percent = percentOf(cur.value, cur.max);
    if (format) return format({ value: cur.value, max: cur.max, percent });
    if (percent === null) return t('widget.progress.working');
    return t('widget.progress.counts', { done: cur.value, total: cur.max, percent });
  };

  const labelEl = h('span', { class: 'progress__label', id: `${id}-label` }, label);
  const fill = h('div', { class: 'progress__fill' });
  const bar = h('div', { class: 'progress__bar', role: 'progressbar', 'aria-labelledby': `${id}-label`, 'aria-valuemin': '0', testid: `${name}-progress` }, fill);
  const text = h('p', { class: 'progress__text', testid: `${name}-progress-text` });
  const status = h('p', { class: 'visually-hidden', role: 'status', testid: `${name}-progress-status` });
  const cancelBtn = cancelable ? h('button', { type: 'button', class: 'btn btn--small', testid: `btn-${name}-cancel` }, cancelLabel || t('widget.progress.cancel')) : null;
  const el = h('div', { class: 'progress', 'data-state': 'running', testid: `${name}-progress-box` }, h('div', { class: 'progress__head' }, labelEl, cancelBtn), bar, text, status);
  const announcer = createAnnouncer({
    apply: (s) => {
      status.textContent = s;
    },
    ms: announceMs,
    timers,
  });

  function paint() {
    const percent = percentOf(cur.value, cur.max);
    if (percent === null) {
      bar.removeAttribute('aria-valuenow');
      bar.removeAttribute('aria-valuemax');
      el.classList.add('progress--indeterminate');
      vars(fill, { '--progress': '100%' }, PERCENT_RE);
    } else {
      bar.setAttribute('aria-valuenow', String(cur.value));
      bar.setAttribute('aria-valuemax', String(cur.max));
      el.classList.remove('progress--indeterminate');
      vars(fill, { '--progress': `${percent}%` }, PERCENT_RE);
    }
    const s = textOf();
    bar.setAttribute('aria-valuetext', s);
    text.textContent = s;
    return s;
  }
  function setState(next) {
    state = next;
    el.setAttribute('data-state', next);
    if (cancelBtn && next !== 'running') cancelBtn.hidden = true;
  }
  paint();
  status.textContent = textOf();

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (state !== 'running') return;
      setState('cancelling');
      text.textContent = t('widget.progress.cancelling');
      announcer.flush(t('widget.progress.cancelling'));
      if (onCancel) onCancel();
    });
  }

  return {
    el,
    bar,
    cancelButton: cancelBtn,
    get state() {
      return state;
    },
    /** Update the numbers (and the visible text); the live status follows throttled. Ignored once finished. */
    set({ value: v, max: m } = {}) {
      if (state === 'done' || state === 'error' || state === 'cancelled') return;
      if (Number.isFinite(v)) cur.value = v;
      if (m !== undefined) cur.max = m > 0 ? m : null;
      announcer.push(paint());
    },
    /** Finished: the bar is full and the final text is announced at once. */
    complete(message) {
      if (cur.max !== null) cur.value = cur.max;
      paint();
      setState('done');
      const s = message || t('widget.progress.done');
      text.textContent = s;
      announcer.flush(s);
    },
    /** Failed: the bar stops where it was. */
    fail(message) {
      setState('error');
      const s = message || t('widget.progress.failed');
      text.textContent = s;
      announcer.flush(s);
    },
    /** The runner has stopped after a cancel request. */
    markCancelled(message) {
      setState('cancelled');
      const s = message || t('widget.progress.cancelled');
      text.textContent = s;
      announcer.flush(s);
    },
    dispose() {
      announcer.cancel();
    },
  };
}
