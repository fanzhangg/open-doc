// The doc and its sidecar on disk (SPEC.md §1, §3.5, §6): reads, the locked
// read-modify-write cycle, and atomic replacement.

import { createHash } from 'node:crypto';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { emptySidecar, parseSidecar, refreshSidecar, serializeSidecar } from '../core/index.js';

export const SIDECAR_SUFFIX = '.opendoc.json';
export const LOCK_STALE_MS = 2000;
export const LOCK_TIMEOUT_MS = 5000;

export class StoreError extends Error {
  /** @param {'no_doc' | 'lock_timeout'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const sidecarPath = (docPath) => docPath + SIDECAR_SUFFIX;
const lockPath = (docPath) => sidecarPath(docPath) + '.lock';

export function hashBytes(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

/** @returns {Promise<{ markdown: string, hash: string }>} */
export async function readDoc(docPath) {
  let bytes;
  try {
    bytes = await readFile(docPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new StoreError('no_doc', `no such doc: ${docPath}`);
    throw error;
  }
  return { markdown: bytes.toString('utf8'), hash: hashBytes(bytes) };
}

/** The sidecar as stored, or an empty one when the doc has none yet. */
export async function readSidecar(docPath) {
  try {
    return parseSidecar(await readFile(sidecarPath(docPath), 'utf8'), basename(docPath));
  } catch (error) {
    if (error.code === 'ENOENT') return emptySidecar(basename(docPath));
    throw error;
  }
}

/**
 * The doc plus a sidecar whose anchors match it. When the stored anchors are
 * stale they are refreshed and written back (SPEC.md §3.5).
 */
export async function load(docPath) {
  const doc = await readDoc(docPath);
  const stored = await readSidecar(docPath);
  if (stored.threads.length === 0 || stored.docHash === doc.hash) return { doc, sidecar: stored };
  const sidecar = await update(docPath, (s) => s);
  return { doc: await readDoc(docPath), sidecar };
}

/**
 * Locked read-modify-write of the sidecar. `change(sidecar, doc)` receives
 * the latest sidecar (anchors already refreshed against the current doc) and
 * the doc itself, and returns the new sidecar; returning the same object
 * writes nothing unless anchors changed.
 */
export async function update(docPath, change) {
  const release = await acquireLock(docPath);
  try {
    const doc = await readDoc(docPath);
    const stored = await readSidecar(docPath);
    const fresh = stored.threads.length === 0 && stored.docHash === null
      ? stored
      : refreshSidecar(stored, doc.markdown, doc.hash);
    let next = change(fresh, doc);
    if (next !== stored) {
      if (next.docHash === null && next.threads.some((t) => t.anchor)) next = { ...next, docHash: doc.hash };
      await writeAtomic(sidecarPath(docPath), serializeSidecar(next));
    }
    return next;
  } finally {
    await release();
  }
}

/** Rename a doc and its sidecar together, updating the sidecar's `doc`. */
export async function moveDoc(fromPath, toPath) {
  await readDoc(fromPath);
  if (await exists(toPath)) throw new StoreError('no_doc', `target already exists: ${toPath}`);
  const release = await acquireLock(fromPath);
  try {
    const sidecar = (await exists(sidecarPath(fromPath))) ? await readSidecar(fromPath) : null;
    await rename(fromPath, toPath);
    if (sidecar) {
      await writeAtomic(sidecarPath(toPath), serializeSidecar({ ...sidecar, doc: basename(toPath) }));
      await rm(sidecarPath(fromPath));
    }
  } finally {
    await release();
  }
}

async function acquireLock(docPath) {
  const path = lockPath(docPath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    }
    try {
      if (Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS) await rm(path, { force: true });
    } catch {
      // The holder released it between our attempts.
    }
    if (Date.now() > deadline) throw new StoreError('lock_timeout', `could not lock ${sidecarPath(docPath)}`);
    await sleep(5 + Math.random() * 20);
  }
}

// Write a temp file next to the target and rename it into place. On Windows a
// rename can fail briefly while another process has the target open.
async function writeAtomic(path, content) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        await rm(temp, { force: true });
        throw error;
      }
      await sleep(10);
    }
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
