// SPDX-License-Identifier: AGPL-3.0-or-later
// CalDAV/CardDAV client built on the transport (http.js) and the request
// builders (requests.js).
//
// Conventions:
//   - every href handed out is canonical (see normalizeHref) and same-origin;
//   - item text is LF in memory: server text (GET, REPORT) is normalised from
//     CRLF/CR to LF, and PUT bodies are converted to CRLF on the wire;
//   - ETags are opaque strings exactly as the server sent them (quotes kept);
//     the client never computes one;
//   - writes are conditional: update sends If-Match, create sends
//     If-None-Match: *, delete sends If-Match with a real ETag, never '*';
//   - a 412 on a write becomes ConflictError{href, sentEtag}.

import { NS, parseXml, find, findAll, text, is } from './xml.js';
import * as RQ from './requests.js';
import { DavError, ConflictError, kindForStatus, encodeSegment, toLf, toCrlf } from './http.js';

const { PROP } = RQ;
const XML_HEADERS = { 'Content-Type': RQ.XML_CONTENT_TYPE };
const DEFAULT_COMPONENTS = Object.freeze(['VEVENT', 'VTODO']);

// ---------------------------------------------------------------- helpers

/** Child href of a parent collection path: childHref('/alice/', 'My Cal', {collection: true}). */
export function childHref(parent, name, { collection = false } = {}) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\/\\\u0000]/.test(name)) {
    throw new DavError('invalid', { message: 'invalid resource name' });
  }
  const base = parent.endsWith('/') ? parent : parent + '/';
  return base + encodeSegment(name) + (collection ? '/' : '');
}

function statusCode(line) {
  const m = /^\s*HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line || '');
  return m ? Number(m[1]) : 0;
}

/**
 * Parse a 207 multistatus body.
 * @returns {{syncToken: string|null, responses: {hrefs: string[], status: number, propstats: {status:number, prop: object}[]}[]}}
 */
export function parseMultistatus(body) {
  let root;
  try {
    root = parseXml(body);
  } catch (e) {
    throw new DavError('invalid', { message: 'malformed XML response: ' + e.message, cause: e });
  }
  if (!is(root, NS.DAV, 'multistatus')) throw new DavError('invalid', { message: 'expected a DAV:multistatus response' });
  const token = find(root, NS.DAV, 'sync-token');
  const responses = findAll(root, NS.DAV, 'response').map((r) => ({
    hrefs: findAll(r, NS.DAV, 'href').map((h) => text(h).trim()),
    status: statusCode(text(find(r, NS.DAV, 'status'))),
    propstats: findAll(r, NS.DAV, 'propstat').map((ps) => ({
      status: statusCode(text(find(ps, NS.DAV, 'status'))),
      prop: find(ps, NS.DAV, 'prop') || { children: [], text: '' },
    })),
  }));
  return { syncToken: token ? text(token).trim() : null, responses };
}

/** The {ns}name element from the successful (2xx) propstats of a response, or null. */
function getProp(resp, qname) {
  const m = /^\{([^}]*)\}(.+)$/.exec(qname);
  for (const ps of resp.propstats) {
    if (ps.status < 200 || ps.status >= 300) continue;
    const p = find(ps.prop, m[1], m[2]);
    if (p) return p;
  }
  return null;
}

const nonEmpty = (node) => {
  if (!node) return null;
  const t = text(node).trim();
  return t === '' ? null : t;
};

