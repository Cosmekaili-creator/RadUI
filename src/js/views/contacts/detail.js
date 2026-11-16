// SPDX-License-Identifier: AGPL-3.0-or-later
// The detail pane: one contact read-only, with its actions. Everything from the card goes in as text nodes;
// phone, e-mail and web links are built by links.js from an allowlist (anything else is plain text); photos
// are drawn only after canDisplayPhoto, through the audited setDataImage (via the avatar widget).
//
// Test ids: contact-detail (data-uid, data-href), contact-avatar, contact-name, contact-nickname, contact-org,
// btn-edit-contact, btn-delete-contact, btn-export-contact, contact-phone, contact-email, contact-address,
// contact-url, contact-birthday, contact-anniversary, contact-note, contact-categories, contact-groups,
// btn-add-to-group, contact-meta, contact-readonly-reason, contact-raw, contact-notfound, btn-back, photo-note.

import { clear, fill, h } from '../../ui.js';
import { createAvatar, isolate } from '../../widgets/avatar.js';
import { partText, stripTel } from '../../model/vcard.js';
import { abbreviatePhotos, capText, mailHref, telHref, webHref } from './links.js';
import { ageOn, formatDay, groupHash, listHash, typeLabel } from './common.js';

const nz = (v) => (v === undefined || v === null ? '' : String(v));

/** Address lines for display: street (may hold line breaks), extended, PO box, "code city", region, country. */
export function addressLines(v) {
  const p = (k) => partText(v && v[k]).trim();
  const line = [p('code'), p('locality')].filter(Boolean).join(' ');
  return [p('street'), p('ext'), p('pobox'), line, p('region'), p('country')].filter(Boolean);
}

function section(title, id, body) {
  return h('section', { class: 'cdetail__sec', 'aria-labelledby': id }, h('h3', { class: 'section-title', id }, title), body);
}

function kvRow(testid, label, value, { pref = false, t } = {}) {
  return h('li', { class: 'ckv__row', testid }, h('span', { class: 'ckv__k' }, label), h('span', { class: 'ckv__v' }, value, pref ? h('span', { class: 'tag tag--accent ckv__pref' }, t('contact.preferred')) : null));
}

const link = (href, text, attrs) => h('a', { class: 'link', href, ...(attrs || {}) }, h('bdi', null, text));

/**
 * @param {object} o
 * @param {Function} o.t @param {Function} o.tp @param {string} o.lang
 * @param {object} o.ops {onEdit, onDelete, onExport, onAddToGroup}
 * @param {object} [o.deps] {now}
 */
