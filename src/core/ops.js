// Sidecar operations (SPEC.md §6). Pure functions: each returns a new sidecar
// (or the same object when the operation was already applied), so a retried
// operation is applied at most once and unknown fields are preserved.

import { NAME_PATTERN, parseMentions, sameName } from './mentions.js';
import { AGENT_RULES } from './agents.js'; // used only inside functions, so the import cycle is safe

export const FORMAT_VERSION = 1;
export const WORKING_TTL_MS = 5 * 60 * 1000;
const MESSAGE_ID = /^m_[A-Za-z0-9_-]{6,}$/;
const PARTICIPANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class OpError extends Error {
  /** @param {'unknown_thread' | 'bad_input' | 'not_allowed'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function emptySidecar(docName) {
  return { opendoc: FORMAT_VERSION, doc: docName, docHash: null, participants: [], threads: [] };
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random id such as `t_k3x9q2m7pa` (prefix `t`, `m`, or `u` for a person). */
export function newId(prefix) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  let id = '';
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${id}`;
}

/**
 * Apply one operation.
 *
 *   { type: 'join', participant: { name, kind, id? } }
 *   { type: 'identify', participant: { name, kind, id }, aka? } // the same person under a new name
 *   { type: 'leave', name }                        // out of the @mention directory
 *   { type: 'addThread', id, anchor | null, message: { id, author, body, createdAt } }
 *   { type: 'addMessage', threadId, message }
 *   { type: 'resolve', threadId, by, kind?, at }   // humans only
 *   { type: 'reopen', threadId, by, kind? }        // humans only
 *   { type: 'setWorking', threadId, by, since }   // since: null clears `by`'s
 *   { type: 'pass', threadId, by }                 // `by` leaves an open ask to others
 *   { type: 'attachEdits', threadId, messageId, edits }
 *
 * A message may carry `edits` (what its author changed in the doc, §2.5),
 * `undoes` (the id of the message whose edits it reverted), `proposal`
 * (changes the author suggests instead of making them, §2.6) and `applies`
 * (the id of the message whose proposal it applied).
 *
 * Only a human may resolve or reopen a thread (§2.2): `by` must not be a
 * participant of kind "agent", and `kind`, when given, must be "human".
 */
export function applyOp(sidecar, op) {
  switch (op.type) {
    case 'join':
      return join(sidecar, op.participant);
    case 'identify':
      return identify(sidecar, op.participant, op.aka);
    case 'describe':
      return describe(sidecar, op);
    case 'leave':
      return leave(sidecar, op.name);
    case 'addThread':
      return addThread(sidecar, op);
    case 'addMessage':
      return addMessage(sidecar, op);
    case 'resolve':
      requireHuman(sidecar, op);
      return updateThread(sidecar, op.threadId, (t) =>
        t.status === 'resolved' ? t : { ...t, status: 'resolved', resolvedBy: canonicalName(sidecar, op.by), resolvedAt: op.at, working: null });
    case 'reopen':
      requireHuman(sidecar, op);
      return updateThread(sidecar, op.threadId, (t) =>
        t.status === 'open' ? t : { ...t, status: 'open', resolvedBy: null, resolvedAt: null });
    case 'setWorking':
      return updateThread(sidecar, op.threadId, (t) => {
        const others = workingList(t).filter((w) => !sameName(w.by, op.by));
        return { ...t, working: listOrNull(op.since ? [...others, { by: op.by, since: op.since }] : others) };
      });
    case 'pass':
      return pass(sidecar, op);
    case 'attachEdits':
      return attachEdits(sidecar, op);
    default:
      throw new OpError('bad_input', `unknown operation: ${op.type}`);
  }
}

// An agent looked at the thread's open ask (one addressed to no one, SPEC
// §5) and left it to others: it is out of that agent's inbox until a human
// asks again. `passed` is optional; a thread without it has no passes.
function pass(sidecar, { threadId, by }) {
  if (typeof by !== 'string' || !NAME_PATTERN.test(by)) throw new OpError('bad_input', `invalid participant name: ${by}`);
  return updateThread(sidecar, threadId, (t) => {
    const passed = t.passed ?? [];
    const working = stopWorking(t, by);
    if (passed.some((n) => sameName(n, by))) return working === t.working ? t : { ...t, working };
    return { ...t, working, passed: [...passed, canonicalName(sidecar, by)] };
  });
}

function join(sidecar, participant) {
  validateParticipant(participant);
  const { id } = participant;
  const known = id ? identify(sidecar, participant) : sidecar;
  if (known.participants.some((p) => (id && p.id === id) || sameName(p.name, participant.name))) return known;
  const entry = { name: participant.name, kind: participant.kind, ...(id ? { id } : {}), ...about(participant) };
  return { ...known, participants: [...known.participants, entry] };
}

// A participant with an `id` is one person whatever they are called (SPEC
// §2.4): under a new name, their entry and every place the doc names them
// (authors, mentions, resolvedBy, working, passed) take it. Entries without
// an id, from before the doc knew it, are theirs when named `name` or one
// of `aka` (names they went by), and merge into one. Bodies stay as written.
// A name another participant has is not taken: they keep their old one.
// Someone not in the doc yet is not added.
function identify(sidecar, participant, aka = []) {
  validateParticipant(participant);
  const { id, kind } = participant;
  if (!id) throw new OpError('bad_input', 'identify needs a participant id');
  if (!Array.isArray(aka) || !aka.every((n) => NAME_PATTERN.test(n))) throw new OpError('bad_input', 'invalid aka');
  const names = [participant.name, ...aka];
  const theirs = (p) => p.id === id || (p.id === undefined && p.kind === kind && names.some((n) => sameName(n, p.name)));
  const claimed = sidecar.participants.filter(theirs);
  if (claimed.length === 0) return sidecar;
  const taken = sidecar.participants.some((p) => !theirs(p) && sameName(p.name, participant.name));
  const name = taken ? (claimed.find((p) => p.id === id) ?? claimed[0]).name : participant.name;
  const old = new Set(claimed.map((p) => p.name.toLowerCase()));
  old.add(name.toLowerCase()); // their posts from before the id, under the name they keep
  const was = (n) => typeof n === 'string' && old.has(n.toLowerCase());
  const rename = (n) => (was(n) ? name : n);
  const once = (n, i, all) => all.findIndex((m) => sameName(m, n)) === i;

  const entry = { ...claimed[0], name, id };
  const participants = sidecar.participants.flatMap((p) => (p === claimed[0] ? [entry] : claimed.includes(p) ? [] : [p]));
  const threads = sidecar.threads.map((t) => ({
    ...t,
    resolvedBy: rename(t.resolvedBy),
    ...(t.working ? { working: { ...t.working, by: rename(t.working.by) } } : {}),
    ...(t.passed ? { passed: t.passed.map(rename).filter(once) } : {}),
    messages: t.messages.map((m) => {
      const mine = m.author.id === id || (m.author.id === undefined && m.author.kind === kind && was(m.author.name));
      return { ...m, ...(mine ? { author: { ...m.author, name, id } } : {}), mentions: m.mentions.map(rename).filter(once) };
    }),
  }));
  const next = { ...sidecar, participants, threads };
  return JSON.stringify(next) === JSON.stringify(sidecar) ? sidecar : next;
}

// An agent in the doc carries who it is (SPEC §2.4): its persona and
// instructions, so the doc keeps its agents wherever it goes. `describe`
// sets them; an empty one is left out.
function describe(sidecar, { name, persona = '', instructions = '' }) {
  const at = sidecar.participants.findIndex((p) => p.kind === 'agent' && sameName(p.name, name ?? ''));
  if (at === -1) throw new OpError('not_found', `no agent ${name} in this doc`);
  const next = { name: sidecar.participants[at].name, kind: 'agent', ...about({ kind: 'agent', persona, instructions }) };
  const participants = sidecar.participants.map((p, i) => (i === at ? next : p));
  return { ...sidecar, participants };
}

function about({ kind, persona, instructions }) {
  if (kind !== 'agent') return {};
  const out = {};
  for (const [key, value] of [['persona', persona], ['instructions', instructions]]) {
    if (value === undefined || value === '') continue;
    if (!AGENT_RULES[key](value)) throw new OpError('bad_input', `invalid ${key}`);
    out[key] = value;
  }
  return out;
}

// A participant leaves the doc (an agent removed from it): they are no
// longer offered for @mentions and stop working on any thread. Their messages
// stay, under their name.
function leave(sidecar, name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new OpError('bad_input', `invalid participant name: ${name}`);
  if (!sidecar.participants.some((p) => sameName(p.name, name))) return sidecar;
  return {
    ...sidecar,
    participants: sidecar.participants.filter((p) => !sameName(p.name, name)),
    threads: sidecar.threads.map((t) => {
      const working = stopWorking(t, name);
      return working === t.working ? t : { ...t, working };
    }),
  };
}

function addThread(sidecar, { id, anchor, message }) {
  if (sidecar.threads.some((t) => t.id === id)) return sidecar;
  const joined = join(sidecar, message.author);
  const thread = {
    id,
    anchor: anchor ?? null,
    detached: false,
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    working: null,
    messages: [buildMessage(joined, message)],
  };
  return { ...joined, threads: [...joined.threads, thread] };
}

function addMessage(sidecar, { threadId, message }) {
  const thread = findThread(sidecar, threadId);
  if (thread.messages.some((m) => m.id === message.id)) return sidecar;
  const joined = join(sidecar, message.author);
  return updateThread(joined, threadId, (t) => ({
    ...t,
    // Replying to a resolved thread reopens it.
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    // The agent's reply ends its "responding…" state.
    working: stopWorking(t, message.author.name),
    // A new ask from a human is open to every agent again.
    ...(t.passed?.length && message.author.kind === 'human' && !message.undoes && !message.applies ? { passed: [] } : {}),
    messages: [...t.messages, buildMessage(joined, message)],
  }));
}

function buildMessage(sidecar, { id, author, body, createdAt, edits, undoes, proposal, applies }) {
  if (typeof body !== 'string' || body.trim() === '') throw new OpError('bad_input', 'message body is empty');
  const message = {
    id,
    author: authorIn(sidecar, author),
    body,
    mentions: parseMentions(body, sidecar.participants),
    createdAt,
  };
  if (edits !== undefined) message.edits = validateEdits(edits);
  if (undoes !== undefined) message.undoes = validateMessageId(undoes);
  if (proposal !== undefined) message.proposal = validateProposal(proposal);
  if (applies !== undefined) message.applies = validateMessageId(applies);
  return message;
}

function validateMessageId(id) {
  if (!MESSAGE_ID.test(id ?? '')) throw new OpError('bad_input', `invalid message id: ${id}`);
  return id;
}

function validateProposal(proposal) {
  const ok = Array.isArray(proposal) && proposal.length > 0 && proposal.every((c) => c
    && typeof c.before === 'string' && c.before !== '' && typeof c.after === 'string' && c.before !== c.after
    && typeof c.prefix === 'string' && c.prefix.length <= 32
    && typeof c.suffix === 'string' && c.suffix.length <= 32
    && Number.isInteger(c.start) && c.start >= 0);
  if (!ok) throw new OpError('bad_input', 'invalid proposal');
  return proposal;
}

// Resolving and reopening are the human's decisions (SPEC.md §2.2).
function requireHuman(sidecar, { by, kind }) {
  if (typeof by !== 'string' || !NAME_PATTERN.test(by)) throw new OpError('bad_input', `invalid participant name: ${by}`);
  const known = sidecar.participants.find((p) => sameName(p.name, by));
  if (kind === 'agent' || known?.kind === 'agent') {
    throw new OpError('not_allowed', `${by} is an agent; only a human can resolve or reopen a thread. Reply instead.`);
  }
  if (kind !== undefined && kind !== 'human') throw new OpError('bad_input', `invalid participant kind: ${kind}`);
}

// Set a message's edits; an empty list removes them.
function attachEdits(sidecar, { threadId, messageId, edits }) {
  if (!Array.isArray(edits) || edits.length > 0) validateEdits(edits);
  return updateThread(sidecar, threadId, (t) => {
    const current = t.messages.find((m) => m.id === messageId);
    if (!current) throw new OpError('bad_input', `no message ${messageId} in thread ${threadId}`);
    if (JSON.stringify(current.edits ?? []) === JSON.stringify(edits)) return t;
    const { edits: _old, ...rest } = current;
    const next = edits.length > 0 ? { ...rest, edits } : rest;
    return { ...t, messages: t.messages.map((m) => (m === current ? next : m)) };
  });
}

function validateEdits(edits) {
  const ok = Array.isArray(edits) && edits.length > 0 && edits.every((e) => e
    && typeof e.before === 'string' && typeof e.after === 'string' && e.before !== e.after
    && typeof e.prefix === 'string' && e.prefix.length <= 32
    && typeof e.suffix === 'string' && e.suffix.length <= 32
    && Number.isInteger(e.start) && e.start >= 0
    && (e.scope === undefined || e.scope === 'thread' || e.scope === 'run'));
  if (!ok) throw new OpError('bad_input', 'invalid edits');
  return edits;
}

function updateThread(sidecar, threadId, change) {
  const current = findThread(sidecar, threadId);
  const next = change(current);
  if (next === current) return sidecar;
  return { ...sidecar, threads: sidecar.threads.map((t) => (t === current ? next : t)) };
}

export function findThread(sidecar, threadId) {
  const thread = sidecar.threads.find((t) => t.id === threadId);
  if (!thread) throw new OpError('unknown_thread', `no thread ${threadId}`);
  return thread;
}

// An author with an id goes by their entry's name (identify may have kept an old one).
function authorIn(sidecar, { name, kind, id }) {
  if (!id) return { name: canonicalName(sidecar, name), kind };
  return { name: sidecar.participants.find((p) => p.id === id)?.name ?? name, kind, id };
}

function canonicalName(sidecar, name) {
  return sidecar.participants.find((p) => sameName(p.name, name))?.name ?? name;
}

function validateParticipant(participant) {
  if (!participant || !NAME_PATTERN.test(participant.name ?? '')) {
    throw new OpError('bad_input', `invalid participant name: ${participant?.name}`);
  }
  if (participant.kind !== 'human' && participant.kind !== 'agent') {
    throw new OpError('bad_input', `invalid participant kind: ${participant.kind}`);
  }
  if (participant.id !== undefined && !PARTICIPANT_ID.test(participant.id)) {
    throw new OpError('bad_input', `invalid participant id: ${participant.id}`);
  }
}

/**
 * Who is working on the thread: `working` as a list of { by, since }. A
 * sidecar written before several could work at once holds a single object.
 */
export function workingList(thread) {
  const w = thread.working;
  if (!w) return [];
  return (Array.isArray(w) ? w : [w]).filter((e) => e && typeof e.by === 'string');
}

/** Who is working on the thread as seen at `now`: entries older than 5 minutes do not count. */
export function activeWorking(thread, now = Date.now()) {
  return workingList(thread).filter((w) => now - Date.parse(w.since) < WORKING_TTL_MS);
}

// `working` without `name`'s entry (the same value when it had none).
function stopWorking(thread, name) {
  const list = workingList(thread);
  const rest = list.filter((w) => !sameName(w.by, name));
  return rest.length === list.length ? thread.working : listOrNull(rest);
}

// No one working is written as null, which tools that knew only a single
// object also read as no one.
const listOrNull = (list) => (list.length > 0 ? list : null);
