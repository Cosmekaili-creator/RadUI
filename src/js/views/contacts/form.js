// SPDX-License-Identifier: AGPL-3.0-or-later
// The contact form (`#/contacts/new`, `#/contacts/<key>/edit`): ONE form for both. Rules (RUN2 code review
// section e, binding):
//  - `{text, etag}` is kept from the moment the form opens; every save passes `base` and `baseFields`;
//  - every patch is built by formmodel.toPatch(baseFields, values): a form that changed nothing sends nothing;
//  - ADR street and extended parts and the note are <textarea>s (line breaks survive byte for byte);
//  - Save is disabled while a request is in flight;
//  - a conflict with `noop && rows.length === 0` means "already saved" (resolveReload); a real conflict opens
//    the conflict dialog; serverLossWarnings are shown before saving; after `unknown-result` a create is
//    retried ONLY with the result's `retry` token;
//  - unsaved input is guarded (app.setDirty) and kept over a language switch (snapshot/restore).

import { clear, fill, h, restoreForm, snapshotForm } from '../../ui.js';
import { classify, davErrorKey } from '../../store/errors.js';
import { createRepeatable } from '../../widgets/repeatable.js';
import { createDateField } from '../../widgets/datefield.js';
import { confirmDialog } from '../../widgets/dialogs.js';
import { isolate } from '../../widgets/avatar.js';
import { createAnnouncer, debounce } from '../../widgets/timing.js';
import { ADR_PARTS, FORM_IDS, TYPE_OPTIONS, emptyFields, followFn, isEmptyPatch, newCardPatch, serverLossWarnings, toFormValues, toPatch, validate } from '../../contacts/formmodel.js';
import { findDuplicates, keyFor, resolveKey } from '../../contacts/index.js';
import { canDisplayPhoto } from '../../contacts/photo.js';
import { pickNewCardVersion } from '../../model/vcard.js';
import { bookParams, createBookData, isReadOnlyBook, pickBook } from './bookdata.js';
import { cleanQuery, contactHash, failureText, listHash, nameOf, photoApiOf, resolveDeps } from './common.js';
import { createChips, createPhotoBlock, textField } from './formfields.js';

const KINDS = [
  { k: 'tel', id: 'phone', input: 'tel' },
  { k: 'email', id: 'email', input: 'email' },
  { k: 'adr', id: 'address' },
  { k: 'url', id: 'url', input: 'url' },
];
const DEFAULT_TYPE = { tel: 'cell', email: 'home', adr: 'home', url: 'other' };
const MAX_ROWS = 30;
/** Test-id suffix of an address part (formmodel ADR_PARTS) -> the repeatable's field name. */
const ADR_NAME_OF = Object.fromEntries(ADR_PARTS.map((p) => [p.id, p.part]));
/** Where an in-flight create leaves its answer, so a form remounted by a language switch neither repeats nor loses it. */
const PENDING_KEY = 'radui.contacts.pendingCreate';
const OK_STATUS = new Set(['saved', 'created', 'copied', 'unchanged', 'reloaded', 'discarded']);

const ymd = (v) => (v ? { year: v.y === null || v.y === undefined ? null : v.y, month: v.m, day: v.d } : null);
const toWidget = (d) => (d && !d.text ? { y: d.year === undefined ? null : d.year, m: d.month, d: d.day } : null);

