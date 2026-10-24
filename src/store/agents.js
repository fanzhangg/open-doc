// Agents (docs/agent-config.md#agents): what runs a buddy's work, in the
// config folder's `agents/`: the program `<name>` on macOS and Linux,
// `<name>.cmd` on Windows, and its manifest `<name>.json`, if any. Claude
// Code, Codex and the Ponjo agent ship, written when missing and replaced
// by a newer shipped version while unedited; once edited they are the
// user's. Never in a project: a shared folder must not decide what runs on
// this machine.

import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

// The hash of each shipped file as last written here, by file name: a file
// that still has it is unedited.
const writtenPath = (dir) => join(agentsDir(dir), '.shipped.json');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Write the shipped programs and manifests that are missing or unedited and
 * older, and those of `reset` (a shipped name) even when edited.
 */
export async function installAgents(dir = configDir(), { reset = null, platform = process.platform } = {}) {
  await mkdir(agentsDir(dir), { recursive: true });
  const before = await readFile(writtenPath(dir), 'utf8').catch(() => '{}');
  const written = JSON.parse(before);
  for (const name of SHIPPED_AGENTS) {
    for (const file of [name + extension(platform), `${name}.json`, ...(PROGRAMS[name] ?? [])]) {
      const to = join(agentsDir(dir), file);
      const shipped = hash(await readFile(join(SHIPPED_DIR, file)));
      const here = await readFile(to).then(hash, () => null);
      const unedited = here === null || here === written[file] || name === reset;
      if (here !== shipped && unedited) {
        await copyFile(join(SHIPPED_DIR, file), to);
        if (platform !== 'win32' && !file.endsWith('.json')) await chmod(to, 0o755);
      }
      if (here === shipped || unedited) written[file] = shipped;
    }
  }
  if (JSON.stringify(written) !== before) await writeFile(writtenPath(dir), JSON.stringify(written));
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
