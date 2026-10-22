import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDoc } from '../src/host/doc-service.js';
import { diffOps } from '../src/core/ot.js';

// Keep tests away from the real user's settings file.
process.env.PONJO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ponjo-config-'));

export const SAMPLE = `# Q4 Launch Plan

We plan to **ship all six features** in week one, then gather feedback from the
beta cohort before the public release.

## Risks

The main risk is that the \`sync\` service cannot handle the extra load.
See the [capacity doc](./capacity.md) for details.
`;

/** A fresh temp directory holding `plan.md`; returns the doc path. */
export async function tempDoc(content = SAMPLE, name = 'plan.md') {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-test-'));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.js');

/**
 * A config folder whose agent script `fake` runs the fake agent
 * (fixtures/fake-agent.js), with `settings` over the user fzhan's. The fake
 * logs its runs to `runs.log` there.
 */
export async function fakeConfig(settings = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-config-'));
  await mkdir(join(dir, 'agents'));
  // On this process's binary, as Node when it is Electron's (test/views/main.js).
  await writeFile(join(dir, 'agents', 'fake'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${FAKE_AGENT}"\n`, { mode: 0o755 });
  await writeFile(join(dir, 'agents', 'fake.cmd'), `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" "${FAKE_AGENT}"\r\n`);
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ name: 'fzhan', agent: 'fake', ...settings }));
  process.env.FAKE_DIR = dir;
  return dir;
}

/** The fake agent's runs logged in config folder `dir`, oldest first. */
export async function fakeRuns(dir) {
  return (await readFile(join(dir, 'runs.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let edits = 0;

/**
 * Open `docPath` as a window would: `call(type, arg)` asks the doc as its owner,
 * `events` holds what it said ([name, data], oldest first), and
 * `edit(next, from)` types the doc's text into `next` from state `from`
 * (default: the doc as it is now), landed and written once it resolves.
 * With `buddies` ({ name: file text }), the doc's folder is a project
 * holding them.
 */
export async function openTestDoc(docPath, { buddies = null, ...options } = {}) {
  const events = [];
  if (buddies) {
    options.folder ??= dirname(docPath);
    await mkdir(join(options.folder, '.opendoc', 'buddies'), { recursive: true });
    for (const [name, text] of Object.entries(buddies)) await writeFile(join(options.folder, '.opendoc', 'buddies', `${name}.md`), text);
  }
  const doc = await openDoc(docPath, { ...options, emit: (name, data) => events.push([name, data]) });
  const edit = async (next, from) => {
    const at = from ?? await call('state');
    return call('submit', { ops: diffOps(at.text, next), rev: at.rev, epoch: at.epoch, id: `test.${++edits}` });
  };
  const call = async (type, arg) => doc.call(type, arg, await doc.owner());
  return { doc, events, edit, call, state: () => call('state') };
}

/** Wait until `check()` resolves to a truthy value, which it returns. */
export async function until(check, what = 'a condition', timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
