// SPDX-License-Identifier: AGPL-3.0-or-later
// The import dialog for address books (.vcf) and for calendars and task lists (.ics, RUN3 C2): the same structure and
// test ids, the texts and the planner differ by kind.
//
//   openImportDialog({ctx, collectionHref, kind}) -> Promise<{done: boolean, report?: object}>   (promise.dialog = controller)
//
// `collectionHref` presets the target; the kind follows that collection ('calendar' or 'addressbook'). Without a preset
// `kind` ('addressbook' by default) says which writable collections the person chooses among. Calendar texts are the
// same keys with a `.cal` suffix. The file is
// decoded as UTF-8 only, the target is read in full before the plan is made (so duplicates are known), the
// preview lists every card with its state and reasons, and nothing is sent until "Import N items" is pressed.
// The run is `store.startImport` (three requests at a time, cancel after the requests in flight, a per-item
// report). Replacing an existing card with one the server would damage needs an explicit, listed confirmation.
//
// Test ids: dialog-import, field-import-target, field-import-file (the hidden native input), btn-choose-file, import-file-name,
// import-status, import-error, import-preview,
// import-row (data-state), btn-import-more, import-policy (policy-skip, policy-replace, policy-keep),
// import-lossy (import-lossy-confirm), import-summary, dialog-import-confirm, import-progress, btn-import-cancel,
// import-report, import-report-row (data-result), dialog-cancel; calendar kind: import-report-notes.

import { clear, formField, h, openDialog } from '../ui.js';
import { uniqueId } from '../widgets/fieldkit.js';
import { createProgress } from '../widgets/progress.js';
import { isolate } from '../widgets/avatar.js';
import { labelOf, leafOfHref } from './collections/model.js';

const ROWS_FIRST = 100;
const ROWS_MORE = 250;
const POLICY_VALUE = { skip: 'skip', replace: 'replace', keep: 'keep-both' };
const STATE_TAG = { new: 'tag--ok', duplicate: 'tag--warn', invalid: 'tag--warn', unsupported: 'tag--warn', 'file-duplicate': 'tag--quiet' };

/** The likely encoding of bytes that are not UTF-8 (a name for the message; it is a guess). */
export function guessEncoding(buffer) {
  const b = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return 'UTF-16';
  let zeros = 0;
  const probe = Math.min(b.length, 400);
  for (let i = 0; i < probe; i++) if (b[i] === 0) zeros++;
  if (probe > 0 && zeros / probe > 0.3) return 'UTF-16';
  return 'ISO-8859-1 / Windows-1252';
}

const looksLikeCalendar = (text, name) => (/\.ics$/i.test(name || '') || /^\s*BEGIN:VCALENDAR/im.test(text)) && !/^\s*BEGIN:VCARD/im.test(text);
const looksLikeContacts = (text, name) => (/\.vcf$/i.test(name || '') || /^\s*BEGIN:VCARD/im.test(text)) && !/^\s*BEGIN:VCALENDAR/im.test(text);

async function loadLibs() {
  const [plan, ics, run, idx] = await Promise.all([import('../model/importplan.js'), import('../model/importics.js'), import('../store/importrun.js'), import('../contacts/index.js')]);
  return { planImport: plan.planImport, planIcsImport: plan.planIcsImport, calendarUidOf: ics.calendarUidOf, resolveImport: plan.resolveImport, LIMITS: plan.LIMITS, decodeUtf8File: run.decodeUtf8File, summarize: idx.summarize };
}

const norm = (href) => (String(href).endsWith('/') ? String(href) : `${href}/`);

/**
 * @param {object} o
 * @param {object} o.ctx {app, t, tp}; `app.getStore()` gives the store context
 * @param {string|null} [o.collectionHref]
 * @param {'addressbook'|'calendar'} [o.kind] the kind to import into when there is no preset collection
 * @param {object} [o.libs] injected model functions (tests)
 * @param {object} [o.win]
 */
