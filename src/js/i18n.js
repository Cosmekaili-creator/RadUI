// SPDX-License-Identifier: AGPL-3.0-or-later
// Dictionary loader, translation function and Intl formatting helpers.
// No DOM access: the same file runs in browsers and in Node.
//
// Dictionaries are flat objects (key -> string with optional `{name}`
// placeholders). Plural forms use the keys `<key>.one`, `<key>.other` (and the
// other CLDR categories if a language needs them) and are read with `tp()`.
// Test hooks (data-testid) are never translated.
//
// Only the ACTIVE language is loaded: this file imports no dictionary. `loadDictionary()` imports
// `../i18n/<lang>.js` (default export = the dictionary) on demand; that file is the aggregator of the
// part files in the source tree and one merged file in the built tree (tools/build-dist.py). Tests that
// need every language import both aggregators themselves (tests/unit-js/_i18n-all.mjs).

export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'fr']);
export const DEFAULT_LANGUAGE = 'en';

// ---------------------------------------------------------------- loading

const defaultImporter = (lang) => import(`../i18n/${lang}.js`);

/**
 * Import one dictionary. The language is checked against the whitelist BEFORE any path is built.
 * @param {string} lang one of SUPPORTED_LANGUAGES
 * @param {(lang: string) => Promise<{default: object}>} [importer]
 * @returns {Promise<Record<string, string>>}
 */
export async function loadDictionary(lang, importer = defaultImporter, supported = SUPPORTED_LANGUAGES) {
  if (typeof lang !== 'string' || !supported.includes(lang)) throw new RangeError('unsupported language');
  const mod = await importer(lang);
  const dict = mod && mod.default;
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) throw new TypeError(`dictionary "${lang}" is not an object`);
  return dict;
}

/**
 * Per-language cache over loadDictionary: each language is imported at most once; a failed import is not
 * cached here, so a later call retries. Some browsers remember a failed module import (the same URL fails again)
 * until the page is reloaded, so a retry may need a reload to succeed.
 */
export function createDictionaryLoader({ importer = defaultImporter, supported = SUPPORTED_LANGUAGES } = {}) {
  const done = new Map(); // lang -> dictionary
  const pending = new Map(); // lang -> promise
  return {
    load(lang) {
      if (typeof lang === 'string' && done.has(lang)) return Promise.resolve(done.get(lang));
      if (typeof lang === 'string' && pending.has(lang)) return pending.get(lang);
      const p = loadDictionary(lang, importer, supported).then(
        (dict) => {
          done.set(lang, dict);
          pending.delete(lang);
          return dict;
        },
        (err) => {
          pending.delete(lang);
          throw err;
        },
      );
      if (typeof lang === 'string' && supported.includes(lang)) pending.set(lang, p);
      return p;
    },
    /** The dictionary when already loaded, else null. */
    get: (lang) => (done.has(lang) ? done.get(lang) : null),
  };
}

// ----------------------------------------------------------------- parity

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Sorted, de-duplicated placeholder names of a message. */
export function placeholders(message) {
  const names = new Set();
  for (const m of String(message).matchAll(PLACEHOLDER_RE)) names.add(m[1]);
  return [...names].sort();
}

/**
 * Compare every dictionary with the first one (the reference).
 * Problems: `missing` (key absent), `extra` (key not in the reference),
 * `empty` (blank value), `placeholders` (different `{names}`).
 * @returns {{ok: boolean, problems: {lang: string, key: string, kind: string}[]}}
 */
export function checkParity(dictionaries, reference = Object.keys(dictionaries)[0]) {
  const problems = [];
  const base = dictionaries[reference];
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(dict, key)) {
        problems.push({ lang, key, kind: 'missing' });
        continue;
      }
      if (typeof dict[key] !== 'string' || !dict[key].trim()) {
        problems.push({ lang, key, kind: 'empty' });
        continue;
      }
      if (lang !== reference && placeholders(dict[key]).join(',') !== placeholders(base[key]).join(',')) {
        problems.push({ lang, key, kind: 'placeholders' });
      }
    }
    for (const key of Object.keys(dict)) {
      if (!Object.hasOwn(base, key)) problems.push({ lang, key, kind: 'extra' });
    }
  }
  return { ok: problems.length === 0, problems };
}

// -------------------------------------------------------------- selection

/** 'fr-CH' -> 'fr' when supported, else null. */
export function matchLanguage(tag, supported = SUPPORTED_LANGUAGES) {
  if (typeof tag !== 'string') return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return supported.includes(primary) ? primary : null;
}

/**
 * Language choice, in order: the user's stored choice, the configured default,
 * the first supported language of the browser's list, then English.
 */
export function pickLanguage({ stored = null, configured = null, browser = [], supported = SUPPORTED_LANGUAGES } = {}) {
  const fromStored = matchLanguage(stored, supported);
  if (fromStored) return fromStored;
  const fromConfig = matchLanguage(configured, supported);
  if (fromConfig) return fromConfig;
  for (const tag of browser || []) {
    const m = matchLanguage(tag, supported);
    if (m) return m;
  }
  return DEFAULT_LANGUAGE;
}

// ------------------------------------------------------------ translation

/**
 * @param {object} [opts]
 * @param {Record<string, Record<string,string>>} [opts.dictionaries] already loaded dictionaries (may be empty:
 *   every key then answers with itself until `addDictionary`)
 * @param {string} [opts.lang]
 * @param {string} [opts.fallback] language used for keys missing in `lang`
 * @param {(key: string, lang: string) => void} [opts.onMissing]
 */
