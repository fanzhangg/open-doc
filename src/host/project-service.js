// ProjectService: a project's files, the same for everyone. The owner's
// windows and, planned, a teammate's page read the project only through
// it, so all see the same tree. A path names a file or folder by its place
// in the project (`/` between folders, '' for the project itself); it is
// resolved to its real path, which must be inside the project, and no part
// of either may start with `.`. Anything else is as if it were not there.

import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { MAX_TEXT_BYTES, SIDECAR_SUFFIX } from '../store/files.js';

const notFound = (rel) => Object.assign(new Error(`${rel}: no such file in the project`), { code: 'not_found' });
const hidden = (part) => part.startsWith('.');
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The real path of `rel` in the project `root`; `not_found` when it is not
 * a name the project shows: not a string, an empty or dotted part, out of
 * the project once its links are followed, or not there.
 */
export async function resolve(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw notFound(rel);
  const parts = rel === '' ? [] : rel.split('/');
  if (parts.some((part) => !part || hidden(part) || (sep !== '/' && part.includes(sep)))) throw notFound(rel);
  try {
    const real = await realpath(join(root, ...parts));
    const inside = relative(await realpath(root), real);
    if (!isAbsolute(inside) && !inside.split(sep).some(hidden)) return real;
  } catch {
    // not there
  }
  throw notFound(rel);
}

/**
 * The file `rel`, opened: its handle and what it is. Checked again once
 * open, so a file swapped for a link out of the project meanwhile is
 * refused: what was opened must be what `rel` names now, its real path
 * not followed again (lstat), as a link put there since would be.
 */
async function openFile(root, rel) {
  const path = await resolve(root, rel);
  if (!(await stat(path)).isFile()) throw notFound(rel);
  const handle = await open(path, 'r');
  try {
    const [opened, named] = await Promise.all([handle.stat(), resolve(root, rel).then((now) => lstat(now))]);
    if (opened.dev !== named.dev || opened.ino !== named.ino || !opened.isFile()) throw notFound(rel);
    return { handle, path, size: opened.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The project in folder `root` (a real path): what everyone may read of it. */
export function projectService(root) {
  return {
    /**
     * What the folder `rel` holds: its subfolders, then its files, both by
     * name. Left out: what the project does not show, and each file's
     * sidecar (`X.opendoc.jsonl` next to `X`); a sidecar whose file is gone
     * shows, so it can be found and fixed. An unreadable folder is empty.
     * @returns {Promise<{ name: string, folder: boolean }[]>}
     */
    async list(rel) {
      const dir = await resolve(root, rel);
      if (!(await stat(dir)).isDirectory()) throw notFound(rel);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const names = new Set(entries.map((entry) => entry.name));
      const shown = [];
      for (const entry of entries) {
        const { name } = entry;
        if (hidden(name) || (name.endsWith(SIDECAR_SUFFIX) && names.has(name.slice(0, -SIDECAR_SUFFIX.length)))) continue;
        let folder = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          const real = await resolve(root, rel ? `${rel}/${name}` : name).catch(() => null);
          if (!real) continue;
          folder = (await stat(real)).isDirectory();
        }
        shown.push({ name, folder });
      }
      return shown.sort((a, b) => b.folder - a.folder || byName.compare(a.name, b.name));
    },

    /** The file `rel` to show read only: { text }, or { problem } when it is 'large' or 'binary'. */
    async read(rel) {
      const { handle, size } = await openFile(root, rel);
      try {
        if (size > MAX_TEXT_BYTES) return { problem: 'large' };
        const bytes = await handle.readFile();
        return bytes.includes(0) ? { problem: 'binary' } : { text: bytes.toString('utf8') };
      } finally {
        await handle.close();
      }
    },

    /** The file `rel` to open: { path }, its real path. */
    async open(rel) {
      const { handle, path } = await openFile(root, rel);
      await handle.close();
      return { path };
    },
  };
}
