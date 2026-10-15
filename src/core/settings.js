// The user's editor settings: one set per user, shared by every doc and every
// window. Pure, so the server and the page validate them the same way; the
// file itself is handled by src/store/settings.js.

import { NAME_PATTERN } from './mentions.js';
import { AgentError, BUILTIN_AGENTS, checkAgentPatch, MAX_AGENTS, resolveAgent, resolveRoster } from './agents.js';
import { resolveGrants, validGrants } from './grants.js';

export { EDIT_MODES } from './agents.js';

export const SETTINGS_VERSION = 1;

/**
 * `name: null` means "not chosen yet": the server suggests one. `agents` is
 * the user's roster of agents (src/core/agents.js), the built-in ones until
 * the user changes it: the pilot works in every doc, a co-pilot in the docs
 * where it was @mentioned. `claudeBin` and `codexBin` are where Claude Code and
 * Codex are, for every agent that runs on them (null: found automatically).
 * `grants` are the permissions the human gave agents at first use
 * (src/core/grants.js), changed only through the server's grant requests.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  name: null,
  theme: 'system',
  font: 'sans',
  width: 'normal',
  outline: true,
  wordCount: false,
  focus: false,
  agents: BUILTIN_AGENTS,
  claudeBin: null,
  codexBin: null,
  grants: [],
});

/** Settings that choose the program to run: set only in the desktop app or settings.json. */
export const PROGRAM_KEYS = Object.freeze(['claudeBin', 'codexBin']);

const oneOf = (...values) => (v) => values.includes(v);
const boolean = (v) => typeof v === 'boolean';
const text = (max) => (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\0\r\n]/.test(v);

const RULES = {
  name: (v) => v === null || (typeof v === 'string' && NAME_PATTERN.test(v)),
  theme: oneOf('system', 'light', 'dark'),
  font: oneOf('sans', 'serif', 'mono'),
  width: oneOf('normal', 'wide'),
  outline: boolean,
  wordCount: boolean,
  focus: boolean,
  agents: validRoster,
  claudeBin: (v) => v === null || text(2000)(v),
  codexBin: (v) => v === null || text(2000)(v),
  grants: validGrants,
};

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_input';
  }
}

/**
 * Throws a SettingsError unless every key of `patch` is a known setting with
 * an allowed value. `agents`, when given, is the whole roster.
 */
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
 * Settings as stored (possibly from an older or newer app, or hand-edited)
 * → a complete, valid set: known keys with allowed values are kept, the rest
 * fall back to the defaults. Until the user changes the roster, it is the
 * built-in agents. Settings from before the roster kept one agent (`agent`);
 * where Claude Code is carries over, and Clippy takes the old agent's place.
 */
export function resolveSettings(stored) {
  const out = { ...DEFAULT_SETTINGS, agents: BUILTIN_AGENTS.map((a) => ({ ...a })) };
  if (!isObject(stored)) return out;
  for (const key of Object.keys(RULES)) {
    if (key === 'agents' || key === 'grants' || !Object.hasOwn(stored, key) || !RULES[key](stored[key])) continue;
    out[key] = stored[key];
  }
  if (Object.hasOwn(stored, 'agents')) out.agents = resolveRoster(stored.agents);
  out.grants = resolveGrants(stored.grants);
  if (!Object.hasOwn(stored, 'claudeBin') && isObject(stored.agent) && RULES.claudeBin(stored.agent.bin ?? null)) {
    out.claudeBin = stored.agent.bin ?? null;
  }
  return out;
}

function validRoster(value) {
  if (!Array.isArray(value) || value.length > MAX_AGENTS) return false;
  try {
    for (const agent of value) {
      checkAgentPatch(agent);
      if (!resolveAgent(agent)) return false;
    }
  } catch (error) {
    if (error instanceof AgentError) return false;
    throw error;
  }
  // No repeated id or name, and exactly one pilot.
  return resolveRoster(value).length === value.length && value.filter((a) => a.role === 'pilot').length === 1;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