/** Build a collection descriptor from one multistatus response (null if not a calendar/address book). */
function toCollection(resp, normalize) {
  const rt = getProp(resp, PROP.resourcetype);
  if (!rt) return null;
  let kind = null;
  if (find(rt, NS.CALDAV, 'calendar')) kind = 'calendar';
  else if (find(rt, NS.CARDDAV, 'addressbook')) kind = 'addressbook';
  if (!kind || !resp.hrefs.length) return null;
  const href = normalize(resp.hrefs[0]);
  let components;
  if (kind === 'addressbook') components = ['VCARD'];
  else {
    const set = getProp(resp, PROP.componentSet);
    const names = set ? findAll(set, NS.CALDAV, 'comp').map((c) => c.attrs.name).filter(Boolean) : [];
    components = names.length ? names : DEFAULT_COMPONENTS.slice();
  }
  const priv = getProp(resp, PROP.privileges);
  const privileges = priv
    ? findAll(priv, NS.DAV, 'privilege').flatMap((p) => p.children.map((c) => c.name))
    : null;
  const segs = href.split('/').filter(Boolean);
  let name = segs.length ? segs[segs.length - 1] : '';
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the encoded form */
  }
  return {
    href,
    kind,
    name,
    components,
    displayName: nonEmpty(getProp(resp, PROP.displayname)),
    color: nonEmpty(getProp(resp, PROP.calendarColor)),
    description: nonEmpty(getProp(resp, kind === 'addressbook' ? PROP.addressbookDescription : PROP.calendarDescription)),
    ctag: nonEmpty(getProp(resp, PROP.ctag)),
    syncToken: nonEmpty(getProp(resp, PROP.syncToken)),
    etag: nonEmpty(getProp(resp, PROP.getetag)),
    privileges,
  };
}

/**
 * Can the current user write items in this collection? Unknown privileges
 * (the server did not report them) count as writable: the server stays the
 * authority and answers 403 otherwise. Note that a read-write grantee may be
 * shown 'write-properties' without being allowed to PROPPATCH.
 */
export function canWriteItems(collection) {
  const p = collection && collection.privileges;
  if (!p) return true;
  return p.includes('write-content') || p.includes('write') || p.includes('all');
}

function needEtag(etag, what) {
  if (typeof etag !== 'string' || !etag.trim() || etag.trim() === '*') {
    throw new TypeError(what + ' requires the ETag of the version being replaced (never "*")');
  }
  return etag.trim();
}

function toConflict(e, href, sentEtag) {
  if (e instanceof DavError && e.kind === 'precondition') {
    return new ConflictError({
      status: e.status, body: e.body, method: e.method, path: e.path, href, sentEtag,
      message: 'precondition failed for ' + href,
    });
  }
  return e;
}

// ----------------------------------------------------------------- client

/**
 * @param {ReturnType<import('./http.js').createTransport>} transport
 * @param {{multigetChunk?: number}} [opts]
 */
