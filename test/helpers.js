import { mkdtempSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep tests away from the real user's settings file.
process.env.OPENDOC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'opendoc-config-'));

export const SAMPLE = `# Q4 Launch Plan

We plan to **ship all six features** in week one, then gather feedback from the
beta cohort before the public release.

## Risks

The main risk is that the \`sync\` service cannot handle the extra load.
See the [capacity doc](./capacity.md) for details.
`;

/** A fresh temp directory holding `plan.md`; returns the doc path. */
export async function tempDoc(content = SAMPLE, name = 'plan.md') {
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-test-'));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

const FAKE_PROGRAM = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-program.cjs');

/**
 * Runs `fn` with node (process.execPath) standing in for Claude Code and
 * Codex: it answers their sign-in checks as signed in or not (`signedIn`).
 * Pass the returned `set` a new answer to change it mid-test.
 */
export async function withFakeProgram(signedIn, fn) {
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, FAKE_PROGRAM: process.env.FAKE_PROGRAM };
  const set = (yes) => { process.env.FAKE_PROGRAM = yes ? 'signed-in' : 'signed-out'; };
  process.env.NODE_OPTIONS = `--require "${FAKE_PROGRAM.replaceAll('\\', '/')}"`;
  set(signedIn);
  try {
    return await fn({ program: process.execPath, set });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
