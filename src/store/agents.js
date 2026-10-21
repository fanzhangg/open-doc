// Agent scripts (docs/agent-config.md): what runs a buddy's work, in the
// config folder's `agents/`: `<name>` on macOS and Linux, `<name>.cmd` on
// Windows. Claude Code, Codex and the OpenDoc agent ship, written when
// missing; then they are the user's. Never in a project: a shared folder
// must not decide what runs on this machine.

import { chmod, copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './settings.js';

export const SHIPPED_AGENTS = Object.freeze(['claude', 'codex', 'opendoc']);
// The files a shipped script runs, written next to it: one for both platforms.
const PROGRAMS = { opendoc: ['opendoc.mjs'] };
const SHIPPED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents');
const extension = (platform) => (platform === 'win32' ? '.cmd' : '');

export const agentsDir = (dir = configDir()) => join(dir, 'agents');

/** Where agent `name`'s script is on this platform. */
export const agentScript = (name, dir = configDir(), platform = process.platform) => join(agentsDir(dir), name + extension(platform));

/**
 * Write the shipped scripts that are missing, and `reset` (a shipped name)
 * even when it is there.
 */
export async function installAgents(dir = configDir(), { reset = null, platform = process.platform } = {}) {
  await mkdir(agentsDir(dir), { recursive: true });
  for (const name of SHIPPED_AGENTS) {
    for (const file of [name + extension(platform), ...(PROGRAMS[name] ?? [])]) {
      const to = join(agentsDir(dir), file);
      try {
        await copyFile(join(SHIPPED_DIR, file), to, name === reset ? 0 : 1); // 1: COPYFILE_EXCL
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      if (platform !== 'win32') await chmod(to, 0o755);
    }
  }
}

/** The names of the agent scripts on this platform, sorted. */
export async function listAgents(dir = configDir(), platform = process.platform) {
  let names;
  try {
    names = await readdir(agentsDir(dir));
  } catch {
    return [];
  }
  const ext = extension(platform);
  return names
    .filter((n) => !n.startsWith('.') && (ext ? n.toLowerCase().endsWith(ext) : !n.includes('.')))
    .map((n) => n.slice(0, n.length - ext.length))
    .sort();
}
