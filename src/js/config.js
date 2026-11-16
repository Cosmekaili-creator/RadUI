// SPDX-License-Identifier: AGPL-3.0-or-later
// Deployment configuration: `config.json` is served next to index.html. Nothing
// in the code knows a host name, a base path or a time zone; every default here
// is neutral and relative.
//
//   basePath          where the application is served; relative values are
//                     resolved against the page (default "./")
//   radicaleBasePath  where the CalDAV/CardDAV server answers (default "/")
//   apiBasePath       where the account service answers; relative values are
//                     resolved against basePath (default "api/")
//   defaultLanguage   "en" | "fr" | null (null: the browser's language)
//   defaultTimeZone   IANA name | null (null: the browser's own zone)
//   firstWeekday      1 (Monday) ... 7 (Sunday) | null (null: from the locale)
//   appTitle          name shown in the header and the document title
//   sourceUrl         https: address of the source code of THIS deployment's build (shown in Settings, About;
//                     AGPL section 13: set it when you run a modified version); "" shows a neutral sentence
//   debug             true shows test scaffolding on #/debug (default false);
//                     `#/debug?debug=1` in the address does the same for one visit

import { SUPPORTED_LANGUAGES, isValidTimeZone, matchLanguage } from './i18n.js';

export const DEFAULT_CONFIG = Object.freeze({
  basePath: './',
  radicaleBasePath: '/',
  apiBasePath: 'api/',
  defaultLanguage: null,
  defaultTimeZone: null,
  firstWeekday: null,
  appTitle: 'RadUI',
  sourceUrl: '',
  debug: false,
});

export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG));
export const CONFIG_URL = 'config.json';

const MAX_TITLE = 40;
const MAX_URL = 300;

/** An https: address without credentials, control characters or spaces (the only kind of source link accepted). */
export function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f-\u00a0\\]/.test(value)) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.host !== '' && !u.username && !u.password;
}
const MAX_PATH = 256;

/** A same-origin path (absolute or relative): no scheme, no network-path reference, no query, no control characters. */
export function isSafePath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\?#]/.test(value)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false; // scheme
  if (value.startsWith('//')) return false; // protocol-relative
  return true;
}

/**
 * Validate a parsed config.json. Never throws: every invalid or unknown entry
 * produces a warning and falls back to the default.
 * @returns {{config: typeof DEFAULT_CONFIG, warnings: {key: string, code: string, message: string}[]}}
 */
export function validateConfig(raw, { languages = SUPPORTED_LANGUAGES } = {}) {
  const config = { ...DEFAULT_CONFIG };
  const warnings = [];
  const warn = (key, code, message) => warnings.push({ key, code, message });

  if (raw === undefined || raw === null) return { config, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('', 'not-an-object', 'config.json must contain a JSON object');
    return { config, warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) warn(key, 'unknown-key', `unknown key "${key}" ignored`);
  }

  for (const key of ['basePath', 'radicaleBasePath', 'apiBasePath']) {
    if (!(key in raw)) continue;
    if (isSafePath(raw[key])) config[key] = raw[key];
    else warn(key, 'bad-value', `${key} must be a same-origin path (no scheme, no "//", no query)`);
  }

  if ('defaultLanguage' in raw && raw.defaultLanguage !== null) {
    const m = matchLanguage(raw.defaultLanguage, languages);
    if (m) config.defaultLanguage = m;
    else warn('defaultLanguage', 'bad-value', `defaultLanguage must be null or one of: ${languages.join(', ')}`);
  }

  if ('defaultTimeZone' in raw && raw.defaultTimeZone !== null) {
    if (isValidTimeZone(raw.defaultTimeZone)) config.defaultTimeZone = raw.defaultTimeZone;
    else warn('defaultTimeZone', 'bad-value', 'defaultTimeZone must be null or an IANA time zone name');
  }

  if ('firstWeekday' in raw && raw.firstWeekday !== null) {
    if (Number.isInteger(raw.firstWeekday) && raw.firstWeekday >= 1 && raw.firstWeekday <= 7) config.firstWeekday = raw.firstWeekday;
    else warn('firstWeekday', 'bad-value', 'firstWeekday must be null or an integer from 1 (Monday) to 7 (Sunday)');
  }

  if ('appTitle' in raw) {
    // eslint-disable-next-line no-control-regex
    const ok = typeof raw.appTitle === 'string' && raw.appTitle.trim() && raw.appTitle.trim().length <= MAX_TITLE && !/[\u0000-\u001f\u007f]/.test(raw.appTitle);
    if (ok) config.appTitle = raw.appTitle.trim();
    else warn('appTitle', 'bad-value', `appTitle must be a non-empty string of at most ${MAX_TITLE} characters`);
  }

  if ('sourceUrl' in raw) {
    const v = typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim() : raw.sourceUrl;
    if (v === '' || isHttpsUrl(v)) config.sourceUrl = v;
    else warn('sourceUrl', 'bad-value', 'sourceUrl must be empty or an https: address');
  }

  if ('debug' in raw) {
    if (typeof raw.debug === 'boolean') config.debug = raw.debug;
    else warn('debug', 'bad-value', 'debug must be true or false');
  }

  return { config, warnings };
}

