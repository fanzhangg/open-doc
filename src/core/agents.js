// The user's agents: collaborators with a name, a persona, a role, their own
// permissions and a runtime, kept in the user's settings (one roster for
// every doc). Pure, so the server and the page validate them the same way.
//
// Roles: the **pilot** is in every doc and answers every comment that is not
// addressed to someone else, so a comment never goes unanswered. **Co-pilots**
// are specialists that answer only when @mentioned; mentioning one brings it
// into the doc, as mentioning a person shares a doc with them.
//
// Permissions are per agent and as narrow as its job: `editMode` 'auto' may
// edit the doc ("Can edit"), 'approve' only proposes changes the human
// applies ("Can suggest"); `webAccess` searches and fetches the web;
// `fileAccess` reads the user's other files. No built-in agent has both web
// and files: one that reads your files could otherwise send them to a website.
//
// The persona is plain instructions ("you are a strict copy editor…") that
// every runtime receives with its task, so the same agent can run on another
// runtime without being rewritten. The runtime is what executes it: 'claude'
// (Claude Code), 'codex' (OpenAI Codex CLI) or 'custom' (any command line).

import { NAME_PATTERN, sameName } from './mentions.js';
import { newId } from './ops.js';

export const RUNTIMES = Object.freeze(['claude', 'codex', 'custom']);
export const EDIT_MODES = Object.freeze(['auto', 'approve']);
export const ROLES = Object.freeze(['pilot', 'copilot']);
export const MAX_PERSONA = 4000;
export const MAX_TAGLINE = 60;
export const MAX_AGENTS = 50;

/**
 * One agent, as stored. `tagline` is its slogan: a few words that say what it
 * is for, shown on its card and wherever it is picked.
 * `command` (a custom runtime's command line) decides what program runs.
 * A Claude agent sees only the doc unless `webAccess` or `fileAccess`. A Codex
 * agent runs under a Codex permission profile (in the doc's folder it sees
 * only the doc and its sidecar); `webAccess` turns on its web search. `model` applies to both; `maxTurns`,
 * `maxBudgetUsd`, `isolated` and `fileAccess` only to Claude.
 */
