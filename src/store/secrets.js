// The agents' secret settings, such as API keys (docs/agent-config.md#settings):
// `secrets.bin` in the config folder, all of them as one JSON object
// ({ <agent>: { <key>: value } }) encrypted with the system keychain. Never in
// settings.json or a log. `cipher` encrypts and decrypts: Electron's
// safeStorage, which only the app's main process has.

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './files.js';
import { configDir } from './settings.js';

const secretsPath = (dir) => join(dir, 'secrets.bin');

/** The secrets, decrypted: { <agent>: { <key>: value } }; none while there is no file. */
export async function readSecrets(cipher, dir = configDir()) {
  let bytes;
  try {
    bytes = await readFile(secretsPath(dir));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  return JSON.parse(cipher.decryptString(bytes));
}

/** Save `secrets`, all of them, encrypted. */
export async function writeSecrets(cipher, secrets, dir = configDir()) {
  await mkdir(dir, { recursive: true });
  await writeAtomic(secretsPath(dir), cipher.encryptString(JSON.stringify(secrets)));
}

/** The secrets set, by their last 4 characters only: { <agent>: { <key>: tail } }, for Settings to show. */
export const secretTails = (secrets) => Object.fromEntries(Object.entries(secrets).map(([agent, own]) =>
  [agent, Object.fromEntries(Object.entries(own).map(([key, value]) => [key, value.slice(-4)]))]));
