// The doc's version history: a snapshot of the doc each time it changes on
// disk, with who changed it (the human, a buddy, or a program outside
// Ponjo), so any earlier version can be looked at and restored, and a
// buddy's edit undone.
//
// History is kept per doc in the user's config folder, not next to the doc,
// so it never shows up in the doc's folder or in git:
//   <config>/history/<key>/index.json   the versions, oldest first
//   <config>/history/<key>/<sha256>.md  each version's text, by content
//   <config>/history/<key>/taken.json   the comments this host took (noteTaken)
// `key` is derived from the doc's absolute path; renaming a doc in Ponjo
// moves its history along (moveHistory).
//
// A burst of typing is one version: a change by people who typed in the
// latest version, within COALESCE_MS of it, and less than MAX_SPAN_MS after
// it began, replaces that version's text. A version typed by several people
// lists them all in `authors`. A buddy's edit is always a
// version of its own, after the version it was merged into.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { diffEdits } from '../core/diff.js';
import { newId } from '../core/comments.js';
import { hashText, lockFile, writeAtomic } from './files.js';

const HISTORY_VERSION = 1;
export const COALESCE_MS = 2 * 60 * 1000;
export const MAX_SPAN_MS = 30 * 60 * 1000;
const MAX_VERSIONS = 500;
// The characters of text kept, besides: of a doc of millions of characters
// (up to 5,000,000 are edited, web/views/plain/index.js), the latest versions
// that fit; of an ordinary doc, all MAX_VERSIONS.
export const MAX_HISTORY_CHARS = 100_000_000;
export const VERSION_ID = /^v_[a-z0-9]{6,}$/;

/** The folder holding the history of `docPath`, under the config folder `root`. */
export function historyDir(docPath, root) {
  let path = resolve(docPath);
  if (process.platform === 'win32' || process.platform === 'darwin') path = path.toLowerCase();
  return join(root, 'history', createHash('sha256').update(path).digest('hex').slice(0, 24));
}

/**
 * The versions of the doc, oldest first:
 *   { id, kind, author, authors?, startedAt, at, hash, size, added, removed, thread?, reply?, undid?, restoredFrom? }
 * `kind` is 'opened' (the doc as first seen), 'edit', 'undo', 'restore' or
 * 'external' (changed outside Ponjo); `author` is { id?, name, kind } or null
 * when unknown, the first of `authors` when several typed it; `added` and `removed` count the characters changed since
 * the version before. A buddy's edit has the `thread` it answered and the
 * id of its `reply`, and `conflict` when a person's edit that started
 * before it landed took part of it back; an undo of one has the reply it
 * `undid`.
 */
export async function readHistory(docPath, root) {
  return (await readIndex(historyDir(docPath, root))).versions;
}

/**
 * One version with its text, and the text of the version before it (null
 * for the first): { version, text, before }, or null when it is gone.
 */
export async function readVersion(docPath, root, id) {
  const dir = historyDir(docPath, root);
  const { versions } = await readIndex(dir);
  const i = versions.findIndex((v) => v.id === id);
  if (i === -1) return null;
  const text = await readBlob(dir, versions[i].hash);
  if (text === null) return null;
  const before = i > 0 ? await readBlob(dir, versions[i - 1].hash) : null;
  return { version: versions[i], text, before };
}

/**
 * Note that the doc now reads `text`. Returns the version that holds it
 * (new or extended), or null when it is the latest version already.
 * `change` is { kind, author, authors?, thread?, reply?, undid?, restoredFrom? }.
 */
export async function recordVersion(docPath, root, text, change, now = Date.now()) {
  const dir = historyDir(docPath, root);
  await mkdir(dir, { recursive: true });
  const release = await lockFile(join(dir, 'index.json.lock'), dir);
  try {
    const index = await readIndex(dir);
    const { versions } = index;
    const hash = hashText(text);
    const last = versions.at(-1);
    if (last?.hash === hash) return null;

    const at = new Date(now).toISOString();
    const dropped = [];
    let version;
    if (last && continues(last, change, now)) {
      // The same people, still at it: this version now ends at `text`.
      versions.pop();
      dropped.push(last.hash);
      const previous = versions.at(-1);
      if (previous?.hash === hash) {
        // They put it back the way it was: no change left to show.
        await saveIndex(dir, index, docPath, dropped);
        return previous;
      }
      version = { ...last, at, hash };
    } else {
      version = {
        id: newId('v'),
        kind: versions.length === 0 && change.kind === 'external' ? 'opened' : change.kind,
        author: change.author ?? null,
        ...(change.authors ? { authors: change.authors } : {}),
        startedAt: at,
        at,
        hash,
        ...Object.fromEntries(['thread', 'reply', 'undid', 'restoredFrom'].filter((k) => change[k]).map((k) => [k, change[k]])),
      };
    }
    const before = versions.length > 0 ? await readBlob(dir, versions.at(-1).hash) : null;
    Object.assign(version, countChanges(before, text), { size: text.length });
    await writeBlob(dir, hash, text);
    versions.push(version);
    const kept = () => versions.reduce((n, v) => n + (v.size ?? 0), 0);
    while (versions.length > MAX_VERSIONS || (versions.length > 1 && kept() > MAX_HISTORY_CHARS)) dropped.push(versions.shift().hash);
    await saveIndex(dir, index, docPath, dropped);
    return version;
  } finally {
    await release();
  }
}

