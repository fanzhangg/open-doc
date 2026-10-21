// A project folder for the desktop app: what one of its folders holds, for
// the sidebar; its docs, found down through its subfolders, for the doc a
// window opens with; and a watch that says when files may have come or gone.
// Plain Node (no Electron), so the tests run under `node --test`.

import { watch } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { SIDECAR_SUFFIX } from '../src/store/files.js';
import { MAX_TEXT_BYTES, isDocName, isTextFile } from './files.js';

const MAX_DOCS = 2000;
const MAX_DEPTH = 12;
const DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 3000;

// Never in the sidebar: git's own folder and Finder's leftovers.
const HIDDEN = new Set(['.git', '.DS_Store']);
export const isHiddenName = (name) => HIDDEN.has(name);
// Folders never searched for docs: hidden ones (.git, .claude, …) and installed packages.
const SKIPPED = new Set(['node_modules']);
const skipped = (name) => name.startsWith('.') || SKIPPED.has(name);
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * What the folder `dir` holds, for the sidebar: its subfolders, then its
 * files, both by name. Left out: `.git`, `.DS_Store` and each file's
 * sidecar (`X.opendoc.jsonl` next to `X`); a sidecar whose file is gone
 * shows, so it can be found and fixed. An unreadable folder is empty.
 * @returns {Promise<{ name: string, folder: boolean }[]>}
 */
export async function readFolder(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = new Set(entries.map((entry) => entry.name));
  const shown = [];
  for (const entry of entries) {
    const { name } = entry;
    if (HIDDEN.has(name) || (name.endsWith(SIDECAR_SUFFIX) && names.has(name.slice(0, -SIDECAR_SUFFIX.length)))) continue;
    const folder = entry.isDirectory() || (entry.isSymbolicLink() && (await isFolder(join(dir, name))));
    shown.push({ name, folder });
  }
  return shown.sort((a, b) => b.folder - a.folder || byName.compare(a.name, b.name));
}

/** The file `path` to show read only: { text }, or { problem } when it is 'large' or 'binary'. */
export async function readText(path) {
  if ((await stat(path)).size > MAX_TEXT_BYTES) return { problem: 'large' };
  const bytes = await readFile(path);
  return bytes.includes(0) ? { problem: 'binary' } : { text: bytes.toString('utf8') };
}

/**
 * The docs in `root` and its subfolders, as paths relative to it with `/`
 * between folders: each folder's subfolders first, then its docs, both by
 * name. Hidden folders, installed packages and symlinked folders are left
 * out. At most `max` docs. Docs are the files `isDoc` names one: by
 * default, Markdown.
 * @returns {Promise<string[]>}
 */
export async function listDocs(root, { max = MAX_DOCS, isDoc = isDocName } = {}) {
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
      } else if (isDoc(entry.name) && !entry.name.startsWith('.')) {
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
  return docs;
}

/** `rel` (`/` between folders) as a path under `root`. */
export const docInFolder = (root, rel) => join(root, ...rel.split('/'));

/** `path` relative to `root` with `/` between folders, or null when it is not inside it. */
export function relativeDoc(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * The first text file (isTextFile) in `root`, one at the top before those in
 * its subfolders; null for none. A sidecar is not one.
 */
export async function firstTextFile(root) {
  const files = await listDocs(root, { isDoc: (name) => !name.endsWith(SIDECAR_SUFFIX) });
  const top = files.filter((rel) => !rel.includes('/'));
  for (const rel of [...top, ...files.filter((rel) => rel.includes('/'))]) {
    if (await isTextFile(docInFolder(root, rel))) return rel;
  }
  return null;
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
 * The doc to show once `rel` (a doc, or a folder with its docs) is gone:
 * the next doc below it in its folder, else the one above, else the
 * folder's first doc; only docs `keep` accepts. Null for none.
 */
export function neighbourDoc(docs, rel, keep = () => true) {
  const parent = (path) => path.split('/').slice(0, -1).join('/');
  const left = docs.filter((doc) => doc !== rel && keep(doc));
  const at = docs.indexOf(rel);
  if (at >= 0) {
    const siblings = (list) => list.filter((doc) => parent(doc) === parent(rel) && left.includes(doc));
    const next = siblings(docs.slice(at + 1))[0] ?? siblings(docs.slice(0, at)).at(-1);
    if (next) return next;
  }
  return firstDoc(left);
}

/**
 * Call `onChange()` (debounced) whenever a file or folder in `root` or its
 * subfolders may have been added, removed or renamed. Edits to a file's
 * contents and anything in `.git` are left out. Where the file system
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
      if (name && String(name).split(/[\\/]/).includes('.git')) return;
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

async function isFolder(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
