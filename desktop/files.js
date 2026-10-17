// Creating, renaming, moving and trashing docs and folders for the desktop app. Plain Node (no Electron),
// so the tests run under `node --test`.

import { mkdir, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SIDECAR_SUFFIX, moveDoc, sidecarPath } from '../src/store/files.js';

export const DOC_EXTENSIONS = ['.md', '.markdown'];
const UNTITLED = 'Untitled';
const MAX_UNTITLED = 10_000;

export class DocFileError extends Error {
  /** @param {'exists' | 'inside'} code */
  constructor(code, message, path) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

export const isDocName = (path) => DOC_EXTENSIONS.includes(extname(path).toLowerCase());

/** The doc a path opens: X.md for X.md or its sidecar X.md.opendoc.json, null for any other file. */
export function docPathFor(path) {
  const doc = path.endsWith(SIDECAR_SUFFIX) ? path.slice(0, -SIDECAR_SUFFIX.length) : path;
  return isDocName(doc) ? doc : null;
}

/**
 * Doc paths on a command line, made absolute against `cwd`. Flags are
 * skipped; run from a checkout (`electron desktop/main.js ...`, not
 * `packaged`), the first argument is the app's own script.
 */
export function pathsFromArgs(argv, { packaged, cwd }) {
  const args = argv.slice(1).filter((arg) => !arg.startsWith('-'));
  if (!packaged) args.shift();
  return args.map((arg) => resolve(cwd, arg));
}

/**
 * Paths handed over by another launch or a drop: absolute strings only, at
 * most `max` of them; anything else is dropped.
 */
export function cleanPaths(value, max = 50) {
  if (!Array.isArray(value)) return [];
  return value.filter((path) => typeof path === 'string' && path.length < 4096 && isAbsolute(path)).slice(0, max);
}

/** `path` with `.md` added unless it already ends in `.md` or `.markdown`. */
export const withDocExtension = (path) => (isDocName(path) ? path : `${path}.md`);

/**
 * Create an empty doc (and its folder). Never overwrites: an existing file
 * throws DocFileError('exists').
 */
export async function createDoc(path) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, '', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new DocFileError('exists', `${basename(path)} already exists`, path);
    throw error;
  }
  return path;
}

/** The first of `Untitled.md`, `Untitled 2.md`, ... in `dir` with neither a doc nor a leftover sidecar. */
export async function freeUntitledPath(dir) {
  for (let n = 1; n <= MAX_UNTITLED; n++) {
    const path = join(dir, n === 1 ? `${UNTITLED}.md` : `${UNTITLED} ${n}.md`);
    if (!(await exists(path)) && !(await exists(sidecarPath(path)))) return path;
  }
  throw new Error(`no free name for a new doc in ${dir}`);
}

/** Create the next free `Untitled N.md` in `dir`; another app taking the name first just moves on. */
export async function createUntitled(dir) {
  for (;;) {
    try {
      return await createDoc(await freeUntitledPath(dir));
    } catch (error) {
      if (error.code !== 'exists') throw error;
    }
  }
}

/**
 * Rename (or move) a doc and its sidecar together, as `opendoc mv` does.
 * `.md` is added when the new name has no doc extension. A name that only
 * changes case works on case-insensitive disks too. Never overwrites.
 * @returns {Promise<string>} the doc's new path
 */
export async function renameDoc(fromPath, toPath) {
  const target = withDocExtension(toPath);
  if (target === fromPath) return fromPath;
  if (await exists(target)) {
    if (!(await sameFile(fromPath, target))) {
      throw new DocFileError('exists', `${basename(target)} already exists`, target);
    }
    // Same file under another case: go through a temporary name.
    const temp = join(dirname(target), `.${basename(target)}.${process.pid}.renaming.md`);
    await moveDoc(fromPath, temp);
    await moveDoc(temp, target);
    return target;
  }
  await moveDoc(fromPath, target);
  return target;
}

