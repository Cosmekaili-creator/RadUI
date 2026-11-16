// SPDX-License-Identifier: AGPL-3.0-or-later
// The task form (`#/tasks/new?list=<href>`, `#/tasks/<key>/edit?list=<href>`): ONE form for both. Rules (RUN2 code review
// section e, binding, as for contacts and events):
//  - `{text, etag}` is kept from the moment the form opens; every save passes `base`;
//  - every patch is built by tasks/formmodel.toPatch(baseValues, values): a form that changed nothing sends nothing;
//  - the due and start times keep their own zone (TZID) unless the user changes the picker; a time typed into a
//    date-only value takes the display zone; a value without a time is a DATE;
//  - a repeating task keeps its rule (shown read-only) and cannot be completed here (Q-R3-5);
//  - Save is disabled while a request is in flight; a lost answer to a create is retried only with the result's `retry`;
//  - unsaved input is guarded (app.setDirty) and kept over a language switch (snapshot/restore);
//  - a conflict opens the shared conflict dialog.
// Test ids: task-form-screen, task-form, field-summary, field-list, field-due-date, field-due-time, field-tz-due,
// field-start-date, field-start-time, field-tz-start, field-priority, field-status, field-percent, field-categories,
// field-description, task-recurrence, form-errors, form-status, task-save, task-cancel, task-delete, task-form-notfound,
// task-form-readonly, task-form-nolist.

import { clear, fill, h, restoreForm, snapshotForm } from '../../ui.js';
import { classify, davErrorKey } from '../../store/errors.js';
import { collectionForParam } from '../../router.js';
import { buildField, uniqueId } from '../../widgets/fieldkit.js';
import { createDateField } from '../../widgets/datefield.js';
import { createTimeField } from '../../widgets/timefield.js';
import { summarizeRule } from '../../calendar/recurtext.js';
import { loadDisplayZone } from '../../calendar/tzprefs.js';
import { createZoneField } from '../calendar/tzpicker.js';
import { createChips, textField } from '../contacts/formfields.js';
import { openConflictDialog } from '../conflictdialog.js';
import { LIMITS, fromItem, isEmptyPatch, newTaskValues, priorityOptions, statusOptions, toNewFields, toPatch, validate, withZone } from '../../tasks/formmodel.js';
import { createTaskActions } from './actions.js';
import { isolate, readTaskPrefs, resolveDeps, resolveUse24h, taskHash, tasksHash } from './common.js';
import { createTaskSource } from './source.js';

const OK_STATUS = new Set(['saved', 'created', 'unchanged', 'reloaded', 'discarded', 'copied']);
const ERR_FIELDS = { summary: 'field-summary', description: 'field-description', percent: 'field-percent', priority: 'field-priority', status: 'field-status', 'field-due-date': 'field-due-date', 'field-due-time': 'field-due-time', 'field-start-date': 'field-start-date', 'field-start-time': 'field-start-time', 'field-tz-due': 'field-tz-due', 'field-tz-start': 'field-tz-start' };

function selectField({ testid, label, value, options, hint }) {
  const id = uniqueId(testid);
  const control = h('select', { class: 'input', id, testid }, ...options.map(([v, text]) => h('option', { value: String(v) }, text)));
  control.value = String(value);
  const f = buildField({ id, label, testid: null, control, hint });
  f.el.setAttribute('data-field', testid);
  return { el: f.el, control, setError: f.setError, focus: () => control.focus() };
}

