// SPDX-License-Identifier: AGPL-3.0-or-later
// Field builders of the contact form: labelled text fields with a persistent, linked error line, the
// category chips, and the photo block. DOM through ui.js `h()` only; no state of the card is kept here.

import { clear, fill, h } from '../../ui.js';
import { buildField, uniqueId } from '../../widgets/fieldkit.js';
import { createAvatar, isolate } from '../../widgets/avatar.js';
import { ACCEPT } from '../../contacts/photo.js';

/**
 * A labelled text field. `input`: 'text' | 'textarea' | 'tel' | 'email' | 'url'.
 * @returns {{el, control, setError(msg|null), focus()}}
 */
export function textField({ testid, label, value = '', input = 'text', hint, attrs = {}, className }) {
  const id = uniqueId(testid);
  const control =
    input === 'textarea'
      ? h('textarea', { class: 'input form__textarea', rows: attrs.rows || '3', testid, id, ...attrs })
      : h('input', { class: 'input', type: input, testid, id, autocomplete: 'off', ...attrs });
  control.value = value;
  const f = buildField({ id, label, testid: null, control, hint, className });
  f.el.setAttribute('data-field', testid);
  return { el: f.el, control, setError: f.setError, focus: () => control.focus() };
}

/** Category chips: one chip per category (a comma inside one stays inside it). */
export function createChips({ t, items = [], onChange }) {
  let list = [...items];
  const id = uniqueId('cats');
  const input = h('input', { class: 'input', type: 'text', id, testid: 'field-categories', autocomplete: 'off', 'aria-describedby': `${id}-hint ${id}-error`, enterkeyhint: 'enter' });
  const addBtn = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-add-category' }, t('contact.categories.add'));
  const chips = h('ul', { class: 'chips', testid: 'categories-list' });
  const hint = h('p', { class: 'field__hint', id: `${id}-hint` }, t('contact.categories.hint'));
  const err = h('p', { class: 'field__error', id: `${id}-error`, hidden: true });
  const el = h('div', { class: 'field', 'data-field': 'field-categories' }, h('label', { class: 'field__label', for: id }, t('contact.categories')), chips, h('div', { class: 'datefield__row' }, input, addBtn), hint, err);

  function draw() {
    fill(
      chips,
      list.map((c, i) =>
        h(
          'li',
          { class: 'tag tag--chip', testid: 'category-chip' },
          h('bdi', null, c),
          h('button', { type: 'button', class: 'chip__x', testid: 'btn-remove-category', 'data-index': String(i), 'aria-label': t('contact.categories.remove', { name: isolate(c) }), on: { click: () => remove(i) } }, '×'),
        ),
      ),
    );
  }
  function add() {
    const v = input.value.trim();
    if (!v) return false;
    if (!list.some((c) => c.trim().toLowerCase() === v.toLowerCase())) list.push(v);
    input.value = '';
    draw();
    if (onChange) onChange();
    return true;
  }
  function remove(i) {
    const [gone] = list.splice(i, 1);
    draw();
    const btns = chips.querySelectorAll('[data-testid="btn-remove-category"]');
    (btns[i] || btns[i - 1] || input).focus();
    if (onChange) onChange(gone);
  }
  addBtn.addEventListener('click', () => {
    add();
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // Enter adds the chip; it never submits the form
      add();
    }
  });
  input.addEventListener('input', () => onChange && onChange());
  draw();
  return {
    el,
    input,
    /** The chips, plus the text still waiting in the field. */
    values() {
      const pending = input.value.trim();
      return pending && !list.some((c) => c.trim().toLowerCase() === pending.toLowerCase()) ? [...list, pending] : [...list];
    },
    set(next) {
      list = [...next];
      draw();
    },
    setError(msg) {
      if (msg) {
        input.setAttribute('aria-invalid', 'true');
        err.textContent = msg;
        err.hidden = false;
      } else {
        input.removeAttribute('aria-invalid');
        err.textContent = '';
        err.hidden = true;
      }
    },
    focus: () => input.focus(),
  };
}

/**
 * The photo block: preview avatar, choose / remove buttons, a status line, the hidden file input.
 * `onFile(file)` is called when a file was chosen; the caller processes it and calls set().
 */
export function createPhotoBlock({ t, name, uid, photo, note, onFile, onRemove }) {
  const input = h('input', { type: 'file', class: 'visually-hidden', accept: ACCEPT, tabindex: '-1', testid: 'field-photo', 'aria-label': t('contact.photo.choose') });
  const choose = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-choose-photo', on: { click: () => input.click() } }, t('contact.photo.choose'));
  const remove = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-remove-photo', hidden: true, on: { click: () => onRemove() } }, t('contact.photo.remove'));
  const status = h('p', { class: 'field__hint', role: 'status', testid: 'photo-status' });
  const preview = h('div', { class: 'photo__preview' });
  const el = h('div', { class: 'photo', testid: 'photo-block' }, preview, h('div', { class: 'photo__actions' }, choose, input, remove, status));
  let nameNow = name;
  let current = photo || null;
  function draw() {
    fill(preview, createAvatar({ name: nameNow, uid, size: 'xl', photo: current, decorative: true, testid: 'photo-preview' }));
    remove.hidden = !current;
  }
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) onFile(f);
    // The same file can be chosen again after Remove.
    try {
      input.value = '';
    } catch {
      /* some environments refuse to reset a file input */
    }
  });
  draw();
  status.textContent = note || '';
  return {
    el,
    input,
    choose,
    remove,
    /** Show `photo` ({mime, base64}|null) and a status text. */
    set(next, text = '') {
      current = next;
      draw();
      status.textContent = text;
    },
    setName(n) {
      nameNow = n;
      if (!current) draw();
    },
    setStatus(text) {
      status.textContent = text;
    },
    setBusy(on) {
      choose.disabled = on;
      remove.disabled = on;
    },
    clear: () => clear(preview),
  };
}
