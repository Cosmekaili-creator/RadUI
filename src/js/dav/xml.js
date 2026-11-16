// SPDX-License-Identifier: AGPL-3.0-or-later
// Namespace-aware XML parser and builder for WebDAV bodies.
//
// Runs unchanged in browsers and Node (no DOM). Security model:
//   - any DOCTYPE, ENTITY or other markup declaration is rejected, so no
//     external or internal entity can ever be defined (no XXE, no entity bombs);
//   - only the five predefined entities and numeric character references are
//     decoded, and each reference yields at most one character, so decoding can
//     never expand the input;
//   - hard limits on input size, nesting depth, element count, attribute count
//     and name length (see DEFAULT_LIMITS).
//
// Parsed node:   { ns, name, attrs, children, text }
//   ns        namespace URI ('' when none), name = local name
//   attrs     { key: value } where key is the local name for an attribute
//             without namespace and '{uri}local' for a namespaced one
//             (xmlns declarations are consumed, not listed)
//   children  child elements only, in document order
//   text      the element's direct text and CDATA, concatenated
// Literal CRLF and lone CR in the input become LF. A numeric reference such as
// &#13; is kept as written (XML rule); callers that need LF normalise again.

export class XmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlError';
  }
}

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024, // string length of the document
  maxDepth: 64,
  maxElements: 500000,
  maxAttributes: 32, // per element, xmlns declarations included
  maxNameLength: 256,
});

/** Well-known namespaces. */
export const NS = Object.freeze({
  DAV: 'DAV:',
  CALDAV: 'urn:ietf:params:xml:ns:caldav',
  CARDDAV: 'urn:ietf:params:xml:ns:carddav',
  CS: 'http://calendarserver.org/ns/',
  ICAL: 'http://apple.com/ns/ical/',
  XML: 'http://www.w3.org/XML/1998/namespace',
});

