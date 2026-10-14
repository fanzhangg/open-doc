// The desktop app's own state, apart from settings: recent docs, the last
// folder used and the last window bounds, in <config dir>/state.json. Not
// synced between machines and safe to delete. Plain Node (no Electron).

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../src/store/files.js';
import { configDir } from '../src/store/settings.js';

export const STATE_FILE = 'state.json';
export const MAX_RECENT = 10;

/** @returns {Promise<{ recent: string[], lastFolder: string | null, bounds: { x: number, y: number, width: number, height: number } | null }>} */
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
  return {
    recent: recent.slice(0, MAX_RECENT),
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
