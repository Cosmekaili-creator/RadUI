// SPDX-License-Identifier: AGPL-3.0-or-later
// Debounce and a throttled announcer for polite status text, with injectable timers so the
// logic is testable without waiting. DOM-free.

const defaultTimers = () => ({ setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });

/**
 * Trailing debounce: `fn` runs `ms` after the last call, with the last arguments.
 * The returned function has `cancel()`, `flush()` (run now if a call is pending) and `pending`.
 */
export function debounce(fn, ms, timers = defaultTimers()) {
  let handle = null;
  let args = null;
  const run = () => {
    handle = null;
    const a = args;
    args = null;
    fn(...a);
  };
  const wrapped = (...a) => {
    args = a;
    if (handle !== null) timers.clearTimeout(handle);
    handle = timers.setTimeout(run, ms);
  };
  wrapped.cancel = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
    args = null;
  };
  wrapped.flush = () => {
    if (handle === null) return;
    timers.clearTimeout(handle);
    run();
  };
  Object.defineProperty(wrapped, 'pending', { get: () => handle !== null });
  return wrapped;
}

/**
 * Throttled status text for a polite live region: `push(text)` keeps only the latest text and applies it
 * at most once every `ms`; `flush(text)` applies a final text at once (done, failed, cancelled) and drops
 * what was waiting. Nothing disappears by itself: the text stays until replaced.
 * @param {{apply: (text: string) => void, ms?: number, timers?: object}} o
 */
export function createAnnouncer({ apply, ms = 1500, timers = defaultTimers() }) {
  let handle = null;
  let latest = null;
  let last = null;
  const fire = () => {
    handle = null;
    if (latest !== null && latest !== last) {
      last = latest;
      apply(latest);
    }
    latest = null;
  };
  return {
    push(text) {
      latest = String(text);
      if (handle === null) handle = timers.setTimeout(fire, ms);
    },
    flush(text) {
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
      latest = null;
      if (text !== undefined && text !== last) {
        last = String(text);
        apply(last);
      }
    },
    cancel() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
      latest = null;
    },
    get pending() {
      return handle !== null;
    },
  };
}