const NAME_RE = /[A-Za-z_:À-￿][A-Za-z0-9_.:\-·À-￿]*/y;
const SPACE_RE = /[ \t\r\n]*/y;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const NCNAME_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function validCodePoint(cp) {
  return (
    cp === 0x9 || cp === 0xa || cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&([^&;\s<]*)(;?)/g, (m, body, semi) => {
    if (!semi) throw new XmlError('unterminated entity reference');
    if (Object.prototype.hasOwnProperty.call(PREDEFINED, body)) return PREDEFINED[body];
    let cp = NaN;
    let r;
    if ((r = /^#([0-9]{1,8})$/.exec(body))) cp = parseInt(r[1], 10);
    else if ((r = /^#x([0-9A-Fa-f]{1,8})$/.exec(body))) cp = parseInt(r[1], 16);
    else throw new XmlError('undefined entity &' + body.slice(0, 32) + ';');
    if (!validCodePoint(cp)) throw new XmlError('invalid character reference');
    return String.fromCodePoint(cp);
  });
}

/**
 * Parse an XML document and return its root element node.
 * @param {string} src
 * @param {Partial<typeof DEFAULT_LIMITS>} [limitOverrides]
 */
export function parseXml(src, limitOverrides) {
  const L = limitOverrides ? { ...DEFAULT_LIMITS, ...limitOverrides } : DEFAULT_LIMITS;
  if (typeof src !== 'string') throw new XmlError('XML input must be a string');
  if (src.length > L.maxBytes) throw new XmlError('document too large');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (CONTROL_RE.test(src)) throw new XmlError('forbidden control character');
  if (src.indexOf('\r') >= 0) src = src.replace(/\r\n?/g, '\n');

  const n = src.length;
  let pos = 0;
  let elementCount = 0;
  let root = null;
  /** @type {{node: object, scope: object, qname: string}[]} */
  const stack = [];
  const baseScope = Object.create(null);
  baseScope.xml = NS.XML;

  const fail = (msg) => {
    throw new XmlError(msg + ' (offset ' + pos + ')');
  };
  const skipSpace = () => {
    SPACE_RE.lastIndex = pos;
    SPACE_RE.exec(src);
    pos = SPACE_RE.lastIndex;
  };
  const readName = () => {
    NAME_RE.lastIndex = pos;
    const m = NAME_RE.exec(src);
    if (!m) fail('name expected');
    if (m[0].length > L.maxNameLength) fail('name too long');
    pos += m[0].length;
    return m[0];
  };
  const splitQName = (q) => {
    const i = q.indexOf(':');
    if (i < 0) return ['', q];
    const prefix = q.slice(0, i);
    const local = q.slice(i + 1);
    if (!prefix || !local || local.indexOf(':') >= 0) fail('malformed qualified name');
    return [prefix, local];
  };

  // prolog: optional XML declaration, then misc
  if (src.startsWith('<?xml') && /[ \t\n?]/.test(src.charAt(5))) {
    const end = src.indexOf('?>');
    if (end < 0) fail('unterminated XML declaration');
    pos = end + 2;
  }

  while (pos < n) {
    if (src.charCodeAt(pos) !== 60 /* < */) {
      // character data
      let next = src.indexOf('<', pos);
      if (next < 0) next = n;
      const raw = src.slice(pos, next);
      if (!stack.length) {
        if (raw.trim() !== '') fail('text outside the root element');
      } else {
        stack[stack.length - 1].node.text += decodeEntities(raw);
      }
      pos = next;
      continue;
    }
    if (src.startsWith('<!--', pos)) {
      const end = src.indexOf('-->', pos + 4);
      if (end < 0) fail('unterminated comment');
      pos = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', pos)) {
      if (!stack.length) fail('CDATA outside the root element');
      const end = src.indexOf(']]>', pos + 9);
      if (end < 0) fail('unterminated CDATA section');
      stack[stack.length - 1].node.text += src.slice(pos + 9, end);
      pos = end + 3;
      continue;
    }
    if (src.startsWith('<?', pos)) {
      const end = src.indexOf('?>', pos + 2);
      if (end < 0) fail('unterminated processing instruction');
      pos = end + 2;
      continue;
    }
    if (src.startsWith('<!', pos)) {
      fail('DOCTYPE and markup declarations are not allowed');
    }
    if (src.charCodeAt(pos + 1) === 47 /* / */) {
      // end tag
      pos += 2;
      const q = readName();
      skipSpace();
      if (src.charCodeAt(pos) !== 62) fail('malformed end tag');
      pos++;
      const top = stack.pop();
      if (!top || top.qname !== q) fail('mismatched end tag </' + q + '>');
      continue;
    }
    // start tag
    pos++;
    if (root && !stack.length) fail('more than one root element');
    if (stack.length >= L.maxDepth) fail('nesting too deep');
    if (++elementCount > L.maxElements) fail('too many elements');
    const qname = readName();
    const rawAttrs = [];
    let selfClose = false;
    for (;;) {
      const before = pos;
      skipSpace();
      const c = src.charCodeAt(pos);
      if (c === 62) { pos++; break; }
      if (c === 47 && src.charCodeAt(pos + 1) === 62) { pos += 2; selfClose = true; break; }
      if (pos === before) fail('whitespace expected before attribute');
      if (pos >= n) fail('unterminated start tag');
      const an = readName();
      skipSpace();
      if (src.charCodeAt(pos) !== 61) fail('attribute without value');
      pos++;
      skipSpace();
      const quote = src.charCodeAt(pos);
      if (quote !== 34 && quote !== 39) fail('attribute value must be quoted');
      const end = src.indexOf(quote === 34 ? '"' : "'", pos + 1);
      if (end < 0) fail('unterminated attribute value');
      const rawVal = src.slice(pos + 1, end);
      if (rawVal.indexOf('<') >= 0) fail('"<" in attribute value');
      pos = end + 1;
      if (rawAttrs.length >= L.maxAttributes) fail('too many attributes');
      rawAttrs.push([an, decodeEntities(rawVal.replace(/[\t\n]/g, ' '))]);
    }
    // namespace scope
    const parentScope = stack.length ? stack[stack.length - 1].scope : baseScope;
    let scope = parentScope;
    for (const [an, av] of rawAttrs) {
      if (an === 'xmlns' || an.startsWith('xmlns:')) {
        if (scope === parentScope) scope = Object.create(parentScope);
        if (an === 'xmlns') scope[''] = av;
        else {
          const p = an.slice(6);
          if (!p || p === 'xmlns' || p === 'xml' || av === '') fail('invalid namespace declaration');
          scope[p] = av;
        }
      }
    }
    const [prefix, local] = splitQName(qname);
    const uri = scope[prefix];
    if (prefix && uri === undefined) fail('unbound namespace prefix "' + prefix + '"');
    const attrs = Object.create(null);
    for (const [an, av] of rawAttrs) {
      if (an === 'xmlns' || an.startsWith('xmlns:')) continue;
      const [ap, al] = splitQName(an);
      let key = al;
      if (ap) {
        const au = scope[ap];
        if (au === undefined) fail('unbound namespace prefix "' + ap + '"');
        key = '{' + au + '}' + al;
      }
      if (key in attrs) fail('duplicate attribute "' + an + '"');
      attrs[key] = av;
    }
    const node = { ns: uri || '', name: local, attrs, children: [], text: '' };
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else root = node;
    if (!selfClose) stack.push({ node, scope, qname });
  }
  if (stack.length) fail('unclosed element <' + stack[stack.length - 1].qname + '>');
  if (!root) fail('no root element');
  return root;
}

// ---------------------------------------------------------------- reading

/** True when the node is the element {ns}name. */
export function is(node, ns, name) {
  return !!node && node.ns === ns && node.name === name;
}

/** First direct child {ns}name, or null. */
export function find(node, ns, name) {
  if (!node) return null;
  for (const c of node.children) if (c.ns === ns && c.name === name) return c;
  return null;
}

/** All direct children {ns}name. */
export function findAll(node, ns, name) {
  return node ? node.children.filter((c) => c.ns === ns && c.name === name) : [];
}

/** Follow a path of [ns, name] pairs through first matching children. */
export function findPath(node, path) {
  let cur = node;
  for (const [ns, name] of path) {
    cur = find(cur, ns, name);
    if (!cur) return null;
  }
  return cur;
}

/** Full text content of a node (all descendants), not trimmed. */
export function text(node) {
  if (!node) return '';
  if (!node.children.length) return node.text;
  let out = node.text;
  for (const c of node.children) out += text(c);
  return out;
}

// --------------------------------------------------------------- building

const KNOWN_PREFIX = {
  [NS.DAV]: 'D',
  [NS.CALDAV]: 'C',
  [NS.CARDDAV]: 'CR',
  [NS.CS]: 'CS',
  [NS.ICAL]: 'IC',
};

/** Escape character data and attribute values. */
export function xmlEscape(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

function splitClark(qname) {
  const m = /^\{([^{}]*)\}(.+)$/.exec(qname);
  const ns = m ? m[1] : '';
  const name = m ? m[2] : qname;
  if (!NCNAME_RE.test(name)) throw new TypeError('invalid XML element name: ' + qname);
  return [ns, name];
}

/**
 * Build an element. qname is '{namespace}local' (or plain 'local').
 * attrs is null or { name: value } (a '{ns}name' key makes a namespaced
 * attribute; undefined/null values are skipped). Children may be nodes,
 * strings or numbers (text), arrays (flattened); null/undefined/false skipped.
 */
export function el(qname, attrs, ...children) {
  const [ns, name] = splitClark(qname);
  const node = { ns, name, attrs: Object.create(null), children: [], text: '' };
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      splitClark(k);
      node.attrs[k] = String(attrs[k]);
    }
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else if (typeof c === 'string' || typeof c === 'number') node.text += String(c);
    else if (typeof c === 'object' && typeof c.name === 'string' && Array.isArray(c.children)) node.children.push(c);
    else throw new TypeError('invalid child for <' + name + '>');
  };
  children.forEach(add);
  return node;
}

/**
 * Serialise a node tree (text first, then child elements). Namespaces are
 * declared once on the root element with fixed prefixes for the DAV family.
 */
export function serializeXml(root, { declaration = true } = {}) {
  const prefixes = new Map(); // uri -> prefix
  let counter = 0;
  const register = (uri) => {
    if (!uri || prefixes.has(uri)) return;
    let p = KNOWN_PREFIX[uri];
    if (!p) p = 'ns' + ++counter;
    prefixes.set(uri, p);
  };
  const walkNs = (node, depth) => {
    if (depth > DEFAULT_LIMITS.maxDepth) throw new XmlError('tree too deep');
    register(node.ns);
    for (const k of Object.keys(node.attrs)) {
      const m = /^\{([^{}]*)\}/.exec(k);
      if (m) register(m[1]);
    }
    node.children.forEach((c) => walkNs(c, depth + 1));
  };
  walkNs(root, 0);
  const nsAttr = [...prefixes].map(([u, p]) => ' xmlns:' + p + '="' + xmlEscape(u) + '"').join('');
  const out = [];
  const emit = (node, isRoot) => {
    const tag = (node.ns ? prefixes.get(node.ns) + ':' : '') + node.name;
    let s = '<' + tag + (isRoot ? nsAttr : '');
    for (const k of Object.keys(node.attrs)) {
      const m = /^\{([^{}]*)\}(.+)$/.exec(k);
      const an = m ? prefixes.get(m[1]) + ':' + m[2] : k;
      s += ' ' + an + '="' + xmlEscape(node.attrs[k]) + '"';
    }
    if (!node.text && !node.children.length) {
      out.push(s + '/>');
      return;
    }
    out.push(s + '>');
    if (node.text) out.push(xmlEscape(node.text));
    node.children.forEach((c) => emit(c, false));
    out.push('</' + tag + '>');
  };
  emit(root, true);
  return (declaration ? '<?xml version="1.0" encoding="utf-8"?>\n' : '') + out.join('');
}
