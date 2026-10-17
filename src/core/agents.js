// The user's buddies (docs/architecture-v2.md calls who you @mention a
// buddy; the code still says agent): a name, a persona and instructions,
// kept in the user's settings (one roster for every doc). Pure, so the
// server and the page validate them the same way. What runs a buddy is the
// agent script picked in Settings, the same for every buddy.
//
// A new one belongs to the doc it was made in (`doc`: the doc's path): it
// shows and answers only there, comes back whenever the doc is opened, and
// is deleted when it is removed from the doc. Starring it (`starred`) puts
// it in the user's library, for every doc. Names are unique among the
// starred agents and each doc's own, so two docs may each have a "reviewer".
//
// A new doc starts with Clippy, the agent the app comes with: the first time
// a doc is opened with no agents in it, Clippy joins it (under whatever name
// the user gave it). Every other agent is added in the doc.
//
// Who an agent is takes two plain-text fields: its **persona**, one line
// that shows on its card, and its **instructions**, the details and rules
// behind it. An agent's face (web/faces.js) is drawn from its `face`, a
// seed: null draws it from the name. Renaming one keeps the face it had.

import { NAME_PATTERN, sameName } from './mentions.js';
import { newId } from './comments.js';

export const MAX_PERSONA = 120;
export const MAX_INSTRUCTIONS = 4000;
export const MAX_AGENTS = 500;

/** One agent, as stored: `persona` is one line; `instructions` any length. */
export const AGENT_DEFAULTS = Object.freeze({
  face: null,
  starred: false,
  doc: null,
  persona: '',
  instructions: '',
});

/** Agent fields only the server sets: which doc an unstarred agent belongs to. */
export const AGENT_SERVER_KEYS = Object.freeze(['doc']);

const boolean = (v) => typeof v === 'boolean';
const text = (max) => (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\0\r\n]/.test(v);
const orNull = (rule) => (v) => v === null || rule(v);

/** A face seed (web/faces.js): any short line. Shared with the human's in settings. */
export const FACE_RULE = text(64);

export const AGENT_RULES = Object.freeze({
  id: (v) => typeof v === 'string' && /^a_[A-Za-z0-9_-]{4,40}$/.test(v),
  name: (v) => typeof v === 'string' && NAME_PATTERN.test(v),
  face: orNull(FACE_RULE),
  starred: boolean,
  doc: orNull((v) => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0')),
  persona: (v) => typeof v === 'string' && v.length <= MAX_PERSONA && !/[\0\r\n]/.test(v),
  instructions: (v) => typeof v === 'string' && v.length <= MAX_INSTRUCTIONS && !v.includes('\0'),
});

/** The id of Clippy, the agent the app comes with and every new doc starts with. */
export const DEFAULT_AGENT_ID = 'a_default_clippy';

/**
 * The roster a new user starts with: Clippy, starred, a generic writing
 * assistant that drafts and edits whatever the doc needs. The product ships
 * no job titles; who does what is up to the personas people write, Clippy's too.
 */
export const DEFAULT_AGENTS = Object.freeze([
  { id: DEFAULT_AGENT_ID, name: 'Clippy', persona: 'A general writing assistant that helps draft and edit docs', starred: true },
].map((agent) => Object.freeze({ ...AGENT_DEFAULTS, ...agent })));

export class AgentError extends Error {
  constructor(message, code = 'bad_input') {
    super(message);
    this.code = code;
  }
}

/** Throws an AgentError unless every key of `patch` is a known agent field with an allowed value. */
export function checkAgentPatch(patch) {
  if (!isObject(patch)) throw new AgentError('an agent must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(AGENT_RULES, key)) throw new AgentError(`unknown agent setting: ${key}`);
    if (!AGENT_RULES[key](value)) throw new AgentError(`invalid value for ${key}`);
  }
  return patch;
}

/** A stored agent → a complete, valid one, or null when it has no valid id or name. */
export function resolveAgent(stored) {
  if (!isObject(stored) || !AGENT_RULES.id(stored.id) || !AGENT_RULES.name(stored.name)) return null;
  const out = { id: stored.id, name: stored.name, ...AGENT_DEFAULTS };
  for (const key of Object.keys(AGENT_DEFAULTS)) {
    if (Object.hasOwn(stored, key) && AGENT_RULES[key](stored[key])) out[key] = stored[key];
  }
  if (!out.doc) out.starred = true; // in no doc: the user's
  if (out.starred) out.doc = null;
  return out;
}

/** Whether `agent` belongs to one doc only: not starred. */
export function docOnly(agent) {
  return !agent.starred && agent.doc !== null;
}

/** Whether `agent` shows and answers in the doc at `doc`: starred, or that doc's own. */
export function availableIn(agent, doc) {
  return agent.starred || agent.doc === doc;
}

// Two agents can be told apart by name only where both show: they clash
// when either is starred, or both belong to the same doc.
function clash(a, b) {
  return sameName(a.name, b.name) && (a.starred || b.starred || a.doc === b.doc);
}

/** A stored roster → valid agents, each id and name once (names case-insensitively), at most MAX_AGENTS. */
export function resolveRoster(stored) {
  const out = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    const agent = resolveAgent(entry);
    if (!agent || out.some((a) => a.id === agent.id || clash(a, agent))) continue;
    out.push(agent);
  }
  return out.slice(0, MAX_AGENTS);
}

