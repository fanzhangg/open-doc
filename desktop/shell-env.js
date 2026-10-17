// The environment of the user's login shell. An app opened from the Finder
// or the dock gets only a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) and none
// of the variables set in the user's shell files, so the programs its agents
// run (Claude Code's PDF reader pdftoppm, a Codex installed with npm, an
// ANTHROPIC_API_KEY) would be missing. Not needed on Windows, where an app
// gets the user's environment. Plain Node (no Electron).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { delimiter } from 'node:path';

// Variables that describe the shell that printed them, not the user's setup.
const SHELL_OWN = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);

/**
 * The login shell's environment, or null if it could not be read in
 * `timeout` ms. Interactive too (-i), as many people set PATH in .zshrc.
 */
export function readLoginEnv({ shell = process.env.SHELL, timeout = 3000 } = {}) {
  if (!shell) return Promise.resolve(null);
  // Shell files may print anything; the environment is what is between the markers.
  const marker = `__opendoc_${randomBytes(8).toString('hex')}__`;
  const script = `printf '%s' '${marker}'; /usr/bin/env -0; printf '%s' '${marker}'`;
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(shell, ['-ilc', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    // Its own timer: a program the shell files start may hold stdout open
    // long after the shell is gone.
    const timer = setTimeout(() => {
      child.kill();
      child.stdout.destroy();
      resolve(null);
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parseEnv(out, marker));
    });
  });
}

/** The variables `env -0` printed between two `marker`s, or null if they are not both there. */
export function parseEnv(stdout, marker) {
  const start = stdout.indexOf(marker);
  const end = stdout.lastIndexOf(marker);
  if (start === -1 || end === start) return null;
  const env = {};
  for (const entry of stdout.slice(start + marker.length, end).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * The variables to set in `current` for it to have the login shell's `login`
 * environment: the ones it lacks, and PATH with the login shell's entries
 * first. What `current` already has wins, as the app may have been started
 * from a shell with its own settings.
 */
export function loginEnvPatch(current, login) {
  if (!login) return {};
  const patch = {};
  for (const [key, value] of Object.entries(login)) {
    if (key !== 'PATH' && !SHELL_OWN.has(key) && current[key] === undefined) patch[key] = value;
  }
  const path = [...new Set([...(login.PATH ?? '').split(delimiter), ...(current.PATH ?? '').split(delimiter)].filter(Boolean))].join(delimiter);
  if (path !== (current.PATH ?? '')) patch.PATH = path;
  return patch;
}
