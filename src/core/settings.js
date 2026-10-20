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
 * (src/store/buddies.js), never settings. `plugins` holds each plugin's
 * switches by its id (`{ <id>: { enabled: false } }`); a switch not
 * there takes the default the plugin declares (pluginSettings).
 */
export const DEFAULT_SETTINGS = Object.freeze({
  id: null,
  name: null,
  theme: 'system',
  font: 'sans',
  width: 'normal',
  wordCount: false,
  plugins: Object.freeze({}),
  agent: 'claude',
});

const oneOf = (...values) => (v) => values.includes(v);
const boolean = (v) => typeof v === 'boolean';
const scalar = (v) => boolean(v) || typeof v === 'string' || typeof v === 'number';

export const USER_ID = /^u_[A-Za-z0-9_-]{6,40}$/;

const RULES = {
  id: (v) => v === null || (typeof v === 'string' && USER_ID.test(v)),
  name: (v) => v === null || (typeof v === 'string' && NAME_PATTERN.test(v)),
  theme: oneOf('system', 'light', 'dark'),
  font: oneOf('sans', 'serif', 'mono'),
  width: oneOf('normal', 'wide'),
  wordCount: boolean,
  plugins: (v) => isObject(v) && Object.values(v).every((one) => isObject(one) && Object.values(one).every(scalar)),
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

/** `stored` with `patch` applied: top-level keys replace, but a plugin's switches merge into its others. */
export function mergeSettings(stored, patch) {
  const next = { ...stored, ...patch };
  if (patch.plugins) {
    next.plugins = { ...objectOr(stored.plugins) };
    for (const [id, switches] of Object.entries(patch.plugins)) next.plugins[id] = { ...objectOr(next.plugins[id]), ...switches };
  }
  return next;
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
  // A plugin's bad value falls back alone (pluginSettings checks it); plugins this version does not know are kept.
  if (isObject(stored.plugins)) {
    out.plugins = Object.fromEntries(Object.entries(stored.plugins).filter(([, one]) => isObject(one))
      .map(([id, one]) => [id, Object.fromEntries(Object.entries(one).filter(([, value]) => scalar(value)))]));
  }
  return out;
}

// Whether `value` is allowed for a declared field.
const FIELD_RULES = {
  switch: (field, value) => boolean(value),
  choice: (field, value) => field.options.some(([option]) => option === value),
  number: (field, value) => Number.isInteger(value) && value >= field.min && value <= field.max,
};

/**
 * The settings of `plugin` (a declaration, web/plugins/ or src/plugins/): on
 * unless switched off (an `always` plugin cannot be), and each field of its `settings` (an ordered list of
 * { key, type: 'switch' | 'choice' | 'number', label, default, ... }, see
 * web/plugins/index.js) as stored if valid, else its default.
 */
export function pluginSettings(settings, plugin) {
  const stored = objectOr(settings.plugins[plugin.id]);
  const out = { enabled: plugin.always || (boolean(stored.enabled) ? stored.enabled : true) };
  for (const field of plugin.settings ?? []) {
    out[field.key] = FIELD_RULES[field.type](field, stored[field.key]) ? stored[field.key] : field.default;
  }
  return out;
}

const objectOr = (value) => (isObject(value) ? value : {});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
