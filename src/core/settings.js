// The user's editor settings: one set per user, shared by every doc and every
// window. Pure, so the server and the page validate them the same way; the
// file itself is handled by src/store/settings.js.

import { NAME_PATTERN } from './mentions.js';

export const SETTINGS_VERSION = 1;

/** `name: null` means "not chosen yet": the server suggests one. */
export const DEFAULT_SETTINGS = Object.freeze({
  name: null,
  theme: 'system',
  font: 'sans',
  width: 'normal',
  outline: true,
  wordCount: false,
  focus: false,
});

const oneOf = (...values) => (v) => values.includes(v);
const boolean = (v) => typeof v === 'boolean';

const RULES = {
  name: (v) => v === null || (typeof v === 'string' && NAME_PATTERN.test(v)),
  theme: oneOf('system', 'light', 'dark'),
  font: oneOf('sans', 'serif', 'mono'),
  width: oneOf('normal', 'wide'),
  outline: boolean,
  wordCount: boolean,
  focus: boolean,
};

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_input';
  }
}

/** Throws a SettingsError unless every key of `patch` is a known setting with an allowed value. */
export function checkSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(RULES, key)) throw new SettingsError(`unknown setting: ${key}`);
    if (!RULES[key](value)) throw new SettingsError(`invalid value for ${key}`);
  }
  return patch;
}

/**
 * Settings as stored (possibly from an older or newer app, or hand-edited)
 * → a complete, valid set: known keys with allowed values are kept, the rest
 * fall back to the defaults.
 */
export function resolveSettings(stored) {
  const out = { ...DEFAULT_SETTINGS };
  if (!stored || typeof stored !== 'object') return out;
  for (const key of Object.keys(RULES)) {
    if (Object.hasOwn(stored, key) && RULES[key](stored[key])) out[key] = stored[key];
  }
  return out;
}
