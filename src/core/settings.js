// The user's editor settings: one set per user, shared by every doc and every
// window. Pure, so the server and the page validate them the same way; the
// file itself is handled by src/store/settings.js.

import { NAME_PATTERN } from './mentions.js';

export const SETTINGS_VERSION = 1;

/**
 * The co-author agent the editor starts for every doc, off until the user
 * turns it on. `command` (a custom agent's command line) and `bin` (where
 * Claude Code is) decide what program runs. `editMode` is how far the agent
 * may go: 'auto' edits the doc and replies, 'approve' only replies with a
 * proposal the human applies. `presence` is when it answers: 'online', every
 * comment not addressed to someone else; 'dnd' (do not disturb), only
 * comments that @mention it.
 */
export const DEFAULT_AGENT = Object.freeze({
  enabled: false,
  kind: 'claude',
  name: 'claude',
  command: null,
  editMode: 'auto',
  presence: 'online',
  model: null,
  maxTurns: 30,
  runTimeoutMinutes: 10,
  runsPerHour: 20,
  maxBudgetUsd: null,
  bin: null,
  isolated: false,
});

/** `name: null` means "not chosen yet": the server suggests one. */
export const DEFAULT_SETTINGS = Object.freeze({
  name: null,
  theme: 'system',
  font: 'sans',
  width: 'normal',
  outline: true,
  wordCount: false,
  focus: false,
  agent: DEFAULT_AGENT,
});

/** Agent settings that choose the program to run. */
export const AGENT_PROGRAM_KEYS = Object.freeze(['command', 'bin']);

const oneOf = (...values) => (v) => values.includes(v);
export const EDIT_MODES = Object.freeze(['auto', 'approve']);
export const PRESENCES = Object.freeze(['online', 'dnd']);
const boolean = (v) => typeof v === 'boolean';
const integer = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const text = (max) => (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\0\r\n]/.test(v);
const orNull = (rule) => (v) => v === null || rule(v);

const AGENT_RULES = {
  enabled: boolean,
  kind: oneOf('claude', 'custom'),
  name: (v) => typeof v === 'string' && NAME_PATTERN.test(v),
  command: orNull(text(2000)),
  editMode: oneOf(...EDIT_MODES),
  presence: oneOf(...PRESENCES),
  model: orNull((v) => typeof v === 'string' && /^[A-Za-z0-9._:[\]-]{1,100}$/.test(v)),
  maxTurns: integer(1, 500),
  runTimeoutMinutes: integer(1, 240),
  runsPerHour: integer(1, 1000),
  maxBudgetUsd: orNull((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0.01 && v <= 10_000),
  bin: orNull(text(2000)),
  isolated: boolean,
};

const RULES = {
  name: (v) => v === null || (typeof v === 'string' && NAME_PATTERN.test(v)),
  theme: oneOf('system', 'light', 'dark'),
  font: oneOf('sans', 'serif', 'mono'),
  width: oneOf('normal', 'wide'),
  outline: boolean,
  wordCount: boolean,
  focus: boolean,
  agent: (v) => isObject(v) && Object.entries(v).every(([key, value]) => Object.hasOwn(AGENT_RULES, key) && AGENT_RULES[key](value)),
};

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_input';
  }
}

/**
 * Throws a SettingsError unless every key of `patch` is a known setting with
 * an allowed value. `agent` is itself a partial patch of the agent settings.
 */
export function checkSettingsPatch(patch) {
  if (!isObject(patch)) throw new SettingsError('settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(RULES, key)) throw new SettingsError(`unknown setting: ${key}`);
    if (key === 'agent' && isObject(value)) {
      for (const [agentKey, agentValue] of Object.entries(value)) {
        if (!Object.hasOwn(AGENT_RULES, agentKey)) throw new SettingsError(`unknown setting: agent.${agentKey}`);
        if (!AGENT_RULES[agentKey](agentValue)) throw new SettingsError(`invalid value for agent.${agentKey}`);
      }
    } else if (!RULES[key](value)) {
      throw new SettingsError(`invalid value for ${key}`);
    }
  }
  return patch;
}

/** `stored` with `patch` applied: top-level keys replace, `agent` merges key by key. */
export function mergeSettings(stored, patch) {
  const next = { ...stored, ...patch };
  if (patch.agent) next.agent = { ...(isObject(stored?.agent) ? stored.agent : {}), ...patch.agent };
  return next;
}

/**
 * Settings as stored (possibly from an older or newer app, or hand-edited)
 * → a complete, valid set: known keys with allowed values are kept, the rest
 * fall back to the defaults.
 */
export function resolveSettings(stored) {
  const out = { ...DEFAULT_SETTINGS, agent: { ...DEFAULT_AGENT } };
  if (!isObject(stored)) return out;
  for (const key of Object.keys(RULES)) {
    if (key === 'agent' || !Object.hasOwn(stored, key) || !RULES[key](stored[key])) continue;
    out[key] = stored[key];
  }
  if (isObject(stored.agent)) {
    for (const key of Object.keys(AGENT_RULES)) {
      if (Object.hasOwn(stored.agent, key) && AGENT_RULES[key](stored.agent[key])) out.agent[key] = stored.agent[key];
    }
  }
  return out;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
