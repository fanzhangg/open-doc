// Creating and renaming docs for the desktop app. Plain Node (no Electron),
// so the tests run under `node --test`.

import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { SIDECAR_SUFFIX, moveDoc, sidecarPath } from '../src/store/files.js';

export const DOC_EXTENSIONS = ['.md', '.markdown'];
const UNTITLED = 'Untitled';
const MAX_UNTITLED = 10_000;

export class DocFileError extends Error {
  /** @param {'exists'} code */
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
