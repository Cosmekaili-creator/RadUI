// SPDX-License-Identifier: AGPL-3.0-or-later
// Create a calendar or an address book, and edit one (`#/collections/new-calendar`, `/new-addressbook`,
// `/edit?href=`). Edit changes the display name, description and colour only: the components and the URL
// segment are fixed after creation (the form says so). Every write goes through the store's `writes`.
//
// Test ids: calendar-form / addressbook-form, field-coll-name, field-coll-slug (under Advanced),
// field-coll-desc, field-color (colour-<id> radios, field-color-custom), field-components (component-vevent,
// component-vtodo), private-notice, rename-note, collection-save, collection-cancel, form-errors,
// collection-denied, collection-notfound, btn-back-collections.

import { collectionForParam } from '../../router.js';
import { clear, formField, h, restoreForm, snapshotForm } from '../../ui.js';
import { isolate } from '../../widgets/avatar.js';
import { COLOUR_ALLOW, CUSTOM_COLOUR_RE, DEFAULT_COLOUR_ID, MAX_DESCRIPTION, PALETTE, checkDisplayName, checkSlug, displayNameTaken, ensureAlert, ensureStatus, generateSlug, labelOf, leafOfHref, paletteFor, slugTaken, slugify, typeOf } from './model.js';

const MODES = { 'collection-new-calendar': 'calendar', 'collection-new-addressbook': 'book', 'collection-edit': 'edit' };

/** Same colour, ignoring case and a trailing alpha byte that one side lacks. */
export function sameColour(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (x === y) return true;
  if (x.length === 9 && y.length === 7) return x.slice(0, 7) === y;
  if (y.length === 9 && x.length === 7) return y.slice(0, 7) === x;
  return false;
}

const lf = (s) => String(s ?? '').replace(/\r\n?/g, '\n');

export function mount(ctx) {
  let view = buildScreen(ctx);
  return {
    get title() {
      return view.title;
    },
    update(next) {
      view.dispose();
      clear(next.root);
      view = buildScreen(next);
    },
    snapshot: () => view.snapshot(),
    dispose: () => view.dispose(),
  };
}