export const AGENT_DEFAULTS = Object.freeze({
  role: 'copilot',
  tagline: '',
  persona: '',
  runtime: 'claude',
  command: null,
  editMode: 'approve',
  model: null,
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

const oneOf = (...values) => (v) => values.includes(v);
const boolean = (v) => typeof v === 'boolean';
const integer = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const text = (max) => (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\0\r\n]/.test(v);
const orNull = (rule) => (v) => v === null || rule(v);

export const AGENT_RULES = Object.freeze({
  id: (v) => typeof v === 'string' && /^a_[A-Za-z0-9_-]{4,40}$/.test(v),
  name: (v) => typeof v === 'string' && NAME_PATTERN.test(v),
  role: oneOf(...ROLES),
  tagline: (v) => typeof v === 'string' && v.length <= MAX_TAGLINE && !/[\0\r\n]/.test(v),
  persona: (v) => typeof v === 'string' && v.length <= MAX_PERSONA && !v.includes('\0'),
  runtime: oneOf(...RUNTIMES),
  command: orNull(text(2000)),
  editMode: oneOf(...EDIT_MODES),
  model: orNull((v) => typeof v === 'string' && /^[A-Za-z0-9._:[\]-]{1,100}$/.test(v)),
  maxTurns: integer(1, 500),
  runTimeoutMinutes: integer(1, 240),
  runsPerHour: integer(1, 1000),
  maxBudgetUsd: orNull((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0.01 && v <= 10_000),
  isolated: boolean,
  webAccess: boolean,
  fileAccess: boolean,
});

const persona = (...lines) => lines.join('\n');

/**
 * The agents the app comes with, named after the Office Assistants of old
 * (in parody): Clippy the paperclip pilots, and Rocky, Will, the Genius and
 * Merlin are on call. Each has only the permissions its job needs. The user
 * can change any of them, and delete any but the pilot.
 */
export const BUILTIN_AGENTS = Object.freeze([
  {
    id: 'a_builtin_clippy',
    name: 'Clippy',
    role: 'pilot',
    tagline: 'Your all-round co-author',
    editMode: 'auto',
    webAccess: true,
    persona: persona(
      'You are Clippy, the human\'s main co-author: a capable, general-purpose writing partner with a paperclip\'s cheerful can-do attitude.',
      'Do what each comment asks: rewrite, expand, restructure, summarize, answer questions about the doc. Search the web when a comment needs facts you do not know.',
      'Keep the author\'s voice and the doc\'s conventions. Make the change, then reply in a sentence or two with what you did and anything you were unsure of. A little warmth is welcome; "It looks like you\'re…" jokes at most once in a while.',
      'When a comment is really a job for a specialist, do your best and mention who could help: @Rocky for grammar, @Will for creative writing, @Genius for fact checking, @Merlin for the author\'s own notes and files.',
    ),
  },
  {
    id: 'a_builtin_rocky',
    name: 'Rocky',
    tagline: 'Sniffs out grammar slips',
    editMode: 'auto',
    persona: persona(
      'You are Rocky, the grammar watchdog: a meticulous copy editor with a nose for typos.',
      'Fix spelling, grammar, punctuation, agreement and consistency (capitalization, hyphenation, number style) in the text the comment points at, or the whole doc when it asks for that.',
      'Never change meaning, tone, structure or word choice beyond what correctness needs; the author\'s voice is not yours to fix.',
      'Reply briefly: list the kinds of fixes you made, and flag anything ambiguous instead of guessing.',
    ),
  },
  {
    id: 'a_builtin_will',
    name: 'Will',
    tagline: 'Makes your prose sing',
    editMode: 'approve',
    persona: persona(
      'You are Will, a creative writer with a strong ear for rhythm and imagery.',
      'When asked to draft or improve text, make it vivid, concrete and surprising: prefer specific images to abstractions, strong verbs to adverbs, and varied sentence length.',
      'Match the doc\'s genre and audience; be bold, but do not invent facts about real people, products or events, and never turn the doc into pastiche Shakespeare unless asked.',
      'When a comment is open-ended, offer one strong version and say in a sentence what you were going for.',
    ),
  },
  {
    id: 'a_builtin_genius',
    name: 'Genius',
    tagline: 'Checks every fact',
    editMode: 'approve',
    webAccess: true,
    persona: persona(
      'You are Genius, a fact checker: precise, skeptical and deliberately boring.',
      'Check every factual claim, number, date, name and quotation in the text the comment points at, searching the web for sources. For each one say whether it is correct, wrong (with the correct value) or unverifiable.',
      'Only propose changes that fix something factually wrong or misleading; never touch style.',
      'Say how sure you are and cite your sources. If you cannot check something, say so plainly rather than guess.',
    ),
  },
  {
    id: 'a_builtin_merlin',
    name: 'Merlin',
    tagline: 'Finds it in your files',
    editMode: 'approve',
    fileAccess: true,
    persona: persona(
      'You are Merlin, the author\'s personal assistant: discreet, organized and thorough.',
      'You may read the author\'s other files. When a comment asks for context, earlier notes, figures or wording the author wrote elsewhere, find it in their files and bring it into the doc as a suggestion, saying which file it came from.',
      'Never copy secrets, credentials or personal details of other people into the doc. Read only what the comment needs.',
      'Reply briefly with what you found and where; if you found nothing, say where you looked.',
    ),
  },
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
  return out;
}

/**
 * A stored roster → valid agents, each name once (case-insensitively), at
 * most MAX_AGENTS, with exactly one pilot: the first one marked so, or else
 * the built-in Clippy, added back.
 */
export function resolveRoster(stored) {
  const out = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    const agent = resolveAgent(entry);
    if (!agent || out.some((a) => a.id === agent.id || sameName(a.name, agent.name))) continue;
    out.push(agent);
  }
  return withOnePilot(out).slice(0, MAX_AGENTS);
}

function withOnePilot(roster) {
  const pilot = roster.find((a) => a.role === 'pilot');
  if (pilot) return roster.map((a) => (a.role === 'pilot' && a !== pilot ? { ...a, role: 'copilot' } : a));
  const clippy = BUILTIN_AGENTS[0];
  if (!roster.some((a) => a.id === clippy.id || sameName(a.name, clippy.name))) return [{ ...clippy }, ...roster];
  return roster.map((a, i) => (i === 0 ? { ...a, role: 'pilot' } : a));
}

/** The pilot of a resolved roster. */
export function pilotOf(roster) {
  return roster.find((a) => a.role === 'pilot') ?? null;
}

/**
 * A new co-pilot for `roster`: `fields` over the defaults, with a fresh id and
 * a name no other agent and no `taken` name (the human's) has: "agent",
 * "agent-2", …
 */
export function createAgent(roster, fields = {}, taken = []) {
  checkAgentPatch({ ...fields, id: 'a_check' });
  if (roster.length >= MAX_AGENTS) throw new AgentError(`at most ${MAX_AGENTS} agents`);
  const used = [...roster.map((a) => a.name), ...taken];
  const base = fields.name ?? 'agent';
  let name = base;
  for (let n = 2; used.some((u) => sameName(u, name)); n++) name = `${base.slice(0, 60)}-${n}`;
  return { ...AGENT_DEFAULTS, ...fields, role: 'copilot', id: newId('a'), name };
}

/**
 * `roster` with agent `id` changed by `patch` (validated; the id cannot
 * change). Making an agent the pilot makes the old pilot a co-pilot; the
 * pilot itself cannot step down, only be replaced.
 */
export function updateAgent(roster, id, patch, taken = []) {
  checkAgentPatch(patch);
  if (Object.hasOwn(patch, 'id')) throw new AgentError('an agent id cannot change');
  const current = roster.find((a) => a.id === id);
  if (!current) throw new AgentError('no such agent', 'not_found');
  if (patch.name !== undefined) {
    const clash = [...roster.filter((a) => a.id !== id).map((a) => a.name), ...taken].some((n) => sameName(n, patch.name));
    if (clash) throw new AgentError(`the name ${patch.name} is taken`);
  }
  if (patch.role === 'copilot' && current.role === 'pilot') throw new AgentError('there is always a pilot: make another agent the pilot instead');
  const promoted = patch.role === 'pilot' && current.role !== 'pilot';
  return roster.map((a) => {
    if (a.id === id) return { ...a, ...patch };
    return promoted && a.role === 'pilot' ? { ...a, role: 'copilot' } : a;
  });
}

/** `roster` without agent `id`; the pilot cannot be deleted. */
export function deleteAgent(roster, id) {
  const agent = roster.find((a) => a.id === id);
  if (!agent) throw new AgentError('no such agent', 'not_found');
  if (agent.role === 'pilot') throw new AgentError('the pilot cannot be deleted: make another agent the pilot first');
  return roster.filter((a) => a.id !== id);
}

/** Short words for an agent's permissions, for cards and pickers: ['Can edit', 'Web']. */
export function permissionLabels(agent) {
  return [
    agent.editMode === 'auto' ? 'Can edit' : 'Can suggest',
    ...(agent.webAccess ? ['Web'] : []),
    ...(agent.fileAccess ? ['Your files'] : []),
  ];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
