// SPDX-License-Identifier: AGPL-3.0-or-later
// The list pane of the contacts screen: toolbar (book, search, group, Groups, New, Import, Export), the
// count status, the lettered list, the A-Z index, the windowing buttons and every list state. The toolbar
// is built once (so the search box keeps its focus); `render(model)` replaces the body.
//
// Test ids: contacts-book, contacts-search, contacts-group, contacts-count, contact-list, contact-row
// (data-uid, data-href, data-letter, data-readonly), az-index, az-<L>, az-hash, btn-new-contact, btn-import-vcf,
// btn-export-book, btn-groups, btn-show-more, btn-show-earlier, contacts-empty, contacts-nobook,
// contacts-noaccess, contacts-readonly, contacts-no-match, contacts-error, contacts-offline,
// contacts-notfound, contacts-loading, btn-retry.

import { clear, fill, h } from '../../ui.js';
import { createAvatar } from '../../widgets/avatar.js';
import { createAnnouncer } from '../../widgets/timing.js';
import { fmtNumber, nameOf } from './common.js';

const UID_ATTR = (s) => (s.uid ? s.uid : null);

/** The second line of a row: organisation, else first e-mail, else first phone. */
export function subline(s) {
  return s.org || s.emails[0] || s.phones[0] || '';
}

/**
 * @param {object} o
 * @param {Function} o.t @param {Function} o.tp @param {string} o.lang
 * @param {object} o.ops callbacks: onBook(href) onSearch(q) onGroup(key) onNew() onImport() onExport() onJump(letter)
 *        onMore() onEarlier() onRetry() onOpen(summary)
 * @param {{timers?: object, countMs?: number}} [o.deps]
 */
