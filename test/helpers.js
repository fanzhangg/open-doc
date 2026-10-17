import { mkdtempSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
