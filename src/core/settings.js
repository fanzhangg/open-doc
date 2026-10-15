// The user's editor settings: one set per user, shared by every doc and every
// window. Pure, so the server and the page validate them the same way; the
// file itself is handled by src/store/settings.js.

import { NAME_PATTERN } from './mentions.js';
import { AgentError, DEFAULT_AGENTS, checkAgentPatch, MAX_AGENTS, resolveAgent, resolveRoster } from './agents.js';

export { EDIT_MODES } from './agents.js';

export const SETTINGS_VERSION = 1;

/**
 * `name: null` means "not chosen yet": the server suggests one. `agents` is
 * the user's roster of agents (src/core/agents.js), the default one until
 * the user changes it: an agent with Auto Commenter works in every doc, any other
 * in the docs where it was @mentioned. `claudeBin` and `codexBin` are where
 * Claude Code and Codex are, for every agent that runs on them (null: found
 * automatically).
 */
export const DEFAULT_SETTINGS = Object.freeze({
  name: null,
  theme: 'system',
  font: 'sans',
  width: 'normal',
  outline: true,
  wordCount: false,
  focus: false,
  agents: DEFAULT_AGENTS,
  claudeBin: null,
  codexBin: null,
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
 * default agent. Settings from before the roster kept one agent (`agent`);
 * where Claude Code is carries over, and the default agent takes its place.
 */
export function resolveSettings(stored) {
  const out = { ...DEFAULT_SETTINGS, agents: DEFAULT_AGENTS.map((a) => ({ ...a })) };
  if (!isObject(stored)) return out;
  for (const key of Object.keys(RULES)) {
    if (key === 'agents' || !Object.hasOwn(stored, key) || !RULES[key](stored[key])) continue;
    out[key] = stored[key];
  }
  if (Object.hasOwn(stored, 'agents')) out.agents = resolveRoster(stored.agents);
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
  // No repeated id or name.
  return resolveRoster(value).length === value.length;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