export function createListPane({ t, tp, lang, ops, deps = {} }) {
  const timers = deps.timers;
  const q = h('input', { type: 'search', class: 'input', id: 'contacts-search', testid: 'contacts-search', autocomplete: 'off', spellcheck: 'false', placeholder: t('contacts.searchPlaceholder'), enterkeyhint: 'search' });
  const searchForm = h('form', { role: 'search', class: 'searchbox', 'aria-label': t('contacts.search'), on: { submit: (e) => e.preventDefault() } }, h('label', { class: 'visually-hidden', for: 'contacts-search' }, t('contacts.search')), q);
  const bookSel = h('select', { class: 'input input--compact', id: 'contacts-book', testid: 'contacts-book' });
  const bookField = h('div', { class: 'clist__book', hidden: true }, h('label', { class: 'visually-hidden', for: 'contacts-book' }, t('contacts.book')), bookSel);
  const groupSel = h('select', { class: 'input input--compact', id: 'contacts-group', testid: 'contacts-group' });
  const btnGroups = h('a', { class: 'btn btn--small', href: '#/contacts/groups', testid: 'btn-groups' }, t('contacts.groups'));
  const btnNew = h('button', { type: 'button', class: 'btn btn--primary btn--small', testid: 'btn-new-contact', write: true, on: { click: () => ops.onNew() } }, t('contacts.new'));
  const btnImport = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-import-vcf', write: true, on: { click: () => ops.onImport() } }, t('contacts.import'));
  const btnExport = h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-export-book', on: { click: () => ops.onExport() } }, t('contacts.export'));
  const row2 = h('div', { class: 'clist__row2' }, h('label', { class: 'visually-hidden', for: 'contacts-group' }, t('contacts.group.label')), groupSel, btnGroups);
  const row3 = h('div', { class: 'clist__row2' }, btnNew, btnImport, btnExport);
  const notice = h('p', { class: 'notice', id: 'contacts-readonly-note', role: 'note', testid: 'contacts-readonly', hidden: true }, t('contacts.readonly.text'));
  const count = h('p', { class: 'muted small', role: 'status', testid: 'contacts-count' });
  const list = h('div', { class: 'clist', testid: 'contact-list' });
  const az = h('nav', { class: 'az', 'aria-label': t('contacts.az'), testid: 'az-index' });
  const wrap = h('div', { class: 'clist__wrap' }, list, az);
  const tools = h('div', { class: 'clist__tools' }, bookField, searchForm, row2, row3, notice, count);
  const title = h('h1', { class: 'page-title', tabindex: '-1' }, t('contacts.title'));
  const el = h('section', { class: 'split__list', 'aria-label': t('contacts.listLabel'), testid: 'contacts-pane' }, title, tools, wrap);

  const announcer = createAnnouncer({ apply: (text) => (count.textContent = text), ms: deps.countMs ?? 600, timers });
  let lastCount = null;
  q.addEventListener('input', () => ops.onSearch(q.value));

  bookSel.addEventListener('change', () => ops.onBook(bookSel.value));
  groupSel.addEventListener('change', () => ops.onGroup(groupSel.value));

  function setCount(text, typing) {
    if (text === lastCount) return;
    const first = lastCount === null;
    lastCount = text;
    // The first text and every text that is not a reaction to typing appear at once; typing is throttled.
    if (first || !typing) announcer.flush(text);
    else announcer.push(text);
  }

  function stateBox(testid, titleText, text, actions = []) {
    return h('div', { class: 'state', testid }, h('h2', { class: 'state__title' }, titleText), text ? h('p', { class: 'muted' }, text) : null, actions.length ? h('div', { class: 'state__actions' }, actions) : null);
  }

  function rowEl(s, model) {
    const href = model.hashFor(s);
    const name = nameOf(s, t);
    return h(
      'li',
      null,
      h(
        'a',
        {
          class: 'crow',
          href,
          testid: 'contact-row',
          'data-uid': UID_ATTR(s),
          'data-href': s.href,
          'data-letter': s.letter,
          'data-readonly': s.readOnly ? 'true' : 'false',
          'aria-current': model.selectedHref && model.selectedHref === s.href ? 'page' : null,
        },
        createAvatar({ name, uid: s.uid || s.href, size: 'sm', testid: 'row-avatar' }),
        h('span', { class: 'crow__text' }, h('bdi', { class: 'crow__name' }, name), h('span', { class: 'crow__sub' }, h('bdi', null, subline(s)))),
        s.readOnly ? h('span', { class: 'tag tag--warn' }, t('contacts.readonlyTag')) : null,
      ),
    );
  }

  function bodyOf(model) {
    const w = model.win;
    const nodes = [];
    if (w.showEarlier) {
      nodes.push(h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-show-earlier', on: { click: () => ops.onEarlier(w.showEarlier.from) } }, t('contacts.showEarlier', { count: fmtNumber(lang, w.showEarlier.count), hidden: fmtNumber(lang, w.showEarlier.hidden) })));
    }
    let letter = null;
    let ul = null;
    for (const s of w.rows) {
      if (s.letter !== letter) {
        letter = s.letter;
        ul = h('ul', { class: 'clist__rows' });
        nodes.push(h('section', { class: 'clist__group', 'aria-labelledby': `letter-${letter === '#' ? 'hash' : letter}` }, h('h2', { class: 'clist__letter', id: `letter-${letter === '#' ? 'hash' : letter}`, tabindex: '-1' }, letter), ul));
      }
      ul.append(rowEl(s, model));
    }
    if (w.showMore) {
      nodes.push(h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-show-more', on: { click: () => ops.onMore(w.showMore.nextSize) } }, t('contacts.showMore', { count: fmtNumber(lang, w.showMore.count), hidden: fmtNumber(lang, w.showMore.hidden) })));
    }
    return nodes;
  }

  function countText(model) {
    const w = model.win;
    const total = fmtNumber(lang, model.total);
    const n = fmtNumber(lang, model.rows.length);
    const windowed = w.hiddenBefore > 0 || w.hiddenAfter > 0;
    const range = { from: fmtNumber(lang, w.from), to: fmtNumber(lang, w.to) };
    if (model.filtered) return windowed ? t('contacts.count.filteredWindow', { n, total, ...range }) : t('contacts.count.filtered', { n, total });
    return windowed ? t('contacts.count.window', { total, ...range }) : tp('contacts.count', model.total, { n: total });
  }

  function fillSelect(sel, options, value) {
    clear(sel);
    for (const [v, label] of options) sel.append(h('option', { value: v, selected: v === value }, label));
    sel.value = value;
  }

  const toolsHidden = (on) => {
    for (const x of [searchForm, row2, row3, count]) x.hidden = on;
  };

  return {
    el,
    list,
    az,
    search: q,
    title,
    /** Draw a model: {status, books, book, readOnly, groups, group, q, total, rows, win, filtered, selectedHref, hashFor, error, canCreateBook}. */
    render(model) {
      const status = model.status;
      el.setAttribute('data-status', status);
      fillSelect(
        bookSel,
        (model.books || []).map((b) => [b.href, b.label || b.displayName || b.name || b.href]),
        model.book ? model.book.href : '',
      );
      bookField.hidden = !((model.books || []).length > 1) || status === 'nobook' || status === 'noaccess';
      const withTools = status === 'ready' || status === 'loading';
      toolsHidden(!withTools);
      if (withTools) {
        fillSelect(groupSel, [['', t('contacts.group.all')], ...(model.groups || []).map((g) => [g.key, g.name])], model.group || '');
        if ((model.forceQ || document_activeIsNot(q)) && q.value !== (model.q || '')) q.value = model.q || '';
        const ro = Boolean(model.readOnly);
        btnImport.hidden = ro;
        notice.hidden = !ro;
        btnNew.hidden = false;
        if (ro) {
          btnNew.setAttribute('aria-disabled', 'true');
          btnNew.setAttribute('aria-describedby', 'contacts-readonly-note');
        } else {
          btnNew.removeAttribute('aria-disabled');
          btnNew.removeAttribute('aria-describedby');
        }
        btnExport.hidden = false;
        btnGroups.hidden = false;
      } else notice.hidden = true;

      clear(az);
      list.removeAttribute('data-count');
      if (status === 'loading') {
        fill(list, h('p', { class: 'muted', testid: 'contacts-loading' }, t('contacts.loading')));
        return;
      }
      if (status === 'nobook') {
        fill(list, stateBox('contacts-nobook', t('contacts.nobook.title'), t('contacts.nobook.text'), model.canCreateBook ? [h('a', { class: 'btn btn--primary', href: '#/collections/new-addressbook', testid: 'btn-create-addressbook' }, t('contacts.nobook.create'))] : []));
        return;
      }
      if (status === 'noaccess') {
        fill(list, stateBox('contacts-noaccess', t('contacts.noaccess.title'), t('contacts.noaccess.text')));
        return;
      }
      if (status === 'notfound') {
        fill(list, stateBox('contacts-notfound', t('contacts.notfound.title'), t('contacts.notfound.text'), [h('a', { class: 'btn', href: '#/contacts', testid: 'btn-back-contacts' }, t('contacts.notfound.back'))]));
        return;
      }
      if (status === 'offline') {
        fill(list, stateBox('contacts-offline', t('contacts.offline.title'), t('contacts.offline.text'), [h('button', { type: 'button', class: 'btn', testid: 'btn-retry', on: { click: () => ops.onRetry() } }, t('contacts.retry'))]));
        return;
      }
      if (status === 'error') {
        fill(list, stateBox('contacts-error', t('contacts.error.title'), model.errorText || '', [h('button', { type: 'button', class: 'btn', testid: 'btn-retry', on: { click: () => ops.onRetry() } }, t('contacts.retry'))]));
        return;
      }
      // ready
      setCount(countText(model), model.typing);
      list.setAttribute('data-count', String(model.rows.length));
      if (model.total === 0) {
        const acts = [];
        if (!model.readOnly) {
          acts.push(h('button', { type: 'button', class: 'btn btn--primary', testid: 'btn-new-contact-empty', write: true, on: { click: () => ops.onNew() } }, t('contacts.new')));
          acts.push(h('button', { type: 'button', class: 'btn', testid: 'btn-import-vcf-empty', write: true, on: { click: () => ops.onImport() } }, t('contacts.import')));
        }
        fill(list, stateBox('contacts-empty', t('contacts.empty.title'), model.readOnly ? t('contacts.empty.textReadonly') : t('contacts.empty.text'), acts));
        return;
      }
      if (model.rows.length === 0) {
        fill(list, h('p', { class: 'empty-inline', testid: 'contacts-no-match' }, t('contacts.nomatch', { q: model.q || '' })));
        return;
      }
      fill(list, bodyOf(model));
      for (const e of model.az) {
        if (!e.present) continue;
        az.append(
          h('button', { type: 'button', class: 'az__l', testid: e.testId, 'aria-label': e.letter === '#' ? t('contacts.az.other') : t('contacts.az.jump', { letter: e.letter }), on: { click: () => ops.onJump(e.letter) } }, e.letter),
        );
      }
    },
    dispose() {
      announcer.cancel();
    },
  };
}

// The search box keeps what the user typed while it has the focus; the URL is only the saved copy of it.
function document_activeIsNot(input) {
  const doc = input.ownerDocument;
  return !doc || doc.activeElement !== input;
}

