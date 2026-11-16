// SPDX-License-Identifier: AGPL-3.0-or-later
// Searchable single- or multi-select picker dialog (group membership, "add to group", ...).
//  - DOM-free logic: buildIndex, searchOptions (accent/case/ligature-insensitive via fold.js), createPickerState;
//  - rendering: openPicker, a modal dialog with a search field (combobox pattern), a listbox of at most 50
//    results, an aria-live result count, keyboard operation and debounced updates (m17).
//
// Test ids (x = `name`): dialog `<x>-picker`, search `field-<x>-search`, list `<x>-list`, option rows
// `<x>-option` (data-id), count `<x>-result-count`, selection count `<x>-selected-count`, confirm
// `<x>-picker-confirm` (multi-select only), `dialog-cancel`.
//
// Keys in the search field: Down/Up move the active option, Page Down/Up move by 8, Enter chooses (single)
// or toggles (multi) the active option, Esc cancels. Clicking an option does the same.

import { h, openDialog } from '../ui.js';
import { foldText, foldTokens, matchesTokens } from './fold.js';
import { identityT, uniqueId } from './fieldkit.js';
import { createAnnouncer, debounce } from './timing.js';

export const MAX_RESULTS = 50;

// ------------------------------------------------------------------------ logic

/**
 * @typedef {object} PickerOption
 * @property {string} id
 * @property {string} label
 * @property {string} [sublabel]      second line (an e-mail, an organisation)
 * @property {string[]} [keywords]    extra searchable text, not shown
 * @property {boolean} [disabled]     shown, not selectable (already a member)
 */

/** Pre-fold every option once; searching then only does substring tests. */
export function buildIndex(options) {
  return options.map((opt, order) => {
    const label = foldText(String(opt.label ?? ''));
    return { opt, order, label, hay: foldText([opt.label, opt.sublabel, ...(opt.keywords || [])].filter(Boolean).join(' ')) };
  });
}

/**
 * Filter and rank options: every query word must occur (folded) in the label, sub-label or keywords; labels
 * that start with the first word come first, then labels with a word starting with it, then the rest; ties keep
 * the caller's order. An empty query returns the first `limit` options.
 * @param {PickerOption[]|ReturnType<typeof buildIndex>} optionsOrIndex
 * @returns {{items: PickerOption[], total: number, truncated: boolean}}
 */
export function searchOptions(optionsOrIndex, query, { limit = MAX_RESULTS } = {}) {
  const index = optionsOrIndex.length && optionsOrIndex[0] && 'hay' in optionsOrIndex[0] ? optionsOrIndex : buildIndex(optionsOrIndex);
  const max = Math.max(1, Math.min(MAX_RESULTS, limit));
  const tokens = foldTokens(query);
  let hits = index.filter((e) => matchesTokens(e.hay, tokens));
  const total = hits.length;
  if (tokens.length) {
    const first = tokens[0];
    const rank = (e) => (e.label.startsWith(first) ? 0 : ` ${e.label}`.includes(` ${first}`) ? 1 : 2);
    hits = hits
      .map((e) => ({ e, r: rank(e) }))
      .sort((a, b) => a.r - b.r || a.e.order - b.e.order)
      .map((x) => x.e);
  }
  return { items: hits.slice(0, max).map((e) => e.opt), total, truncated: total > max };
}

/**
 * The state machine behind the dialog.
 * @param {{options: PickerOption[], multiple?: boolean, selected?: string[], limit?: number}} o
 */