/**
 * Fetch and validate config.json. A missing file (404) means "use the defaults"
 * and is not a warning; an unreadable or invalid file is.
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.url]
 * @returns {Promise<{config: object, warnings: object[], source: 'file'|'defaults'}>}
 */
export async function loadConfig({ fetchImpl, url = CONFIG_URL } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const fallback = (warnings) => ({ config: { ...DEFAULT_CONFIG }, warnings, source: 'defaults' });
  if (!doFetch) return fallback([{ key: '', code: 'unreadable', message: 'no fetch implementation available' }]);
  let resp;
  try {
    resp = await doFetch(url, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } });
  } catch {
    return fallback([{ key: '', code: 'unreadable', message: 'config.json could not be fetched' }]);
  }
  if (resp.status === 404) return fallback([]);
  if (!resp.ok) return fallback([{ key: '', code: 'unreadable', message: `config.json answered HTTP ${resp.status}` }]);
  let parsed;
  try {
    parsed = JSON.parse(await resp.text());
  } catch {
    return fallback([{ key: '', code: 'unreadable', message: 'config.json is not valid JSON' }]);
  }
  const { config, warnings } = validateConfig(parsed);
  return { config, warnings, source: 'file' };
}

const withSlash = (p) => (p.endsWith('/') ? p : p + '/');

/**
 * Turn the configured paths into absolute same-origin paths with a trailing
 * slash. `baseHref` is the page URL (document.baseURI); the application must be
 * served from a directory URL (with its trailing slash) for "./" to work.
 * @returns {{appBase: string, apiBase: string, radicaleBase: string}}
 */
export function resolveBases(config, baseHref) {
  const page = new URL(baseHref);
  const appUrl = new URL(config.basePath, page);
  const appBase = withSlash(appUrl.pathname);
  const appDir = new URL(appBase, page);
  return {
    appBase,
    apiBase: withSlash(new URL(config.apiBasePath, appDir).pathname),
    radicaleBase: withSlash(new URL(config.radicaleBasePath, appDir).pathname),
  };
}

export const BUILD_INFO_URL = 'build-info.json';

/**
 * The version label of a built tree (`build-info.json` `source`, written by tools/build-dist.py), or null:
 * a source tree has no such file, and anything unreadable or odd counts as "no information".
 * @returns {Promise<{source: string, minified: boolean|null}|null>}
 */
export async function loadBuildInfo({ fetchImpl, url = BUILD_INFO_URL } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!doFetch) return null;
  try {
    const resp = await doFetch(url, { cache: 'no-cache', credentials: 'omit', headers: { Accept: 'application/json' } });
    if (!resp.ok) return null;
    const raw = JSON.parse(await resp.text());
    if (!raw || typeof raw !== 'object' || typeof raw.source !== 'string' || !/^[A-Za-z0-9._+~-]{1,64}$/.test(raw.source)) return null;
    return { source: raw.source, minified: typeof raw.minified === 'boolean' ? raw.minified : null };
  } catch {
    return null;
  }
}