export function createClient(transport, { multigetChunk = 100 } = {}) {
  const norm = transport.normalize;

  async function dav(rq, href, { headers } = {}) {
    const r = await transport.request(rq.method, href, {
      headers: { ...XML_HEADERS, ...(headers || {}) },
      body: rq.body,
      depth: rq.depth,
    });
    return r;
  }

  async function multistatus(rq, href) {
    const r = await dav(rq, href);
    if (r.status !== 207) throw new DavError('invalid', { status: r.status, method: rq.method, path: r.path, message: 'expected 207 Multi-Status' });
    return parseMultistatus(r.text);
  }

  const inCollection = (collectionHref, href) => {
    const c = norm(collectionHref);
    const h = norm(href);
    if (!c.endsWith('/') || !h.startsWith(c) || h === c || h.slice(c.length).includes('/')) {
      throw new DavError('invalid', { message: 'href is not an item of ' + collectionHref });
    }
    return h;
  };

  function itemsOf(ms, collectionHref, dataProp) {
    const items = [];
    for (const r of ms.responses) {
      if (!r.hrefs.length) continue;
      const data = getProp(r, dataProp);
      if (!data) continue;
      const href = norm(r.hrefs[0]);
      if (href === collectionHref) continue;
      items.push({ href, etag: nonEmpty(getProp(r, PROP.getetag)), text: toLf(text(data)) });
    }
    return items;
  }

  async function multiget(collectionHref, hrefs, builder, dataProp) {
    const coll = norm(collectionHref);
    const wanted = [...new Set(hrefs.map((h) => inCollection(coll, h)))];
    const items = [];
    const missing = [];
    for (let i = 0; i < wanted.length; i += multigetChunk) {
      const chunk = wanted.slice(i, i + multigetChunk);
      const ms = await multistatus(builder(chunk), coll);
      const seen = new Set();
      for (const r of ms.responses) {
        if (!r.hrefs.length) continue;
        const href = norm(r.hrefs[0]);
        const data = getProp(r, dataProp);
        if (data) {
          seen.add(href);
          items.push({ href, etag: nonEmpty(getProp(r, PROP.getetag)), text: toLf(text(data)) });
        } else if (r.status === 404 || r.propstats.some((p) => p.status === 404)) {
          seen.add(href);
          missing.push(href);
        }
      }
      // anything the server silently omitted counts as missing
      for (const h of chunk) if (!seen.has(h)) missing.push(h);
    }
    return { items, missing };
  }

  return {
    transport,

    /** Href of the current user's principal. */
    async principal() {
      const ms = await multistatus(RQ.propfind([PROP.currentUserPrincipal], { depth: 0 }), transport.basePath);
      for (const r of ms.responses) {
        const p = getProp(r, PROP.currentUserPrincipal);
        const h = p && find(p, NS.DAV, 'href');
        if (h) return norm(text(h).trim());
      }
      throw new DavError('invalid', { message: 'the server did not report a current-user-principal' });
    },

    /** Calendar and address-book home sets of a principal (defaults to the current one). */
    async homeSets(principalHref) {
      const principal = principalHref ? norm(principalHref) : await this.principal();
      const ms = await multistatus(
        RQ.propfind([PROP.calendarHomeSet, PROP.addressbookHomeSet], { depth: 0 }),
        principal,
      );
      const collect = (qname) => {
        const out = [];
        for (const r of ms.responses) {
          const p = getProp(r, qname);
          if (p) for (const h of findAll(p, NS.DAV, 'href')) out.push(norm(text(h).trim()));
        }
        return [...new Set(out)];
      };
      let calendarHomes = collect(PROP.calendarHomeSet);
      let addressbookHomes = collect(PROP.addressbookHomeSet);
      if (!calendarHomes.length) calendarHomes = [principal];
      if (!addressbookHomes.length) addressbookHomes = [principal];
      return { principal, calendarHomes, addressbookHomes };
    },

    /** Calendars and address books directly inside a home collection. */
    async listCollections(home) {
      const h = norm(home);
      const ms = await multistatus(RQ.propfind(RQ.COLLECTION_PROPS, { depth: 1 }), h);
      const out = [];
      for (const r of ms.responses) {
        const c = toCollection(r, norm);
        if (c && c.href !== h) out.push(c);
      }
      return out;
    },

    /** One collection (PROPFIND Depth 0). Throws notfound/forbidden as the server answers. */
    async getCollection(href) {
      const h = norm(href);
      const ms = await multistatus(RQ.propfind(RQ.COLLECTION_PROPS, { depth: 0 }), h);
      for (const r of ms.responses) {
        const c = toCollection(r, norm);
        if (c) return c;
      }
      throw new DavError('invalid', { path: h, message: 'not a calendar or address book: ' + h });
    },

    /** [{href, etag}] for every item of a collection (PROPFIND Depth 1, no data). */
    async listItemEtags(href) {
      const h = norm(href);
      const ms = await multistatus(RQ.propfind([PROP.getetag, PROP.resourcetype], { depth: 1 }), h);
      const out = [];
      for (const r of ms.responses) {
        if (!r.hrefs.length) continue;
        const ih = norm(r.hrefs[0]);
        const rt = getProp(r, PROP.resourcetype);
        if (ih === h || (rt && find(rt, NS.DAV, 'collection'))) continue;
        out.push({ href: ih, etag: nonEmpty(getProp(r, PROP.getetag)) });
      }
      return out;
    },

    /** calendar-query: [{href, etag, text}] (text is LF). Time range, no server-side expansion. */
    async calendarQuery(href, { comp = 'VEVENT', start, end } = {}) {
      const h = norm(href);
      return itemsOf(await multistatus(RQ.calendarQuery({ comp, start, end }), h), h, PROP.calendarData);
    },

    /** calendar-multiget: {items: [{href, etag, text}], missing: [href]}. */
    calendarMultiget(href, hrefs) {
      return multiget(href, hrefs, (c) => RQ.calendarMultiget(c), PROP.calendarData);
    },

    /** addressbook-query: [{href, etag, text}] (text is LF). */
    async addressbookQuery(href) {
      const h = norm(href);
      return itemsOf(await multistatus(RQ.addressbookQuery(), h), h, PROP.addressData);
    },

    /** addressbook-multiget: {items, missing}. */
    addressbookMultiget(href, hrefs) {
      return multiget(href, hrefs, (c) => RQ.addressbookMultiget(c), PROP.addressData);
    },

    /**
     * sync-collection (RFC 6578). An empty/absent token lists everything.
     * @returns {{token: string, changed: {href, etag}[], removed: string[]}}
     * An invalid token surfaces as DavError kind 'forbidden' whose
     * hasCondition(NS.DAV, 'valid-sync-token') is true (see sync.js).
     */
    async syncCollection(href, token) {
      const h = norm(href);
      const ms = await multistatus(RQ.syncCollection(token || ''), h);
      if (!ms.syncToken) throw new DavError('invalid', { path: h, message: 'sync response without a sync-token' });
      const changed = [];
      const removed = [];
      for (const r of ms.responses) {
        if (!r.hrefs.length) continue;
        const ih = norm(r.hrefs[0]);
        if (ih === h) continue;
        if (r.status === 404) {
          removed.push(ih);
        } else {
          changed.push({ href: ih, etag: nonEmpty(getProp(r, PROP.getetag)) });
        }
      }
      // Radicale also lists previously deleted items as 404 entries on a full
      // (empty-token) listing; with no previous state there is nothing to remove.
      return { token: ms.syncToken, changed, removed: token ? removed : [] };
    },

    /** GET one item: {href, etag, text (LF), contentType}. */
    async getItem(href) {
      const h = norm(href);
      const r = await transport.request('GET', h);
      return { href: h, etag: r.header('etag'), text: toLf(r.text), contentType: r.header('content-type') };
    },

    /**
     * GET a whole collection (Radicale serves every item of it as one text: a VCALENDAR with
     * all components, or the vCards one after the other). Returns {href, etag, text (LF),
     * contentType, kind: 'calendar'|'addressbook'|'empty'}; an empty collection gives
     * text '' and kind 'empty'. Errors are the transport's typed DavErrors (auth, forbidden,
     * notfound, network, server ...), plus kind 'toolarge' when the body is over `maxBytes`
     * (default 32 MiB; the transport's own cap applies on top, before the body is read) and
     * kind 'invalid' when the body is neither empty nor calendar or vCard data (for example
     * an error page from a proxy).
     */
    async getCollectionText(href, { maxBytes = 32 * 1024 * 1024 } = {}) {
      const h = norm(href);
      if (!h.endsWith('/')) throw new TypeError('getCollectionText needs a collection href ending with /');
      const r = await transport.request('GET', h);
      if (r.text.length > maxBytes) throw new DavError('toolarge', { status: r.status, method: 'GET', path: h, message: 'collection is too large to export' });
      const text = toLf(r.text);
      const head = text.trimStart().slice(0, 32).toUpperCase();
      let kind;
      if (!text.trim()) kind = 'empty';
      else if (head.startsWith('BEGIN:VCALENDAR')) kind = 'calendar';
      else if (head.startsWith('BEGIN:VCARD')) kind = 'addressbook';
      else throw new DavError('invalid', { status: r.status, method: 'GET', path: h, message: 'the collection did not answer with calendar or vCard data' });
      return { href: h, etag: r.header('etag'), text: kind === 'empty' ? '' : text, contentType: r.header('content-type'), kind };
    },

    /**
     * PUT an item. Exactly one of {etag} (update, If-Match) or {create: true}
     * (If-None-Match: *) must be given. text may use any line endings; the
     * body is sent with CRLF. Resolves {href, etag, created}; a 412 throws
     * ConflictError{href, sentEtag}.
     */
    async putItem(href, itemText, opts = {}) {
      const h = norm(href);
      if (h.endsWith('/')) throw new TypeError('putItem needs an item href, not a collection');
      if (typeof itemText !== 'string' || !itemText) throw new TypeError('putItem needs the item text');
      const hasEtag = opts.etag !== undefined && opts.etag !== null;
      if (hasEtag === !!opts.create) {
        throw new TypeError('putItem needs exactly one of {etag} or {create: true}');
      }
      const headers = {
        'Content-Type': opts.contentType || (h.endsWith('.vcf') ? 'text/vcard; charset=utf-8' : 'text/calendar; charset=utf-8'),
      };
      let sent = null;
      if (hasEtag) {
        sent = needEtag(opts.etag, 'putItem');
        headers['If-Match'] = sent;
      } else {
        headers['If-None-Match'] = '*';
      }
      try {
        const r = await transport.request('PUT', h, { headers, body: toCrlf(itemText) });
        return { href: h, etag: r.header('etag'), created: r.status === 201 };
      } catch (e) {
        throw toConflict(e, h, sent);
      }
    },

    /** DELETE an item with If-Match: etag (required, never '*'). */
    async deleteItem(href, etag) {
      const h = norm(href);
      const sent = needEtag(etag, 'deleteItem');
      try {
        await transport.request('DELETE', h, { headers: { 'If-Match': sent } });
      } catch (e) {
        throw toConflict(e, h, sent);
      }
      return { href: h };
    },

    /** MKCALENDAR at href (a collection path ending in '/'). */
    async mkcalendar(href, props) {
      const h = norm(href);
      if (!h.endsWith('/')) throw new TypeError('collection href must end with /');
      const rq = RQ.mkcalendar(props || {});
      await dav(rq, h);
      return { href: h };
    },

    /** Extended MKCOL creating an address book at href. */
    async mkAddressbook(href, props) {
      const h = norm(href);
      if (!h.endsWith('/')) throw new TypeError('collection href must end with /');
      const rq = RQ.mkAddressbook(props || {});
      await dav(rq, h);
      return { href: h };
    },

    /** PROPPATCH displayName / color / description (null removes). kind: 'calendar'|'addressbook'. */
    async proppatch(href, kind, changes) {
      const h = norm(href);
      const rq = RQ.proppatch(kind, changes);
      const ms = await multistatus(rq, h);
      for (const r of ms.responses) {
        for (const ps of r.propstats) {
          if (ps.status >= 300) {
            throw new DavError(kindForStatus(ps.status) || 'invalid', { status: ps.status, method: 'PROPPATCH', path: h, message: 'property update refused' });
          }
        }
      }
      return { href: h };
    },

    /** DELETE a collection with If-Match: its etag (required, never '*'). */
    async deleteCollection(href, etag) {
      const h = norm(href);
      if (!h.endsWith('/')) throw new TypeError('collection href must end with /');
      const sent = needEtag(etag, 'deleteCollection');
      try {
        await transport.request('DELETE', h, { headers: { 'If-Match': sent } });
      } catch (e) {
        throw toConflict(e, h, sent);
      }
      return { href: h };
    },
  };
}
