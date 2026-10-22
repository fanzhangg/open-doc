// Agents (docs/agent-config.md#agents): what runs a buddy's work, in the
// config folder's `agents/`: the program `<name>` on macOS and Linux,
// `<name>.cmd` on Windows, and its manifest `<name>.json`, if any. Claude
// Code, Codex and the Ponjo agent ship, written when missing; then they
// are the user's. Never in a project: a shared folder must not decide what
// runs on this machine.

import { chmod, copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentOf } from '../core/settings.js';
import { configDir } from './settings.js';

export const SHIPPED_AGENTS = Object.freeze(['claude', 'codex', 'ponjo']);
// The files a shipped script runs, written next to it: one for both platforms.
const PROGRAMS = { ponjo: ['ponjo.mjs'] };
const SHIPPED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents');
const extension = (platform) => (platform === 'win32' ? '.cmd' : '');

export const agentsDir = (dir = configDir()) => join(dir, 'agents');

/** Where agent `name`'s script is on this platform. */
export const agentScript = (name, dir = configDir(), platform = process.platform) => join(agentsDir(dir), name + extension(platform));

/**
 * Write the shipped programs and manifests that are missing, and those of
 * `reset` (a shipped name) even when they are there.
 */
export async function installAgents(dir = configDir(), { reset = null, platform = process.platform } = {}) {
  await mkdir(agentsDir(dir), { recursive: true });
  for (const name of SHIPPED_AGENTS) {
    for (const file of [name + extension(platform), `${name}.json`, ...(PROGRAMS[name] ?? [])]) {
      const to = join(agentsDir(dir), file);
      try {
        await copyFile(join(SHIPPED_DIR, file), to, name === reset ? 0 : 1); // 1: COPYFILE_EXCL
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      if (platform !== 'win32' && !file.endsWith('.json')) await chmod(to, 0o755);
    }
  }
}

/** The agents on this platform, by file name: [{ id, name, about, settings }] (agentOf). */
export async function listAgents(dir = configDir(), platform = process.platform) {
  let names;
  try {
    names = await readdir(agentsDir(dir));
  } catch {
    return [];
  }
  const ext = extension(platform);
  return Promise.all(names
    .filter((n) => !n.startsWith('.') && (ext ? n.toLowerCase().endsWith(ext) : !n.includes('.')))
    .map((n) => n.slice(0, n.length - ext.length))
    .sort()
    .map((id) => readAgent(id, dir)));
}

/** Agent `id` as its manifest declares it, if it has a valid one (agentOf). */
export async function readAgent(id, dir = configDir()) {
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(join(agentsDir(dir), `${id}.json`), 'utf8'));
  } catch {
    // none, or not JSON: shown by its file name
  }
  return agentOf(id, manifest);
}