/** Mark the version of buddy reply `reply`'s edit `conflict`: part of it was taken back. */
export async function markConflict(docPath, root, reply) {
  const dir = historyDir(docPath, root);
  const release = await lockFile(join(dir, 'index.json.lock'), dir);
  try {
    const index = await readIndex(dir);
    const version = index.versions.find((v) => v.reply === reply);
    if (!version || version.conflict) return;
    version.conflict = true;
    await saveIndex(dir, index, docPath, []);
  } finally {
    await release();
  }
}

/**
 * Note, before the doc is written, the edits the file will hold once it is:
 * `next`, { hash, ids }, the hash it will have and the ids of windows' edits
 * in it; and `was`, the same of the file as last written, which it still
 * is should the write not happen. A doc host that starts again reads them
 * (writtenEdits), so a window learns its edit is in the file though it
 * never heard so.
 */
export async function noteWritten(docPath, root, next, was = null) {
  const dir = historyDir(docPath, root);
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, 'written.json'), JSON.stringify({ notes: was ? [next, was] : [next] }));
}

/** The ids noteWritten noted for the file with `hash`, the doc's file now; else none. */
export async function writtenEdits(docPath, root, hash) {
  try {
    const { notes } = JSON.parse(await readFile(join(historyDir(docPath, root), 'written.json'), 'utf8'));
    const ids = notes.find((note) => note.hash === hash)?.ids;
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

/**
 * Note, before the sidecar is written, that this host took `comment`, a
 * person's: only such a comment asks a buddy (src/host/doc-service.js,
 * asks). `ids` are the comments the sidecar holds; the notes of others are
 * dropped.
 */
export async function noteTaken(docPath, root, comment, ids) {
  const dir = historyDir(docPath, root);
  const kept = new Set(ids);
  const taken = Object.fromEntries(Object.entries(await readTakenFile(dir)).filter(([id]) => kept.has(id)));
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, 'taken.json'), JSON.stringify({ ...taken, [comment.id]: takenHash(comment) }));
}

/** A check of whether this host took a comment as it now reads: its thread, author and body unchanged. */
export async function readTaken(docPath, root) {
  const taken = await readTakenFile(historyDir(docPath, root));
  return (comment) => taken[comment.id] === takenHash(comment);
}

async function readTakenFile(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'taken.json'), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

const takenHash = (c) => hashText(JSON.stringify([c.thread ?? null, c.by.id, c.body]));

/**
 * The doc was renamed from `fromPath` to `toPath`: its history follows. A
 * history left at the new path by an earlier doc is set aside, not deleted.
 */
export async function moveHistory(fromPath, toPath, root) {
  const from = historyDir(fromPath, root);
  const to = historyDir(toPath, root);
  if (from === to || !(await exists(from))) return;
  if (await exists(to)) await rename(to, `${to}.old-${Date.now()}`);
  await rename(from, to);
}

function continues(last, change, now) {
  const typed = authorsOf(last);
  return change.kind === 'edit' && last.kind === 'edit' && !change.reply && !last.reply
    && authorsOf(change).length > 0 && authorsOf(change).every((a) => typed.some((b) => sameAuthor(a, b)))
    && now - Date.parse(last.at) < COALESCE_MS
    && now - Date.parse(last.startedAt) < MAX_SPAN_MS;
}

const authorsOf = (v) => v.authors ?? (v.author ? [v.author] : []);

const sameAuthor = (a, b) => Boolean(a && b) && a.kind === b.kind && (a.id ?? a.name).toLowerCase() === (b.id ?? b.name).toLowerCase();

// Characters added and removed between two versions of the source.
function countChanges(before, after) {
  if (before === null) return { added: after.length, removed: 0, changes: 1 };
  let added = 0;
  let removed = 0;
  const edits = diffEdits(before, after);
  for (const { edit } of edits) {
    // Edits are widened to whole words; count only what differs.
    const a = edit.before;
    const b = edit.after;
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    added += b.length - head - tail;
    removed += a.length - head - tail;
  }
  return { added, removed, changes: edits.length };
}

async function readIndex(dir) {
  try {
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    if (index?.history === HISTORY_VERSION && Array.isArray(index.versions)) return index;
  } catch {
    // none yet, or unreadable: start a new one
  }
  return { history: HISTORY_VERSION, doc: null, versions: [] };
}

// Save the index, then remove the blobs of `dropped` versions no version uses.
async function saveIndex(dir, index, docPath, dropped) {
  index.doc = resolve(docPath);
  await writeAtomic(join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  const kept = new Set(index.versions.map((v) => v.hash));
  for (const hash of new Set(dropped)) {
    if (!kept.has(hash)) await rm(blobPath(dir, hash), { force: true });
  }
}

const blobPath = (dir, hash) => join(dir, `${hash.replace(/^sha256:/, '')}.md`);

async function readBlob(dir, hash) {
  try {
    return await readFile(blobPath(dir, hash), 'utf8');
  } catch {
    return null;
  }
}

async function writeBlob(dir, hash, text) {
  if (!(await exists(blobPath(dir, hash)))) await writeAtomic(blobPath(dir, hash), text);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
