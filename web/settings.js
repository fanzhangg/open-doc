// The user's settings as the page sees them. They live in one file shared by
// every doc and window, so a change here is saved through the doc host, and a
// change made elsewhere arrives as a `settings` event. While this page has
// saves in flight it ignores those events: they may be echoes of an older
// keystroke, and the last save's reply is the truth.

import { mergeSettings, resolveSettings } from '../src/core/settings.js';

/**
 * @param {object} initial settings from /api/state
 * @param {{ save: (patch: object) => Promise<object>, onError: (error: Error) => void }} options
 */
export function createSettings(initial, { save, onError }) {
  let current = resolveSettings(initial);
  let inflight = 0;
  const listeners = new Set();

  function apply(next) {
    const prev = current;
    current = resolveSettings(next);
    if (JSON.stringify(prev) === JSON.stringify(current)) return;
    for (const listener of listeners) listener(current, prev);
  }

  return {
    get: () => current,
    /** Apply `patch` here at once and save it for every doc; `agent` is partial. */
    set(patch) {
      apply(mergeSettings(current, patch));
      inflight++;
      save(patch).then(
        (saved) => {
          if (--inflight === 0) apply(saved);
        },
        (error) => {
          inflight--;
          onError(error);
        },
      );
    },
    /** A change saved by another window or run. */
    receive(next) {
      if (inflight === 0) apply(next);
    },
    /** `listener(settings, previous)` after every change, local or remote. */
    subscribe(listener) {
      listeners.add(listener);
    },
  };
}