/**
 * A new agent for `roster`: `fields` over the defaults, with a fresh id and
 * a name no other agent and no `taken` name (the human's) has: "agent",
 * "agent-2", … With `exact`, the name in `fields` is kept or refused: the
 * user typed it, and a different one would surprise them.
 */
export function createAgent(roster, fields = {}, taken = [], { exact = false } = {}) {
  checkAgentPatch({ ...fields, id: 'a_check' });
  if (roster.length >= MAX_AGENTS) throw new AgentError(`at most ${MAX_AGENTS} agents`);
  const draft = { ...AGENT_DEFAULTS, ...fields, id: newId('a') };
  const base = fields.name ?? 'agent';
  let name = base;
  const used = (n) => taken.some((t) => sameName(t, n)) || roster.some((a) => clash(a, { ...draft, name: n }));
  if (exact && used(name)) throw new AgentError(`the name ${name} is taken`);
  for (let n = 2; used(name); n++) name = `${base.slice(0, 60)}-${n}`;
  return { ...draft, name };
}

/**
 * A new agent in the Agents panel before it is created: the defaults, with
 * `fields` over them, no id and no name yet. `face` keeps its face from
 * changing with each letter of the name typed.
 */
export function draftAgent(fields = {}) {
  return { ...AGENT_DEFAULTS, id: null, name: '', ...fields };
}

/**
 * What creating `draft` sends: its name, trimmed, and the fields changed from
 * the defaults; or null while the name is not valid. The doc is the server's
 * to set.
 */
export function createFields(draft) {
  const name = (draft.name ?? '').trim();
  if (!AGENT_RULES.name(name)) return null;
  const fields = { name };
  for (const [key, value] of Object.entries(draft)) {
    if (!Object.hasOwn(AGENT_DEFAULTS, key) || AGENT_SERVER_KEYS.includes(key)) continue;
    if (value !== AGENT_DEFAULTS[key]) fields[key] = value;
  }
  return checkAgentPatch(fields);
}

/** `roster` with agent `id` changed by `patch` (validated; the id cannot change). */
export function updateAgent(roster, id, patch, taken = []) {
  checkAgentPatch(patch);
  if (Object.hasOwn(patch, 'id')) throw new AgentError('an agent id cannot change');
  if (!roster.some((a) => a.id === id)) throw new AgentError('no such agent', 'not_found');
  const before = roster.find((a) => a.id === id);
  const next = { ...before, ...patch };
  // A new name keeps the face the old one drew.
  if (patch.name !== undefined && patch.face === undefined && before.face === null && patch.name !== before.name) next.face = before.name;
  const others = roster.filter((a) => a.id !== id);
  if ((patch.name !== undefined && taken.some((t) => sameName(t, next.name))) || others.some((a) => clash(a, next))) {
    throw new AgentError(`the name ${next.name} is taken`);
  }
  return roster.map((a) => (a.id === id ? next : a));
}

/** `roster` without agent `id`. */
export function deleteAgent(roster, id) {
  if (!roster.some((a) => a.id === id)) throw new AgentError('no such agent', 'not_found');
  return roster.filter((a) => a.id !== id);
}

/** Who `agent` is, in a line: its persona, or '' when the user has not written one. */
export function introOf(agent) {
  return (agent.persona ?? '').trim().split('\n')[0];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
