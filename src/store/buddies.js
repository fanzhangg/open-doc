// Buddy files (spec/PROJECT.md): a project's, in its `.ponjo/buddies/`,
// and the user's, in `buddies/` in their config folder.

import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BuddyError, buddyText, parseBuddy } from '../core/buddies.js';
import { NAME_PATTERN, sameName } from '../core/mentions.js';
import { writeAtomic } from './files.js';

export const projectBuddiesDir = (folder) => join(folder, '.ponjo', 'buddies');
export const userBuddiesDir = (settingsDir) => join(settingsDir, 'buddies');

/** The buddies in `dir`, by name; none when it does not exist. A name twice (in another case) counts once. */
export async function readBuddies(dir) {
  const names = (await namesIn(dir)).sort();
  const unique = names.filter((name, i) => names.findIndex((n) => sameName(n, name)) === i);
  return Promise.all(unique.map(async (name) => parseBuddy(name, await readFile(fileOf(dir, name), 'utf8'))));
}

/** Write buddy `buddy` in `dir` (made if missing); `was` is its name before, when it is renamed or changed. */
export async function writeBuddy(dir, buddy, was = null) {
  const names = await namesIn(dir);
  const old = was && names.find((n) => sameName(n, was));
  if (was && !old) throw new BuddyError(`no buddy ${was}`, 'not_found');
  if (names.some((n) => sameName(n, buddy.name) && n !== old)) throw new BuddyError(`the name ${buddy.name} is taken`);
  await mkdir(dir, { recursive: true });
  if (old && old !== buddy.name) await rename(fileOf(dir, old), fileOf(dir, buddy.name));
  await writeAtomic(fileOf(dir, buddy.name), buddyText(buddy));
}

/** The user's first buddy, Clippy, written when their config folder `settingsDir` has no `buddies/` yet; theirs from then on. */
export async function firstBuddies(settingsDir) {
  const dir = userBuddiesDir(settingsDir);
  if ((await mkdir(dir, { recursive: true })) === undefined) return; // there already
  await writeAtomic(fileOf(dir, 'Clippy'), buddyText({ id: 'Clippy', name: 'Clippy', about: 'A general writing assistant that helps draft and edit docs' }));
}

export async function removeBuddy(dir, name) {
  const found = (await namesIn(dir)).find((n) => sameName(n, name));
  if (!found) throw new BuddyError(`no buddy ${name}`, 'not_found');
  await rm(fileOf(dir, found));
}

const fileOf = (dir, name) => join(dir, `${name}.md`);

async function namesIn(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return files.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter((n) => NAME_PATTERN.test(n));
}
