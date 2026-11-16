// SPDX-License-Identifier: AGPL-3.0-or-later
// The time-zone picker (RUN3 D-R3-6): a button that shows the current zone and opens the searchable picker dialog
// (widgets/picker.js, test ids `zone-picker`, `field-zone-search`, `zone-option`). Recent zones come first, then the zones seen
// in the loaded items, then every zone Intl knows (tzprefs.zoneList). Used by the event form (`field-tz-start`,
// `field-tz-end`) and by Settings (`settings-tz-display`). Choosing a zone here never writes anything: the form decides
// what to do with it, Settings stores a preference.

import { h } from '../../ui.js';
import { buildField, uniqueId } from '../../widgets/fieldkit.js';
import { openPicker } from '../../widgets/picker.js';
import { pushRecent, recentZones, zoneList, zoneOffsetLabel } from '../../calendar/tzprefs.js';

/** The shown name of a zone id ("America/New_York" -> "America/New York"). */
export const zoneLabel = (id) => String(id).replace(/_/g, ' ');

/** Picker options of the zone list: {id, label, sublabel (UTC offset), keywords}. */
export function zoneOptions({ login = '', seen = [], browser, storage, supported, atMs = Date.now() } = {}) {
  const list = zoneList({ ...(supported ? { supported } : {}), seen, recent: recentZones(login, { storage }), browser });
  return list.map((z) => ({ id: z.id, label: zoneLabel(z.id), sublabel: zoneOffsetLabel(z.id, atMs), keywords: [z.id] }));
}

/**
 * Open the zone picker. Resolves with the chosen zone id or null (cancelled).
 * @param {object} o
 * @param {string} [o.current] the zone that is selected now
 */
export async function openZonePicker({ t, tp, login = '', seen = [], browser, storage, supported, current = '', title, win, timers } = {}) {
  const ids = await openPicker({
    name: 'zone',
    title: title || t('event.tz.pickTitle'),
    description: t('event.tz.pickText'),
    searchLabel: t('event.tz.search'),
    options: zoneOptions({ login, seen, browser, storage, supported }),
    selected: current ? [current] : [],
    t,
    tp,
    win,
    timers,
  });
  return ids && ids.length ? ids[0] : null;
}

/**
 * A labelled zone control. `value` '' is a floating time (no zone): it is shown as such and can only be replaced by a zone.
 * @param {object} o
 * @param {string} o.testid  `field-tz-start`: on the button
 * @param {string} o.label
 * @param {string} [o.value]
 * @param {(zone: string) => void} [o.onChange]
 * @param {object} [o.deps] {pick(opts) -> Promise<string|null>} (tests), plus whatever openZonePicker takes
 */
export function createZoneField({ testid, label, value = '', t, tp, login = '', getSeen = () => [], browser, storage, hint, onChange, deps = {} } = {}) {
  const id = uniqueId('zone');
  let current = value || '';
  const button = h('button', { type: 'button', class: 'btn zone-btn', id, testid, 'aria-haspopup': 'dialog' });
  const f = buildField({ id, label, testid: null, control: button, hint });
  f.el.setAttribute('data-field', testid);
  const show = () => {
    button.textContent = current ? zoneLabel(current) : t('event.tz.floating');
    button.setAttribute('data-zone', current);
  };
  show();
  const api = {
    el: f.el,
    control: button,
    get value() {
      return current;
    },
    setValue(next) {
      current = next || '';
      show();
    },
    setError: (msg) => f.setError(msg),
    focus: () => button.focus(),
    async choose() {
      const opts = { t, tp, login, seen: [current, ...getSeen()].filter(Boolean), browser, storage, current, win: deps.win, timers: deps.timers, supported: deps.supported };
      const zone = await (deps.pick ? deps.pick(opts) : openZonePicker(opts));
      if (!zone || zone === current) {
        button.focus();
        return null;
      }
      pushRecent(login, zone, { storage });
      api.setValue(zone);
      button.focus();
      if (onChange) onChange(zone);
      return zone;
    },
  };
  button.addEventListener('click', () => void api.choose());
  return api;
}
