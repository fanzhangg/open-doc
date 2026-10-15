// The user's settings as the page sees them. They live in one file shared by
// every doc and window, so a change here is saved through the server, and a
// change made elsewhere arrives as a `settings` event. While this page has
// saves in flight it ignores those events: they may be echoes of an older
// keystroke, and the last save's reply is the truth.

import { DEFAULT_SETTINGS, mergeSettings, resolveSettings } from '../src/core/settings.js';

const LEGACY_DISPLAY_KEY = 'opendoc.display';
const LEGACY_NAME_KEY = 'opendoc.name';

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

/**
 * Settings an older version kept in this browser's storage, as a patch, so
 * the first run with a settings file keeps them. Empty when there are none.
 */
export function legacySettings() {
  const patch = {};
  try {
    const display = JSON.parse(localStorage.getItem(LEGACY_DISPLAY_KEY) ?? '{}');
    const name = localStorage.getItem(LEGACY_NAME_KEY);
    const resolved = resolveSettings({ ...display, name });
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === 'agent') continue; // never kept in the browser
      const given = key === 'name' ? name : display?.[key];
      if (given !== undefined && given !== null && resolved[key] === given) patch[key] = given;
    }
  } catch {
    // storage unavailable or corrupt
  }
  return patch;
}

export function forgetLegacySettings() {
  try {
    localStorage.removeItem(LEGACY_DISPLAY_KEY);
    localStorage.removeItem(LEGACY_NAME_KEY);
  } catch {
    // storage unavailable
  }
}
