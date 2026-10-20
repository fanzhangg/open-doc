// The doc's version history: a snapshot of the doc each time it changes on
// disk, with who changed it (the human, a buddy, or a program outside
// OpenDoc), so any earlier version can be looked at and restored, and a
// buddy's edit undone.
//
// History is kept per doc in the user's config folder, not next to the doc,
// so it never shows up in the doc's folder or in git:
//   <config>/history/<key>/index.json   the versions, oldest first
//   <config>/history/<key>/<sha256>.md  each version's text, by content
// `key` is derived from the doc's absolute path; renaming a doc in OpenDoc
// moves its history along (moveHistory).
//
// A burst of typing by the same person is one version: a change within
// COALESCE_MS of their last one, and less than MAX_SPAN_MS after their
// version began, replaces that version's text. A buddy's edit is always a
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
export const VERSION_ID = /^v_[a-z0-9]{6,}$/;

/** The folder holding the history of `docPath`, under the config folder `root`. */
export function historyDir(docPath, root) {
  let path = resolve(docPath);
  if (process.platform === 'win32' || process.platform === 'darwin') path = path.toLowerCase();
  return join(root, 'history', createHash('sha256').update(path).digest('hex').slice(0, 24));
}

/**
 * The versions of the doc, oldest first:
 *   { id, kind, author, startedAt, at, hash, added, removed, thread?, reply?, undid?, restoredFrom? }
 * `kind` is 'opened' (the doc as first seen), 'edit', 'undo', 'restore' or
 * 'external' (changed outside OpenDoc); `author` is { id?, name, kind } or null
 * when unknown; `added` and `removed` count the characters changed since
 * the version before. A buddy's edit has the `thread` it answered and the
 * id of its `reply`; an undo of one has the reply it `undid`.
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
 * `change` is { kind, author, thread?, reply?, undid?, restoredFrom? }.
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
      // Same author, still at it: this version now ends at `text`.
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
        startedAt: at,
        at,
        hash,
        ...Object.fromEntries(['thread', 'reply', 'undid', 'restoredFrom'].filter((k) => change[k]).map((k) => [k, change[k]])),
      };
    }
    const before = versions.length > 0 ? await readBlob(dir, versions.at(-1).hash) : null;
    Object.assign(version, countChanges(before, text));
    await writeBlob(dir, hash, text);
    versions.push(version);
    while (versions.length > MAX_VERSIONS) dropped.push(versions.shift().hash);
    await saveIndex(dir, index, docPath, dropped);
    return version;
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

function continues(last, change, now) {
  return change.kind === 'edit' && last.kind === 'edit' && !change.reply && !last.reply
    && sameAuthor(last.author, change.author)
    && now - Date.parse(last.at) < COALESCE_MS
    && now - Date.parse(last.startedAt) < MAX_SPAN_MS;
}

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
