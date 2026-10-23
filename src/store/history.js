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
//   <config>/history/<key>/seen.json    the version each person last looked at (noteSeen)
// `key` is derived from the doc's absolute path; renaming a doc in Ponjo
// moves its history along (moveHistory).
//
// A version is never changed once written, only dropped when it is the
// oldest and the history is full. Each names its `parent`, the version
// before it, whose text is what it changed: so any version can be undone
// while its parent is kept, however many came after. Typing is a version
// each time it pauses (the history view groups a burst of them); one typed
// by several people lists them all in `authors`.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { diffEdits } from '../core/diff.js';
import { newId } from '../core/comments.js';
import { hashText, lockFile, writeAtomic } from './files.js';

const HISTORY_VERSION = 1;
const MAX_VERSIONS = 2000;
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
 *   { id, parent, kind, author, authors?, at, hash, size, added, removed, thread?, reply?, conflict?, undid?, restoredFrom? }
 * `parent` is the version before it (null for the first); `kind` is
 * 'opened' (the doc as first seen), 'edit', 'undo', 'restore' or 'external'
 * (changed outside Ponjo); `author` is { id?, name, kind } or null when
 * unknown, the first of `authors` when several typed it; `added` and
 * `removed` count the characters changed since the parent. A buddy's edit
 * has the `thread` it answered and the id of its `reply`, and `conflict`
 * when it collided with people's lines again when run once more, and theirs
 * stayed there; an undo has the version it `undid`.
 */
export async function readHistory(docPath, root) {
  return (await readIndex(historyDir(docPath, root))).versions;
}

/**
 * One version with its text, and the text of its parent (null for the
 * first, or once the parent is dropped): { version, text, before }, or
 * null when it is gone.
 */
export async function readVersion(docPath, root, id) {
  const dir = historyDir(docPath, root);
  const { versions } = await readIndex(dir);
  const version = versions.find((v) => v.id === id);
  const text = version && (await readBlob(dir, version.hash));
  if (text == null) return null;
  const parent = versions.find((v) => v.id === version.parent);
  return { version, text, before: parent ? await readBlob(dir, parent.hash) : null };
}

/**
 * Note that the doc now reads `text`: a new version, whose parent is the
 * latest. Returns it, or null when the latest version reads `text` already.
 * `change` is { kind, author, authors?, thread?, reply?, conflict?, undid?, restoredFrom? }.
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

    const dropped = [];
    const version = {
      id: newId('v'),
      parent: last?.id ?? null,
      kind: versions.length === 0 && change.kind === 'external' ? 'opened' : change.kind,
      author: change.author ?? null,
      ...(change.authors ? { authors: change.authors } : {}),
      at: new Date(now).toISOString(),
      hash,
      ...Object.fromEntries(['thread', 'reply', 'conflict', 'undid', 'restoredFrom'].filter((k) => change[k]).map((k) => [k, change[k]])),
    };
    const before = last ? await readBlob(dir, last.hash) : null;
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

/**
 * Note, before the doc is written, the edits the file will hold once it is:
 * the ids of windows' edits, and the hash it will have; `before`, the ids
 * already written. A doc host that starts again reads them (writtenEdits),
 * so a window learns its edit is in the file though it never heard so.
 */
export async function noteWritten(docPath, root, hash, ids, before = ids) {
  const dir = historyDir(docPath, root);
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, 'written.json'), JSON.stringify({ hash, ids, before }));
}

/**
 * The ids noteWritten noted, if the doc's file now has the `hash` it noted;
 * else those already written before: the write never happened, or the file
 * changed outside since, which keeps what was written landed.
 */
export async function writtenEdits(docPath, root, hash) {
  try {
    const noted = JSON.parse(await readFile(join(historyDir(docPath, root), 'written.json'), 'utf8'));
    const ids = noted?.hash === hash ? noted.ids : noted?.before;
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
 * The text of version `id` and of each version after it, oldest first:
 * { text, after: [{ version, text }] }, or null when `id` is gone.
 */
export async function versionsSince(docPath, root, id) {
  const dir = historyDir(docPath, root);
  const { versions } = await readIndex(dir);
  const at = versions.findIndex((v) => v.id === id);
  const text = at === -1 ? null : await readBlob(dir, versions[at].hash);
  if (text === null) return null;
  const after = [];
  for (const version of versions.slice(at + 1)) after.push({ version, text: await readBlob(dir, version.hash) ?? '' });
  return { text, after };
}

/** The version each person last looked at: { [person id]: version id }. */
export async function readSeen(docPath, root) {
  try {
    return JSON.parse(await readFile(join(historyDir(docPath, root), 'seen.json'), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** Person `person` has looked at the doc as version `id`. */
export async function noteSeen(docPath, root, person, id) {
  const dir = historyDir(docPath, root);
  await mkdir(dir, { recursive: true });
  const release = await lockFile(join(dir, 'seen.json.lock'), dir);
  try {
    await writeAtomic(join(dir, 'seen.json'), JSON.stringify({ ...(await readSeen(docPath, root)), [person]: id }));
  } finally {
    await release();
  }
}

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
    if (index?.history === HISTORY_VERSION && Array.isArray(index.versions)) {
      index.versions.forEach((v, i) => { v.parent ??= index.versions[i - 1]?.id ?? null; }); // written before versions named it
      return index;
    }
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
