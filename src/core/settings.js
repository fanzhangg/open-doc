// The user's editor settings: one set per user, shared by every doc and every
// window. Pure, so the server and the page validate them the same way; the
// file itself is handled by src/store/settings.js.

import { NAME_PATTERN } from './mentions.js';

export const SETTINGS_VERSION = 2;

/**
 * `id` is who the user is in every doc's comments, whatever their name
 * (`u_…`, made once by the doc host; null until then). `name: null` means
 * "not chosen yet": the doc host suggests one. `agent` names the agent
 * script that runs every buddy (src/store/agents.js). Buddies are files
 * (src/store/buddies.js), never settings.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  id: null,
  name: null,
  theme: 'system',
  font: 'sans',
  width: 'normal',
  outline: true,
  wordCount: false,
  focus: false,
  agent: 'claude',
});

const oneOf = (...values) => (v) => values.includes(v);
const boolean = (v) => typeof v === 'boolean';

export const USER_ID = /^u_[A-Za-z0-9_-]{6,40}$/;

const RULES = {
  id: (v) => v === null || (typeof v === 'string' && USER_ID.test(v)),
  name: (v) => v === null || (typeof v === 'string' && NAME_PATTERN.test(v)),
  theme: oneOf('system', 'light', 'dark'),
  font: oneOf('sans', 'serif', 'mono'),
  width: oneOf('normal', 'wide'),
  outline: boolean,
  wordCount: boolean,
  focus: boolean,
  agent: (v) => typeof v === 'string' && NAME_PATTERN.test(v),
};

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_input';
  }
}

/** Throws a SettingsError unless every key of `patch` is a known setting with an allowed value. */
export function checkSettingsPatch(patch) {
  if (!isObject(patch)) throw new SettingsError('settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(RULES, key)) throw new SettingsError(`unknown setting: ${key}`);
    if (!RULES[key](value)) throw new SettingsError(`invalid value for ${key}`);
  }
  return patch;
}

/** `stored` with `patch` applied: top-level keys replace. */
export function mergeSettings(stored, patch) {
  return { ...stored, ...patch };
}

/**
 * Settings as stored (possibly from a newer app, or hand-edited) → a
 * complete, valid set: known keys with allowed values are kept, the rest
 * fall back to the defaults.
 */
export function resolveSettings(stored) {
  const out = { ...DEFAULT_SETTINGS };
  if (!isObject(stored)) return out;
  for (const key of Object.keys(RULES)) {
    if (Object.hasOwn(stored, key) && RULES[key](stored[key])) out[key] = stored[key];
  }
  return out;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