export function createPickerState({ options, multiple = false, selected = [], limit = MAX_RESULTS }) {
  const index = buildIndex(options);
  const known = new Set(options.map((o) => o.id));
  const byId = new Map(options.map((o) => [o.id, o]));
  let picked = [...new Set(selected.filter((id) => known.has(id)))];
  if (!multiple) picked = picked.slice(0, 1);
  let query = '';
  let res = searchOptions(index, query, { limit });
  let active = res.items.length ? 0 : -1;
  const selectable = (id) => byId.has(id) && !byId.get(id).disabled;
  const state = {
    multiple,
    get query() {
      return query;
    },
    /** Run a search; the active option goes back to the first result. */
    setQuery(q) {
      query = String(q ?? '');
      res = searchOptions(index, query, { limit });
      active = res.items.length ? 0 : -1;
      return res;
    },
    get results() {
      return res.items;
    },
    get total() {
      return res.total;
    },
    get truncated() {
      return res.truncated;
    },
    get activeIndex() {
      return active;
    },
    get activeId() {
      return active >= 0 ? res.items[active].id : null;
    },
    /** Move the active option by `delta` (clamped, no wrap) or to 'first'/'last'. */
    move(delta) {
      if (!res.items.length) return -1;
      const last = res.items.length - 1;
      active = delta === 'first' ? 0 : delta === 'last' ? last : Math.max(0, Math.min(last, active + delta));
      return active;
    },
    get selected() {
      return [...picked];
    },
    isSelected: (id) => picked.includes(id),
    /** Toggle in multi mode; in single mode select only this one. Disabled and unknown ids are refused. */
    toggle(id) {
      if (!selectable(id)) return false;
      if (!multiple) picked = [id];
      else picked = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
      return true;
    },
    optionById: (id) => byId.get(id) || null,
  };
  return state;
}

// --------------------------------------------------------------------- rendering

/**
 * Open the picker.
 * @param {object} o
 * @param {string} o.name  test id family (`member` -> `member-picker`, `field-member-search`, `member-option`)
 * @param {string} o.title @param {string} [o.description]
 * @param {string} [o.searchLabel]  @param {PickerOption[]} o.options
 * @param {boolean} [o.multiple=false] @param {string[]} [o.selected]
 * @param {string|Node|Node[]} [o.confirmLabel] @param {string|Node|Node[]} [o.cancelLabel]
 * @param {string} [o.confirmTestid]  @param {boolean} [o.write]
 * @param {(key: string, params?: object) => string} o.t  @param {(key: string, n: number, params?: object) => string} [o.tp]
 * @param {number} [o.debounceMs=120] list refresh delay  @param {number} [o.announceMs=500] live-count delay
 * @param {{setTimeout: Function, clearTimeout: Function}} [o.timers]  injectable (tests)
 * @returns {Promise<string[]|null>} the chosen ids (one in single mode), or null when cancelled
 */
