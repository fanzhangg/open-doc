// The doc and its sidecar on disk (spec/SPEC.md §1, §5): reads, writing
// a file whole (a temporary file renamed over it), and renaming a doc with
// its sidecar. Only the doc host writes them, one change at a time.

import { createHash } from 'node:crypto';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

export const SIDECAR_SUFFIX = '.opendoc.jsonl';
const LOCK_STALE_MS = 2000;
const LOCK_TIMEOUT_MS = 5000;

export class StoreError extends Error {
  /** @param {'no_doc' | 'exists' | 'lock_timeout'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const sidecarPath = (docPath) => docPath + SIDECAR_SUFFIX;

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

/** The sidecar's text, or null when the doc has none yet. */
export async function readSidecarText(docPath) {
  try {
    return await readFile(sidecarPath(docPath), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Rename a doc and its sidecar together, never over another file. */
export async function moveDoc(fromPath, toPath) {
  await readDoc(fromPath);
  if (await exists(toPath)) throw new StoreError('exists', `target already exists: ${toPath}`);
  await rename(fromPath, toPath);
  if (await exists(sidecarPath(fromPath))) await rename(sidecarPath(fromPath), sidecarPath(toPath));
}

/**
 * Take the exclusive lock file `path` guarding `target` (a file the app's
 * processes share, such as settings.json); a lock older than LOCK_STALE_MS
 * is taken over.
 * @returns {Promise<() => Promise<void>>} release
 */
export async function lockFile(path, target) {
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
    if (Date.now() > deadline) throw new StoreError('lock_timeout', `could not lock ${target}`);
    await sleep(5 + Math.random() * 20);
  }
}

// Write a temp file next to the target and rename it into place. On Windows a
// rename can fail briefly while another process has the target open.
export async function writeAtomic(path, content) {
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

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
