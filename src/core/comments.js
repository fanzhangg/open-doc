// The sidecar, version 2 (spec/SPEC-v2.md): `X.md.opendoc.jsonl`, a first
// line `{"opendoc":2}` and then one comment per line. A comment never
// changes; resolving is a comment, deleting removes lines. Threads, who is
// mentioned and who is asked are read from the comments, never stored.
// Pure, so the doc host and the page read a sidecar the same way.

import { NAME_PATTERN, parseMentions, sameName } from './mentions.js';

export const FORMAT_VERSION = 2;
export const COMMENT_ID = /^c_[A-Za-z0-9_-]{6,}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export class FormatError extends Error {
  /** @param {'version' | 'invalid'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

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
 * Throws a FormatError for a file that is not version 2.
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
  if (!isObject(header) || !Number.isInteger(header.opendoc)) throw new FormatError('invalid', 'not an opendoc sidecar: the first line is not {"opendoc":2}');
  if (header.opendoc !== FORMAT_VERSION) throw new FormatError('version', `opendoc version ${header.opendoc}; this tool reads version ${FORMAT_VERSION}`);
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
  return { lines, bad };
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
  if (typeof c.body !== 'string' || (c.body.trim() === '' && c.resolved !== true)) return 'bad body';
  for (const key of ['resolved', 'conflict', 'failed']) if (c[key] !== undefined && c[key] !== true) return `bad ${key}`;
  return null;
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
 * the order of their first comments. A reply whose first comment is missing
 * is left out. `mentionable` names who an @name can mean (§6); each comment
 * gets `mentions`, the names it mentions, as spelled there.
 */
export function threadsOf(comments, mentionable = []) {
  const firsts = comments.filter((c) => c.thread === undefined).sort(byTime);
  return firsts.map((first) => {
    const all = [first, ...comments.filter((c) => c.thread === first.id).sort(byTime)]
      .map((c) => ({ ...c, mentions: parseMentions(c.body, mentionable) }));
    return { id: first.id, anchor: first.anchor ?? null, resolved: all.at(-1).resolved === true, comments: all };
  });
}

/**
 * The buddies the open `thread` (from threadsOf) waits on: each X that a
 * comment by user `me` (an id) @mentions, newer than X's last comment there
 * (docs/architecture-v2.md, Who answers).
 */
export function askedOf(thread, me) {
  if (thread.resolved) return [];
  const asked = [];
  thread.comments.forEach((c, i) => {
    if (c.by.kind !== 'human' || c.by.id !== me) return;
    for (const name of c.mentions) {
      const answered = thread.comments.slice(i + 1).some((r) => r.by.kind === 'ai' && sameName(r.by.id, name));
      if (!answered && !asked.some((n) => sameName(n, name))) asked.push(name);
    }
  });
  return asked;
}

/** `lines` with comment `id` deleted, and its replies when it is a first comment (§5). */
export function deleteComment(lines, id) {
  return lines.filter((l) => l.comment?.id !== id && l.comment?.thread !== id);
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
