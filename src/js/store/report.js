// SPDX-License-Identifier: AGPL-3.0-or-later
// Activity and status/alert reporting for the store layer. It wraps the shell's
// activity log and feedback store (both injected, both optional) and the translator
// (replaceable: the screen's `t` changes with the language). No DOM.
//
//   reporter.log(op, target, result, detail)   Activity line; op is one of OPS
//   reporter.status(key, params)               status slot (role=status), the current screen's
//   reporter.alert(key, params, {persistent})  alert slot (role=alert); persistent = global scope,
//                                              it survives navigation until dismissed
//   reporter.text(key, params)                 translated text only

export const OPS = Object.freeze(['create', 'update', 'delete', 'import', 'export', 'mkcalendar', 'mkcol', 'proppatch', 'sync', 'conflict', 'verify', 'revoke', 'account', 'grant', 'password', 'split', 'truncate', 'move', 'complete', 'reopen']);

export function createReporter({ activity = null, feedback = null, t = null } = {}) {
  let translate = typeof t === 'function' ? t : null;
  const text = (key, params) => {
    if (!translate) return key;
    const out = translate(key, params);
    return typeof out === 'string' && out ? out : key;
  };
  return {
    setTranslator(fn) {
      translate = typeof fn === 'function' ? fn : null;
    },
    text,
    log(op, target = '', result = 'ok', detail = '') {
      if (!activity) return null;
      try {
        return activity.add({ op, target, result, detail });
      } catch {
        return null;
      }
    },
    status(key, params) {
      const s = text(key, params);
      if (feedback) feedback.setStatus(s);
      return s;
    },
    alert(key, params, { persistent = false } = {}) {
      const s = text(key, params);
      if (feedback) feedback.setAlert(s, persistent ? { scope: null } : undefined);
      return s;
    },
  };
}