export function mount(ctx, deps = {}) {
  const d = { openConflictDialog, ...resolveDeps(deps) };
  const app = ctx.app;
  const { t, tp } = ctx;
  const lang = app.lang || 'en';
  const isNew = ctx.route && ctx.route.name === 'task-new';
  const login = app.session ? app.session.login : '';
  const prefs = app.prefs ? app.prefs() : null;
  const P = readTaskPrefs(prefs, { firstWeekday: app.firstWeekday });
  const use24h = resolveUse24h(P.use24h, lang);
  const displayTz = loadDisplayZone(login, { storage: d.storage, defaultZone: app.timeZone });
  const root = h('section', { class: 'tform', testid: 'task-form-screen', 'data-state': 'loading', 'data-mode': isNew ? 'new' : 'edit' });
  const endLoad = app.readiness ? app.readiness.begin() : () => {};
  let disposed = false;
  let F = null;
  let source = null;
  let titleText = isNew ? t('tasks.form.titleNew') : t('tasks.form.titleEdit', { name: '' });
  const heading = h('h1', { class: 'page-title', id: 'tf-title', tabindex: '-1' }, titleText);
  const body = h('div', { class: 'tform__body' });
  root.append(heading, body);
  ctx.root.append(root);
  const nav = (hash, opts) => app.navigate(hash, opts);
  const params = ctx.params || {};

  function stateBox(testid, title, text, actions = []) {
    fill(body, h('div', { class: 'state', testid }, h('h2', { class: 'state__title' }, title), text ? h('p', { class: 'muted' }, text) : null, actions.length ? h('div', { class: 'state__actions' }, actions) : null));
  }
  function finish(ok) {
    root.setAttribute('data-state', ok ? 'ready' : 'error');
    endLoad(ok);
  }
  const backLink = (testid = 'btn-back-tasks') => h('a', { class: 'btn', href: tasksHash({}), testid }, t('tasks.detail.back'));

  async function load() {
    let storeCtx;
    let target = null;
    let found = null;
    try {
      storeCtx = await app.getStore();
      await storeCtx.access.load();
      if (disposed) return;
      source = createTaskSource({ storeCtx });
      const lists = source.lists();
      if (!lists.length) {
        stateBox('task-form-nolist', t('tasks.nolist.title'), t('tasks.form.nolist'), [backLink()]);
        return finish(true);
      }
      if (isNew) {
        const wanted = typeof params.list === 'string' && params.list ? collectionForParam(params.list, lists) : null;
        if (params.list && !wanted) {
          stateBox('task-form-notfound', t('tasks.form.listNotFound'), t('tasks.form.listNotFoundText'), [backLink()]);
          return finish(true);
        }
        target = wanted || source.writable()[0] || null;
        if (!target || !storeCtx.access.canWrite(target)) {
          stateBox('task-form-readonly', t('tasks.form.readonly.title'), t('tasks.form.readonly.text'), [backLink()]);
          return finish(true);
        }
      } else {
        found = await source.resolve({ key: typeof params.key === 'string' ? params.key : '', list: typeof params.list === 'string' ? params.list : '' });
        if (disposed) return;
        if (found.state === 'error') throw { kind: found.kind };
        if (found.state !== 'ok') {
          stateBox('task-form-notfound', t('tasks.detail.notfound'), null, [backLink()]);
          return finish(true);
        }
        target = found.collection;
        const blocked = !storeCtx.access.canWrite(target) ? 'tasks.form.readonly.text' : found.item.readOnly ? 'tasks.form.readonlyItem' : storeCtx.writes.isReadOnly(found.entry.href) ? 'tasks.form.readonlyItem' : null;
        if (blocked) {
          stateBox('task-form-readonly', t('tasks.form.readonly.title'), t(blocked), [h('a', { class: 'btn', href: taskHash(found.key, { list: target.href }), testid: 'btn-back-task' }, t('tasks.detail.back'))]);
          return finish(true);
        }
      }
    } catch (e) {
      const kind = e && typeof e.kind === 'string' && !e.name ? e.kind : classify(e).kind;
      stateBox(d.isOnline() ? 'tasks-error' : 'tasks-offline', t(d.isOnline() ? 'tasks.err.generic' : 'tasks.err.offline'), d.isOnline() ? t(davErrorKey(kind)) : null, [backLink()]);
      return finish(false);
    }
    const restore = ctx.restore && ctx.restore.mode === (isNew ? 'new' : 'edit') ? ctx.restore : null;
    const base = isNew ? null : restore && restore.base ? restore.base : { text: found.entry.text, etag: found.entry.etag };
    let item = null;
    if (!isNew) {
      try {
        item = app.openItem(base.text, 'task');
      } catch {
        item = null;
      }
      if (!item || !item.ok || item.readOnly) {
        stateBox('task-form-readonly', t('tasks.form.readonly.title'), t('tasks.form.readonlyItem'), [backLink()]);
        return finish(true);
      }
    }
    F = buildForm({ storeCtx, target, base, item, restore, key: isNew ? null : found.key, href: isNew ? null : found.entry.href });
    fill(body, F.el);
    if (restore && restore.form) restoreForm(F.el, restore.form);
    F.afterRestore();
    titleText = isNew ? t('tasks.form.titleNew') : t('tasks.form.titleEdit', { name: isolate(item.fields().summary || t('tasks.untitled')) });
    heading.textContent = titleText;
    finish(true);
    (isNew ? F.focusFirst : () => heading.focus())();
  }

  // ---------------------------------------------------------------------------------------------------------

  function buildForm({ storeCtx, target, base, item, restore, key, href }) {
    const writes = storeCtx.writes;
    const v0 = item ? fromItem(item) : newTaskValues({ tz: displayTz });
    const zones = item ? item.zones : null;
    const state = { busy: false, retry: restore && restore.retry ? restore.retry : null, dirty: false, list: restore && restore.list ? restore.list : target.href };
    const fields = new Map();
    const reg = (testid, f) => {
      fields.set(testid, f);
      return f;
    };
    const lists = source.writable();

    const form = h('form', { class: 'form task-form', novalidate: true, testid: 'task-form', 'aria-labelledby': 'tf-title', 'aria-busy': 'false', 'data-mode': isNew ? 'new' : 'edit' });
    const errors = h('div', { class: 'form__errors', role: 'alert', tabindex: '-1', testid: 'form-errors', hidden: true });
    const live = h('p', { class: 'visually-hidden', role: 'status', testid: 'form-status' });

    // ------------------------------------------------------------------ fields
    const fSummary = reg('field-summary', textField({ testid: 'field-summary', label: t('tasks.field.summary'), value: v0.summary, attrs: { maxlength: String(LIMITS.summary) } }));
    let fList = null;
    let listBox;
    if (isNew) {
      fList = reg('field-list', selectField({ testid: 'field-list', label: t('tasks.field.list'), value: state.list, options: lists.map((l) => [l.href, l.name]) }));
      fList.control.addEventListener('change', () => {
        state.list = fList.control.value;
      });
      listBox = fList.el;
    } else {
      const name = (source.lists().find((l) => l.href === target.href) || {}).name || target.href;
      listBox = h('div', { class: 'field', 'data-field': 'field-list' }, h('span', { class: 'field__label' }, t('tasks.field.list')), h('p', { class: 'field__static', testid: 'field-list' }, h('bdi', null, name)));
    }
    const prioOpts = priorityOptions(v0).map((n) => [n, n === 0 ? t('tasks.prio.none') : `${t(`tasks.prio.${n <= 4 ? 'high' : n === 5 ? 'medium' : 'low'}`)}${[1, 5, 9].includes(n) ? '' : ` (${n})`}`]);
    const fPrio = reg('field-priority', selectField({ testid: 'field-priority', label: t('tasks.field.priority'), value: v0.priority, options: prioOpts, hint: t('tasks.field.priorityHint') }));
    const fStatus = reg('field-status', selectField({ testid: 'field-status', label: t('tasks.field.status'), value: v0.status, options: statusOptions(v0).map((s) => [s, s ? t(`tasks.state.${s}`) : t('tasks.state.none')]) }));
    const fPercent = reg('field-percent', textField({ testid: 'field-percent', label: t('tasks.field.percent'), value: v0.percent, attrs: { inputmode: 'numeric', maxlength: '3' }, hint: t('tasks.field.percentHint') }));
    const now = () => new Date(d.now());

    function timeBlock(which, labelKey) {
      const dateF = createDateField({ testid: `field-${which}-date`, label: t(`tasks.field.${labelKey}`), t, lang, picker: true, clearable: true, firstWeekday: P.firstWeekday, now, value: v0[`${which}Date`] || null, onChange: () => whenChanged(which), onInput: () => softChanged() });
      const timeF = createTimeField({ testid: `field-${which}-time`, label: t(`tasks.field.${labelKey}Time`), t, lang, use24h, value: v0[`${which}Time`] || null, hint: t('tasks.field.timeHint'), onChange: () => whenChanged(which), onInput: () => softChanged() });
      const zoneF = createZoneField({ testid: `field-tz-${which}`, label: t(`tasks.field.${which}Zone`), value: v0[`${which}Tz`], t, tp, login, getSeen: () => [v0.dueTz, v0.startTz].filter(Boolean), storage: d.storage, deps: d.zoneDeps || {}, onChange: (zone) => zoneChosen(which, zone) });
      const row = h('div', { class: 'tform__when', 'data-which': which }, dateF.el, timeF.el, zoneF.el);
      reg(`field-${which}-date`, dateF);
      reg(`field-${which}-time`, timeF);
      reg(`field-tz-${which}`, zoneF);
      return { dateF, timeF, zoneF, row };
    }
    const due = timeBlock('due', 'due');
    const start = timeBlock('start', 'start');
    const blocks = { due, start };
    const zoneState = { due: { tz: v0.dueTz, kind: v0.dueKind }, start: { tz: v0.startTz, kind: v0.startKind } };
    if (restore && restore.zones) {
      for (const w of ['due', 'start']) if (restore.zones[w]) zoneState[w] = { ...restore.zones[w] };
      for (const w of ['due', 'start']) blocks[w].zoneF.setValue(zoneState[w].tz);
    }
    function zoneChosen(which, zone) {
      const next = withZone({ [`${which}Tz`]: zoneState[which].tz, [`${which}Kind`]: zoneState[which].kind }, which, zone);
      zoneState[which] = { tz: next[`${which}Tz`], kind: next[`${which}Kind`] };
      changed();
    }
    const timeOf = (f) => {
      const r = f.parse();
      return r.ok ? r.iso : f.input.value;
    };
    const dateOf = (f) => {
      const r = f.parse();
      return r.ok ? r.iso : f.input.value;
    };
    /** The zone control only matters once a time is typed. A time added to a date-only value starts in the display zone. */
    function whenChanged(which) {
      const b = blocks[which];
      const hasTime = Boolean(timeOf(b.timeF));
      b.zoneF.el.hidden = !hasTime;
      if (hasTime && !zoneState[which].tz && zoneState[which].kind !== 'floating') {
        zoneState[which] = { tz: displayTz, kind: displayTz === 'UTC' ? 'utc' : 'zoned' };
        b.zoneF.setValue(displayTz);
      }
      changed();
    }
    for (const w of ['due', 'start']) blocks[w].zoneF.el.hidden = !timeOf(blocks[w].timeF);

    const chips = createChips({ t, items: restore && restore.cats ? restore.cats : v0.categories, onChange: () => changed() });
    fields.set('field-categories', chips);
    const fDesc = reg('field-description', textField({ testid: 'field-description', label: t('tasks.field.description'), value: v0.description, input: 'textarea', attrs: { rows: '5' } }));
    let ruleBox = null;
    if (v0.recurring) {
      const startSpec = item.fields().due || item.fields().start;
      let sentence = v0.rrule;
      if (startSpec) {
        try {
          sentence = summarizeRule(v0.rrule, startSpec, { t, tp, lang, zones: item.zones });
        } catch {
          sentence = v0.rrule;
        }
      }
      ruleBox = h('div', { class: 'field', 'data-field': 'task-recurrence' }, h('span', { class: 'field__label' }, t('tasks.field.repeats')), h('p', { class: 'field__static', testid: 'task-recurrence' }, sentence), h('p', { class: 'field__hint' }, t('tasks.form.repeatsNote')));
    }

    // ------------------------------------------------------------------ collecting
    function collect() {
      const v = {
        summary: fSummary.control.value,
        description: fDesc.control.value,
        status: fStatus.control.value,
        priority: fPrio.control.value,
        percent: fPercent.control.value,
        categories: chips.values(),
        rrule: v0.rrule,
        recurring: v0.recurring,
      };
      for (const w of ['due', 'start']) {
        v[`${w}Date`] = dateOf(blocks[w].dateF);
        v[`${w}Time`] = timeOf(blocks[w].timeF);
        v[`${w}Tz`] = zoneState[w].tz;
        v[`${w}Kind`] = zoneState[w].kind;
      }
      return v;
    }
    const opts = () => ({ now: d.now(), defaultTz: displayTz });

    // ------------------------------------------------------------------ dirty
    let dirtyQueued = false;
    function computeDirty() {
      try {
        return !isEmptyPatch(toPatch(v0, collect(), opts()));
      } catch {
        return true; // a half-typed date or time is a change too
      }
    }
    function changed() {
      if (dirtyQueued || disposed) return;
      dirtyQueued = true;
      Promise.resolve().then(() => {
        dirtyQueued = false;
        if (disposed) return;
        state.dirty = computeDirty() || state.retry !== null;
        app.setDirty(state.dirty);
      });
    }
    const softChanged = changed;
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);

    // ------------------------------------------------------------------ errors
    function clearErrors() {
      for (const f of fields.values()) f.setError(null);
      errors.hidden = true;
      clear(errors);
    }
    const labelOf = (testId) => {
      const map = { 'field-summary': 'summary', 'field-description': 'description', 'field-percent': 'percent', 'field-priority': 'priority', 'field-status': 'status', 'field-due-date': 'due', 'field-due-time': 'dueTime', 'field-tz-due': 'dueZone', 'field-start-date': 'start', 'field-start-time': 'startTime', 'field-tz-start': 'startZone' };
      return map[testId] ? t(`tasks.field.${map[testId]}`) : '';
    };
    function showErrors(list) {
      clearErrors();
      const items = list.map((e) => {
        const message = t(`tasks.err.${e.code}`);
        const f = fields.get(ERR_FIELDS[e.testId] || e.testId);
        if (f) f.setError(message);
        const prefix = labelOf(e.testId);
        return { text: prefix ? `${prefix}: ${message}` : message, focus: () => (f ? f.focus() : errors.focus()) };
      });
      fill(
        errors,
        h('p', { class: 'form__errors-title' }, tp('tasks.form.errors', items.length, { n: items.length })),
        h('ul', null, items.map((it) => h('li', null, h('button', { type: 'button', class: 'linklike', testid: 'form-error-link', on: { click: () => it.focus() } }, it.text)))),
      );
      errors.hidden = false;
      if (items.length) items[0].focus();
    }
    function showFailure(res) {
      clearErrors();
      fill(errors, h('p', { class: 'form__errors-title' }, t('tasks.form.notSaved')), h('p', null, (res && res.message) || t('tasks.err.generic')));
      errors.hidden = false;
      errors.focus();
    }

    // ------------------------------------------------------------------ save
    const save = h('button', { type: 'submit', class: 'btn btn--primary', testid: 'task-save', write: true }, isNew ? t('tasks.form.create') : t('tasks.form.save'));
    const backHash = isNew ? tasksHash({}) : taskHash(key, { list: target.href });
    const cancel = h('a', { class: 'btn', href: backHash, testid: 'task-cancel' }, t('tasks.form.cancel'));
    const fieldsets = h('fieldset', { class: 'form__fields' });
    function refreshSave() {
      save.disabled = state.busy;
      form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    }
    function lockFields(on) {
      fieldsets.disabled = on;
      save.textContent = on ? t('tasks.form.retry') : isNew ? t('tasks.form.create') : t('tasks.form.save');
    }
    function leaveTo(hash) {
      state.dirty = false;
      app.setDirty(false);
      nav(hash);
    }

    async function handle(res) {
      if (disposed || !res) return;
      if (res.ok && OK_STATUS.has(res.status)) {
        leaveTo(backHash);
        return;
      }
      if (res.status === 'conflict' || res.status === 'deleted-elsewhere') {
        const out = await d.openConflictDialog({ conflict: res, t, writes, label: v0.summary || undefined, feedback: app.feedback, win: d.win });
        if (out && out.ok) leaveTo(out.status === 'discarded' ? tasksHash({}) : backHash);
        return;
      }
      if (res.status === 'unknown-result' && isNew && res.retry) {
        state.retry = res.retry;
        lockFields(true);
      }
      if (res.status === 'auth') return;
      showFailure(res);
    }

    async function submit() {
      if (state.busy) return;
      clearErrors();
      const v = collect();
      const errs = validate(v0, v, { isNew, zones, defaultTz: displayTz });
      if (errs.length) {
        showErrors(errs);
        return;
      }
      let patch = null;
      let newFields = null;
      try {
        if (isNew) newFields = toNewFields(v, opts());
        else patch = toPatch(v0, v, opts());
      } catch {
        showFailure({ message: t('tasks.form.unexpected') });
        return;
      }
      if (!isNew && isEmptyPatch(patch)) {
        app.feedback.setStatus(t('store.status.unchanged'));
        live.textContent = t('store.status.unchanged');
        return;
      }
      state.busy = true;
      refreshSave();
      live.textContent = t('tasks.form.saving');
      try {
        const res = isNew
          ? await writes.createItem({ collection: state.list || target.href, kind: 'task', fields: newFields, retry: state.retry || null })
          : await writes.saveItem({ collection: target.href, href, patch, base });
        await handle(res);
      } catch {
        if (!disposed) {
          const message = t('tasks.form.unexpected');
          app.feedback.setAlert(message, { scope: null });
          showFailure({ message });
        }
      } finally {
        state.busy = false;
        if (!disposed) {
          refreshSave();
          const active = d.doc && d.doc.activeElement;
          if (!save.disabled && (!active || active === d.doc.body)) save.focus();
        }
      }
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void submit();
    });

    // ------------------------------------------------------------------ delete (edit only)
    let del = null;
    if (!isNew) {
      del = h('button', { type: 'button', class: 'btn btn--danger-quiet', testid: 'task-delete', write: true, 'aria-label': t('tasks.delete.named', { name: isolate(v0.summary || t('tasks.untitled')) }), on: { click: () => void remove() } }, t('tasks.delete'));
    }
    async function remove() {
      const actions = createTaskActions({ app, storeCtx, source, t, deps: { win: d.win, ...d.actionDeps } });
      const out = await actions.remove({ collection: target.href, entry: { href, etag: base.etag }, summary: v0.summary, uid: item ? item.uid : null });
      if (out.done) leaveTo(tasksHash({}));
    }

    fill(
      fieldsets,
      h('div', { class: 'form__grid' }, h('div', { class: 'span-2' }, fSummary.el), listBox, fPrio.el, fStatus.el, fPercent.el),
      h('div', { class: 'tform__times' }, due.row, start.row),
      ruleBox,
      chips.el,
      fDesc.el,
    );
    fill(form, errors, live, fieldsets, h('div', { class: 'form__actions' }, del, h('span', { class: 'spacer' }), cancel, save));
    refreshSave();

    return {
      el: form,
      focusFirst: () => fSummary.focus(),
      afterRestore() {
        for (const w of ['due', 'start']) blocks[w].zoneF.el.hidden = !timeOf(blocks[w].timeF);
        if (state.retry) lockFields(true);
        changed();
      },
      snapshot() {
        return { mode: isNew ? 'new' : 'edit', base, form: snapshotForm(form), cats: chips.values(), zones: { ...zoneState }, list: state.list, retry: state.retry };
      },
      dispose() {},
      // exposed for tests
      state,
      collect,
      fields,
      submit,
    };
  }

  load().catch(() => finish(false));

  return {
    get title() {
      return titleText;
    },
    snapshot: () => (F ? F.snapshot() : ctx.restore || null),
    dispose() {
      disposed = true;
      app.setDirty(false);
      if (F) F.dispose();
      if (source) source.dispose();
      clear(root);
      root.remove();
    },
    get form() {
      return F;
    },
  };
}
