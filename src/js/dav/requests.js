// SPDX-License-Identifier: AGPL-3.0-or-later
// Request builders for the WebDAV/CalDAV/CardDAV calls RadUI makes.
//
// Every builder returns { method, depth, body } (depth is undefined when the
// request carries no Depth header). Bodies are produced with the XML builder,
// so all caller-supplied text is escaped. Property names are Clark strings:
// '{DAV:}getetag'.

import { NS, el, serializeXml } from './xml.js';

export const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

const q = (ns, name) => '{' + ns + '}' + name;

/** Frequently used property names. */
export const PROP = Object.freeze({
  resourcetype: q(NS.DAV, 'resourcetype'),
  displayname: q(NS.DAV, 'displayname'),
  getetag: q(NS.DAV, 'getetag'),
  getcontenttype: q(NS.DAV, 'getcontenttype'),
  syncToken: q(NS.DAV, 'sync-token'),
  privileges: q(NS.DAV, 'current-user-privilege-set'),
  currentUserPrincipal: q(NS.DAV, 'current-user-principal'),
  ctag: q(NS.CS, 'getctag'),
  calendarHomeSet: q(NS.CALDAV, 'calendar-home-set'),
  addressbookHomeSet: q(NS.CARDDAV, 'addressbook-home-set'),
  calendarDescription: q(NS.CALDAV, 'calendar-description'),
  addressbookDescription: q(NS.CARDDAV, 'addressbook-description'),
  componentSet: q(NS.CALDAV, 'supported-calendar-component-set'),
  calendarColor: q(NS.ICAL, 'calendar-color'),
  calendarData: q(NS.CALDAV, 'calendar-data'),
  addressData: q(NS.CARDDAV, 'address-data'),
});

/** Properties requested when listing collections. */
export const COLLECTION_PROPS = Object.freeze([
  PROP.resourcetype,
  PROP.displayname,
  PROP.calendarColor,
  PROP.calendarDescription,
  PROP.addressbookDescription,
  PROP.componentSet,
  PROP.ctag,
  PROP.syncToken,
  PROP.getetag,
  PROP.privileges,
]);

const COMPONENT_RE = /^[A-Z][A-Z0-9-]{0,31}$/;
const UTC_RE = /^\d{8}T\d{6}Z$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/;

function propList(props) {
  return el(q(NS.DAV, 'prop'), null, props.map((p) => el(p, null)));
}

function doc(root) {
  return serializeXml(root);
}

/** Format a Date (or pass a ready string) as a UTC iCalendar date-time. */
export function toUtcStamp(v) {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TypeError('invalid date');
    return v.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }
  if (typeof v === 'string' && UTC_RE.test(v)) return v;
  throw new TypeError('time range bound must be a Date or YYYYMMDDTHHMMSSZ');
}

export function propfind(props, { depth = 0 } = {}) {
  if (depth !== 0 && depth !== 1) throw new TypeError('PROPFIND depth must be 0 or 1');
  return {
    method: 'PROPFIND',
    depth,
    body: doc(el(q(NS.DAV, 'propfind'), null, propList(props))),
  };
}

function checkComponent(c) {
  if (typeof c !== 'string' || !COMPONENT_RE.test(c)) throw new TypeError('invalid component name');
  return c;
}

/** calendar-query REPORT: all items of one component type, optionally in a time range. */
export function calendarQuery({ comp = 'VEVENT', start, end, props } = {}) {
  checkComponent(comp);
  const range =
    start || end
      ? el(q(NS.CALDAV, 'time-range'), {
          start: start ? toUtcStamp(start) : null,
          end: end ? toUtcStamp(end) : null,
        })
      : null;
  const body = el(
    q(NS.CALDAV, 'calendar-query'),
    null,
    propList(props || [PROP.getetag, PROP.calendarData]),
    el(
      q(NS.CALDAV, 'filter'),
      null,
      el(q(NS.CALDAV, 'comp-filter'), { name: 'VCALENDAR' }, el(q(NS.CALDAV, 'comp-filter'), { name: comp }, range)),
    ),
  );
  return { method: 'REPORT', depth: 1, body: doc(body) };
}

function hrefList(hrefs) {
  if (!Array.isArray(hrefs) || !hrefs.length) throw new TypeError('multiget needs at least one href');
  return hrefs.map((h) => el(q(NS.DAV, 'href'), null, String(h)));
}

