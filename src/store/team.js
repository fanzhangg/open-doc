// A project's team (docs/architecture.md, Sharing): `team/<key>.json` in the
// config folder, the key being the SHA-256 of the project folder's real
// path, so a project that moves must allow its teammates again. It holds the
// secret its link's room is made from and each teammate's
// `{ id, name, level }`.

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './files.js';
import { configDir } from './settings.js';

const teamPath = (folder, dir) => join(dir, 'team', `${createHash('sha256').update(folder).digest('hex')}.json`);

/**
 * The team of the project at real path `folder`: { secret (null before a
 * first link), members }. A file that cannot be read is no team.
 * @returns {Promise<{ secret: string | null, members: { id: string, name: string, level: 'read' | 'write' }[] }>}
 */
export async function readTeam(folder, dir = configDir()) {
  try {
    const { secret = null, members = [] } = JSON.parse(await readFile(teamPath(folder, dir), 'utf8'));
    return { secret, members };
  } catch {
    return { secret: null, members: [] };
  }
}

/** Write the team of the project at real path `folder`. */
export async function writeTeam(folder, { secret, members }, dir = configDir()) {
  await mkdir(join(dir, 'team'), { recursive: true });
  await writeAtomic(teamPath(folder, dir), `${JSON.stringify({ folder, secret, members }, null, 2)}\n`);
}