export function createDetailPane({ t, tp, lang, ops, deps = {} }) {
  const el = h('section', { class: 'split__detail', 'aria-label': t('contact.detail'), testid: 'contact-detail-pane' });
  const nowFn = deps.now || (() => new Date());

  function backLink(query) {
    return h('a', { class: 'btn btn--small cdetail__back', href: listHash(query), testid: 'btn-back' }, t('contacts.back'));
  }

  function actions(m, name) {
    const named = isolate(name);
    return h(
      'div',
      { class: 'cdetail__actions' },
      m.canWrite && !m.noEdit ? h('button', { type: 'button', class: 'btn btn--primary', testid: 'btn-edit-contact', write: true, 'aria-label': t('contact.editNamed', { name: named }), on: { click: () => ops.onEdit() } }, t('contact.edit')) : null,
      m.canWrite ? h('button', { type: 'button', class: 'btn btn--danger-quiet', testid: 'btn-delete-contact', write: true, 'aria-label': t('contact.deleteNamed', { name: named }), on: { click: () => ops.onDelete() } }, t('contact.delete')) : null,
      h('button', { type: 'button', class: 'btn', testid: 'btn-export-contact', 'aria-label': t('contact.exportNamed', { name: named }), on: { click: () => ops.onExport() } }, t('contact.export')),
    );
  }

  function groupsSection(m) {
    const gl = m.groupLinks || [];
    const canAdd = m.canWrite && m.canAddToGroup !== false;
    const list = gl.length
      ? h('ul', { class: 'chips' }, gl.map((g) => h('li', null, h('a', { class: 'tag tag--link', href: groupHash(g.key, m.linkQuery), testid: 'contact-group-link' }, h('bdi', null, g.name)))))
      : h('p', { class: 'muted' }, t('contact.groups.none'));
    return h(
      'section',
      { class: 'cdetail__sec', 'aria-labelledby': 'cd-groups', testid: 'contact-groups' },
      h('h3', { class: 'section-title', id: 'cd-groups' }, t('contact.groups')),
      list,
      canAdd ? h('button', { type: 'button', class: 'btn btn--small', testid: 'btn-add-to-group', write: true, 'aria-label': t('contact.addToGroupNamed', { name: isolate(m.name) }), on: { click: () => ops.onAddToGroup() } }, t('contact.addToGroup')) : null,
    );
  }

  function readOnlyBlock(m) {
    const reason = t(`contact.readonly.${m.reason}`) !== `contact.readonly.${m.reason}` ? t(`contact.readonly.${m.reason}`) : t('contact.readonly.unknown');
    const raw = capText(abbreviatePhotos(m.text, (kb) => t('contact.photoAbbrev', { kb })));
    return [
      h('p', { class: 'notice notice--warn', role: 'note', testid: 'contact-readonly-reason' }, t('contact.readonly.lead'), ' ', reason),
      h('details', { class: 'cdetail__raw', open: true }, h('summary', null, t('contact.raw.title')), h('pre', { class: 'raw', tabindex: '0', 'aria-label': t('contact.raw.title'), testid: 'contact-raw' }, raw.text), raw.truncated ? h('p', { class: 'muted small' }, t('contact.raw.truncated')) : null),
    ];
  }

  function fieldsBlock(m) {
    const f = m.fields;
    const out = [];
    const rows = (kind, entries, testid, make) => {
      if (!entries || !entries.length) return;
      const title = { tel: t('contact.phones'), email: t('contact.emails'), adr: t('contact.addresses'), url: t('contact.urls') }[kind];
      out.push(section(title, `cd-${kind}`, h('ul', { class: 'ckv' }, entries.map((e) => make(e)))));
    };
    rows('tel', f.tel, 'contact-phone', (e) => {
      const text = stripTel(e.value);
      const href = telHref(e.value);
      return kvRow('contact-phone', typeLabel('tel', e, t), href ? link(href, text, { testid: 'contact-phone-link' }) : h('bdi', null, text), { pref: e.pref, t });
    });
    rows('email', f.email, 'contact-email', (e) => {
      const href = mailHref(e.value);
      return kvRow('contact-email', typeLabel('email', e, t), href ? link(href, e.value, { testid: 'contact-email-link' }) : h('bdi', null, nz(e.value)), { pref: e.pref, t });
    });
    rows('adr', f.adr, 'contact-address', (e) => kvRow('contact-address', typeLabel('adr', e, t), h('span', { class: 'adr' }, addressLines(e.value).map((l) => h('bdi', { class: 'adr__line' }, l))), { pref: e.pref, t }));
    rows('url', f.url, 'contact-url', (e) => {
      const href = webHref(e.value);
      const text = nz(e.value);
      return kvRow('contact-url', typeLabel('url', e, t), href ? link(href, text, { target: '_blank', rel: 'noopener noreferrer', testid: 'contact-url-link' }) : h('bdi', null, text), { pref: e.pref, t });
    });

    const dates = [];
    if (f.bday) {
      const age = ageOn(f.bday, nowFn());
      const txt = formatDay(f.bday, lang);
      dates.push(kvRow('contact-birthday', t('contact.birthday'), age !== null ? t('contact.birthdayAge', { date: txt, age }) : txt, { t }));
    }
    if (f.anniversary) dates.push(kvRow('contact-anniversary', t('contact.anniversary'), formatDay(f.anniversary, lang), { t }));
    for (const a of f.anniversaries || []) {
      if (a.source === 'ANNIVERSARY') continue;
      const label = a.kind === 'anniversary' ? t('contact.anniversary') : typeLabel('url', { label: a.label, types: [] }, t);
      dates.push(kvRow('contact-anniversary', label, formatDay(a.date, lang), { t }));
    }
    if (dates.length) out.push(section(t('contact.dates'), 'cd-dates', h('ul', { class: 'ckv' }, dates)));
    if (f.note) out.push(h('section', { class: 'cdetail__sec', 'aria-labelledby': 'cd-note' }, h('h3', { class: 'section-title', id: 'cd-note' }, t('contact.note')), h('p', { class: 'prose', testid: 'contact-note' }, f.note)));
    if (f.categories && f.categories.length) out.push(section(t('contact.categories'), 'cd-cats', h('ul', { class: 'chips', testid: 'contact-categories' }, f.categories.map((c) => h('li', { class: 'tag' }, h('bdi', null, c))))));
    return out;
  }

  return {
    el,
    /**
     * @param {object} m {status: 'none'|'loading'|'notfound'|'ready', summary, name, uid, href, etag, text, fields|null,
     *        reason, canWrite, noEdit, photo (canDisplayPhoto result), groupLinks, canAddToGroup, linkQuery}
     */
    render(m) {
      el.setAttribute('data-status', m.status);
      if (m.status === 'none') {
        fill(el, h('p', { class: 'muted', testid: 'contact-pick' }, t('contacts.pick')));
        return;
      }
      if (m.status === 'blank') {
        clear(el); // nothing can be chosen (no access, no book, an empty book, still loading): no instruction to choose
        return;
      }
      if (m.status === 'loading') {
        fill(el, backLink(m.backQuery), h('p', { class: 'muted' }, t('contacts.loading')));
        return;
      }
      if (m.status === 'notfound') {
        fill(el, backLink(m.backQuery), h('div', { class: 'state', testid: 'contact-notfound', role: 'status' }, h('h2', { class: 'state__title' }, t('contact.notfound.title')), h('p', { class: 'muted' }, t('contact.notfound.text'))));
        return;
      }
      const name = m.name;
      const photoOk = m.photo && m.photo.ok;
      const head = h(
        'header',
        { class: 'cdetail__head' },
        createAvatar({ name, uid: m.uid || m.href, size: 'xl', photo: photoOk ? { mime: m.photo.mime, base64: m.photo.base64 } : null, decorative: true, testid: 'contact-avatar' }),
        h(
          'div',
          { class: 'cdetail__id' },
          h('h2', { class: 'cdetail__name', id: 'cd-name', tabindex: '-1', testid: 'contact-name' }, h('bdi', null, name)),
          m.fields && m.fields.nickname && m.fields.nickname[0] ? h('p', { class: 'muted', testid: 'contact-nickname' }, '« ', h('bdi', null, m.fields.nickname[0]), ' »') : null,
          m.fields && (m.fields.title || (m.fields.org && m.fields.org.name)) ? h('p', { class: 'cdetail__org', testid: 'contact-org' }, h('bdi', null, [m.fields.title, m.fields.org && m.fields.org.name].filter(Boolean).join(', '))) : null,
        ),
        actions(m, name),
      );
      const note = m.photo && !m.photo.ok && m.photo.reason !== 'none' ? h('p', { class: 'muted small', testid: 'photo-note' }, t(m.photo.key)) : null;
      const body = m.fields ? fieldsBlock(m) : [];
      fill(
        el,
        h(
          'article',
          { class: 'cdetail', testid: 'contact-detail', 'data-uid': m.uid || null, 'data-href': m.href, 'data-readonly': m.reason ? 'true' : 'false', 'aria-labelledby': 'cd-name' },
          backLink(m.backQuery),
          head,
          note,
          m.reason ? readOnlyBlock(m) : null,
          ...body,
          m.fields ? groupsSection(m) : null,
          m.fields ? h('p', { class: 'meta-line', testid: 'contact-meta' }, t('contact.meta', { version: m.fields.version })) : null,
        ),
      );
    },
    clear: () => clear(el),
  };
}

