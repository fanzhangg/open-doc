// The desktop app's own state, apart from settings: recent docs and folders,
// the doc last open in each folder, the last folder used and the last window
// bounds, in <config dir>/state.json. Not synced between machines and safe to
// delete. Plain Node (no Electron).

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../src/store/files.js';
import { configDir } from '../src/store/settings.js';

const STATE_FILE = 'state.json';
export const MAX_RECENT = 10;
export const MAX_FOLDER_DOCS = 50;

/** @returns {Promise<{ recent: string[], folderDocs: Record<string, string>, lastFolder: string | null, bounds: { x: number, y: number, width: number, height: number } | null }>} */
export async function readState(dir = configDir()) {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8')) ?? {};
  } catch {
    // missing or corrupt: start over
  }
  const recent = Array.isArray(stored.recent) ? stored.recent.filter((p) => typeof p === 'string') : [];
  const bounds = stored.bounds;
  const validBounds = bounds && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(bounds[k]))
    ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    : null;
  const folderDocs = stored.folderDocs && typeof stored.folderDocs === 'object' && !Array.isArray(stored.folderDocs)
    ? Object.fromEntries(Object.entries(stored.folderDocs).filter(([, rel]) => typeof rel === 'string').slice(0, MAX_FOLDER_DOCS))
    : {};
  return {
    recent: recent.slice(0, MAX_RECENT),
    folderDocs,
    lastFolder: typeof stored.lastFolder === 'string' ? stored.lastFolder : null,
    bounds: validBounds,
  };
}

export async function writeState(state, dir = configDir()) {
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

/** `path` first, without duplicates, at most MAX_RECENT. */
export const addRecent = (recent, path) => [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT);

/** The list with `from` renamed to `to`, keeping its place. */
export const renameRecent = (recent, from, to) => recent.filter((p) => p !== to).map((p) => (p === from ? to : p));

export const removeRecent = (recent, path) => recent.filter((p) => p !== path);

/** `folderDocs` with `rel` as the doc last open in `folder`, newest first, at most MAX_FOLDER_DOCS folders. */
export function rememberFolderDoc(folderDocs, folder, rel) {
  const rest = Object.entries(folderDocs).filter(([path]) => path !== folder);
  return Object.fromEntries([[folder, rel], ...rest].slice(0, MAX_FOLDER_DOCS));
}
