// Watch files for changes. fs.watch on the directory catches atomic renames;
// a stat poll covers file systems where watch events are unreliable (network
// shares, some Windows setups) and folders that do not exist yet.

import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { sidecarPath } from './files.js';

const POLL_INTERVAL_MS = 500;
const DEBOUNCE_MS = 50;

/**
 * Call `onChange()` (debounced) whenever the doc or its sidecar changes.
 * @returns {() => void} stop watching
 */
export function watchDoc(docPath, onChange) {
  return watchFiles([docPath, sidecarPath(docPath)], onChange);
}

/**
 * Call `onChange()` (debounced) whenever one of `paths`, all in one folder,
 * is created, changed or removed.
 * @returns {() => void} stop watching
 */
export function watchFiles(paths, onChange) {
  const names = new Set(paths.map((path) => basename(path)));
  const signature = async () => (await Promise.all(paths.map(signatureOf))).join('|');
  return watchIn(dirname(paths[0]), (name) => names.has(name), signature, onChange);
}

/** Call `onChange()` (debounced) whenever a file in folder `dir` is created, changed or removed. */
export function watchFolder(dir, onChange) {
  const signature = async () => {
    const names = await readdir(dir).catch(() => null);
    if (!names) return 'missing';
    return (await Promise.all(names.sort().map(async (name) => `${name}:${await signatureOf(join(dir, name))}`))).join('|');
  };
  return watchIn(dir, () => true, signature, onChange);
}

function watchIn(dir, matches, signature, onChange) {
  let timer = null;
  let last = signature(); // as the watch starts: a change right after it counts
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };

  let watcher = null;
  try {
    watcher = watch(dir, (_event, name) => {
      if (!name || matches(name.toString())) fire();
    });
    watcher.on('error', () => {}); // polling keeps working
  } catch {
    // no such folder yet: polling notices when the files appear
  }

  const poll = setInterval(async () => {
    const now = await signature();
    if (now !== (await last)) fire();
    last = now;
  }, POLL_INTERVAL_MS);

  return () => {
    clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}

async function signatureOf(path) {
  try {
    const s = await stat(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
}
