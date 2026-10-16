// The user's agents: collaborators with a name, an introduction, a persona,
// their own permissions and a runtime, kept in the user's settings (one
// roster for every doc). Pure, so the server and the page validate them the
// same way.
//
// Every agent reads the doc it works on. Beyond that, permissions, each a
// switch on the agent's card (PERMISSIONS):
// - **Editor**: changes the doc. Without **Auto Editor** it proposes each
//   change for the human to apply; with it, it edits directly. Neither: it
//   only replies. Stored as `editMode`: 'none', 'approve' or 'auto'. A new
//   agent edits directly, as a co-author would: every edit can be undone.
// - **Auto Commenter** (`autoComment`): looks at every new comment that
//   @mentions no one in the docs it is in, answering the ones that fit its
//   persona. Without it, an agent answers only when @mentioned. Mentioning an
//   agent brings it into the doc, as mentioning a person shares a doc with them.
//   The first agent among those it works with leads them: it starts with
//   Auto Commenter (`leaderless`); the others answer when @mentioned.
// - **Web Searcher** (`webAccess`): searches and fetches the web.
// - **File Searcher** (`fileAccess`): reads the user's other files.
// Turning on web or files when the agent has the other asks to confirm: one
// that reads your files could otherwise send them to a website.
//
// Agents are light. A new one belongs to the doc it was made in (`doc`: the
// doc's path): it shows and answers only there, comes back whenever the doc
// is opened, and is deleted when it is removed from the doc. Starring it
// (`starred`) puts it in the user's library, for every doc. Agents saved
// before stars existed count as starred. Names are unique among the starred
// agents and each doc's own, so two docs may each have a "reviewer".
//
// A new doc starts with Clippy, the agent the app comes with: the first time
// a doc is opened with no agents in it, Clippy joins it (under whatever name
// the user gave it). Every other agent is added in the doc.
//
// Who an agent is takes two plain-text fields: its **persona**, one line
// that defines it ("a strict copy editor") and shows on its card and in the
// People panel, and its **instructions**, the details and rules behind it
// (optional, edited in the Agents panel). Both reach every runtime with the
// task, so the same agent can run on another runtime without being
// rewritten. The runtime is what executes it: 'claude'
// (Claude Code), 'codex' (OpenAI Codex CLI) or 'custom' (any command line).
//
// An agent's face (web/faces.js) is drawn from its `face`, a seed: null
// draws it from the name. Renaming one keeps the face it had.

import { NAME_PATTERN, sameName } from './mentions.js';
import { newId } from './ops.js';

export const RUNTIMES = Object.freeze(['claude', 'codex', 'custom']);
export const EDIT_MODES = Object.freeze(['none', 'approve', 'auto']);
export const EFFORTS = Object.freeze(['low', 'medium', 'high']);
export const MAX_PERSONA = 120;
export const MAX_INSTRUCTIONS = 4000;
export const MAX_AGENTS = 500;

/**
 * One agent, as stored. `persona` is one line; `instructions` any length.
 * `command` (a custom runtime's command line) decides what program runs.
 * A Claude agent sees only the doc unless `webAccess` or `fileAccess`. A Codex
 * agent runs under a Codex permission profile (in the doc's folder it sees
 * only the doc and its sidecar); `webAccess` turns on its web search. `model` applies to both; `effort`, `maxTurns`,
 * `maxBudgetUsd`, `isolated` and `fileAccess` only to Claude. A Claude agent
 * with no `model` runs on a fast one (see claudeAdapter), at low `effort`:
 * most comments ask for small changes.
 */
export const AGENT_DEFAULTS = Object.freeze({
  face: null,
  starred: false,
  doc: null,
  persona: '',
  instructions: '',
  runtime: 'claude',
  command: null,
  editMode: 'auto',
  autoComment: false,
  model: null,
  effort: 'low',
  maxTurns: 30,
  runTimeoutMinutes: 10,
  runsPerHour: 20,
  maxBudgetUsd: null,
  isolated: false,
  webAccess: false,
  fileAccess: false,
});

/** Agent fields that choose the program to run: set only in the desktop app or settings.json. */
export const AGENT_PROGRAM_KEYS = Object.freeze(['command']);

/** Agent fields only the server sets: which doc an unstarred agent belongs to. */
export const AGENT_SERVER_KEYS = Object.freeze(['doc']);

const oneOf = (...values) => (v) => values.includes(v);
const boolean = (v) => typeof v === 'boolean';
const integer = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
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
  runtime: oneOf(...RUNTIMES),
  command: orNull(text(2000)),
  editMode: oneOf(...EDIT_MODES),
  autoComment: boolean,
  model: orNull((v) => typeof v === 'string' && /^[A-Za-z0-9._:[\]-]{1,100}$/.test(v)),
  effort: oneOf(...EFFORTS),
  maxTurns: integer(1, 500),
  runTimeoutMinutes: integer(1, 240),
  runsPerHour: integer(1, 1000),
  maxBudgetUsd: orNull((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0.01 && v <= 10_000),
  isolated: boolean,
  webAccess: boolean,
  fileAccess: boolean,
});

/** The id of Clippy, the agent the app comes with and every new doc starts with. */
export const DEFAULT_AGENT_ID = 'a_default_clippy';

/**
 * The roster a new user starts with: Clippy, starred, a generic writing
 * assistant that drafts and edits whatever the doc needs. The product ships
 * no job titles; who does what is up to the personas people write, Clippy's too.
 */
