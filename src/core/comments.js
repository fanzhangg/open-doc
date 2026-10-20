// The sidecar, version 3 (spec/SPEC.md): `X.opendoc.jsonl`, a first
// line `{"opendoc":3}` and then one comment per line. A comment never
// changes or goes; resolving is a comment. Threads, who is
// mentioned and who is asked are read from the comments, never stored.
// Pure, so the doc host and the page read a sidecar the same way.

import { NAME_PATTERN, parseMentions } from './mentions.js';
import { createAnchor } from './anchor.js';

export const FORMAT_VERSION = 3;
export const COMMENT_ID = /^c_[A-Za-z0-9_-]{6,}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random id such as `c_k3x9q2m7pa` (prefix `c` for a comment, `u` for a person). */
export function newId(prefix) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  let id = '';
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${id}`;
}

/**
 * Read a sidecar's text (§2, §4). `lines` keeps every line after the first
 * in order, each `{ text, comment }` with `comment` null for a line that is
 * not one (reported in `bad`, skipped, and kept as it is when the file is
 * written again). Of lines with the same id, the first is the comment.
 * `problem` is 'older' or 'newer' when the first line is another version and
 * 'invalid' when it is not a header at all; the lines are still read, to
 * show, but the file must not be written (§2).
 */
export function parseSidecar(text) {
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  let header;
  try {
    header = JSON.parse(all[0] ?? '');
  } catch {
    header = null;
  }
  const problem = !isObject(header) || !Number.isInteger(header.opendoc) ? 'invalid' : header.opendoc < FORMAT_VERSION ? 'older' : header.opendoc > FORMAT_VERSION ? 'newer' : null;
  const lines = [];
  const bad = [];
  const seen = new Set();
  all.slice(1).forEach((line, i) => {
    let comment = null;
    try {
      comment = JSON.parse(line);
    } catch {
      // not JSON
    }
    const why = comment === null ? 'not JSON' : invalid(comment);
    if (why) {
      bad.push({ line: i + 2, error: why });
      lines.push({ text: line, comment: null });
    } else if (!seen.has(comment.id)) {
      seen.add(comment.id);
      lines.push({ text: line, comment });
    }
  });
  return { lines, bad, problem };
}

/** A sidecar's text: the header, then `lines` (from parseSidecar, or added). */
export function serializeSidecar(lines) {
  return [JSON.stringify({ opendoc: FORMAT_VERSION }), ...lines.map((l) => l.text ?? JSON.stringify(l.comment))].join('\n') + '\n';
}

/** An empty sidecar's lines. */
export const emptyLines = () => [];

// Why `c` is not a valid comment (§2), or null.
function invalid(c) {
  if (!isObject(c)) return 'not an object';
  if (typeof c.id !== 'string' || !COMMENT_ID.test(c.id)) return 'bad id';
  if (c.thread !== undefined && (typeof c.thread !== 'string' || !COMMENT_ID.test(c.thread))) return 'bad thread';
  if (c.anchor !== undefined && c.anchor !== null && !validAnchor(c.anchor)) return 'bad anchor';
  if (!isObject(c.by) || typeof c.by.id !== 'string' || !c.by.id || !NAME_PATTERN.test(c.by.name ?? '') || !['human', 'ai'].includes(c.by.kind)) return 'bad by';
  if (typeof c.at !== 'string' || !AT.test(c.at)) return 'bad at';
  if (typeof c.body !== 'string' || (c.body.trim() === '' && c.resolved !== true && !c.thread)) return 'bad body';
  for (const key of ['resolved', 'conflict', 'failed']) if (c[key] !== undefined && c[key] !== true) return `bad ${key}`;
  return null;
}

/**
 * A new comment as the sidecar holds it (§2), whoever writes it: a first
 * comment on `anchor` (null for the whole doc) or a reply in `thread`, by
 * `by` at `at`. Only a human's `resolved` is kept, and then the body is
 * empty; the id is made here.
 */
export function newComment({ thread, anchor = null, body, resolved }, { by, at }) {
  const resolves = resolved === true && by.kind === 'human';
  return {
    id: newId('c'),
    ...(thread !== undefined ? { thread } : { anchor }),
    by,
    at,
    body: resolves ? '' : body,
    ...(resolves ? { resolved: true } : {}),
  };
}

/**
 * The comments a buddy's run appended to its copy of the sidecar
 * (docs/agent-config.md, Comments): lines in `after` that were not in
 * `before` and have no `id` (a changed comment has one), each `{ anchor: { exact }, body }`, `{ body }` or `{ thread,
 * body }`, made comments `by` the buddy `at` a time. A reply needs a thread
 * of `threads`; a quote found other than once in `text` (the doc's text) is
 * on the whole doc. Anything else is ignored.
 */
export function appendedComments(before, after, { text, by, at, threads }) {
  const had = new Set(before.split('\n'));
  const added = [];
  for (const raw of after.split('\n')) {
    if (!raw.trim() || had.has(raw)) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(line) || line.id !== undefined || typeof line.body !== 'string' || !line.body.trim()) continue;
    if (line.thread !== undefined && !threads.has(line.thread)) continue;
    added.push(newComment({
      thread: line.thread,
      anchor: line.thread === undefined ? quoted(text, line.anchor?.exact) : undefined,
      body: line.body.trim(),
      resolved: line.resolved,
    }, { by, at }));
  }
  return added;
}

// The anchor of `exact` when it is in `text` once, else null. An agent may
// quote a hard-wrapped line as one, or the other way round, so a quote not
// found as it is is looked for with any run of whitespace standing for any
// other.
function quoted(text, exact) {
  if (typeof exact !== 'string' || !exact.trim()) return null;
  const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return once(text, escape(exact)) ?? once(text, exact.trim().split(/\s+/).map(escape).join('\\s+'));
}

// The anchor of the one match of `pattern` in `text`, else null.
function once(text, pattern) {
  const regex = new RegExp(pattern, 'g');
  const found = regex.exec(text);
  if (!found) return null;
  regex.lastIndex = found.index + 1;
  if (regex.exec(text)) return null;
  return createAnchor(text, found.index, found.index + found[0].length);
}

/** Whether `anchor` is `{ exact, prefix, suffix, start }` (§3). */
export function validAnchor(anchor) {
  return isObject(anchor) && typeof anchor.exact === 'string' && anchor.exact.length > 0
    && typeof anchor.prefix === 'string' && anchor.prefix.length <= 32
    && typeof anchor.suffix === 'string' && anchor.suffix.length <= 32
    && Number.isInteger(anchor.start) && anchor.start >= 0;
}

const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The threads in `comments` (§4): each `{ id, anchor, resolved, comments }`,
 * its first comment then its replies, ordered by `at`, then `id`; threads in
 * the order of their first comments. Only people resolve and reopen: a
 * thread is resolved when its latest human comment says so. A reply whose first comment is missing
 * is left out. `mentionable` ([{ id, name }]) is who an @name can mean (§6); each comment
 * gets `mentions`, the ids it mentions.
 */
export function threadsOf(comments, mentionable = []) {
  const firsts = comments.filter((c) => c.thread === undefined).sort(byTime);
  return firsts.map((first) => {
    const all = [first, ...comments.filter((c) => c.thread === first.id).sort(byTime)]
      .map((c) => ({ ...c, mentions: parseMentions(c.body, mentionable) }));
    const human = all.findLast((c) => c.by.kind === 'human');
    return { id: first.id, anchor: first.anchor ?? null, resolved: human?.resolved === true, comments: all };
  });
}

/**
 * The buddies (ids) the open `thread` (from threadsOf) waits on: each X that a
 * comment by user `me` (an id) asks, newer than X's last comment there. A
 * comment asks whom it @mentions; one that mentions no one asks the
 * thread's buddies, unless it is empty (it resolved or reopened the thread): the one that opened it and each that `me` @mentioned
 * there before (docs/architecture.md, Who answers). Resolving drops what
 * was asked before it, so reopening asks no one.
 */
export function askedOf(thread, me) {
  if (thread.resolved) return [];
  const add = (list, id) => { if (!list.includes(id)) list.push(id); };
  const theirs = thread.comments[0].by.kind === 'ai' ? [thread.comments[0].by.id] : [];
  const asked = [];
  thread.comments.forEach((c, i) => {
    if (c.by.kind === 'human' && c.resolved) asked.length = 0;
    if (c.by.kind !== 'human' || c.by.id !== me || c.body.trim() === '') return;
    for (const id of c.mentions.length > 0 ? c.mentions : theirs) {
      const answered = thread.comments.slice(i + 1).some((r) => r.by.kind === 'ai' && r.by.id === id);
      if (!answered) add(asked, id);
    }
    for (const id of c.mentions) add(theirs, id);
  });
  return asked;
}

/**
 * Who a person is in the comments: for each human id, the name in their
 * latest comment (§4): [{ id, name }].
 */
export function peopleOf(comments) {
  const latest = new Map();
  for (const c of [...comments].sort(byTime)) if (c.by.kind === 'human') latest.set(c.by.id, c.by.name);
  return [...latest].map(([id, name]) => ({ id, name }));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