export function createI18n({ dictionaries: initial = {}, lang = DEFAULT_LANGUAGE, fallback = DEFAULT_LANGUAGE, onMissing } = {}) {
  const dictionaries = { ...initial };
  let current = Object.hasOwn(dictionaries, lang) ? lang : fallback;

  function lookup(key) {
    const own = dictionaries[current];
    if (own && Object.hasOwn(own, key)) return own[key];
    const fb = dictionaries[fallback];
    if (fb && Object.hasOwn(fb, key)) return fb[key];
    return null;
  }

  function interpolate(message, params) {
    if (!params) return message;
    return message.replace(PLACEHOLDER_RE, (whole, name) => (Object.hasOwn(params, name) && params[name] !== undefined && params[name] !== null ? String(params[name]) : whole));
  }

  /** Translate `key`; an unknown key returns the key itself (never throws). */
  function t(key, params) {
    const message = lookup(key);
    if (message === null) {
      if (onMissing) onMissing(key, current);
      return key;
    }
    return interpolate(message, params);
  }

  /** Plural form for `n`: `<key>.<category>` with `<key>.other` as fallback. */
  function tp(key, n, params) {
    let category = 'other';
    try {
      category = new Intl.PluralRules(current).select(n);
    } catch {
      /* keep 'other' */
    }
    const k = lookup(`${key}.${category}`) !== null ? `${key}.${category}` : `${key}.other`;
    return t(k, { n, ...(params || {}) });
  }

  return {
    t,
    tp,
    has: (key) => lookup(key) !== null,
    get lang() {
      return current;
    },
    /** Register a loaded dictionary (replaces a previous one of the same language). */
    addDictionary(code, dict) {
      if (typeof code !== 'string' || !dict || typeof dict !== 'object') return false;
      dictionaries[code] = dict;
      return true;
    },
    /** Switch to a language whose dictionary was added; false (and no change) otherwise. */
    setLang(next) {
      if (!Object.hasOwn(dictionaries, next)) return false;
      current = next;
      return true;
    },
    languages: () => Object.keys(dictionaries),
  };
}

// ------------------------------------------------------- language switching

/**
 * The switch logic of the language select, free of DOM so it can be tested: load the dictionary FIRST,
 * then change the language and call `onApplied(code)`; a failed load changes nothing and calls
 * `onFailed(code, error)`. Only the newest request wins (an older answer arriving late is dropped).
 * `begin()` returns the function to call when loading ended (the shell uses it for the busy state).
 * Nothing is written anywhere here: persistence is the caller's `onApplied`.
 */
export function createLanguageSwitcher({ i18n, loader, supported = SUPPORTED_LANGUAGES, begin = () => () => {}, onApplied = () => {}, onFailed = () => {} }) {
  let ticket = 0;
  return async function switchTo(code) {
    if (typeof code !== 'string' || !supported.includes(code)) return false;
    const mine = ++ticket;
    if (code === i18n.lang) return true; // also cancels an older request for another language
    const end = begin();
    let dict;
    try {
      dict = loader.get(code) || (await loader.load(code));
    } catch (err) {
      end();
      if (mine === ticket) onFailed(code, err);
      return false;
    }
    end();
    if (mine !== ticket) return false;
    i18n.addDictionary(code, dict);
    if (!i18n.setLang(code)) return false;
    onApplied(code);
    return true;
  };
}

// ------------------------------------------------------------- Intl helpers

/** True if the runtime knows this IANA time zone name. */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The configured zone, or the browser's own zone when none is configured. */
export function resolveTimeZone(configured) {
  if (configured && isValidTimeZone(configured)) return configured;
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** ISO weekday number of the first day of the week for a language: 1 = Monday ... 7 = Sunday. */
export function localeFirstWeekday(lang) {
  try {
    const loc = new Intl.Locale(lang);
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info && Number.isInteger(info.firstDay) && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay;
  } catch {
    /* fall through */
  }
  return 1;
}

/** The configured first weekday (1-7), or the locale's. */
export function resolveFirstWeekday(configured, lang) {
  return Number.isInteger(configured) && configured >= 1 && configured <= 7 ? configured : localeFirstWeekday(lang);
}

const toDate = (v) => (v instanceof Date ? v : new Date(v));

/** Locale-aware formatters; `timeZone` defaults to the browser's zone. */
export function formatDateTime(value, { lang = DEFAULT_LANGUAGE, timeZone, dateStyle = 'medium', timeStyle = 'short', hour12 = false } = {}) {
  return new Intl.DateTimeFormat(lang, { dateStyle, timeStyle, timeZone, hourCycle: hour12 ? 'h12' : 'h23' }).format(toDate(value));
}

export function formatDate(value, { lang = DEFAULT_LANGUAGE, timeZone, dateStyle = 'medium' } = {}) {
  return new Intl.DateTimeFormat(lang, { dateStyle, timeZone }).format(toDate(value));
}

export function formatTime(value, { lang = DEFAULT_LANGUAGE, timeZone, hour12 = false, withSeconds = false } = {}) {
  return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hourCycle: hour12 ? 'h12' : 'h23', timeZone }).format(toDate(value));
}

export function formatNumber(value, { lang = DEFAULT_LANGUAGE, ...options } = {}) {
  return new Intl.NumberFormat(lang, options).format(value);
}