export const DEFAULT_AGENTS = Object.freeze([
  { id: DEFAULT_AGENT_ID, name: 'Clippy', persona: 'A general writing assistant that helps draft and edit docs', starred: true, editMode: 'auto', autoComment: true },
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

/**
 * A stored agent → a complete, valid one, or null when it has no valid id or
 * name. An agent saved as the one pilot that answered every open comment
 * (`role`), or with this switch's earlier name (`autoPilot`), keeps the job
 * as Auto Commenter.
 */
export function resolveAgent(saved) {
  if (!isObject(saved) || !AGENT_RULES.id(saved.id) || !AGENT_RULES.name(saved.name)) return null;
  const stored = upgradePersona(saved);
  const out = { id: stored.id, name: stored.name, ...AGENT_DEFAULTS };
  for (const key of Object.keys(AGENT_DEFAULTS)) {
    if (Object.hasOwn(stored, key) && AGENT_RULES[key](stored[key])) out[key] = stored[key];
  }
  if (!Object.hasOwn(stored, 'autoComment') && (stored.autoPilot === true || stored.role === 'pilot')) out.autoComment = true;
  if (!Object.hasOwn(stored, 'starred')) out.starred = true; // saved before stars: the user kept it
  if (!out.doc) out.starred = true; // in no doc: the user's
  if (out.starred) out.doc = null;
  return out;
}

/**
 * An agent saved before persona and instructions were split had an
 * introduction (`tagline`) and a `persona` of any length: the introduction,
 * or else a one-line persona, becomes the persona line, and the rest the
 * instructions.
 */
function upgradePersona(stored) {
  if (Object.hasOwn(stored, 'instructions')) return stored;
  const { tagline, ...rest } = stored;
  const old = typeof stored.persona === 'string' ? stored.persona.replace(/\0/g, '') : '';
  const intro = typeof tagline === 'string' ? tagline.trim() : '';
  const short = !/[\r\n]/.test(old.trim()) && old.trim().length <= MAX_PERSONA ? old.trim() : '';
  const persona = (intro || short || firstSentence(old)).slice(0, MAX_PERSONA);
  return { ...rest, persona, instructions: old.trim() === persona ? '' : old.slice(0, MAX_INSTRUCTIONS) };
}

/**
 * Whether none of `agents` has Auto Commenter: then a new agent joining them
 * leads, taking the comments that @mention no one.
 */
export function leaderless(agents) {
  return !agents.some((a) => a.autoComment);
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
 * "agent-2", …
 */
export function createAgent(roster, fields = {}, taken = []) {
  checkAgentPatch({ ...fields, id: 'a_check' });
  if (roster.length >= MAX_AGENTS) throw new AgentError(`at most ${MAX_AGENTS} agents`);
  const draft = { ...AGENT_DEFAULTS, ...fields, id: newId('a') };
  const base = fields.name ?? 'agent';
  let name = base;
  const used = (n) => taken.some((t) => sameName(t, n)) || roster.some((a) => clash(a, { ...draft, name: n }));
  for (let n = 2; used(name); n++) name = `${base.slice(0, 60)}-${n}`;
  return { ...draft, name };
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

/** The permissions, in the order cards show them. */
export const PERMISSIONS = Object.freeze([
  { key: 'editor', label: 'Editor', hint: 'Changes the doc. Without Auto Editor, it proposes each change for you to apply.' },
  { key: 'autoEditor', label: 'Auto Editor', hint: 'Edits the doc directly, without asking you first. Every edit can be undone.' },
  { key: 'autoComment', label: 'Auto Commenter', hint: 'Answers new comments that fit its persona without being @mentioned, in the docs it is in.' },
  { key: 'web', label: 'Web Searcher', hint: 'Searches the web and opens web pages.' },
  { key: 'files', label: 'File Searcher', hint: 'Reads your other files, except keys and .env files.' },
].map((p) => Object.freeze(p)));

/** Which permissions `agent` has: { editor, autoEditor, autoComment, web, files }. */
export function permissionsOf(agent) {
  return {
    editor: agent.editMode === 'approve' || agent.editMode === 'auto',
    autoEditor: agent.editMode === 'auto',
    autoComment: Boolean(agent.autoComment),
    web: Boolean(agent.webAccess),
    files: Boolean(agent.fileAccess),
  };
}

/**
 * The agent patch that switches permission `key` of `agent` on or off.
 * Auto Editor needs Editor: switching it on turns Editor on, and switching
 * Editor off turns it off. Null for an unknown permission.
 */
export function permissionPatch(agent, key, on) {
  const edit = permissionsOf(agent);
  switch (key) {
    case 'editor':
      return { editMode: on ? (edit.autoEditor ? 'auto' : 'approve') : 'none' };
    case 'autoEditor':
      return { editMode: on ? 'auto' : edit.editor ? 'approve' : 'none' };
    case 'autoComment':
      return { autoComment: on };
    case 'web':
      return { webAccess: on };
    case 'files':
      return { fileAccess: on };
    default:
      return null;
  }
}

/** Who `agent` is, in a line: its persona, or '' when the user has not written one. */
export function introOf(agent) {
  return (agent.persona ?? '').trim().split('\n')[0];
}

// The first sentence of `text`, "You are" left out ("A strict copy editor").
function firstSentence(text) {
  const first = text.trim().split('\n')[0].split(/(?<=[.!?])\s/)[0];
  const intro = first.replace(/^you are\s+/i, '').replace(/[.!?:;,]+$/, '').trim();
  return intro ? intro[0].toUpperCase() + intro.slice(1) : '';
}

/** The labels of the permissions `agent` has: ['Editor', 'Web Searcher']. */
export function permissionLabels(agent) {
  const has = permissionsOf(agent);
  return PERMISSIONS.filter((p) => has[p.key]).map((p) => p.label);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
