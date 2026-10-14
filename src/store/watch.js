// Watch a doc and its sidecar for changes. fs.watch on the directory catches
// atomic renames; a stat poll covers file systems where watch events are
// unreliable (network shares, some Windows setups).

import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { sidecarPath } from './files.js';

export const POLL_INTERVAL_MS = 500;
export const DEBOUNCE_MS = 50;

/**
 * Call `onChange()` (debounced) whenever the doc or its sidecar changes.
 * @returns {() => void} stop watching
 */
export function watchDoc(docPath, onChange) {
  const names = new Set([basename(docPath), basename(sidecarPath(docPath))]);
  const paths = [docPath, sidecarPath(docPath)];
  let timer = null;
  let last = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };

  const watcher = watch(dirname(docPath), (_event, name) => {
    if (!name || names.has(name.toString())) fire();
  });
  watcher.on('error', () => {}); // polling keeps working

  const poll = setInterval(async () => {
    const signature = (await Promise.all(paths.map(signatureOf))).join('|');
    if (last !== null && signature !== last) fire();
    last = signature;
  }, POLL_INTERVAL_MS);

  return () => {
    clearTimeout(timer);
    clearInterval(poll);
    watcher.close();
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
