// SPDX-License-Identifier: AGPL-3.0-or-later
// Small building blocks shared by the widgets: unique ids, a labelled text field with a visible
// hint and a persistent error line linked with aria-describedby, and `{n}` substitution.
// Rendering only goes through ui.js `h()` (text nodes, no raw HTML, no style attribute).

import { h } from '../ui.js';

let counter = 0;
/** A document-unique id for generated elements (`wid-date-3`). */
export function uniqueId(prefix = 'wid') {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Replace `{name}` placeholders from `params` (unknown names stay as they are). */
export function fill(template, params = {}) {
  return String(template).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name) => (Object.hasOwn(params, name) && params[name] !== undefined && params[name] !== null ? String(params[name]) : whole));
}

/** The translator a widget uses when the caller passes none: returns the key (never throws). */
export function identityT(key) {
  return key;
}

/**
 * A labelled field: `<div class="field">` with the label, the control (or a row holding it), a visible hint
 * and an error line. The control gets aria-describedby = hint + error (+ extra ids).
 * A caller-provided `errorRegion` element is used instead of an own error line (it gets an id when it has none).
 * @returns {{el: HTMLElement, hintEl: HTMLElement|null, errorEl: HTMLElement, setError(message: string|null): void,
 *            setHint(text: string): void}}
 */
export function buildField({ id, label, testid, control, row, hint, errorRegion, required = false, extraDescribedBy = [], className }) {
  const hintEl = hint ? h('p', { class: 'field__hint', id: `${id}-hint`, testid: testid ? `${testid}-hint` : null }, hint) : null;
  let errorEl = errorRegion || null;
  if (errorEl) {
    if (!errorEl.getAttribute('id')) errorEl.setAttribute('id', `${id}-error`);
  } else {
    errorEl = h('p', { class: 'field__error', id: `${id}-error`, hidden: true, testid: testid ? `${testid}-error` : null });
  }
  const describedBy = () => [hintEl ? `${id}-hint` : null, errorEl.getAttribute('id'), ...extraDescribedBy].filter(Boolean).join(' ');
  control.setAttribute('aria-describedby', describedBy());
  if (required) control.setAttribute('aria-required', 'true');
  const el = h('div', { class: ['field', className], testid }, h('label', { class: 'field__label', for: id }, label), row || control, hintEl, errorRegion ? null : errorEl);
  return {
    el,
    hintEl,
    errorEl,
    setError(message) {
      if (message) {
        control.setAttribute('aria-invalid', 'true');
        errorEl.textContent = message;
        errorEl.hidden = false;
      } else {
        control.removeAttribute('aria-invalid');
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    },
    setHint(text) {
      if (hintEl) hintEl.textContent = text;
    },
  };
}