function buildScreen(ctx) {
  const { root, t, tp, app, signal } = ctx;
  const route = ctx.route || {};
  const mode = MODES[route.name] || 'calendar';
  const editing = mode === 'edit';
  const isBook = mode === 'book';
  const feedback = app.feedback;
  let store = null;
  let target = null; // the collection being edited
  let disposed = false;
  let saving = false;
  let slugTouched = false;
  let form = null;
  let initial = null;
  const title = editing ? t('coll.editTitleGeneric') : isBook ? t('coll.newAddressbook') : t('coll.newCalendar');

  const holder = h('div', { class: 'form-holder' }, h('p', { class: 'muted', testid: 'collection-form-loading' }, t('coll.loading')));
  const screenEl = h(
    'section',
    { class: 'collection-form-screen', testid: 'collection-form-screen', 'data-state': 'loading', 'aria-busy': 'true', 'aria-labelledby': 'collform-title' },
    h('a', { class: 'btn btn--quiet', href: '#/collections', testid: 'btn-back' }, t('coll.back')),
    h('h1', { class: 'page-title', id: 'collform-title', tabindex: '-1' }, title),
    holder,
  );
  root.append(screenEl);
  const setState = (s) => {
    screenEl.setAttribute('data-state', s);
    screenEl.setAttribute('aria-busy', s === 'loading' ? 'true' : 'false');
  };

  function showPanel(testid, key) {
    form = null;
    clear(holder);
    holder.append(h('div', { class: 'notice notice--warn', testid }, h('p', null, t(key)), h('a', { class: 'btn', href: '#/collections', testid: 'btn-back-collections' }, t('nav.collections'))));
    app.setDirty(false);
    setState('ready');
  }

  // ------------------------------------------------------------------ form
  function renderForm() {
    clear(holder);
    const c = target;
    // `initial` is what the form DISPLAYS. In edit mode nothing is invented: a calendar without a colour has none, so an
    // untouched form never writes the default palette colour. The description is shown as a textarea shows it (LF).
    initial = {
      name: c ? c.displayName || '' : '',
      desc: c ? lf(c.description || '') : '',
      colour: c ? c.color || null : isBook ? null : PALETTE.find((p) => p.id === DEFAULT_COLOUR_ID).hex,
      // `?components=VTODO` (the "Create a task list" button of the Tasks screen) starts with tasks ticked
      components: !editing && !isBook && ctx.params && ctx.params.components === 'VTODO' ? ['VTODO'] : ['VEVENT'],
    };
    const hasColour = editing ? c.kind === 'calendar' : !isBook;
    const bookLike = editing ? c.kind === 'addressbook' : isBook;

    const nameInput = h('input', { type: 'text', class: 'input', autocomplete: 'off', 'data-autofocus': '' });
    nameInput.value = initial.name;
    const nameF = formField({ id: 'coll-name', label: t('coll.field.name'), control: nameInput, hint: editing && !c.displayName ? t('coll.field.nameNone', { name: isolate(leafOfHref(c.href)) }) : t('coll.field.nameHint'), testid: 'field-coll-name' });
    nameInput.setAttribute('aria-required', 'true');

    const descInput = h('textarea', { class: 'input input--area', rows: '3' });
    descInput.value = initial.desc;
    const descF = formField({ id: 'coll-desc', label: t('coll.field.description'), control: descInput, hint: t('coll.field.descriptionHint'), testid: 'field-coll-desc' });

    // colour (calendars)
    let colourBox = null;
    let colourErr = null;
    let customInput = null;
    let customF = null;
    const radios = [];
    if (hasColour) {
      const match = initial.colour ? paletteFor(initial.colour) : null;
      const swatches = PALETTE.map((p) => {
        const radio = h('input', { type: 'radio', name: 'collection-colour', value: p.hex, testid: `colour-${p.id}` });
        radio.checked = match ? match.id === p.id : false;
        radios.push(radio);
        return h('label', { class: 'swatch' }, radio, h('span', { class: 'swatch__chip', 'aria-hidden': 'true', vars: { allow: COLOUR_ALLOW, values: { '--cal': p.hex } } }), h('span', { class: 'swatch__name' }, t(`colour.${p.id}`)));
      });
      customInput = h('input', { type: 'text', class: 'input input--compact', autocomplete: 'off', spellcheck: 'false', maxlength: '9', placeholder: '#RRGGBB' });
      customInput.value = initial.colour && !match && COLOUR_ALLOW.test(initial.colour) ? initial.colour : '';
      customF = formField({ id: 'coll-colour-custom', label: t('coll.field.colourCustom'), control: customInput, hint: t('coll.field.colourCustomHint'), testid: 'field-color-custom' });
      colourErr = h('p', { class: 'field__error', hidden: true, id: 'coll-colour-error', testid: 'field-color-error' });
      colourBox = h('fieldset', { class: 'fieldset', testid: 'field-color', 'aria-describedby': 'coll-colour-error' }, h('legend', { class: 'fieldset__legend' }, t('coll.field.colour')), h('div', { class: 'swatches' }, swatches), customF.el, colourErr);
      for (const r of radios) r.addEventListener('change', () => (customInput.value = ''));
      customInput.addEventListener('input', () => {
        if (customInput.value.trim()) for (const r of radios) r.checked = false;
      });
    }

    // components (new calendars)
    let compBox = null;
    let compErr = null;
    const compInputs = {};
    if (!editing && !isBook) {
      compErr = h('p', { class: 'field__error', hidden: true, id: 'coll-components-error', testid: 'field-components-error' });
      const row = (comp, label) => {
        const input = h('input', { type: 'checkbox', value: comp, testid: `component-${comp.toLowerCase()}` });
        input.checked = initial.components.includes(comp);
        compInputs[comp] = input;
        return h('label', { class: 'check' }, input, h('span', null, label));
      };
      compBox = h('fieldset', { class: 'fieldset', testid: 'field-components', 'aria-describedby': 'coll-components-error' }, h('legend', { class: 'fieldset__legend' }, t('coll.field.components')), row('VEVENT', t('coll.comp.VEVENT')), row('VTODO', t('coll.comp.VTODO')), h('p', { class: 'field__hint' }, t('coll.field.componentsHint')), compErr);
    }

    // technical name
    let slugInput = null;
    let slugF = null;
    let advanced = null;
    if (!editing) {
      slugInput = h('input', { type: 'text', class: 'input', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      slugF = formField({ id: 'coll-slug', label: t('coll.field.slug'), control: slugInput, hint: t('coll.field.slugHint'), testid: 'field-coll-slug' });
      advanced = h('details', { class: 'collform__advanced', testid: 'collection-advanced' }, h('summary', { testid: 'collection-advanced-toggle' }, t('coll.field.advanced')), slugF.el);
      nameInput.addEventListener('input', () => {
        if (!slugTouched) slugInput.value = slugify(nameInput.value);
      });
      slugInput.addEventListener('input', () => {
        slugTouched = slugInput.value !== slugify(nameInput.value);
      });
    }

    const errorsBox = h('div', { class: 'notice notice--warn', testid: 'form-errors', tabindex: '-1', hidden: true });
    const saveBtn = h('button', { type: 'submit', class: 'btn btn--primary', testid: 'collection-save', write: true }, editing ? t('coll.save') : isBook ? t('coll.createBook') : t('coll.createCal'));
    const kids = [
      errorsBox,
      nameF.el,
      descF.el,
      colourBox,
      compBox,
      editing ? h('p', { class: 'muted small', testid: 'coll-components-fixed' }, t('coll.componentsFixed', { type: t(`coll.type.${typeOf(c)}`) })) : null,
      advanced,
      editing
        ? h('div', { class: 'notice notice--quiet', testid: 'rename-note' }, h('p', null, t('coll.renameNote')), h('p', { class: 'small' }, t('coll.technicalName'), ' ', h('code', { testid: 'coll-technical' }, leafOfHref(c.href))))
        : h('aside', { class: 'notice', testid: 'private-notice' }, t('coll.privateNotice')),
      h('div', { class: 'form__actions' }, h('a', { class: 'btn', href: '#/collections', testid: 'collection-cancel' }, t('coll.cancel')), saveBtn),
    ];
    form = h('form', { class: 'form form--narrow', novalidate: true, testid: bookLike ? 'addressbook-form' : 'calendar-form', 'aria-label': title }, kids);
    holder.append(form);

    // ------------------------------------------------------------ helpers
    const readColour = () => {
      if (!hasColour) return { value: null };
      const typed = customInput.value.trim();
      if (typed) {
        if (CUSTOM_COLOUR_RE.test(typed) || (initial.colour && sameColour(typed, initial.colour) && COLOUR_ALLOW.test(typed))) return { value: typed };
        return { error: true };
      }
      const r = radios.find((x) => x.checked);
      return { value: r ? r.value : editing ? initial.colour : null };
    };
    const selectedComponents = () => Object.entries(compInputs).filter(([, i]) => i.checked).map(([k]) => k);
    const dirty = () => {
      if (nameInput.value.trim() !== initial.name.trim() || lf(descInput.value) !== initial.desc) return true;
      if (!editing && (slugInput.value !== '' && slugTouched)) return true;
      if (hasColour) {
        const col = readColour();
        if (col.error || !sameColour(col.value, initial.colour)) return true;
      }
      if (compBox && selectedComponents().join() !== initial.components.join()) return true;
      return false;
    };
    const updateDirty = () => app.setDirty(dirty());
    form.addEventListener('input', updateDirty);
    form.addEventListener('change', updateDirty);

    const fields = [nameF, descF, slugF, customF].filter(Boolean);
    const clearErrors = () => {
      for (const f of fields) f.setError(null);
      if (colourErr) {
        colourErr.hidden = true;
        colourErr.textContent = '';
      }
      if (compErr) {
        compErr.hidden = true;
        compErr.textContent = '';
      }
      errorsBox.hidden = true;
      clear(errorsBox);
    };
    const showErrors = (errs) => {
      if (errs.some((e) => e.field === slugF)) advanced.open = true;
      for (const e of errs) {
        if (e.field === 'colour') {
          colourErr.textContent = e.message;
          colourErr.hidden = false;
        } else if (e.field === 'components') {
          compErr.textContent = e.message;
          compErr.hidden = false;
        } else if (e.field === 'form') {
          /* only in the summary */
        } else e.field.setError(e.message);
      }
      fill(errorsBox, errs);
      const first = errs.find((e) => e.field !== 'form');
      ensureAlert(feedback, tp('coll.err.summary', errs.length));
      const focusEl = !first ? errorsBox : first.field === 'colour' ? radios[0] || customInput : first.field === 'components' ? Object.values(compInputs)[0] : first.field.control;
      if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
    };
    function fill(box, errs) {
      clear(box);
      box.append(h('p', { class: 'notice__title' }, tp('coll.err.summary', errs.length)), h('ul', null, errs.map((e) => h('li', null, e.message))));
      box.hidden = false;
    }

    function validate() {
      const errs = [];
      const name = nameInput.value;
      const bad = checkDisplayName(name);
      if (bad) errs.push({ field: nameF, message: t(`coll.err.name.${bad}`, { max: 100 }) });
      else if (displayNameTaken(name, store.access.list(), { except: editing ? c.href : null })) errs.push({ field: nameF, message: t('coll.err.nameTaken') });
      if (descInput.value.length > MAX_DESCRIPTION) errs.push({ field: descF, message: t('coll.err.descLong', { max: MAX_DESCRIPTION }) });
      let slug = null;
      if (!editing) {
        const prefix = isBook ? 'addressbook' : 'calendar';
        const typed = slugInput.value.trim();
        slug = slugTouched && typed ? typed : generateSlug(name, { prefix });
        const sb = checkSlug(slug);
        if (sb) errs.push({ field: slugF, message: t(`coll.err.slug.${sb}`) });
        else if (slugTaken(slug, store.access.list())) errs.push({ field: slugTouched && typed ? slugF : nameF, message: t(slugTouched && typed ? 'coll.err.slugTaken' : 'coll.err.slugTakenAuto') });
      }
      const col = readColour();
      if (col.error) errs.push({ field: 'colour', message: t('coll.err.colour') });
      if (compBox && selectedComponents().length === 0) errs.push({ field: 'components', message: t('coll.err.components') });
      return { errs, slug, col };
    }

    function applyStoreFailure(res, slugWasTyped) {
      const text = res.message || t('coll.err.generic');
      if (res.status === 'exists') {
        const f = slugWasTyped ? slugF : nameF;
        f.setError(t(slugWasTyped ? 'coll.err.slugTaken' : 'coll.err.exists'));
        if (!slugWasTyped && advanced) advanced.open = true;
        f.control.focus();
      } else if (res.status === 'invalid' && slugF && ['pattern', 'reserved', 'empty', 'tilde'].includes(res.reason)) {
        slugF.setError(t(`coll.err.slug.${res.reason}`));
        advanced.open = true;
        slugF.control.focus();
      } else {
        clear(errorsBox);
        errorsBox.append(h('p', null, text));
        errorsBox.hidden = false;
        errorsBox.focus();
      }
      if (res.status !== 'auth') ensureAlert(feedback, text);
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (saving) return;
      clearErrors();
      const { errs, slug, col } = validate();
      if (errs.length) return showErrors(errs);
      const name = nameInput.value.trim();
      const desc = descInput.value;
      saving = true;
      saveBtn.disabled = true;
      form.setAttribute('aria-busy', 'true');
      const end = app.readiness.begin();
      let res;
      try {
        res = editing ? await saveEdit(name, desc, col) : await saveNew(name, desc, slug, col);
      } catch {
        res = { ok: false, status: 'error', message: t('coll.err.generic') };
      }
      if (disposed) return end(true);
      saving = false;
      saveBtn.disabled = false;
      form.removeAttribute('aria-busy');
      end(res.ok);
      if (res.ok) {
        app.setDirty(false);
        const msg = res.status === 'unchanged' ? t('store.status.unchanged') : editing ? t('coll.saved', { name: isolate(name) }) : t('coll.createdPrivate', { name: isolate(name) });
        ensureStatus(feedback, msg);
        app.navigate('#/collections');
        return;
      }
      applyStoreFailure(res, !editing && slugTouched && slugInput.value.trim() !== '');
      if (editing && res.status === 'forbidden' && !store.access.canManage(c.href)) showPanel('collection-denied', 'coll.notAllowed');
    });

    async function saveNew(name, desc, slug, col) {
      const homes = await store.access.homeSets();
      const home = isBook ? homes.addressbookHomes[0] : homes.calendarHomes[0];
      const { mkcol, mkcalendar } = store.writes;
      const description = desc.trim() === '' ? undefined : desc;
      if (isBook) return mkcol({ home, name: slug, displayName: name, description });
      return mkcalendar({ home, name: slug, displayName: name, color: col.value || undefined, description, components: selectedComponents() });
    }

    // Each property is compared with what the form displayed (`initial`) and sent only when the person changed it.
    async function saveEdit(name, desc, col) {
      const changes = {};
      if (name.trim() !== initial.name.trim()) changes.displayName = name.trim();
      if (lf(desc) !== initial.desc) changes.description = desc.trim() === '' ? null : lf(desc);
      if (hasColour && col.value && !sameColour(col.value, initial.colour)) changes.color = col.value;
      if (!Object.keys(changes).length) return { ok: true, status: 'unchanged' };
      const { proppatch } = store.writes;
      return proppatch({ href: c.href, kind: c.kind, changes });
    }

    const api = { nameInput, descInput, slugInput, customInput, radios, compInputs, saveBtn, updateDirty, setSlugTouched: (v) => (slugTouched = v) };
    return api;
  }

  // ------------------------------------------------------------------ start
  (async () => {
    const end = app.readiness.begin();
    try {
      store = await app.getStore();
      await store.access.load();
    } catch (e) {
      if (disposed || signal.aborted) return end(true);
      if (e && e.kind === 'auth') return end(true);
      clear(holder);
      holder.append(h('div', { class: 'notice notice--warn', testid: 'collections-error' }, t('coll.error')));
      setState('error');
      return end(false);
    }
    if (disposed || signal.aborted) return end(true);
    if (editing) {
      target = collectionForParam(route.query ? route.query.href : (route.params || {}).href, store.access.list());
      if (!target) {
        showPanel('collection-notfound', 'coll.notFound');
        return end(true);
      }
      if (target.level !== 'own') {
        showPanel('collection-denied', 'coll.notAllowed');
        return end(true);
      }
      screenEl.querySelector('#collform-title').textContent = t('coll.editTitle', { name: isolate(labelOf(target)) });
    } else if (!store.access.canCreateCollections()) {
      showPanel('collection-denied', 'coll.ownSpaceOff');
      return end(true);
    }
    const handles = renderForm();
    if (ctx.restore) {
      restoreForm(form, ctx.restore);
      handles.setSlugTouched(!editing && handles.slugInput.value !== slugify(handles.nameInput.value));
      handles.updateDirty();
    }
    setState('ready');
    end(true);
    if (handles.nameInput && typeof handles.nameInput.focus === 'function' && !ctx.restore) handles.nameInput.focus();
  })();

  return {
    title,
    snapshot: () => (form ? snapshotForm(form) : null),
    dispose() {
      disposed = true;
    },
  };
}
