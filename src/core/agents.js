// The user's agents: collaborators with a name, an introduction, a persona,
// their own permissions and a runtime, kept in the user's settings (one
// roster for every doc). Pure, so the server and the page validate them the
// same way.
//
// Every agent reads the doc it works on. Beyond that, permissions, each a
// switch on the agent's card (PERMISSIONS):
// - **Editor**: changes the doc. Without **Auto Editor** it proposes each
//   change for the human to apply; with it, it edits directly. Neither: it
//   only replies. Stored as `editMode`: 'none', 'approve' or 'auto'.
// - **Auto Commenter** (`autoComment`): is in every doc and looks at every new
//   comment that @mentions no one, answering the ones that fit its persona.
//   Without it, an agent answers only when @mentioned, which also brings it
//   into the doc, as mentioning a person shares a doc with them.
// - **Web Searcher** (`webAccess`): searches and fetches the web.
// - **File Searcher** (`fileAccess`): reads the user's other files.
// No built-in agent has both web and files: one that reads your files could
// otherwise send them to a website.
//
// The persona is plain instructions ("you are a strict copy editor…") that
// every runtime receives with its task, so the same agent can run on another
// runtime without being rewritten. The runtime is what executes it: 'claude'
// (Claude Code), 'codex' (OpenAI Codex CLI) or 'custom' (any command line).

import { NAME_PATTERN, sameName } from './mentions.js';
import { newId } from './ops.js';

export const RUNTIMES = Object.freeze(['claude', 'codex', 'custom']);
export const EDIT_MODES = Object.freeze(['none', 'approve', 'auto']);
export const MAX_PERSONA = 4000;
export const MAX_TAGLINE = 60;
export const MAX_AGENTS = 50;

/**
 * One agent, as stored. `tagline` is its introduction: a few words that say
 * what it is for, shown on its card and wherever it is picked.
 * `command` (a custom runtime's command line) decides what program runs.
 * A Claude agent sees only the doc unless `webAccess` or `fileAccess`. A Codex
 * agent runs under a Codex permission profile (in the doc's folder it sees
 * only the doc and its sidecar); `webAccess` turns on its web search. `model` applies to both; `maxTurns`,
 * `maxBudgetUsd`, `isolated` and `fileAccess` only to Claude.
 */
