// The agents' mirror (docs/agent-config.md, Permissions): a copy of what a
// project shows, in the config folder, which a run is given as its project
// folder, so an agent reads no more than a teammate may. It holds what
// ProjectService shows: no name starting with `.`, nothing a link leads to
// out of the project, and no symlinked folders; and of that, nothing in
// `node_modules`, and only text files of 20 MB or less (a NUL byte makes a
// file binary). It is brought up to date before each run, a file copied
// again when its size or mtime changed, with a copy-on-write clone where
// the file system has them; then the run gets a clone of it of its own, so
// what it reads never changes while it works, whatever other runs do.

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MAX_TEXT_BYTES } from '../store/files.js';
import { resolve } from './project-service.js';

const SKIPPED = new Set(['node_modules']);
const binaries = new Map(); // a file found not to be text → its size and mtime then
const syncs = new Map(); // mirror folder → its latest sync

/** Where the mirror of the project at real path `root` is, in config folder `settingsDir`. */
export const mirrorDir = (root, settingsDir) => join(settingsDir, 'mirrors', createHash('sha256').update(root).digest('hex').slice(0, 16), basename(root) || 'project');

/**
 * Bring the mirror in `dir` of the project at real path `root` up to date,
 * then clone it to `into`, a run's own copy; resolves to `into`. One at a
 * time per mirror, so no sync changes it while it is cloned.
 */
export function snapshotMirror(root, dir, into) {
  const run = (syncs.get(dir) ?? Promise.resolve()).then(() => copyFolder(root, root, dir, '')).then(() => clone(dir, into)).then(() => into);
  syncs.set(dir, run.catch(() => {}));
  return run;
}

// Folder `from`, which holds only folders and files, cloned to `to`.
async function clone(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await clone(join(from, entry.name), join(to, entry.name));
    else await copyFile(join(from, entry.name), join(to, entry.name), constants.COPYFILE_FICLONE);
  }
}

// The project's folder `rel` (`from`, a real path) into `to`; what `to`
// holds that the project does not show goes.
async function copyFolder(root, from, to, rel) {
  await mkdir(to, { recursive: true });
  const kept = new Set();
  for (const entry of await readdir(from, { withFileTypes: true }).catch(() => [])) {
    const { name } = entry;
    if (name.startsWith('.') || SKIPPED.has(name)) continue;
    if (entry.isDirectory()) {
      await copyFolder(root, join(from, name), join(to, name), rel ? `${rel}/${name}` : name);
      kept.add(name);
      continue;
    }
    // A file, or a link to one in the project.
    const real = entry.isFile() ? join(from, name) : await resolve(root, rel ? `${rel}/${name}` : name).catch(() => null);
    if (real && (await copyText(real, join(to, name)))) kept.add(name);
  }
  for (const entry of await readdir(to, { withFileTypes: true })) {
    if (!kept.has(entry.name)) await rm(join(to, entry.name), { recursive: true, force: true });
  }
}

// Copy `from` to `to` if it is a text file of 20 MB or less and changed
// since; whether `to` is its copy now.
async function copyText(from, to) {
  const source = await stat(from).catch(() => null);
  if (!source?.isFile() || source.size > MAX_TEXT_BYTES) return false;
  const copy = await stat(to).catch(() => null);
  const mtime = Math.floor(source.mtimeMs);
  if (copy?.isFile() && copy.size === source.size && Math.floor(copy.mtimeMs) === mtime) return true;
  const mark = `${source.size}:${mtime}`;
  if (binaries.get(from) === mark) return false;
  if ((await readFile(from)).includes(0)) {
    binaries.set(from, mark);
    return false;
  }
  if (copy && !copy.isFile()) await rm(to, { recursive: true, force: true });
  await copyFile(from, to, constants.COPYFILE_FICLONE);
  await utimes(to, source.atime, source.mtime);
  return true;
}