export function mount(ctx, deps = {}) {
  const d = resolveDeps(deps);
  const app = ctx.app;
  const { t, tp } = ctx;
  const lang = app.lang || 'en';
  const isNew = ctx.route && ctx.route.name === 'contact-new';
  const root = h('section', { class: 'cform', testid: 'contact-form-screen', 'data-state': 'loading', 'data-mode': isNew ? 'new' : 'edit' });
  const endLoad = app.readiness ? app.readiness.begin() : () => {};
  let disposed = false;
  let F = null; // the built form (after loading)
  const heading = h('h1', { class: 'page-title', id: 'cf-title', tabindex: '-1' }, isNew ? t('contact.form.titleNew') : t('contact.form.titleEdit'));
  const body = h('div', { class: 'cform__body' });
  root.append(heading, body);
  ctx.root.append(root);
  let titleText = isNew ? t('contact.form.titleNew') : t('contact.form.titleEdit');

  const nav = (hash, opts) => app.navigate(hash, opts);
  const params = ctx.params || {};

  function stateBox(testid, title, text, actions = []) {
    fill(body, h('div', { class: 'state', testid }, h('h2', { class: 'state__title' }, title), text ? h('p', { class: 'muted' }, text) : null, actions.length ? h('div', { class: 'state__actions' }, actions) : null));
  }
  function finish(ok) {
    root.setAttribute('data-state', ok ? 'ready' : 'error');
    endLoad(ok);
  }

  async function load() {
    let storeCtx;
    let pick;
    let data;
    try {
      storeCtx = await app.getStore();
      await storeCtx.access.load();
      if (disposed) return;
      pick = pickBook(storeCtx.access, params);
      if (pick.state === 'error') throw pick.error;
      if (pick.state !== 'ok') {
        stateBox('contact-form-notfound', t(pick.state === 'notfound' ? 'contacts.notfound.title' : 'contacts.nobook.title'), t(pick.state === 'notfound' ? 'contacts.notfound.text' : 'contacts.noaccess.text'), [h('a', { class: 'btn', href: '#/contacts', testid: 'btn-back-contacts' }, t('contacts.notfound.back'))]);
        return finish(true);
      }
      if (isReadOnlyBook(pick.book)) {
        stateBox('contact-form-readonly', t('contact.form.readonly.title'), t('contact.form.readonly.text'), [h('a', { class: 'btn', href: listHash(cleanQuery({ ab: params.ab })), testid: 'btn-back-contacts' }, t('contacts.notfound.back'))]);
        return finish(true);
      }
      data = createBookData({ storeCtx, session: app.session, book: pick.book, yieldFn: d.yieldFn });
      if (!data.store.loaded) {
        const res = await data.store.sync({ reason: 'load' });
        if (disposed) return;
        if (!res.ok && data.store.size === 0) throw res.error || res;
      }
      await data.refresh();
      if (disposed) return;
    } catch (e) {
      const kind = e && typeof e.kind === 'string' && !e.name ? e.kind : classify(e).kind;
      stateBox(d.isOnline() ? 'contacts-error' : 'contacts-offline', t(d.isOnline() ? 'contacts.error.title' : 'contacts.offline.title'), d.isOnline() ? t(davErrorKey(kind)) : t('contacts.offline.text'), [h('a', { class: 'btn', href: '#/contacts', testid: 'btn-back-contacts' }, t('contacts.notfound.back'))]);
      return finish(false);
    }
    const linkQuery = bookParams(pick.book, pick.books);
    let base = null;
    let summary = null;
    const restore = ctx.restore && ctx.restore.mode === (isNew ? 'new' : 'edit') ? ctx.restore : null;
    if (!isNew) {
      summary = resolveKey(params.key, data.all);
      const entry = summary && !summary.isGroup ? data.entry(summary.href) : null;
      if (!entry) {
        stateBox('contact-notfound', t('contact.notfound.title'), t('contact.notfound.text'), [h('a', { class: 'btn', href: listHash(cleanQuery(linkQuery)), testid: 'btn-back-contacts' }, t('contacts.notfound.back'))]);
        return finish(true);
      }
      // The version the user started from: after a language switch it is the one the first form opened with.
      base = restore && restore.base ? restore.base : { text: entry.text, etag: entry.etag };
      let r = null;
      try {
        r = app.openItem(base.text, 'contact');
      } catch {
        r = null;
      }
      const fid = storeCtx.writes.isReadOnly(entry.href);
      if (!r || !r.ok || r.readOnly || fid) {
        const why = !r || !r.ok ? (r && r.reason) || 'parse-error' : r.readOnly ? r.readOnlyReason : 'fidelity';
        stateBox('contact-form-readonly', t('contact.form.readonlyItem.title'), t('contact.readonly.lead') + ' ' + (t(`contact.readonly.${why}`) !== `contact.readonly.${why}` ? t(`contact.readonly.${why}`) : t('contact.readonly.unknown')), [h('a', { class: 'btn', href: contactHash(params.key, cleanQuery(linkQuery)), testid: 'btn-back-contact' }, t('contact.form.backToContact'))]);
        return finish(true);
      }
      F = buildForm({ storeCtx, pick, data, base, baseFields: r.fields(), summary, item: r, linkQuery, restore });
    } else {
      const versions = data.store.list().map((e) => (/^VERSION:\s*(\d\.\d)/im.exec(e.text) || [])[1] || '');
      const version = restore && restore.version ? restore.version : pickNewCardVersion(versions);
      F = buildForm({ storeCtx, pick, data, base: null, baseFields: emptyFields({ version }), summary: null, item: null, linkQuery, restore, version });
    }
    fill(body, F.el);
    if (restore && restore.form) restoreForm(F.el, restore.form);
    F.afterRestore();
    titleText = isNew ? t('contact.form.titleNew') : t('contact.form.titleEdit', { name: isolate(nameOf(summary, t)) });
    heading.textContent = titleText;
    finish(true);
    heading.focus();
  }

  // ---------------------------------------------------------------------------------------------------------

  function buildForm({ storeCtx, pick, data, base, baseFields, summary, item, linkQuery, restore, version }) {
    const book = pick.book;
    const v0 = toFormValues(baseFields);
    const writes = storeCtx.writes;
    const lossWarnings = isNew ? [] : serverLossWarnings(baseFields);
    const state = { busy: false, photoBusy: false, fnEdited: Boolean(restore && restore.fnEdited), photo: restore && restore.photo ? restore.photo : { action: 'keep', data: null }, bdayReplace: Boolean(restore && restore.bdayReplace), acceptLoss: false, retry: restore && restore.retry ? restore.retry : null, dirty: false };
    const pending = app.session && app.session.data ? app.session.data : null;
    const fields = new Map(); // test id -> {setError, focus}
    const uid = baseFields.uid || 'new';
    const shownName = () => (v0.fn || '').trim() || t('contacts.unnamed');

    const form = h('form', { class: 'form contact-form', novalidate: true, testid: 'contact-form', 'aria-labelledby': 'cf-title', 'aria-busy': 'false', 'data-mode': isNew ? 'new' : 'edit', 'data-version': baseFields.version });
    const errors = h('div', { class: 'form__errors', role: 'alert', tabindex: '-1', testid: 'form-errors', hidden: true });
    const live = h('p', { class: 'visually-hidden', role: 'status', testid: 'form-status' });
    const say = createAnnouncer({ apply: (x) => (live.textContent = x), ms: 800, timers: d.timers });

    // ------------------------------------------------------------------ photo
    const display = !isNew ? canDisplayPhoto(item) : { ok: false, reason: 'none' };
    const existing = display.ok ? { mime: display.mime, base64: display.base64 } : null;
    const note = !isNew && !display.ok && display.reason !== 'none' ? t(display.key) : '';
    const photo = createPhotoBlock({
      t,
      name: shownName(),
      uid,
      photo: existing,
      note,
      onFile: (file) => choosePhoto(file),
      onRemove: () => {
        state.photo = { action: 'remove', data: null };
        photo.set(null, v0.photo.present || state.photo.action !== 'keep' ? t('contact.photo.removed') : '');
        changed();
      },
    });
    if (state.photo.action === 'replace' && state.photo.data) photo.set({ mime: state.photo.data.mime, base64: state.photo.data.base64 }, t('contact.photo.readyShort'));
    else if (state.photo.action === 'remove') photo.set(null, t('contact.photo.removed'));

    async function choosePhoto(file) {
      state.photoBusy = true;
      photo.setBusy(true);
      photo.setStatus(t('contact.photo.working'));
      refreshSave();
      try {
        const out = await d.processPhoto(file, photoApiOf(d));
        if (disposed) return;
        state.photo = { action: 'replace', data: { mime: out.mime, base64: out.base64 } };
        photo.set({ mime: out.mime, base64: out.base64 }, t('contact.photo.ready', { width: out.width, height: out.height, kb: Math.max(1, Math.round(out.bytes / 1024)) }));
        changed();
      } catch (e) {
        photo.setStatus(t(e && e.key ? e.key : 'photo.err.decode-failed'));
      } finally {
        state.photoBusy = false;
        photo.setBusy(false);
        refreshSave();
      }
    }

    // ------------------------------------------------------------------ names
    const reg = (testid, f) => {
      fields.set(testid, f);
      return f;
    };
    const tf = (testid, label, value, extra = {}) => reg(testid, textField({ testid, label, value, ...extra }));
    const fFn = tf('field-fn', t('contact.field.fn'), v0.fn, { hint: t('contact.field.fnHint'), attrs: { maxlength: '1000' } });
    const fGiven = tf('field-given', t('contact.field.given'), v0.given);
    const fFamily = tf('field-family', t('contact.field.family'), v0.family);
    const fPrefix = tf('field-prefix', t('contact.field.prefix'), v0.prefix);
    const fAdditional = tf('field-additional', t('contact.field.additional'), v0.additional);
    const fSuffix = tf('field-suffix', t('contact.field.suffix'), v0.suffix);
    const moreName = h('details', { class: 'more', testid: 'name-more', open: Boolean(v0.prefix || v0.additional || v0.suffix) }, h('summary', { testid: 'name-more-toggle' }, t('contact.field.moreName')), h('div', { class: 'form__grid' }, fPrefix.el, fAdditional.el, fSuffix.el));
    const nickHint = v0.nicknameMore > 0 ? t('contact.field.nicknameMore', { n: v0.nicknameMore }) : t('contact.field.nicknameHint');
    const fNick = tf('field-nickname', t('contact.field.nickname'), v0.nickname, { hint: nickHint });
    const fOrg = tf('field-org', t('contact.field.org'), v0.org);
    const fDept = tf('field-department', t('contact.field.department'), v0.department, { hint: v0.orgMoreUnits > 0 ? t('contact.field.departmentMore', { n: v0.orgMoreUnits }) : undefined });
    const fTitle = tf('field-title', t('contact.field.title'), v0.title);
    const fNote = tf('field-note', t('contact.field.note'), v0.note, { input: 'textarea', attrs: { rows: '4' } });
    fFn.control.addEventListener('input', () => {
      state.fnEdited = true;
    });

    const parts = () => ({ prefix: fPrefix.control.value, given: fGiven.control.value, additional: fAdditional.control.value, family: fFamily.control.value, suffix: fSuffix.control.value });
    function followName() {
      if (state.fnEdited) return;
      // `fn` is left out on purpose: followFn then compares with the ORIGINAL name, so FN keeps following.
      fFn.control.value = followFn(baseFields, { ...parts(), fnEdited: false });
      photo.setName(fFn.control.value.trim() || shownName());
    }
    for (const f of [fPrefix, fGiven, fAdditional, fFamily, fSuffix]) f.control.addEventListener('input', followName);

    // ------------------------------------------------------------------ repeatable rows
    const reps = {};
    const typeOptions = (k) => TYPE_OPTIONS[k].map((x) => ({ value: x, label: t(`contact.type.${x}`) }));
    const blankOf = (k) => (k === 'adr' ? () => Object.fromEntries(ADR_PARTS.map((p) => [p.part, ''])) : () => ({ value: '' }));
    const rowsFor = (k, src) =>
      src.map((r) => ({ orig: r, type: r.typeSel, custom: r.label, pref: r.pref, values: k === 'adr' ? { ...r.value } : { value: r.value } }));
    const fieldDefs = (k, id) => {
      if (k === 'adr') {
        return ADR_PARTS.map((p) => ({
          name: p.part,
          label: t(`contact.field.adr.${p.id}`),
          input: p.part === 'street' || p.part === 'ext' ? 'textarea' : 'text',
          testid: `field-address-${p.id}`,
          more: !['street', 'code', 'locality', 'country'].includes(p.part),
        }));
      }
      return [{ name: 'value', label: t(`contact.field.${id}`), input: KINDS.find((x) => x.k === k).input, testid: `field-${id}-value`, attrs: k === 'tel' ? { inputmode: 'tel' } : {} }];
    };
    for (const { k, id } of KINDS) {
      // A restored form brings its own row structure (rows added, removed or edited before the language switch).
      let rows = rowsFor(k, v0[k]);
      if (restore && restore.rows && restore.rows[k]) {
        const byId = new Map(v0[k].map((r) => [r.id, r]));
        rows = restore.rows[k].map((r) => ({ orig: r.origId ? byId.get(r.origId) || null : null, type: r.type, custom: r.custom, pref: r.pref, values: { ...r.values } }));
      }
      const rep = createRepeatable({
        kind: id,
        t,
        labels: { legend: t(`contact.rows.${id}.legend`), row: t(`contact.rows.${id}.row`), add: t(`contact.rows.${id}.add`), remove: t(`contact.rows.${id}.remove`) },
        types: typeOptions(k),
        customValue: 'custom',
        fields: fieldDefs(k, id),
        rows,
        blank: blankOf(k),
        defaultType: DEFAULT_TYPE[k],
        max: MAX_ROWS,
        announce: (text) => say.flush(text),
        onChange: () => {
          changed();
          dupSoon();
        },
      });
      // rows restored as "new" carry no handle: mark them so the model sees them as additions
      reps[k] = rep;
    }
    const rowsValue = (k) =>
      reps[k].model.rows.map((r) => ({
        id: r.key,
        prop: r.orig ? r.orig.prop : null,
        value: k === 'adr' ? { ...r.values } : r.values.value ?? '',
        typeSel: r.type,
        label: r.custom,
        labelKey: r.orig ? r.orig.labelKey : null,
        pref: r.pref,
      }));

    // ------------------------------------------------------------------ dates
    const lock = (testid, label, text, why) => {
      const id = `${testid}-ro`;
      return h('div', { class: 'field', 'data-field': testid }, h('label', { class: 'field__label', for: id }, label), h('input', { class: 'input', id, type: 'text', readonly: true, value: text, testid, 'aria-describedby': `${id}-note` }), h('p', { class: 'field__hint', id: `${id}-note` }, why));
    };
    const dateField = (testid, label, value) => createDateField({ testid, label, t, lang, yearOptional: true, picker: true, value: value || null, firstWeekday: app.firstWeekday, now: d.now, onChange: () => changed(), onInput: () => changed() });
    let bdayField = null;
    let bdayBox;
    const bdayText = v0.bday.text;
    if (bdayText !== null) {
      const dateWrap = h('div', { class: 'datefield__replace', hidden: !state.bdayReplace });
      bdayField = dateField('field-bday', t('contact.field.bday'), null);
      dateWrap.append(bdayField.el);
      const replaceBtn = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-replace-bday', hidden: state.bdayReplace, on: { click: () => {
        state.bdayReplace = true;
        dateWrap.hidden = false;
        replaceBtn.hidden = true;
        bdayField.focus();
        changed();
      } } }, t('contact.field.bdayReplace'));
      bdayBox = h('div', { class: 'field' }, lock('field-bday-text', t('contact.field.bday'), bdayText, t('contact.field.bdayText')), replaceBtn, dateWrap);
    } else {
      bdayField = dateField('field-bday', t('contact.field.bday'), toWidget(v0.bday.date));
      bdayBox = bdayField.el;
    }
    let annField = null;
    let annBox;
    if (v0.anniversary.writable) {
      annField = dateField('field-anniversary', t('contact.field.anniversary'), toWidget(v0.anniversary.date));
      annBox = annField.el;
    } else {
      const shown = [v0.anniversary.date, ...v0.anniversary.others.map((o) => o.date)].filter(Boolean).map((x) => (x.year ? `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}` : `${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}`));
      const texts = v0.anniversary.others.filter((o) => o.text).map((o) => o.text);
      annBox = lock('field-anniversary', t('contact.field.anniversary'), [...shown, ...texts].join(', '), t('contact.field.anniversary3'));
    }
    if (bdayField) fields.set('field-bday', { setError: (m) => bdayField.setError(m), focus: () => bdayField.focus() });
    if (annField) fields.set('field-anniversary', { setError: (m) => annField.setError(m), focus: () => annField.focus() });

    // ------------------------------------------------------------------ categories
    const chips = createChips({ t, items: restore && restore.cats ? restore.cats : v0.categories, onChange: () => changed() });
    fields.set('field-categories', chips);

    // ------------------------------------------------------------------ duplicate hint (new contacts)
    const hint = h('p', { class: 'notice', role: 'status', testid: 'duplicate-hint', hidden: true });
    const dupSoon = isNew
      ? debounce(
          () => {
            if (disposed) return;
            const mine = { name: followNameValue(), emails: rowsValue('email').map((r) => String(r.value).trim()).filter(Boolean), phones: rowsValue('tel').map((r) => String(r.value).trim()).filter(Boolean), href: '', isGroup: false };
            const found = findDuplicates(mine, data.all).slice(0, 3);
            if (!found.length) {
              hint.hidden = true;
              clear(hint);
              return;
            }
            fill(hint, t('contact.duplicate.lead'), ' ', found.map((f, i) => [i ? ', ' : '', h('a', { href: contactHash(keyFor(f.summary, data.all), cleanQuery(linkQuery)), testid: 'duplicate-link' }, h('bdi', null, nameOf(f.summary, t)))]));
            hint.hidden = false;
          },
          350,
          d.timers,
        )
      : () => {};
    const followNameValue = () => fFn.control.value.trim();
    for (const f of [fFn, fGiven, fFamily]) f.control.addEventListener('input', () => dupSoon());

    // ------------------------------------------------------------------ collecting
    function collect() {
      const date = (field, replaceFlag, baseText) => {
        const p = field.parse();
        if (!p.ok) return { date: { invalid: true }, replace: replaceFlag, text: baseText };
        return { date: p.empty ? null : ymd(p.value), replace: replaceFlag, text: baseText };
      };
      const v = {
        fn: fFn.control.value,
        fnEdited: state.fnEdited,
        ...parts(),
        nickname: fNick.control.value,
        org: fOrg.control.value,
        department: fDept.control.value,
        title: fTitle.control.value,
        tel: rowsValue('tel'),
        email: rowsValue('email'),
        adr: rowsValue('adr'),
        url: rowsValue('url'),
        bday: date(bdayField, state.bdayReplace, bdayText),
        categories: chips.values(),
        note: fNote.control.value,
        photo: { action: state.photo.action, data: state.photo.data, present: v0.photo.present },
      };
      if (annField) v.anniversary = date(annField, true, null);
      return v;
    }

    // ------------------------------------------------------------------ dirty
    function computeDirty() {
      const v = collect();
      if (isNew) {
        const out = newCardPatch(v, { version: baseFields.version }).fields;
        return Object.keys(out).length > 0;
      }
      return !isEmptyPatch(toPatch(baseFields, v));
    }
    let dirtyQueued = false;
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
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);

    // ------------------------------------------------------------------ errors
    function clearErrors() {
      for (const f of fields.values()) f.setError(null);
      for (const r of Object.values(reps)) r.clearErrors();
      errors.hidden = true;
      clear(errors);
    }
    const labelOfError = (e) => {
      const m = /^field-(phone|email|address|url)-/.exec(e.testId);
      if (m && e.row !== undefined) return t(`contact.rows.${m[1]}.row`, { n: e.row + 1 });
      if (e.testId === 'field-categories') return t('contact.categories');
      const key = `contact.field.${e.testId.replace(/^field-/, '')}`;
      const text = t(key);
      return text === key ? '' : text;
    };
    function place(e, message) {
      const m = /^field-(phone|email|address|url)-([a-z]+)$/.exec(e.testId);
      if (m && e.row !== undefined) {
        const rep = reps[KINDS.find((x) => x.id === m[1]).k];
        const row = rep.model.rows[e.row];
        const name = m[1] === 'address' ? (m[2] === 'custom' ? 'custom' : ADR_NAME_OF[m[2]]) : m[2];
        if (row) {
          rep.setError(row.key, name, message);
          return { focus: () => rep.focusField(row.key, name) };
        }
      }
      const f = fields.get(e.testId);
      if (f) {
        f.setError(message);
        return { focus: () => f.focus() };
      }
      return { focus: () => errors.focus() };
    }
    function showErrors(list) {
      clearErrors();
      const items = list.map((e) => {
        const message = t(e.key, e.params);
        const where = place(e, message);
        const prefix = labelOfError(e);
        return { text: prefix ? `${prefix}: ${message}` : message, focus: where.focus };
      });
      fill(
        errors,
        h('p', { class: 'form__errors-title' }, tp('contact.form.errors', items.length, { n: items.length })),
        h('ul', null, items.map((it) => h('li', null, h('button', { type: 'button', class: 'linklike', testid: 'form-error-link', on: { click: () => it.focus() } }, it.text)))),
      );
      errors.hidden = false;
      if (items.length) items[0].focus();
    }
    function showFailure(res, extra = []) {
      clearErrors();
      fill(errors, h('p', { class: 'form__errors-title' }, t('contact.form.notSaved')), h('p', null, failureText(res, t)), ...extra);
      errors.hidden = false;
      errors.focus();
    }

    // ------------------------------------------------------------------ save
    const save = h('button', { type: 'submit', class: 'btn btn--primary', testid: 'contact-save', write: true }, isNew ? t('contact.form.create') : t('contact.form.save'));
    const cancel = h('a', { class: 'btn', href: isNew ? listHash(cleanQuery(linkQuery)) : contactHash(params.key, cleanQuery(linkQuery)), testid: 'contact-cancel' }, t('contact.form.cancel'));
    const fieldsets = h('fieldset', { class: 'form__fields' });
    function refreshSave() {
      save.disabled = state.busy || state.photoBusy;
      form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    }
    function waiting(on) {
      fieldsets.disabled = on;
      state.busy = on;
      refreshSave();
      if (on) say.flush(t('contact.form.saving'));
    }
    function lockFields(on) {
      fieldsets.disabled = on;
      save.textContent = on ? t('contact.form.retry') : isNew ? t('contact.form.create') : t('contact.form.save');
    }

    async function confirmLoss(lost) {
      return confirmDialog({
        testid: 'dialog-nickname-loss',
        title: t('contact.loss.title'),
        message: t('contact.loss.text', { values: lost.map((x) => isolate(x)).join(', ') }),
        confirmLabel: t('contact.loss.confirm'),
        cancelLabel: t('dialog.cancel'),
        danger: true,
        confirmTestid: 'dialog-confirm-loss',
        write: true,
        t,
        win: d.win,
      });
    }

    function leaveTo(hash) {
      state.dirty = false;
      app.setDirty(false);
      nav(hash);
    }
    const afterOk = (res) => {
      if (isNew || res.status === 'copied') leaveTo(contactHash(res.uid || params.key, cleanQuery(linkQuery)));
      else leaveTo(contactHash(params.key, cleanQuery(linkQuery)));
    };

    async function handle(res) {
      if (disposed) return null; // the screen was redrawn (language switch) or left: its successor owns the answer
      if (res && res.status === 'nickname-loss' && !state.acceptLoss) {
        if (!(await confirmLoss(res.lost || []))) return null;
        state.acceptLoss = true;
        return 'again';
      }
      if (!res) return null;
      if (res.ok && OK_STATUS.has(res.status)) {
        afterOk(res);
        return null;
      }
      if (res.status === 'conflict' && res.noop && (res.rows || []).length === 0) {
        // Nothing differs from what is on the server: the save already went through (a lost response).
        const done = writes.resolveReload(res);
        if (done.ok) {
          afterOk(done);
          return null;
        }
      }
      if (res.status === 'conflict' || res.status === 'deleted-elsewhere') {
        const out = await d.openConflictDialog({ conflict: res, t, writes, label: nameOf(summary, t) || undefined, feedback: app.feedback, win: d.win });
        if (out && out.ok) {
          if (out.status === 'discarded') leaveTo(listHash(cleanQuery(linkQuery)));
          else afterOk(out);
        }
        return null;
      }
      if (res.status === 'unknown-result' && isNew && res.retry) {
        state.retry = res.retry;
        lockFields(true);
      }
      if (res.status === 'fidelity') {
        showFailure(res, [res.exportText ? h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-export-contact', on: { click: () => exportRaw(res.exportText) } }, t('contact.export')) : null]);
        return null;
      }
      if (res.status === 'auth') return null;
      showFailure(res);
      return null;
    }

    function exportRaw(text) {
      const out = storeCtx.exportItem({ text, displayName: shownName(), kind: 'addressbook', target: uid });
      d.downloadText({ text: out.text, mime: out.mime, filename: out.filename, doc: d.doc, win: d.win });
    }

    async function submit() {
      if (state.busy || state.photoBusy) return;
      clearErrors();
      const v = collect();
      const check = validate(baseFields, v, { now: d.now() });
      const errs = [...check.errors];
      for (const [field, testId] of [[bdayField, 'field-bday'], [annField, 'field-anniversary']]) {
        if (field && !field.parse().ok && !errs.some((e) => e.testId === testId)) errs.push({ field: testId, testId, key: 'contact.err.date' });
        if (field && !field.parse().ok) field.validate();
      }
      if (errs.length) {
        showErrors(errs);
        return;
      }
      let patch = null;
      if (!isNew) {
        patch = toPatch(baseFields, v);
        if (isEmptyPatch(patch)) {
          app.feedback.setStatus(t('store.status.unchanged'));
          say.flush(t('store.status.unchanged'));
          return;
        }
      }
      if (lossWarnings.length && !state.acceptLoss) {
        if (!(await confirmLoss(lossWarnings[0].lost))) return;
        state.acceptLoss = true;
      }
      state.busy = true;
      refreshSave();
      say.flush(t('contact.form.saving'));
      try {
        for (let round = 0; round < 3; round += 1) {
          let res;
          if (isNew) {
            const card = newCardPatch(v, { version: baseFields.version });
            const rec = { done: false, result: null, waiters: new Set() };
            if (pending) pending.set(PENDING_KEY, rec);
            res = await writes.createItem({ collection: book.href, fields: card.fields, version: baseFields.version, retry: state.retry || null, acceptNicknameLoss: state.acceptLoss });
            rec.done = true;
            rec.result = res;
            for (const fn of [...rec.waiters]) fn(res);
            rec.waiters.clear();
            if (disposed) return;
          } else {
            res = await writes.saveItem({ collection: book.href, href: summary.href, patch, base, baseFields, acceptNicknameLoss: state.acceptLoss });
          }
          const next = await handle(res);
          if (next !== 'again') break;
        }
      } catch {
        // Nothing may fail silently: a persistent text says what happened and that the card should be checked.
        if (!disposed) {
          const message = t('contact.form.unexpected');
          app.feedback.setAlert(message, { scope: null });
          showFailure({ message });
        }
      } finally {
        state.busy = false;
        if (!disposed) {
          refreshSave();
          // A disabled Save loses the focus to <body> (and a closed dialog cannot give it back): put it on Save again.
          const active = d.doc && d.doc.activeElement;
          if (!save.disabled && (!active || active === d.doc.body)) save.focus();
        }
      }
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });

    const dateBlock = h('div', { class: 'form__grid' }, bdayBox, annBox);
    fill(
      fieldsets,
      photo.el,
      h('div', { class: 'form__grid' }, fGiven.el, fFamily.el),
      fFn.el,
      moreName,
      h('div', { class: 'form__grid' }, fNick.el, fOrg.el, fDept.el, fTitle.el),
      hint,
      ...KINDS.map((x) => reps[x.k].el),
      dateBlock,
      chips.el,
      fNote.el,
      h('p', { class: 'meta-line' }, t('contact.form.versionKept', { version: baseFields.version })),
    );
    fill(form, errors, live, fieldsets, h('div', { class: 'form__actions' }, cancel, save));
    refreshSave();

    return {
      el: form,
      afterRestore() {
        followName();
        if (restore && restore.fn !== undefined && state.fnEdited) fFn.control.value = restore.fn;
        if (state.retry) lockFields(true);
        // A create that was in flight when the screen was redrawn: wait for ITS answer instead of sending a second one.
        const rec = restore && restore.pendingCreate && pending ? pending.get(PENDING_KEY) : null;
        if (rec) {
          const adopt = (res) => {
            if (pending.get(PENDING_KEY) === rec) pending.delete(PENDING_KEY);
            waiting(false);
            return handle(res);
          };
          if (rec.done) adopt(rec.result);
          else {
            waiting(true);
            rec.waiters.add(adopt);
          }
        }
        changed();
      },
      snapshot() {
        const rows = {};
        for (const { k } of KINDS) {
          rows[k] = reps[k].model.rows.map((r) => ({ origId: r.orig ? r.orig.id : null, type: r.type, custom: r.custom, pref: r.pref, values: { ...r.values } }));
        }
        return { mode: isNew ? 'new' : 'edit', base, version: baseFields.version, form: snapshotForm(form), rows, cats: chips.values(), photo: state.photo, fnEdited: state.fnEdited, fn: fFn.control.value, bdayReplace: state.bdayReplace, retry: state.retry, pendingCreate: isNew && state.busy };
      },
      dispose() {
        dupSoon.cancel && dupSoon.cancel();
        say.cancel();
        data.dispose();
      },
      // exposed for tests
      state,
      collect,
      reps,
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
      clear(root);
      root.remove();
    },
    // exposed for tests
    get form() {
      return F;
    },
  };
}
