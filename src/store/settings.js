// The user's settings file: `settings.json` in the per-user config folder,
// shared by every doc, window and `opendoc serve` run. Writes use the same
// lock and atomic rename as the sidecar, so two windows changing different
// settings at once both keep their change.

import { mkdir, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SETTINGS_VERSION, checkSettingsPatch, mergeSettings, resolveSettings } from '../core/settings.js';
import { lockFile, writeAtomic } from './files.js';
import { watchFiles } from './watch.js';

export const SETTINGS_FILE = 'settings.json';

/** The per-user config folder; `OPENDOC_CONFIG_DIR` overrides it. */
export function configDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.OPENDOC_CONFIG_DIR) return env.OPENDOC_CONFIG_DIR;
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'OpenDoc');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'OpenDoc');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opendoc');
}

export const settingsPath = (dir = configDir()) => join(dir, SETTINGS_FILE);

/**
 * The settings, complete and valid. `saved` is false while no settings file
 * exists (nothing was ever changed). A corrupt file is moved aside to
 * `settings.json.bak` so the next write starts clean.
 * @returns {Promise<{ settings: object, saved: boolean }>}
 */
export async function readSettings(dir = configDir()) {
  const stored = await readStored(dir);
  return { settings: resolveSettings(stored), saved: stored !== null };
}

/**
 * Apply a validated partial `patch` and save. Keys this version does not know are kept, so an older app does not
 * erase a newer one's settings.
 * @returns {Promise<object>} the complete settings after the change
 */
export async function updateSettings(patch, dir = configDir()) {
  checkSettingsPatch(patch);
  return change(() => patch, dir);
}

/**
 * Change the agents under the settings lock: `edit(agents, settings)`
 * returns the new roster (or throws), so two windows editing different
 * agents at once both keep their change.
 * @returns {Promise<object>} the complete settings after the change
 */
export async function editAgents(edit, dir = configDir()) {
  return change((stored) => {
    const current = resolveSettings(stored);
    const patch = { agents: edit(current.agents, current) };
    checkSettingsPatch(patch);
    return patch;
  }, dir);
}

async function change(patchFor, dir) {
  await mkdir(dir, { recursive: true });
  const path = settingsPath(dir);
  const release = await lockFile(`${path}.lock`, path);
  try {
    const stored = (await readStored(dir)) ?? {};
    const next = { ...mergeSettings(stored, patchFor(stored)), version: SETTINGS_VERSION };
    await writeAtomic(path, JSON.stringify(next, null, 2) + '\n');
    return resolveSettings(next);
  } finally {
    await release();
  }
}

/** Call `onChange()` (debounced) whenever the settings file changes. */
export function watchSettings(onChange, dir = configDir()) {
  return watchFiles([settingsPath(dir)], onChange);
}

async function readStored(dir) {
  const path = settingsPath(dir);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stored = JSON.parse(text);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
  } catch {
    // fall through
  }
  await rename(path, `${path}.bak`).catch(() => {});
  return {};
}