export const AGENT_DEFAULTS = Object.freeze({
  tagline: '',
  persona: '',
  runtime: 'claude',
  command: null,
  editMode: 'approve',
  autoComment: false,
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
  tagline: (v) => typeof v === 'string' && v.length <= MAX_TAGLINE && !/[\0\r\n]/.test(v),
  persona: (v) => typeof v === 'string' && v.length <= MAX_PERSONA && !v.includes('\0'),
  runtime: oneOf(...RUNTIMES),
  command: orNull(text(2000)),
  editMode: oneOf(...EDIT_MODES),
  autoComment: boolean,
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
 * (in parody). Each owns one part of the work, its persona says what it
 * leaves to the others, and it has only the permissions that part needs:
 *
 *   Clippy  content and structure  Editor, Auto Editor, Auto Commenter
 *   Rocky   correctness            Editor, Auto Editor
 *   Will    style                  Editor
 *   Genius  facts                  Editor, Web Searcher
 *   Merlin  the author's material  Editor, File Searcher
 *   Links   critique               (replies only)
 *
 * Every persona has the same four parts: who it is, its job, what it leaves
 * alone (and to whom), how it replies. The user can change or delete any of
 * them.
 */
export const BUILTIN_AGENTS = Object.freeze([
  {
    id: 'a_builtin_clippy',
    name: 'Clippy',
    tagline: 'Drafts and reshapes your doc',
    editMode: 'auto',
    autoComment: true,
    persona: persona(
      'You are Clippy, the author\'s co-author: a cheerful, capable paperclip who helps shape the doc.',
      'Your job is content and structure: draft new sections, rewrite or cut passages, reorganize, summarize, and answer questions about the doc. You see every comment that mentions no one, so take any request the doc itself is enough for.',
      'Leave the specialists\' work to them: grammar and typos to @Rocky, style and flow to @Will, checking facts to @Genius (you cannot search the web), the author\'s other files to @Merlin (you cannot read them), a frank critique to @Links. When a comment needs one of them, do your part and suggest the author @mention them.',
      'Keep the author\'s voice and the doc\'s conventions. Reply in a sentence or two with what you changed and anything you were unsure of; an "It looks like you\'re…" joke now and then is fine.',
    ),
  },
  {
    id: 'a_builtin_rocky',
    name: 'Rocky',
    tagline: 'Fixes grammar and typos',
    editMode: 'auto',
    persona: persona(
      'You are Rocky, the copy editor: a meticulous watchdog with a nose for typos.',
      'Your job is correctness: spelling, grammar, punctuation, agreement and consistency (capitalization, hyphenation, number and date style) in the text the comment points at, or the whole doc when it asks for that. Fix these directly.',
      'Leave everything else alone: never change meaning, tone, word choice or structure beyond what correctness needs. Style is @Will\'s job, facts are @Genius\'s.',
      'Reply briefly with the kinds of fixes you made, and flag anything ambiguous instead of guessing.',
    ),
  },
  {
    id: 'a_builtin_will',
    name: 'Will',
    tagline: 'Polishes style and flow',
    editMode: 'approve',
    persona: persona(
      'You are Will, the line editor: a writer with an ear for rhythm, clarity and voice.',
      'Your job is style: make sentences clearer, tighter and livelier, smooth the flow between them, and fit the tone to the audience. Prefer concrete words to abstractions, strong verbs to adverbs, and varied sentence length. Propose your changes; the author picks what to apply.',
      'Leave the substance alone: do not add claims, cut content or reorganize sections (that is @Clippy\'s job), and never invent facts. Plain typo fixes are @Rocky\'s.',
      'Say in a phrase what each proposal improves. For an open-ended comment, offer one strong version, not a menu.',
    ),
  },
  {
    id: 'a_builtin_genius',
    name: 'Genius',
    tagline: 'Checks facts against sources',
    editMode: 'approve',
    webAccess: true,
    persona: persona(
      'You are Genius, the fact checker: precise, skeptical and deliberately boring.',
      'Your job is accuracy: check the claims, numbers, dates, names and quotations in the text the comment points at against sources on the web. Mark each one correct, wrong (with the right value) or unverifiable, and propose a fix for each one that is wrong or misleading.',
      'Leave style and structure alone: propose changes only to fix what is factually wrong. The author\'s private notes are @Merlin\'s to find.',
      'Cite a source for every verdict and say how sure you are. If you cannot check something, say so plainly rather than guess.',
    ),
  },
  {
    id: 'a_builtin_merlin',
    name: 'Merlin',
    tagline: 'Finds it in your files',
    editMode: 'approve',
    fileAccess: true,
    persona: persona(
      'You are Merlin, the archivist: a discreet wizard who knows where the author keeps things.',
      'Your job is the author\'s own material: when a comment asks for earlier notes, figures, decisions or wording, find them in the author\'s other files and propose bringing them into the doc, naming the file each one came from.',
      'Read only what the comment needs, and never copy secrets, credentials or other people\'s personal details into the doc. You cannot search the web: public facts are @Genius\'s.',
      'Reply briefly with what you found and where; if you found nothing, say where you looked.',
    ),
  },
  {
    id: 'a_builtin_links',
    name: 'Links',
    tagline: 'Critiques like a tough reader',
    editMode: 'none',
    persona: persona(
      'You are Links, the critic: a cat who reads the doc as its toughest audience would, unimpressed until convinced.',
      'Your job is feedback, not edits: say what is unclear, unconvincing, missing or out of order, from the reader\'s point of view, in the part the comment points at or the whole doc when it asks for that. You cannot change the doc; others do the fixing.',
      'Do not nitpick grammar or style (that is @Rocky\'s and @Will\'s), and do not check facts (that is @Genius\'s).',
      'Reply with the few points that matter most, most important first, each with why it matters to the reader and one concrete way to fix it. End with what already works.',
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

/**
 * A stored agent → a complete, valid one, or null when it has no valid id or
 * name. An agent saved as the one pilot that answered every open comment
 * (`role`), or with this switch's earlier name (`autoPilot`), keeps the job
 * as Auto Commenter.
 */
export function resolveAgent(stored) {
  if (!isObject(stored) || !AGENT_RULES.id(stored.id) || !AGENT_RULES.name(stored.name)) return null;
  const out = { id: stored.id, name: stored.name, ...AGENT_DEFAULTS };
  for (const key of Object.keys(AGENT_DEFAULTS)) {
    if (Object.hasOwn(stored, key) && AGENT_RULES[key](stored[key])) out[key] = stored[key];
  }
  if (!Object.hasOwn(stored, 'autoComment') && (stored.autoPilot === true || stored.role === 'pilot')) out.autoComment = true;
  return out;
}

/** A stored roster → valid agents, each id and name once (names case-insensitively), at most MAX_AGENTS. */
export function resolveRoster(stored) {
  const out = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    const agent = resolveAgent(entry);
    if (!agent || out.some((a) => a.id === agent.id || sameName(a.name, agent.name))) continue;
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
  const used = [...roster.map((a) => a.name), ...taken];
  const base = fields.name ?? 'agent';
  let name = base;
  for (let n = 2; used.some((u) => sameName(u, name)); n++) name = `${base.slice(0, 60)}-${n}`;
  return { ...AGENT_DEFAULTS, ...fields, id: newId('a'), name };
}

/** `roster` with agent `id` changed by `patch` (validated; the id cannot change). */
export function updateAgent(roster, id, patch, taken = []) {
  checkAgentPatch(patch);
  if (Object.hasOwn(patch, 'id')) throw new AgentError('an agent id cannot change');
  if (!roster.some((a) => a.id === id)) throw new AgentError('no such agent', 'not_found');
  if (patch.name !== undefined) {
    const clash = [...roster.filter((a) => a.id !== id).map((a) => a.name), ...taken].some((n) => sameName(n, patch.name));
    if (clash) throw new AgentError(`the name ${patch.name} is taken`);
  }
  return roster.map((a) => (a.id === id ? { ...a, ...patch } : a));
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
  { key: 'autoComment', label: 'Auto Commenter', hint: 'Answers new comments that fit its persona without being @mentioned, in every doc.' },
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

/**
 * What `agent` is for, in a line: its introduction, or else the first
 * sentence of its persona, "You are" left out ("A strict copy editor").
 * '' when it has neither.
 */
export function introOf(agent) {
  if (agent.tagline?.trim()) return agent.tagline.trim();
  const first = (agent.persona ?? '').trim().split('\n')[0].split(/(?<=[.!?])\s/)[0];
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
