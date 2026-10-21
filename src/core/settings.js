// The user's editor settings: one set per user, shared by every doc and every
// window. Pure, so the server and the page validate them the same way; the
// file itself is handled by src/store/settings.js.

import { NAME_PATTERN } from './mentions.js';

export const SETTINGS_VERSION = 3;

/**
 * `id` is who the user is in every doc's comments, whatever their name
 * (`u_…`, made once by the doc host; null until then). `name: null` means
 * "not chosen yet": the doc host suggests one. `about` is who the user is, as a
 * buddy's is, and goes to every buddy that answers them. `agent` names the agent
 * that runs every buddy (src/store/agents.js). Buddies are files
 * (src/store/buddies.js), never settings. `views`, `rules` and `agents` hold the
 * settings of each view, rule and agent by its id (`{ <id>: { enabled: false } }`);
 * one not there takes the default its declaration gives (viewSettings,
 * ruleSettings, agentSettings).
 */
export const DEFAULT_SETTINGS = Object.freeze({
  id: null,
  name: null,
  about: '',
  theme: 'system',
  views: Object.freeze({}),
  rules: Object.freeze({}),
  agents: Object.freeze({}),
  agent: 'claude',
});

const oneOf = (...values) => (v) => values.includes(v);
const boolean = (v) => typeof v === 'boolean';
const scalar = (v) => boolean(v) || typeof v === 'string' || typeof v === 'number';

export const USER_ID = /^u_[A-Za-z0-9_-]{6,40}$/;

const VALID = {
  id: (v) => v === null || (typeof v === 'string' && USER_ID.test(v)),
  name: (v) => v === null || (typeof v === 'string' && NAME_PATTERN.test(v)),
  about: (v) => typeof v === 'string' && !v.includes('\0'),
  theme: oneOf('system', 'light', 'dark'),
  views: perId,
  rules: perId,
  agents: perId,
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
    if (!Object.hasOwn(VALID, key)) throw new SettingsError(`unknown setting: ${key}`);
    if (!VALID[key](value)) throw new SettingsError(`invalid value for ${key}`);
  }
  return patch;
}

/** `stored` with `patch` applied: top-level keys replace, but a view's, rule's or agent's settings merge into its others. */
export function mergeSettings(stored, patch) {
  const next = { ...stored, ...patch };
  for (const kind of KINDS) {
    if (!patch[kind]) continue;
    next[kind] = { ...objectOr(stored[kind]) };
    for (const [id, own] of Object.entries(patch[kind])) next[kind][id] = { ...objectOr(next[kind][id]), ...own };
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
  for (const key of Object.keys(VALID)) {
    if (Object.hasOwn(stored, key) && VALID[key](stored[key])) out[key] = stored[key];
  }
  // A bad value falls back alone (viewSettings checks it); ids this version does not know are kept.
  for (const kind of KINDS) {
    if (!isObject(stored[kind])) continue;
    out[kind] = Object.fromEntries(Object.entries(stored[kind]).filter(([, one]) => isObject(one))
      .map(([id, one]) => [id, Object.fromEntries(Object.entries(one).filter(([, value]) => scalar(value)))]));
  }
  return out;
}

// Whether `value` is allowed for a declared field. A secret is never in
// the settings: it comes from the system keychain (agentSettings).
const FIELD_RULES = {
  switch: (field, value) => boolean(value),
  choice: (field, value) => field.options.some(([option]) => option === value),
  number: (field, value) => Number.isInteger(value) && value >= field.min && value <= field.max,
  text: (field, value) => typeof value === 'string' && !/[\n\r\0]/.test(value),
  secret: (field, value) => value !== '' && FIELD_RULES.text(field, value),
};

/**
 * The settings of `view` (a declaration, web/views/): on unless switched off
 * (an `always` view cannot be), and each field of its `settings` (an ordered
 * list of { key, type: 'switch' | 'choice' | 'number', label, default, ... },
 * see web/views/index.js) as stored if valid, else its default.
 */
export const viewSettings = (settings, view) => declared(settings.views[view.id], view);

/** The settings of `rule` (a declaration, src/rules/): `{ enabled }`, on unless switched off. */
export const ruleSettings = (settings, rule) => declared(settings.rules[rule.id], rule);

/**
 * The settings of `agent` (a declaration, agentOf): each field as stored if
 * valid, else its default; a secret from `secrets`, the agent's decrypted
 * ones, else none.
 */
export const agentSettings = (settings, agent, secrets = {}) => values(objectOr(settings.agents[agent.id]), agent.settings, secrets);

/**
 * Agent `id` (a program's file name) as its manifest `{ name, about,
 * settings }` declares it (docs/agent-config.md#agents), its `settings` as a
 * view's fields with the types `text` and `secret` too: `{ id, name, about,
 * settings }`. With no manifest, or one that is not valid, it is its file
 * name, with no settings.
 */
export function agentOf(id, manifest) {
  const { name, about = '', settings = [] } = objectOr(manifest);
  const valid = typeof name === 'string' && name.trim() !== '' && typeof about === 'string' && Array.isArray(settings)
    && settings.every(validField) && new Set(settings.map((field) => field.key)).size === settings.length;
  return valid ? { id, name, about, settings } : { id, name: id, about: '', settings: [] };
}

// A field a manifest may declare. Its key names its variable, OPENDOC_SETTING_<KEY>.
function validField(field) {
  if (!isObject(field) || !/^[a-z][a-z0-9_]*$/.test(field.key) || !Object.hasOwn(FIELD_RULES, field.type) || typeof field.label !== 'string') return false;
  if (!['hint', 'group'].every((key) => typeof (field[key] ?? '') === 'string') || !isObject(field.when ?? {})) return false;
  if (field.type === 'choice' && !(Array.isArray(field.options) && field.options.every((o) => Array.isArray(o) && scalar(o[0]) && typeof o[1] === 'string'))) return false;
  if (field.type === 'number' && !(Number.isInteger(field.min) && Number.isInteger(field.max))) return false;
  return field.type === 'secret' ? field.default === undefined : FIELD_RULES[field.type](field, field.default);
}

/** Whether `declaration` (a view or a rule) claims the file named `name`, by its extension in any case. */
export const claims = (declaration, name) => declaration.extensions.includes(/\.([^./\\]+)$/.exec(name)?.[1].toLowerCase());

function declared(own, declaration) {
  const stored = objectOr(own);
  return { enabled: declaration.always || (boolean(stored.enabled) ? stored.enabled : true), ...values(stored, declaration.settings) };
}

// Each of `fields` as stored if valid, else its default; a secret from `secrets` only.
function values(stored, fields = [], secrets = {}) {
  return Object.fromEntries(fields.map((field) => {
    const value = (field.type === 'secret' ? secrets : stored)[field.key];
    return [field.key, FIELD_RULES[field.type](field, value) ? value : field.default];
  }));
}

const KINDS = ['views', 'rules', 'agents'];
const objectOr = (value) => (isObject(value) ? value : {});

// `{ <id>: { <key>: boolean | string | number } }`, the shape of `views`, `rules` and `agents`.
function perId(value) {
  return isObject(value) && Object.values(value).every((one) => isObject(one) && Object.values(one).every(scalar));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