export function calendarMultiget(hrefs, { props } = {}) {
  const body = el(
    q(NS.CALDAV, 'calendar-multiget'),
    null,
    propList(props || [PROP.getetag, PROP.calendarData]),
    hrefList(hrefs),
  );
  return { method: 'REPORT', depth: 1, body: doc(body) };
}

export function addressbookQuery({ props } = {}) {
  const body = el(
    q(NS.CARDDAV, 'addressbook-query'),
    null,
    propList(props || [PROP.getetag, PROP.addressData]),
  );
  return { method: 'REPORT', depth: 1, body: doc(body) };
}

export function addressbookMultiget(hrefs, { props } = {}) {
  const body = el(
    q(NS.CARDDAV, 'addressbook-multiget'),
    null,
    propList(props || [PROP.getetag, PROP.addressData]),
    hrefList(hrefs),
  );
  return { method: 'REPORT', depth: 1, body: doc(body) };
}

/** sync-collection REPORT (RFC 6578). An empty/absent token asks for everything. */
export function syncCollection(token, { props } = {}) {
  const body = el(
    q(NS.DAV, 'sync-collection'),
    null,
    el(q(NS.DAV, 'sync-token'), null, token || ''),
    el(q(NS.DAV, 'sync-level'), null, '1'),
    propList(props || [PROP.getetag]),
  );
  return { method: 'REPORT', depth: 1, body: doc(body) };
}

function checkColor(c) {
  if (typeof c !== 'string' || !COLOR_RE.test(c)) throw new TypeError('color must be #RRGGBB or #RRGGBBAA');
  return c;
}

function simpleProps(kind, { displayName, color, description }) {
  const descName = kind === 'addressbook' ? PROP.addressbookDescription : PROP.calendarDescription;
  const out = [];
  if (displayName !== undefined) out.push([PROP.displayname, displayName]);
  if (color !== undefined && kind === 'calendar') out.push([PROP.calendarColor, color === null ? null : checkColor(color)]);
  if (description !== undefined) out.push([descName, description]);
  return out;
}

/** MKCALENDAR with name, colour, description and the supported component set. */
export function mkcalendar({ displayName, color, description, components = ['VEVENT'] } = {}) {
  const set = el(
    q(NS.CALDAV, 'supported-calendar-component-set'),
    null,
    components.map((c) => el(q(NS.CALDAV, 'comp'), { name: checkComponent(c) })),
  );
  const props = simpleProps('calendar', { displayName, color, description });
  const body = el(
    q(NS.CALDAV, 'mkcalendar'),
    null,
    el(
      q(NS.DAV, 'set'),
      null,
      el(
        q(NS.DAV, 'prop'),
        null,
        props.filter(([, v]) => v !== null).map(([p, v]) => el(p, null, v)),
        set,
      ),
    ),
  );
  return { method: 'MKCALENDAR', body: doc(body) };
}

/** Extended MKCOL (RFC 5689) creating an address book. */
export function mkAddressbook({ displayName, description } = {}) {
  const props = simpleProps('addressbook', { displayName, description });
  const body = el(
    q(NS.DAV, 'mkcol'),
    null,
    el(
      q(NS.DAV, 'set'),
      null,
      el(
        q(NS.DAV, 'prop'),
        null,
        el(q(NS.DAV, 'resourcetype'), null, el(q(NS.DAV, 'collection')), el(q(NS.CARDDAV, 'addressbook'))),
        props.filter(([, v]) => v !== null).map(([p, v]) => el(p, null, v)),
      ),
    ),
  );
  return { method: 'MKCOL', body: doc(body) };
}

/**
 * PROPPATCH. kind is 'calendar' or 'addressbook'. changes holds displayName,
 * color (calendars only) and description; a null value removes the property.
 */
export function proppatch(kind, changes) {
  if (kind !== 'calendar' && kind !== 'addressbook') throw new TypeError('kind must be calendar or addressbook');
  const props = simpleProps(kind, changes || {});
  if (!props.length) throw new TypeError('nothing to change');
  const sets = props.filter(([, v]) => v !== null);
  const removes = props.filter(([, v]) => v === null);
  const body = el(
    q(NS.DAV, 'propertyupdate'),
    null,
    sets.length ? el(q(NS.DAV, 'set'), null, el(q(NS.DAV, 'prop'), null, sets.map(([p, v]) => el(p, null, v)))) : null,
    removes.length ? el(q(NS.DAV, 'remove'), null, el(q(NS.DAV, 'prop'), null, removes.map(([p]) => el(p, null)))) : null,
  );
  return { method: 'PROPPATCH', body: doc(body) };
}
