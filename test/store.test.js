import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lockFile, moveDoc, readSidecarText, sidecarPath, writeAtomic } from '../src/store/files.js';
import { watchDoc } from '../src/store/watch.js';
import { tempDoc } from './helpers.js';

const LINE = '{"id":"c_store0001","by":{"id":"u_alice01","name":"alice","kind":"human"},"at":"2026-10-01T10:00:00Z","body":"note"}';

test('a doc without a sidecar has none; writing one leaves no temp file', async () => {
  const docPath = await tempDoc();
  assert.equal(await readSidecarText(docPath), null);
  await writeAtomic(sidecarPath(docPath), `{"opendoc":2}\n${LINE}\n`);
  assert.equal(await readSidecarText(docPath), `{"opendoc":2}\n${LINE}\n`);
  assert.deepEqual((await readdir(dirname(docPath))).sort(), ['plan.md', 'plan.md.opendoc.jsonl']);
});

test('moveDoc renames the doc and its sidecar together, never over another file', async () => {
  const docPath = await tempDoc();
  await writeFile(sidecarPath(docPath), `{"opendoc":2}\n${LINE}\n`);
  const target = join(dirname(docPath), 'renamed.md');
  await moveDoc(docPath, target);
  assert.deepEqual((await readdir(dirname(docPath))).sort(), ['renamed.md', 'renamed.md.opendoc.jsonl']);
  assert.equal(await readSidecarText(target), `{"opendoc":2}\n${LINE}\n`, 'byte for byte');
  await writeFile(docPath, 'other');
  await assert.rejects(moveDoc(target, docPath), (e) => e.code === 'exists');
});

test('a stale lock is broken; a live one is waited for', async () => {
  const dir = dirname(await tempDoc());
  const lock = join(dir, 'settings.json.lock');
  await writeFile(lock, '');
  const old = new Date(Date.now() - 10_000);
  await utimes(lock, old, old);
  const release = await lockFile(lock, join(dir, 'settings.json'));
  let second = false;
  const waiting = lockFile(lock, join(dir, 'settings.json')).then((r) => { second = true; return r; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(second, false, 'waits while the lock is held');
  await release();
  await (await waiting)();
  await assert.rejects(stat(lock), (e) => e.code === 'ENOENT');
});

test('watchDoc reports changes to the sidecar', async () => {
  const docPath = await tempDoc();
  let calls = 0;
  const stop = watchDoc(docPath, () => { calls++; });
  try {
    await new Promise((r) => setTimeout(r, 100));
    await writeAtomic(sidecarPath(docPath), `{"opendoc":2}\n${LINE}\n`);
    const deadline = Date.now() + 2000;
    while (calls === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls > 0);
  } finally {
    stop();
  }
});