export function openPicker({ name = 'picker', title, description, searchLabel, options, multiple = false, selected = [], confirmLabel, cancelLabel, confirmTestid, write = false, t = identityT, tp, limit = MAX_RESULTS, debounceMs = 120, announceMs = 500, timers, win } = {}) {
  const state = createPickerState({ options, multiple, selected, limit });
  const ids = uniqueId(`pk-${name}`);
  const listId = `${ids}-list`;
  const confirmId = confirmTestid || `${name}-picker-confirm`;
  const plural = (key, n, params = {}) => (tp ? tp(key, n, params) : t(`${key}.${n === 1 ? 'one' : 'other'}`, { n, ...params }));

  const input = h('input', {
    type: 'text',
    class: 'input',
    id: `${ids}-search`,
    testid: `field-${name}-search`,
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'true',
    'aria-controls': listId,
    'aria-describedby': `${ids}-hint ${ids}-count`,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'data-autofocus': true,
  });
  const count = h('p', { class: 'field__hint picker__count', id: `${ids}-count`, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', testid: `${name}-result-count` });
  const selectedCount = multiple ? h('p', { class: 'field__hint picker__selected', role: 'status', testid: `${name}-selected-count` }) : null;
  const list = h('ul', { class: 'picker__list', id: listId, role: 'listbox', 'aria-label': title, 'aria-multiselectable': multiple ? 'true' : null, testid: `${name}-list` });
  const hint = h('p', { class: 'field__hint', id: `${ids}-hint` }, t(multiple ? 'widget.picker.hintMulti' : 'widget.picker.hint'));
  const searchField = h('div', { class: 'field' }, h('label', { class: 'field__label', for: `${ids}-search` }, searchLabel || t('widget.picker.search')), input, hint, count);

  const countText = () => (state.total === 0 ? t('widget.picker.none') : state.truncated ? t('widget.picker.truncated', { shown: state.results.length, n: state.total }) : plural('widget.picker.count', state.total));
  const announcer = createAnnouncer({
    apply: (text) => {
      count.textContent = text;
    },
    ms: announceMs,
    timers,
  });
  const updateSelected = () => {
    if (selectedCount) selectedCount.textContent = plural('widget.picker.selected', state.selected.length);
  };

  let ctrl = null;
  let resolveFn = null;
  const finish = (value) => {
    resolveFn(value);
    if (ctrl) ctrl.close(value ? 'choose' : 'cancel');
  };

  function markActive() {
    const kids = list.children;
    for (let i = 0; i < kids.length; i += 1) {
      const on = i === state.activeIndex;
      kids[i].classList.toggle('is-active', on);
      if (on) {
        input.setAttribute('aria-activedescendant', kids[i].getAttribute('id'));
        if (typeof kids[i].scrollIntoView === 'function') kids[i].scrollIntoView({ block: 'nearest' });
      }
    }
    if (state.activeIndex < 0) input.removeAttribute('aria-activedescendant');
  }

  function activate(id) {
    if (!state.toggle(id)) return;
    if (!multiple) {
      finish(state.selected);
      return;
    }
    const row = [...list.children].find((li) => li.getAttribute('data-id') === id);
    if (row) {
      row.setAttribute('aria-selected', state.isSelected(id) ? 'true' : 'false');
      row.classList.toggle('is-selected', state.isSelected(id));
    }
    updateSelected();
  }

  function renderList() {
    while (list.firstChild) list.removeChild(list.firstChild);
    state.results.forEach((opt, i) => {
      const sel = state.isSelected(opt.id);
      list.append(
        h(
          'li',
          {
            class: ['picker__option', sel ? 'is-selected' : null, opt.disabled ? 'is-disabled' : null],
            id: `${ids}-opt-${i}`,
            role: 'option',
            testid: `${name}-option`,
            'data-id': opt.id,
            'aria-selected': sel ? 'true' : 'false',
            'aria-disabled': opt.disabled ? 'true' : null,
            on: {
              mousedown: (e) => e.preventDefault(), // keep the focus in the search field
              click: () => activate(opt.id),
            },
          },
          h('span', { class: 'picker__label' }, opt.label),
          opt.sublabel ? h('span', { class: 'picker__sub' }, opt.sublabel) : null,
        ),
      );
    });
    markActive();
    announcer.push(countText());
  }

  const refresh = debounce(
    () => {
      state.setQuery(input.value);
      renderList();
    },
    debounceMs,
    timers,
  );
  input.addEventListener('input', () => refresh());
  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'PageDown':
      case 'PageUp': {
        e.preventDefault();
        refresh.flush();
        state.move(e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 8 : -8);
        markActive();
        break;
      }
      case 'Enter': {
        e.preventDefault();
        refresh.flush();
        if (state.activeId !== null) activate(state.activeId);
        break;
      }
      default:
    }
  });

  const actions = [{ testid: 'dialog-cancel', label: cancelLabel || t('dialog.cancel'), cancel: true }];
  if (multiple) actions.push({ testid: confirmId, label: confirmLabel || t('widget.picker.confirm'), kind: 'primary', write, onClick: () => resolveFn(state.selected) });

  const promise = new Promise((resolve) => {
    resolveFn = resolve;
    ctrl = openDialog({
      testid: `${name}-picker`,
      title,
      description,
      body: [searchField, list, selectedCount],
      actions,
      focus: input,
      win,
      onClose: () => {
        refresh.cancel();
        announcer.cancel();
        resolve(null); // a no-op after the promise was resolved with a choice
      },
    });
  });
  ctrl.dialog.classList.add('dialog--picker');
  state.setQuery('');
  renderList();
  announcer.flush(countText()); // the first count is shown at once
  updateSelected();
  promise.dialog = ctrl;
  promise.state = state;
  return promise;
}
