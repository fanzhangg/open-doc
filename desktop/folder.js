// A folder of docs for the desktop app's sidebar: the docs in it, found
// down through its subfolders, and a watch that says when that list may
// have changed. Plain Node (no Electron), so the tests run under `node --test`.

import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDocName } from './files.js';

export const MAX_DOCS = 2000;
export const MAX_DEPTH = 12;
export const DEBOUNCE_MS = 300;
export const POLL_INTERVAL_MS = 3000;

// Folders never searched: hidden ones (.git, .claude, …) and installed packages.
const SKIPPED = new Set(['node_modules']);
const skipped = (name) => name.startsWith('.') || SKIPPED.has(name);
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The docs in `root` and its subfolders, as paths relative to it with `/`
 * between folders: each folder's subfolders first, then its docs, both by
 * name. Symlinked folders are not followed. At most `max` docs; `truncated`
 * says whether there were more.
 * @returns {Promise<{ docs: string[], truncated: boolean }>}
 */
export async function listDocs(root, { max = MAX_DOCS } = {}) {
  const docs = [];
  let truncated = false;
  async function walk(dir, prefix, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable: as if empty
    }
    const folders = [];
    const files = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipped(entry.name)) folders.push(entry.name);
      } else if (isDocName(entry.name) && !entry.name.startsWith('.')) {
        if (entry.isFile() || (entry.isSymbolicLink() && (await isFile(join(dir, entry.name))))) files.push(entry.name);
      }
    }
    if (depth < MAX_DEPTH) {
      for (const name of folders.sort(byName.compare)) {
        if (truncated) return;
        await walk(join(dir, name), `${prefix}${name}/`, depth + 1);
      }
    }
    for (const name of files.sort(byName.compare)) {
      if (docs.length >= max) {
        truncated = true;
        return;
      }
      docs.push(prefix + name);
    }
  }
  await walk(root, '', 0);
  return { docs, truncated };
}

/** `rel` (from listDocs) as a path under `root`. */
export const docInFolder = (root, rel) => join(root, ...rel.split('/'));

/** `path` relative to `root` with `/` between folders, or null when it is not inside it. */
export function relativeDoc(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * The doc a folder opens with: `remembered` (the one last open there) while
 * it is still in the list, else a README or index at the top, else the
 * first doc at the top, else the first doc anywhere; null for no docs.
 */
export function firstDoc(docs, remembered = null) {
  if (remembered && docs.includes(remembered)) return remembered;
  const top = docs.filter((rel) => !rel.includes('/'));
  return top.find((rel) => /^readme\./i.test(rel)) ?? top.find((rel) => /^index\./i.test(rel)) ?? top[0] ?? docs[0] ?? null;
}

/**
 * Call `onChange()` (debounced) whenever a file or folder in `root` or its
 * subfolders may have been added, removed or renamed. Edits to a file's
 * contents are left out: they never change the list. Where the file system
 * cannot watch a whole tree, it polls instead.
 * @returns {() => void} stop watching
 */
export function watchFolder(root, onChange) {
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };
  let watcher = null;
  let poll = null;
  const startPolling = () => {
    watcher?.close();
    poll ??= setInterval(fire, POLL_INTERVAL_MS);
  };
  try {
    watcher = watch(root, { recursive: true }, (event, name) => {
      if (event !== 'rename') return;
      if (name && String(name).split(/[\\/]/).slice(0, -1).some(skipped)) return;
      fire();
    });
    watcher.on('error', startPolling);
  } catch {
    startPolling();
  }
  return () => {
    clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
