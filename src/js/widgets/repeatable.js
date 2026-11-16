// SPDX-License-Identifier: AGPL-3.0-or-later
// Repeatable-row editor for phones, e-mails, addresses and URLs (SPECS 5, RUN2-PLAN 2.1).
//  - createRowsModel: the pure model (rows, addRow, removeRow, update, markChanged, setPreferred), DOM-free.
//    Every row carries the caller's original-row handle (`orig`) untouched, so the form model can map a
//    row back to the property it came from; new rows have `orig: null`.
//  - createRepeatable: the rendering on top of ui.js `h()`: a TYPE select + custom label field, value
//    fields, a "preferred" radio group per kind, add/remove buttons with accessible names ('Remove phone 2'),
//    focus management after add and remove, announcements through a caller-provided status function.
//    No drag handles: rows are added and removed with buttons only.
//
// Test ids (k = kind): `<k>-row` (data-key, data-new), `field-<k>-type`, `field-<k>-custom`, `field-<k>-pref`,
// value fields `field-<k>` (one field) or `field-<k>-<name>` (several), `btn-add-<k>`, `btn-remove-<k>`,
// `btn-clear-pref-<k>`, errors `<testid>-error`.

import { h } from '../ui.js';
import { fill, identityT, uniqueId } from './fieldkit.js';

export const DEFAULT_MAX_ROWS = 50;

// ------------------------------------------------------------------------- model

/**
 * @typedef {object} Row
 * @property {string} key       stable within the model (never reused)
 * @property {*} orig           the caller's original-row handle, untouched (null for a new row)
 * @property {boolean} isNew
 * @property {string} type      the TYPE select value ('' = none)
 * @property {string} custom    the custom label
 * @property {boolean} pref     marked preferred
 * @property {Record<string,string>} values  the value fields by name
 * @property {boolean} changed         anything differs from the loaded row (always true for a new row)
 * @property {boolean} typeChanged     the type select was changed (the form model keeps the original tokens otherwise)
 * @property {boolean} prefChanged     the preferred state differs from the loaded one (else the form model sends pref: undefined)
 * @property {string[]} changedFields  names of changed value fields (+ 'type', 'custom' when changed)
 */

/**
 * @param {object} o
 * @param {string} o.kind  'phone', 'email', 'address', 'url'
 * @param {{orig?: *, type?: string, custom?: string, pref?: boolean, values?: Record<string,string>}[]} [o.rows] loaded rows
 * @param {() => Record<string,string>} [o.blank]  value fields of a new row
 * @param {string} [o.defaultType]  type of a new row
 * @param {number} [o.max]
 */