// Characters Windows refuses in a name; elsewhere only `/` (a folder) and NUL.
const WINDOWS_RESERVED = /[<>:"|?*\\]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Why `name` (one part of a path, as typed in the sidebar) can't be a doc or
 * folder name, or null when it can. A leading `.` is refused: hidden files
 * are not listed, so the new one would vanish from the sidebar.
 */
export function nameProblem(name, platform = process.platform) {
  if (!name.trim()) return 'Enter a name.';
  if (name === '.' || name === '..') return `"${name}" can't be a name.`;
  if (name.startsWith('.')) return 'Names starting with "." are hidden; pick another.';
  if (/[\u0000-\u001f]/.test(name)) return 'Names can\'t contain control characters.';
  if (Buffer.byteLength(name) > 255) return 'That name is too long.';
  if (platform === 'win32') {
    const bad = name.match(WINDOWS_RESERVED);
    if (bad) return `Names can't contain ${bad[0]} on Windows.`;
    if (WINDOWS_DEVICE.test(name)) return `Windows keeps "${name}" for itself; pick another.`;
    if (/[. ]$/.test(name)) return 'Names can\'t end with a dot or a space on Windows.';
  }
  return null;
}

/**
 * The parts of a sidebar path (`/` between folders, as typed), trimmed, or
 * a problem with one of them.
 * @returns {{ parts: string[] } | { problem: string }}
 */
export function nameParts(typed, platform = process.platform) {
  const parts = String(typed).split('/').map((part) => part.trim());
  for (const part of parts) {
    const problem = nameProblem(part, platform);
    if (problem) return { problem };
  }
  return { parts };
}

/** Make the folder `path` (and its parents). Never reuses one that exists. */
export async function createFolder(path) {
  if (await exists(path)) throw new DocFileError('exists', `${basename(path)} is already here`, path);
  await mkdir(path, { recursive: true });
  return path;
}

/**
 * Move or rename the folder `fromPath` to `toPath`, with everything in it.
 * Never overwrites, never into itself; a change of case only works on
 * case-insensitive disks too.
 */
export async function moveFolder(fromPath, toPath) {
  if (toPath === fromPath) return fromPath;
  if (isInside(fromPath, toPath)) throw new DocFileError('inside', `${basename(fromPath)} can't go inside itself`, toPath);
  await mkdir(dirname(toPath), { recursive: true });
  if (await exists(toPath)) {
    if (!(await sameFile(fromPath, toPath))) throw new DocFileError('exists', `${basename(toPath)} is already there`, toPath);
    const temp = join(dirname(toPath), `.${basename(toPath)}.${process.pid}.renaming`);
    await rename(fromPath, temp);
    await rename(temp, toPath);
    return toPath;
  }
  await rename(fromPath, toPath);
  return toPath;
}

/** Whether `path` is `folder` or inside it. */
export function isInside(folder, path) {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * What a folder holds, for the delete confirm: its docs, and every other
 * file (sidecars aside), hidden ones and those in hidden folders included.
 * @returns {Promise<{ docs: number, others: number }>}
 */
export async function countFolder(path) {
  const count = { docs: 0, others: 0 };
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else if (entry.name.endsWith(SIDECAR_SUFFIX) && isDocName(entry.name.slice(0, -SIDECAR_SUFFIX.length))) continue;
      else if (isDocName(entry.name) && !entry.name.startsWith('.')) count.docs++;
      else count.others++;
    }
  }
  await walk(path);
  return count;
}

/**
 * Put the doc `docPath` and its sidecar in the Trash with `trashItem`
 * (Electron's shell.trashItem): the doc first, so a failure leaves the
 * comments with a doc that is still there.
 */
export async function trashDoc(docPath, trashItem) {
  await trashItem(docPath);
  if (await exists(sidecarPath(docPath))) await trashItem(sidecarPath(docPath));
}

async function sameFile(a, b) {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
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
