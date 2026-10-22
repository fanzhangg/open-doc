// The agents' mirror (src/host/mirror.js): what a project shows, copied for
// a run, and brought up to date by size and mtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TEXT_BYTES } from '../src/store/files.js';
import { mirrorDir, syncMirror } from '../src/host/mirror.js';

// Every file in `dir`, by its path there.
async function filesIn(dir) {
  return (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).replaceAll('\\', '/')).sort();
}

test('the mirror holds what the project shows: no hidden names, links out, node_modules, binaries or files past 20 MB', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-project-')));
  const outside = await mkdtemp(join(tmpdir(), 'ponjo-outside-'));
  await writeFile(join(outside, 'secret.md'), 'secret\n');
  await mkdir(join(root, 'notes', 'deep'), { recursive: true });
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'plan.md'), 'Plan.\n');
  await writeFile(join(root, 'plan.md.comments.jsonl'), '{"comments":3}\n');
  await writeFile(join(root, 'notes', 'deep', 'a.txt'), 'A.\n');
  await writeFile(join(root, '.env'), 'KEY=secret\n');
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x\n');
  await writeFile(join(root, 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 1]));
  await writeFile(join(root, 'huge.txt'), 'a'.repeat(MAX_TEXT_BYTES + 1));
  await symlink(join(outside, 'secret.md'), join(root, 'leak.md'));
  await symlink(join(root, 'plan.md'), join(root, 'alias.md'));
  await symlink(outside, join(root, 'linked'), 'junction');

  const settingsDir = await mkdtemp(join(tmpdir(), 'ponjo-config-'));
  const dir = await syncMirror(root, mirrorDir(root, settingsDir));
  assert.ok(dir.startsWith(join(settingsDir, 'mirrors')));
  assert.deepEqual(await filesIn(dir), ['alias.md', 'notes/deep/a.txt', 'plan.md', 'plan.md.comments.jsonl']);
  assert.equal(await readFile(join(dir, 'alias.md'), 'utf8'), 'Plan.\n', 'a link in the project is its file');
});

test('a sync copies what changed, drops what went, and puts back what an agent changed in the mirror', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-project-')));
  await writeFile(join(root, 'plan.md'), 'Plan.\n');
  await writeFile(join(root, 'notes.md'), 'Notes.\n');
  const dir = mirrorDir(root, await mkdtemp(join(tmpdir(), 'ponjo-config-')));
  await syncMirror(root, dir);

  await writeFile(join(root, 'plan.md'), 'Plan, longer.\n');
  await rm(join(root, 'notes.md'));
  await writeFile(join(root, 'new.md'), 'New.\n');
  await writeFile(join(dir, 'stray.md'), 'an agent wrote this\n');
  await syncMirror(root, dir);
  assert.deepEqual(await filesIn(dir), ['new.md', 'plan.md']);
  assert.equal(await readFile(join(dir, 'plan.md'), 'utf8'), 'Plan, longer.\n');

  await writeFile(join(dir, 'plan.md'), 'Edited by an agent.\n');
  await syncMirror(root, dir);
  assert.equal(await readFile(join(dir, 'plan.md'), 'utf8'), 'Plan, longer.\n');
});