export function createRowsModel({ kind, rows = [], blank = () => ({}), defaultType = '', max = DEFAULT_MAX_ROWS } = {}) {
  let seq = 0;
  const list = [];
  const removed = [];

  const loaded = (r, isNew) => {
    seq += 1;
    const row = {
      key: `${kind}-${seq}`,
      orig: isNew ? null : r.orig === undefined ? null : r.orig,
      isNew,
      type: r.type ?? '',
      custom: r.custom ?? '',
      pref: Boolean(r.pref),
      values: { ...(r.values || {}) },
      initial: isNew ? null : { type: r.type ?? '', custom: r.custom ?? '', pref: Boolean(r.pref), values: { ...(r.values || {}) } },
      forced: new Set(),
    };
    Object.defineProperties(row, {
      changedFields: {
        enumerable: true,
        get() {
          if (row.isNew) return ['type', 'custom', ...Object.keys(row.values)];
          const out = [];
          if (row.type !== row.initial.type || row.forced.has('type')) out.push('type');
          if (row.custom !== row.initial.custom || row.forced.has('custom')) out.push('custom');
          for (const name of Object.keys(row.values)) if (row.values[name] !== (row.initial.values[name] ?? '') || row.forced.has(name)) out.push(name);
          return out;
        },
      },
      typeChanged: { enumerable: true, get: () => row.isNew || row.type !== row.initial.type || row.forced.has('type') },
      prefChanged: { enumerable: true, get: () => (row.isNew ? row.pref : row.pref !== row.initial.pref || row.forced.has('pref')) },
      changed: { enumerable: true, get: () => row.isNew || row.changedFields.length > 0 || row.prefChanged },
    });
    return row;
  };
  for (const r of rows) list.push(loaded(r, false));

  const find = (key) => list.find((r) => r.key === key) || null;
  const model = {
    kind,
    max,
    /** The live rows, in order. Read-only for callers: change them through the methods below. */
    get rows() {
      return list;
    },
    /** Original handles of the rows that were removed (the form model deletes those properties). */
    get removed() {
      return removed;
    },
    get size() {
      return list.length;
    },
    get canAdd() {
      return list.length < max;
    },
    get dirty() {
      return removed.length > 0 || list.some((r) => r.changed);
    },
    get preferredKey() {
      const r = list.find((x) => x.pref);
      return r ? r.key : null;
    },
    find,
    indexOf: (key) => list.findIndex((r) => r.key === key),
    /** Add a new row at the end; null when the maximum is reached. */
    addRow(init = {}) {
      if (list.length >= max) return null;
      const row = loaded({ type: init.type ?? defaultType, custom: init.custom ?? '', pref: Boolean(init.pref), values: { ...blank(), ...(init.values || {}) } }, true);
      list.push(row);
      if (row.pref) model.setPreferred(row.key);
      return row;
    },
    /** Remove a row; returns {row, index} (null for an unknown key). Original handles are kept in `removed`. */
    removeRow(key) {
      const index = list.findIndex((r) => r.key === key);
      if (index < 0) return null;
      const [row] = list.splice(index, 1);
      if (!row.isNew) removed.push(row.orig);
      return { row, index };
    },
    /** Set the type, the custom label or a value field. Returns true when the row exists. */
    update(key, field, value) {
      const row = find(key);
      if (!row) return false;
      const text = String(value ?? '');
      if (field === 'type') row.type = text;
      else if (field === 'custom') row.custom = text;
      else row.values[field] = text;
      return true;
    },
    /** Force a field (or 'pref') to count as changed even when its text equals the loaded one. */
    markChanged(key, field) {
      const row = find(key);
      if (!row) return false;
      row.forced.add(field);
      return true;
    },
    /** Make one row the preferred one of its kind (exclusive); a no-op for an unknown key. */
    setPreferred(key) {
      const target = find(key);
      if (!target) return false;
      for (const r of list) r.pref = r === target;
      return true;
    },
    clearPreferred() {
      for (const r of list) r.pref = false;
    },
    /** Plain data of the current state, without the original handles (for form snapshots). */
    snapshot() {
      return list.map((r) => ({ key: r.key, isNew: r.isNew, type: r.type, custom: r.custom, pref: r.pref, values: { ...r.values }, changedFields: r.changedFields }));
    },
  };
  return model;
}

// --------------------------------------------------------------------- rendering

/**
 * @typedef {object} FieldDef
 * @property {string} name
 * @property {string} label
 * @property {'text'|'tel'|'email'|'url'|'textarea'} [input='text']
 * @property {string} [testid]      default `field-<kind>` for a single field, else `field-<kind>-<name>`
 * @property {boolean} [more]       folded under a "More fields" disclosure while empty (address parts)
 * @property {Record<string,string>} [attrs]  extra attributes (autocomplete, inputmode, maxlength, ...)
 */

/**
 * @param {object} o
 * @param {string} o.kind
 * @param {(key: string, params?: object) => string} o.t
 * @param {{legend: string, row: string, add: string, remove: string, empty?: string}} o.labels
 *        `row` and `remove` carry `{n}` (the row number): 'Phone {n}', 'Remove phone {n}'
 * @param {{value: string, label: string}[]} [o.types]  the TYPE select; omit for a kind without types
 * @param {string} [o.customValue='custom']  the select value that shows the custom label field
 * @param {FieldDef[]} o.fields
 * @param {object[]} [o.rows]  loaded rows (see createRowsModel)  @param {() => Record<string,string>} [o.blank] @param {string} [o.defaultType]
 * @param {boolean} [o.preferred=true] offer the preferred radio group  @param {number} [o.max]
 * @param {(text: string) => void} [o.announce]  status-region announcements ('Phone 3 added.')
 * @param {(change: {type: 'edit'|'add'|'remove'|'pref', key: string, field?: string}) => void} [o.onChange]
 */
