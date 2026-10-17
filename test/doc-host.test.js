// The doc host (desktop/doc-host.js) and the main process's side of it
// (desktop/doc-host-client.js), with the host started by plain Node's
// child_process.fork in place of an Electron utility process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { access, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sidecarPath } from '../src/store/files.js';
import { createDocHost } from '../desktop/doc-host-client.js';
import { tempDoc } from './helpers.js';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'doc-host.js');

// A host with its own settings, with no agents in them, and the processes
// started for it, latest last.
async function newHost() {
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ agents: [] }));
  const processes = [];
  const logged = [];
  const host = createDocHost({
    fork: () => {
      const child = fork(HOST, [], { env: { ...process.env, OPENDOC_CONFIG_DIR: settingsDir }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      processes.push(child);
      return { postMessage: (message) => child.send(message), on: (event, fn) => child.on(event, fn), kill: () => child.kill() };
    },
    log: (error) => logged.push(error.message),
  });
  return { host, processes, logged };
}

// Whether the server at `url` answers for its doc.
async function serves(url) {
  try {
    const res = await fetch(new URL('/api/state', url), { headers: { 'x-opendoc-token': new URL(url).searchParams.get('t') } });
    return res.ok;
  } catch {
    return false;
  }
}

const exists = (path) => access(path).then(() => true, () => false);

test('the doc host serves a doc, renames it with its sidecar, and closes it', async () => {
  const { host } = await newHost();
  try {
    const docPath = await tempDoc();
    await writeFile(sidecarPath(docPath), JSON.stringify({ opendoc: 1, doc: 'plan.md', docHash: null, threads: [], participants: [] }));
    const doc = await host.startDocServer(docPath);
    assert.ok(await serves(doc.url));

    const moved = await doc.moveTo(join(dirname(docPath), 'renamed'));
    assert.equal(moved, join(dirname(docPath), 'renamed.md'));
    assert.ok(await exists(moved));
    assert.ok(await exists(sidecarPath(moved)));
    assert.ok(!(await exists(docPath)));

    // Never over another file: the error names it, for the Rename dialog.
    const taken = join(dirname(docPath), 'taken.md');
    await writeFile(taken, 'mine');
    await assert.rejects(doc.moveTo(taken), (error) => error.code === 'exists' && error.path === taken);
    assert.ok(await serves(doc.url));

    await doc.close();
    assert.ok(!(await serves(doc.url)));
  } finally {
    await host.shutdown();
  }
});

test('a doc whose folder moved is followed there', async () => {
  const { host } = await newHost();
  try {
    const root = await mkdtemp(join(tmpdir(), 'opendoc-folder-'));
    await mkdir(join(root, 'drafts'));
    const docPath = join(root, 'drafts', 'plan.md');
    await writeFile(docPath, '# Plan\n');
    const doc = await host.startDocServer(docPath);
    await rename(join(root, 'drafts'), join(root, 'archive'));
    const target = join(root, 'archive', 'plan.md');
    assert.equal(await doc.moveTo(target, { moved: true }), target);
    assert.ok(await serves(doc.url));
    await doc.close();
  } finally {
    await host.shutdown();
  }
});

test('a doc that cannot be served fails to open', async () => {
  const { host } = await newHost();
  try {
    await assert.rejects(host.startDocServer(join(tmpdir(), 'no-such-dir-opendoc', 'missing.md')));
  } finally {
    await host.shutdown();
  }
});

test('a doc host that stops is started again and serves the open docs again', async () => {
  const { host, processes, logged } = await newHost();
  try {
    const docPath = await tempDoc();
    const doc = await host.startDocServer(docPath);
    const closedDoc = await host.startDocServer(await tempDoc());
    await closedDoc.close();
    const restarted = new Promise((resolve) => { doc.onRestart = resolve; });
    const before = doc.url;

    processes[0].kill();
    const url = await restarted;
    assert.equal(processes.length, 2);
    assert.equal(doc.url, url);
    assert.notEqual(url, before);
    assert.ok(await serves(url));
    assert.match(logged.join('\n'), /stopped/);

    // It still renames and closes from the new host.
    const moved = await doc.moveTo(join(dirname(docPath), 'after.md'));
    assert.ok(await exists(moved));
    await doc.close();
    assert.ok(!(await serves(url)));
  } finally {
    await host.shutdown();
  }
});

test('shutting the doc host down closes its docs and stops it', async () => {
  const { host, processes } = await newHost();
  const doc = await host.startDocServer(await tempDoc());
  const exited = new Promise((resolve) => processes[0].once('exit', resolve));
  await host.shutdown();
  await exited;
  assert.ok(!(await serves(doc.url)));
  await assert.rejects(host.startDocServer(await tempDoc()), /quitting/);
});
