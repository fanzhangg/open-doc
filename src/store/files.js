// The doc and its sidecar on disk (spec/SPEC.md §1, §5): reads, writing
// a file whole (a temporary file renamed over it), and renaming a doc with
// its sidecar. Only the doc host writes them, one change at a time.
//
// The rest of the app sees a doc only as its text (SPEC.md §1): decoded as
// UTF-8, no byte order mark, lines ending in \n. How the file wrote those
// (`form`) is kept here, to write it back the same way.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

export const SIDECAR_SUFFIX = '.opendoc.jsonl';
// Room for the longest doc the Plain text view edits (5,000,000 characters,
// web/views/plain/index.js), at up to 4 bytes a character.
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const LOCK_STALE_MS = 2000;
const LOCK_TIMEOUT_MS = 5000;

export class StoreError extends Error {
  /** @param {'no_doc' | 'not_text' | 'exists' | 'lock_timeout'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const sidecarPath = (docPath) => docPath + SIDECAR_SUFFIX;

function hashBytes(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

const BOM = '\uFEFF';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A file's text and how it was written: { text, form: { bom, crlf } }, or
 * null when it is not UTF-8. `crlf` when any line ended in \r\n.
 */
export function decodeText(bytes) {
  let raw;
  try {
    raw = utf8.decode(bytes);
  } catch {
    return null;
  }
  const bom = raw.startsWith(BOM);
  if (bom) raw = raw.slice(1);
  return { text: raw.replace(/\r\n?/g, '\n'), form: { bom, crlf: raw.includes('\r\n') } };
}

/** The bytes of `text` written in `form` (from decodeText). */
export function encodeText(text, { bom = false, crlf = false } = {}) {
  return Buffer.from((bom ? BOM : '') + (crlf ? text.replace(/\n/g, '\r\n') : text));
}

export const hashText = hashBytes; // a string is hashed as UTF-8, without a copy

/** @returns {Promise<{ text: string, hash: string, form: { bom: boolean, crlf: boolean } }>} `hash` of the text */
export async function readDoc(docPath) {
  let bytes;
  try {
    bytes = await readFile(docPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new StoreError('no_doc', `no such doc: ${docPath}`);
    throw error;
  }
  const decoded = decodeText(bytes);
  if (!decoded) throw new StoreError('not_text', `${basename(docPath)} is not UTF-8 text, so Ponjo does not open it`);
  return { ...decoded, hash: hashText(decoded.text) };
}

/**
 * Write `text` over the doc in `form` (a new doc: \n, no BOM); resolves to
 * the file's stat as written, or null when `still()`, asked just before the
 * new file takes the doc's place, resolves to false.
 */
export function writeDoc(docPath, text, form, still) {
  return writeAtomic(docPath, encodeText(text, form), still);
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

/**
 * Write the sidecar. Comments may be private and the repo public, so inside
 * a git work tree its pattern first goes into the repo's `info/exclude`, a
 * file git never commits: nothing for the user to do, and a person who wants
 * to share comments adds `!*.opendoc.jsonl` after it. Checked at every write, so a folder
 * that becomes a repo later is covered; outside a repo or without git, no-op.
 */
export async function writeSidecar(docPath, text) {
  await excludeSidecars(dirname(docPath));
  await writeAtomic(sidecarPath(docPath), text);
}

async function excludeSidecars(dir) {
  const pattern = '*' + SIDECAR_SUFFIX;
  let file;
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir });
    file = resolve(dir, stdout.trim());
  } catch {
    return;
  }
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split('\n').includes(pattern)) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, (current === '' || current.endsWith('\n') ? '' : '\n') + pattern + '\n');
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

// Write a temp file next to the target and rename it into place, unless
// `still()` says not to (null then); resolves to its stat as written, taken
// before anyone else could change it. On Windows a rename can fail briefly
// while another process has the target open.
export async function writeAtomic(path, content, still = async () => true) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content);
  const written = await stat(temp);
  if (!(await still())) {
    await rm(temp, { force: true });
    return null;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path);
      return written;
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