export function createRepeatable(o) {
  const { kind, t = identityT, labels, types = null, customValue = 'custom', fields, preferred = true, announce, onChange } = o;
  const model = o.model || createRowsModel({ kind, rows: o.rows || [], blank: o.blank, defaultType: o.defaultType ?? (types && types[0] ? types[0].value : ''), max: o.max });
  const groupId = uniqueId(`rep-${kind}`);
  const radioName = `${groupId}-pref`;
  const fieldTestid = (def) => def.testid || (fields.length === 1 ? `field-${kind}` : `field-${kind}-${def.name}`);
  /** key -> {fieldName -> {control, error}} */
  let refs = new Map();

  const list = h('ul', { class: 'repeat__rows', testid: `${kind}-list` });
  const addBtn = h('button', { type: 'button', class: 'btn btn--small repeat__add', testid: `btn-add-${kind}` }, labels.add);
  const maxNote = h('p', { class: 'field__hint', hidden: true, testid: `${kind}-max` }, t('widget.rep.max', { max: model.max }));
  const clearBtn = h('button', { type: 'button', class: 'btn btn--small btn--quiet repeat__clearpref', testid: `btn-clear-pref-${kind}`, hidden: true }, t('widget.rep.clearPref'));
  const legend = h('legend', { class: 'section-title' }, labels.legend);
  const el = h('fieldset', { class: 'repeat', testid: `${kind}-rows`, 'data-kind': kind }, legend, list, h('div', { class: 'repeat__actions' }, addBtn, preferred ? clearBtn : null), maxNote);

  const rowName = (index) => fill(labels.row, { n: index + 1 });
  const emit = (change) => {
    if (onChange) onChange(change);
  };

  function control(def, row, labelledBy) {
    const common = {
      class: def.input === 'textarea' ? 'input repeat__textarea' : 'input',
      testid: fieldTestid(def),
      'aria-labelledby': labelledBy,
      'data-field': def.name,
      ...(def.attrs || {}),
    };
    const node = def.input === 'textarea' ? h('textarea', { ...common, rows: '2' }) : h('input', { ...common, type: def.input || 'text' });
    node.value = row.values[def.name] ?? '';
    node.addEventListener('input', () => {
      model.update(row.key, def.name, node.value);
      emit({ type: 'edit', key: row.key, field: def.name });
    });
    return node;
  }

  function fieldBox(id, labelText, node, { withError = true } = {}) {
    node.setAttribute('id', id);
    const err = withError ? h('p', { class: 'field__error', id: `${id}-err`, hidden: true }) : null;
    if (err) node.setAttribute('aria-describedby', err.getAttribute('id'));
    return { box: h('div', { class: 'field' }, h('label', { class: 'field__label', for: id, id: `${id}-label` }, labelText), node, err), err };
  }

  function renderRow(row, index) {
    const capId = `${row.key}-${groupId}-cap`;
    const caption = h('span', { class: 'repeat__caption', id: capId }, rowName(index));
    const rowRefs = {};
    refs.set(row.key, rowRefs);
    const parts = [];
    const named = (suffix) => `${capId} ${row.key}-${groupId}-${suffix}-label`;

    if (types) {
      const known = types.some((x) => x.value === row.type);
      const options = [...types, ...(known || row.type === '' ? [] : [{ value: row.type, label: row.type }])];
      const sel = h('select', { class: 'input', testid: `field-${kind}-type`, 'aria-labelledby': named('type'), 'data-field': 'type' }, options.map((opt) => h('option', { value: opt.value, selected: opt.value === row.type }, opt.label)));
      sel.value = row.type;
      const typeField = fieldBox(`${row.key}-${groupId}-type`, t('widget.rep.type'), sel, { withError: false });
      parts.push(typeField.box);
      rowRefs.type = { control: sel, error: null };

      const custom = h('input', { type: 'text', class: 'input', testid: `field-${kind}-custom`, 'aria-labelledby': named('custom'), 'data-field': 'custom', maxlength: '100' });
      custom.value = row.custom;
      const cf = fieldBox(`${row.key}-${groupId}-custom`, t('widget.rep.custom'), custom);
      const customBox = cf.box;
      customBox.hidden = row.type !== customValue;
      custom.addEventListener('input', () => {
        model.update(row.key, 'custom', custom.value);
        emit({ type: 'edit', key: row.key, field: 'custom' });
      });
      rowRefs.custom = { control: custom, error: cf.err };
      parts.push(customBox);
      sel.addEventListener('change', () => {
        model.update(row.key, 'type', sel.value);
        customBox.hidden = sel.value !== customValue;
        emit({ type: 'edit', key: row.key, field: 'type' });
      });
    }

    const mainFields = [];
    const moreFields = [];
    for (const def of fields) {
      const id = `${row.key}-${groupId}-${def.name}`;
      const node = control(def, row, named(def.name));
      const f = fieldBox(id, def.label, node);
      rowRefs[def.name] = { control: node, error: f.err };
      (def.more ? moreFields : mainFields).push(f.box);
    }
    parts.push(...mainFields);
    if (moreFields.length) {
      const anyFilled = fields.some((d) => d.more && (row.values[d.name] ?? '') !== '');
      parts.push(h('details', { class: 'repeat__more', open: anyFilled, testid: `${kind}-more` }, h('summary', { testid: `${kind}-more-toggle` }, t('widget.rep.more')), h('div', { class: 'repeat__morefields' }, moreFields)));
    }

    let prefBox = null;
    if (preferred) {
      const radio = h('input', { type: 'radio', name: radioName, id: `${row.key}-${groupId}-pref`, testid: `field-${kind}-pref`, checked: row.pref, 'aria-labelledby': named('pref') });
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        model.setPreferred(row.key);
        syncClear();
        emit({ type: 'pref', key: row.key });
      });
      prefBox = h('div', { class: 'check repeat__pref' }, radio, h('label', { for: `${row.key}-${groupId}-pref`, id: `${row.key}-${groupId}-pref-label` }, t('widget.rep.preferred')));
    }

    const removeBtn = h('button', { type: 'button', class: 'btn btn--small repeat__remove', testid: `btn-remove-${kind}`, 'aria-label': fill(labels.remove, { n: index + 1 }), 'data-key': row.key }, t('widget.rep.remove'));
    removeBtn.addEventListener('click', () => removeRow(row.key));
    return h(
      'li',
      { class: 'repeat__row', testid: `${kind}-row`, 'data-key': row.key, 'data-new': row.isNew ? 'true' : 'false' },
      h('div', { class: 'repeat__group', role: 'group', 'aria-labelledby': capId }, caption, h('div', { class: 'repeat__fields' }, parts), h('div', { class: 'repeat__foot' }, prefBox, removeBtn)),
    );
  }

  function syncClear() {
    clearBtn.hidden = !(preferred && model.preferredKey);
  }

  function render() {
    refs = new Map();
    while (list.firstChild) list.removeChild(list.firstChild);
    model.rows.forEach((row, index) => list.append(renderRow(row, index)));
    addBtn.disabled = !model.canAdd;
    maxNote.hidden = model.canAdd;
    syncClear();
  }

  const firstControlOf = (key) => {
    const r = refs.get(key);
    if (!r) return null;
    const def = fields.find((d) => !d.more) || fields[0];
    return (r[def.name] || r.type || {}).control || null;
  };

  function addRow() {
    const row = model.addRow();
    if (!row) return null;
    render();
    const c = firstControlOf(row.key);
    if (c) c.focus();
    if (announce) announce(t('widget.rep.added', { row: rowName(model.indexOf(row.key)) }));
    emit({ type: 'add', key: row.key });
    return row;
  }

  function removeRow(key) {
    const index = model.indexOf(key);
    if (index < 0) return null;
    const name = rowName(index);
    const res = model.removeRow(key);
    render();
    const target = model.rows[index] || model.rows[index - 1] || null;
    const c = target ? firstControlOf(target.key) : null;
    if (c) c.focus();
    else addBtn.focus();
    if (announce) announce(t('widget.rep.removed', { row: name }));
    emit({ type: 'remove', key });
    return res;
  }

  addBtn.addEventListener('click', addRow);
  clearBtn.addEventListener('click', () => {
    const prev = model.preferredKey;
    model.clearPreferred();
    render();
    addBtn.focus();
    if (announce) announce(t('widget.rep.prefCleared'));
    emit({ type: 'pref', key: prev });
  });
  render();

  return {
    el,
    model,
    addRow,
    removeRow,
    /** Re-draw from the model (after the caller changed rows). */
    refresh: render,
    /** Show or clear (message null) a persistent error under a field of a row; field 'type' has no own line. */
    setError(key, field, message) {
      const r = refs.get(key);
      const target = r && r[field];
      if (!target || !target.error) return false;
      if (message) {
        target.control.setAttribute('aria-invalid', 'true');
        target.error.textContent = message;
        target.error.hidden = false;
      } else {
        target.control.removeAttribute('aria-invalid');
        target.error.textContent = '';
        target.error.hidden = true;
      }
      return true;
    },
    clearErrors() {
      for (const r of refs.values()) {
        for (const target of Object.values(r)) {
          if (target.error) {
            target.control.removeAttribute('aria-invalid');
            target.error.textContent = '';
            target.error.hidden = true;
          }
        }
      }
    },
    focusField(key, field) {
      const r = refs.get(key);
      const target = r && r[field];
      if (target) target.control.focus();
      return Boolean(target);
    },
    focusAdd: () => addBtn.focus(),
    addButton: addBtn,
  };
}