export function openImportDialog({ ctx, collectionHref = null, kind: openKind = 'addressbook', libs = null, win } = {}) {
  let controller = null;
  const promise = run();
  Object.defineProperty(promise, 'dialog', { get: () => controller });
  return promise;

  async function run() {
    const { app, t, tp } = ctx;
    const store = await app.getStore();
    await store.access.load();
    const L = libs || (await loadLibs());
    const pre = collectionHref && store.access.get ? store.access.get(collectionHref) : null;
    const kind = (pre && pre.kind) || openKind;
    const isCal = kind === 'calendar';
    // Calendar texts are the same keys with a `.cal` suffix; a missing one falls back to the contacts text.
    const tk = (key, p) => {
      if (isCal) {
        const s = t(`${key}.cal`, p);
        if (s !== `${key}.cal`) return s;
      }
      return t(key, p);
    };
    const targets = store.access.writable(kind);
    const preset = collectionHref ? targets.find((c) => norm(c.href) === norm(collectionHref)) : null;

    let phase = 'pick'; // pick | planning | preview | running | done
    let seq = 0;
    let fileText = null;
    let fileName = '';
    let plan = null;
    let shown = 0;
    let handle = null;
    let report = null;
    let progress = null;
    let resolveDone;
    const finished = new Promise((r) => (resolveDone = r));

    // ---------------------------------------------------------------- elements
    const uid = uniqueId('import'); // element ids are per dialog, so two dialogs in one document never share an id
    const select = h('select', { class: 'input' });
    for (const c of targets) select.append(h('option', { value: c.href }, labelOf(c)));
    select.value = (preset || targets[0] || { href: '' }).href;
    const targetF = formField({ id: `${uid}-target`, label: t('import.field.target'), control: select, testid: 'field-import-target' });
    // The native input stays in the page (visually hidden, focusable, keeps its test id and its accessible name from the field
    // label); the visible control is a label styled as a button with a translated file-name text, so no browser text shows.
    const fileInput = h('input', { type: 'file', class: 'input--file-native', accept: isCal ? '.ics,text/calendar' : '.vcf,text/vcard,text/x-vcard' });
    const fileF = formField({ id: `${uid}-file`, label: tk('import.field.file'), control: fileInput, hint: tk('import.field.fileHint', { mb: Math.round(L.LIMITS.fileBytes / 1048576), items: L.LIMITS.items }), testid: 'field-import-file' });
    const fileLabelEl = fileF.el.querySelector('label');
    fileLabelEl.id = `${uid}-file-label`;
    fileInput.setAttribute('aria-labelledby', `${uid}-file-label`); // the name stays the field label; the button label does not add to it
    const fileNameEl = h('span', { class: 'file-pick__name', id: `${uid}-file-name`, testid: 'import-file-name' }, t('import.noFileChosen'));
    fileInput.setAttribute('aria-describedby', `${uid}-file-name ${fileInput.getAttribute('aria-describedby') || ''}`.trim());
    const fileButton = h('label', { class: 'btn file-pick__btn', for: `${uid}-file`, testid: 'btn-choose-file' }, t('import.chooseFile'));
    const filePick = h('div', { class: 'file-pick' }, fileInput, fileButton, fileNameEl);
    const fileFieldEl = h('div', { class: 'field' }, fileLabelEl, filePick, fileF.el.querySelector('.field__hint'), fileF.el.querySelector('.field__error'));
    const showFileName = (name) => {
      fileNameEl.textContent = name ? isolate(name) : t('import.noFileChosen');
      fileNameEl.classList.toggle('file-pick__name--set', !!name);
    };
    const statusEl = h('p', { class: 'field__hint', role: 'status', testid: 'import-status' });
    const errorEl = h('p', { class: 'notice notice--warn', role: 'alert', testid: 'import-error', hidden: true });
    const noteEl = h('p', { class: 'notice notice--quiet', testid: 'import-note', hidden: true });
    const previewEl = h('div', { class: 'import__preview', testid: 'import-preview', 'aria-live': 'polite' });
    const radios = {};
    const policyBox = h('fieldset', { class: 'fieldset', testid: 'import-policy', hidden: true }, h('legend', { class: 'fieldset__legend' }, tk('import.policy')));
    for (const k of ['skip', 'replace', 'keep']) {
      const r = h('input', { type: 'radio', name: 'import-policy', value: k, testid: `policy-${k}` });
      r.checked = k === 'skip';
      radios[k] = r;
      policyBox.append(h('label', { class: 'radio radio--block' }, r, h('span', null, h('strong', null, t(`import.policy.${k}`)), ' ', h('span', { class: 'muted' }, tk(`import.policyHelp.${k}`)))));
    }
    const lossyBox = h('fieldset', { class: 'fieldset', testid: 'import-lossy', hidden: true });
    const summaryEl = h('p', { class: 'import__summary', testid: 'import-summary' });
    const runEl = h('div', { class: 'import__run', testid: 'import-run', hidden: true });
    const reportEl = h('div', { class: 'import__report', testid: 'import-report', hidden: true });
    const noTarget = h('p', { class: 'notice notice--warn', testid: 'import-no-target' }, tk('import.noTarget'));

    const body = targets.length
      ? [h('div', { class: 'import__pick' }, targetF.el, fileFieldEl), preset || !collectionHref ? null : h('p', { class: 'notice notice--quiet', testid: 'import-target-note' }, tk('import.targetNotWritable')), statusEl, errorEl, noteEl, previewEl, policyBox, lossyBox, summaryEl, runEl, reportEl]
      : [noTarget];

    const ctrl = openDialog({
      testid: 'dialog-import',
      title: tk('import.title'),
      description: tk('import.text'),
      body,
      focus: targets.length ? fileInput : 'cancel',
      win,
      actions: [
        { testid: 'dialog-cancel', label: t('import.cancel'), cancel: true },
        ...(targets.length ? [{ testid: 'dialog-import-confirm', label: t('import.go.zero'), kind: 'primary', disabled: true, write: true, onClick: () => (start(), false) }] : []),
      ],
      onClose: () => {
        if (handle && phase === 'running') handle.cancel();
        resolveDone({ done: phase === 'done', report });
      },
    });
    controller = ctrl;
    ctrl.dialog.classList.add('dialog--import');
    ctrl.dialog.addEventListener('cancel', (e) => {
      if (phase === 'running') e.preventDefault();
    });
    const confirmBtn = ctrl.buttons['dialog-import-confirm'] || null;
    const closeBtn = ctrl.buttons['dialog-cancel'];

    // ------------------------------------------------------------------- helpers
    const setStatus = (text) => (statusEl.textContent = text || '');
    const clearError = () => {
      errorEl.textContent = '';
      errorEl.hidden = true;
    };
    function showError(text) {
      setStatus('');
      errorEl.textContent = text;
      errorEl.hidden = false;
      resetPreview();
    }
    function resetPreview() {
      plan = null;
      clear(previewEl);
      policyBox.hidden = true;
      lossyBox.hidden = true;
      noteEl.hidden = true;
      summaryEl.textContent = '';
      setConfirm(0);
    }
    function setConfirm(n) {
      if (!confirmBtn) return;
      confirmBtn.textContent = n > 0 ? tp('import.go', n) : t('import.go.zero');
      confirmBtn.setAttribute('data-count', String(n));
      confirmBtn.disabled = n <= 0 || phase !== 'preview';
    }
    const reasonText = (code, row) => {
      if (!code) return '';
      const k = `import.reason.${code}`;
      const s = tk(k, { component: isolate((row && row.component) || '') });
      return s === k ? t('import.reason.other', { code }) : s;
    };
    const policy = () => POLICY_VALUE[Object.entries(radios).find(([, r]) => r.checked)[0]];
    const confirmedLossy = () => [...lossyBox.querySelectorAll('[data-testid="import-lossy-confirm"]')].filter((i) => i.checked).map((i) => i.getAttribute('data-uid'));
    const nameOf = (r) => r.fn || tk('import.noName');
    const knownName = new Map();

    // ------------------------------------------------------------------ file
    async function onFile() {
      const f = fileInput.files && fileInput.files[0];
      showFileName(f ? f.name || '' : '');
      const mine = ++seq;
      clearError();
      resetPreview();
      fileText = null;
      if (!f) return setStatus('');
      if (f.size > L.LIMITS.fileBytes) return showError(t('import.err.tooLarge', { mb: Math.round(L.LIMITS.fileBytes / 1048576) }));
      setStatus(t('import.reading'));
      let buf;
      try {
        buf = await f.arrayBuffer();
      } catch {
        return mine === seq ? showError(t('import.err.read')) : undefined;
      }
      if (mine !== seq) return;
      const dec = L.decodeUtf8File(buf);
      if (!dec.ok) return showError(tk('import.err.notUtf8', { encoding: guessEncoding(buf) }));
      if (!isCal && looksLikeCalendar(dec.text, f.name)) return showError(t('import.err.calendar'));
      if (isCal && looksLikeContacts(dec.text, f.name)) return showError(t('import.err.contacts'));
      fileText = dec.text;
      fileName = f.name || '';
      await replan(mine);
    }

    async function replan(mine = ++seq) {
      if (fileText === null) return;
      phase = 'planning';
      clearError();
      resetPreview();
      setStatus(tk('import.checking'));
      const href = select.value;
      const end = app.readiness.begin();
      let known;
      try {
        const st = store.stores.open({ href, kind });
        const r = await st.reload({ reason: 'import' });
        if (!r || r.ok === false) {
          phase = 'pick';
          if (mine === seq) showError(tk('import.err.sync'));
          return end(false);
        }
        known = isCal ? st.list().map((e) => ({ href: e.href, etag: e.etag, uid: L.calendarUidOf(e.text) })) : st.list().map((e) => {
          const s = L.summarize(e.text, { href: e.href, etag: e.etag });
          return { href: e.href, etag: e.etag, uid: s.uid, fn: s.name, emails: s.emails || [] };
        });
      } catch {
        phase = 'pick';
        if (mine === seq) showError(tk('import.err.sync'));
        return end(false);
      }
      end(true);
      if (mine !== seq) return;
      knownName.clear();
      for (const k of known) knownName.set(k.href, k.fn || '');
      const p = isCal ? L.planIcsImport(fileText, known, { collectionHref: href, components: (store.access.get && (store.access.get(href) || {}).components) || undefined }) : L.planImport(fileText, known, { collectionHref: href });
      setStatus('');
      if (p.fatal) {
        phase = 'pick';
        return showError(tk(`import.fatal.${p.fatal.reason}`, { limit: p.fatal.limit ? Math.round(p.fatal.limit / 1048576) : '', max: L.LIMITS.items, count: p.fatal.count ?? '' }));
      }
      plan = p;
      phase = 'preview';
      shown = 0;
      drawPreview();
      drawPolicy();
      refresh();
    }

    // --------------------------------------------------------------- preview
    function rowNotes(r) {
      const notes = [];
      if (isCal && r.itemKind) {
        const bits = [t(`import.cal.kind.${r.itemKind}`)];
        if (r.recurring) bits.push(t('import.cal.recurring'));
        if (r.overrides) bits.push(t('import.cal.overrides', { n: r.overrides }));
        notes.push(h('span', { class: 'import__note', 'data-kind': 'info' }, bits.join(' · ')));
      }
      if (r.reason) notes.push(h('span', { class: 'import__note', 'data-kind': 'reason' }, reasonText(r.reason, r)));
      if (r.generatedUid) notes.push(h('span', { class: 'import__note', 'data-kind': 'generated-uid' }, tk('import.note.generatedUid')));
      for (const n of r.notes || []) {
        if (n.code === 'method-dropped') notes.push(h('span', { class: 'import__note', 'data-kind': 'method-dropped' }, t('import.note.method-dropped', { method: isolate(n.method || '') })));
        else if (n.code === 'wrapper-added') notes.push(h('span', { class: 'import__note', 'data-kind': 'wrapper-added' }, t('import.note.wrapper-added')));
        else if (n.code === 'unknown-tzid') notes.push(h('span', { class: 'import__note import__note--warn', 'data-kind': 'unknown-tzid' }, t('import.note.unknown-tzid', { tzids: (n.tzids || []).map((z) => isolate(z)).join(', ') })));
      }
      for (const hint of (r.hints || []).slice(0, 2)) notes.push(h('span', { class: 'import__note', 'data-kind': 'hint' }, t(`import.hint.${hint.kind}`, { name: isolate(knownName.get(hint.href) || '') || t('import.noName') })));
      if ((r.hints || []).length > 2) notes.push(h('span', { class: 'import__note', 'data-kind': 'hint' }, t('import.hint.more', { n: r.hints.length - 2 })));
      if (r.lossy && r.lossy.length) notes.push(h('span', { class: 'import__note import__note--warn', 'data-kind': 'lossy' }, t('import.lossy.row', { props: r.lossy.join(', ') })));
      return notes;
    }
    const rowEl = (r) =>
      h(
        'tr',
        { testid: 'import-row', 'data-state': r.state, 'data-index': String(r.index), 'data-uid': r.uid || '', 'data-component': r.component || '' },
        h('td', null, String(r.index + 1)),
        h('td', null, h('bdi', null, nameOf(r))),
        h('td', null, h('span', { class: ['tag', STATE_TAG[r.state] || ''] }, t(`import.state.${r.state}`))),
        h('td', null, h('div', { class: 'import__notes' }, rowNotes(r))),
      );
    function drawPreview() {
      clear(previewEl);
      const rows = plan.rows;
      const c = plan.counts;
      previewEl.append(h('p', { class: 'small', testid: 'import-file-info' }, tk('import.fileRead', { file: isolate(fileName), n: rows.length })));
      const tbody = h('tbody', { testid: 'import-rows' });
      const more = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-import-more', hidden: true }, '');
      const note = h('p', { class: 'muted small', testid: 'import-preview-note' });
      const draw = (n) => {
        for (const r of rows.slice(shown, shown + n)) tbody.append(rowEl(r));
        shown = Math.min(rows.length, shown + n);
        note.textContent = tk('import.showing', { shown, total: rows.length });
        more.hidden = shown >= rows.length;
        more.textContent = t('import.showMore', { n: Math.min(ROWS_MORE, rows.length - shown) });
      };
      more.addEventListener('click', () => draw(ROWS_MORE));
      previewEl.append(
        h('p', { class: 'small', testid: 'import-counts' }, tk('import.counts', { new: c.new, duplicate: c.duplicate, invalid: c.invalid, unsupported: c.unsupported, repeated: c['file-duplicate'] })),
        h(
          'div',
          { class: 'table-wrap' },
          h('table', { class: 'table', testid: 'import-table' }, h('caption', { class: 'visually-hidden' }, tk('import.previewCaption')), h('thead', null, h('tr', null, ['#', t('import.col.name'), t('import.col.state'), t('import.col.details')].map((x) => h('th', { scope: 'col' }, x)))), tbody),
        ),
        note,
        more,
      );
      draw(ROWS_FIRST);
    }
    function drawPolicy() {
      const dups = plan.rows.filter((r) => r.state === 'duplicate');
      policyBox.hidden = dups.length === 0;
      if (!dups.length) radios.skip.checked = true;
      lastPolicy = null;
    }
    function drawLossy() {
      const risky = policy() === 'replace' ? plan.rows.filter((r) => r.state === 'duplicate' && r.lossy.length) : [];
      const was = new Set(confirmedLossy());
      clear(lossyBox);
      lossyBox.hidden = risky.length === 0;
      if (!risky.length) return;
      lossyBox.append(h('legend', { class: 'fieldset__legend' }, tk('import.lossy.title')), h('p', { class: 'notice notice--warn' }, tk('import.lossy.explain')));
      for (const r of risky) {
        const box = h('input', { type: 'checkbox', testid: 'import-lossy-confirm', 'data-uid': r.uid });
        box.checked = was.has(r.uid);
        box.addEventListener('change', refresh);
        lossyBox.append(h('label', { class: 'check check--block' }, box, h('span', null, t('import.lossy.item', { name: isolate(nameOf(r)), props: r.lossy.join(', ') }))));
      }
    }
    function refresh() {
      if (!plan) return;
      drawLossyOnce();
      let res;
      try {
        res = L.resolveImport(plan, policy(), { collectionHref: select.value, confirmLossy: confirmedLossy() });
      } catch {
        return;
      }
      const c = res.counts;
      let text = t('import.summary', { create: c.create, replace: c.replace, skipped: c.skipped });
      if (c.lossy) text += ' ' + tk('import.summary.lossy', { n: c.lossy });
      if (c.lossySkipped) text += ' ' + t('import.summary.lossySkipped', { n: c.lossySkipped });
      summaryEl.textContent = text;
      noteEl.hidden = true;
      setConfirm(c.create + c.replace);
    }
    let lastPolicy = null;
    function drawLossyOnce() {
      const p = policy();
      if (p !== lastPolicy) {
        lastPolicy = p;
        drawLossy();
      }
    }

    // ------------------------------------------------------------------- run
    async function start() {
      if (phase !== 'preview' || !plan) return;
      const pol = policy();
      const confirmLossy = confirmedLossy();
      const href = select.value;
      phase = 'running';
      select.disabled = true;
      fileInput.disabled = true;
      for (const r of Object.values(radios)) r.disabled = true;
      for (const i of lossyBox.querySelectorAll('input')) i.disabled = true;
      if (confirmBtn) confirmBtn.disabled = true;
      closeBtn.disabled = true;
      previewEl.hidden = true;
      policyBox.hidden = true;
      lossyBox.hidden = true;
      summaryEl.hidden = true;
      runEl.hidden = false;
      progress = createProgress({ name: 'import', label: tk('import.progress.label'), t, cancelable: true, cancelLabel: t('import.progress.cancel'), onCancel: () => handle && handle.cancel(), format: ({ value, max }) => (max ? t('import.progress.counts', { done: value, total: max }) : t('import.progress.working')) });
      runEl.append(progress.el);
      const end = app.readiness.begin();
      let res;
      try {
        handle = store.startImport({
          collection: href,
          kind,
          plan,
          policy: pol,
          resolve: (p, pl, o) => L.resolveImport(p, pl, { ...o, confirmLossy }),
          onProgress: (ev) => progress && progress.set({ value: ev.done, max: ev.total }),
        });
        res = await handle.done;
      } catch {
        res = null;
      }
      handle = null;
      phase = 'done';
      closeBtn.disabled = false;
      closeBtn.textContent = t('import.close');
      if (confirmBtn) confirmBtn.hidden = true;
      if (!res) {
        progress.fail(t('import.progress.failed'));
        end(false);
        return showError(tk('import.err.run'));
      }
      report = res;
      if (res.cancelled) progress.markCancelled(t('import.progress.cancelled', { done: res.created + res.replaced, total: res.total }));
      else if (res.stopped) progress.fail(t('import.progress.stopped'));
      else progress.complete(t('import.progress.done'));
      drawReport(res);
      end(res.ok || res.created + res.replaced > 0);
      closeBtn.focus();
    }

    function drawReport(res) {
      clear(reportEl);
      reportEl.hidden = false;
      const rank = { failed: 0, skipped: 1, replaced: 2, created: 3 };
      const items = res.items.slice().sort((a, b) => (rank[a.result] ?? 4) - (rank[b.result] ?? 4) || a.index - b.index);
      let limit = 200;
      const tbody = h('tbody', { testid: 'import-report-rows' });
      const more = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-report-more', hidden: true }, t('import.report.more'));
      const drawRows = () => {
        for (const it of items.slice(tbody.children.length, limit)) {
          const r = plan.rows[it.index] || {};
          tbody.append(
            h(
              'tr',
              { testid: 'import-report-row', 'data-result': it.result, 'data-index': String(it.index) },
              h('td', null, h('bdi', null, nameOf(r))),
              h('td', { class: 'import__result' }, t(`import.result.${it.result}`)),
              h('td', null, it.reason ? reasonText(it.reason, r) : ''),
            ),
          );
        }
        more.hidden = limit >= items.length;
      };
      more.addEventListener('click', () => {
        limit += ROWS_MORE;
        drawRows();
      });
      reportEl.append(h('h3', { class: 'section-title' }, t('import.report.title')), h('p', { class: 'import__summary', testid: 'import-report-summary' }, t('import.report.summary', { created: res.created, replaced: res.replaced, skipped: res.skipped, failed: res.failed })));
      if (res.stopped && res.stopped !== 'cancelled') reportEl.append(h('p', { class: 'notice notice--warn', testid: 'import-report-stopped' }, t(`import.report.stopped.${res.stopped}`, { notRun: res.notRun })));
      else if (res.cancelled) reportEl.append(h('p', { class: 'notice notice--quiet', testid: 'import-report-stopped' }, tk('import.report.cancelled', { notRun: res.notRun })));
      if (res.verify && res.verify.mismatched.length) {
        reportEl.append(h('p', { class: 'notice notice--warn', testid: 'import-report-verify' }, tk('import.report.verify', { n: res.verify.mismatched.length })));
      }
      if (isCal) {
        const done = (it) => it.result === 'created' || it.result === 'replaced';
        const dropped = plan.rows.filter((r) => (r.notes || []).some((n) => n.code === 'method-dropped') && res.items.some((it) => it.index === r.index && done(it))).length;
        const skippedParts = plan.rows.filter((r) => r.state === 'unsupported' && r.reason === 'unsupported-component').length;
        if (dropped || skippedParts) {
          const box = h('div', { class: 'notice notice--quiet', testid: 'import-report-notes' });
          if (dropped) box.append(h('p', null, tp('import.report.methodDropped', dropped, { n: dropped })));
          if (skippedParts) box.append(h('p', null, tp('import.report.skippedComponents', skippedParts, { n: skippedParts })));
          reportEl.append(box);
        }
      }
      const warn = (res.warnings || []).filter((w) => w.code === 'nickname-truncated');
      if (warn.length) reportEl.append(h('p', { class: 'notice notice--quiet', testid: 'import-report-warnings' }, t('import.report.nickname', { n: warn.length })));
      reportEl.append(h('div', { class: 'table-wrap' }, h('table', { class: 'table', testid: 'import-report-table' }, h('caption', { class: 'visually-hidden' }, tk('import.report.caption')), h('thead', null, h('tr', null, [t('import.col.name'), t('import.col.result'), t('import.col.details')].map((x, i) => h('th', { scope: 'col', class: i === 1 ? 'import__result' : null }, x)))), tbody)), more);
      drawRows();
    }

    // ---------------------------------------------------------------- events
    if (targets.length) {
      fileInput.addEventListener('change', onFile);
      select.addEventListener('change', () => {
        if (phase === 'preview' || phase === 'planning') replan();
      });
      policyBox.addEventListener('change', () => {
        lastPolicy = null;
        refresh();
      });
    }
    return finished;
  }
}
