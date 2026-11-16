// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only: both language aggregators loaded at once. The application never does this (it loads only the
// active language, js/i18n.js loadDictionary); tests that translate in several languages use createI18n from here.
import { createI18n as createBare } from '../../src/js/i18n.js';
import en from '../../src/i18n/en.js';
import fr from '../../src/i18n/fr.js';

export const DICTIONARIES = Object.freeze({ en, fr });

/** createI18n with both dictionaries preloaded (an explicit `dictionaries` option still wins). */
export function createI18n(opts = {}) {
  return createBare({ dictionaries: DICTIONARIES, ...opts });
}
