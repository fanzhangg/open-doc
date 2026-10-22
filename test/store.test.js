import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { decodeText, encodeText, lockFile, moveDoc, readSidecarText, sidecarPath, writeAtomic, writeSidecar } from '../src/store/files.js';
import { watchDoc } from '../src/store/watch.js';
import { tempDoc } from './helpers.js';

const { cases: docText } = JSON.parse(readFileSync(new URL('../spec/conformance/doc-text.json', import.meta.url), 'utf8'));

for (const c of docText) {
  test(`doc text: ${c.name}`, () => {
    const decoded = decodeText(Buffer.from(c.bytes, 'hex'));
    assert.equal(decoded?.text ?? null, c.text);
    if (c.written) assert.equal(encodeText(decoded.text, decoded.form).toString('hex'), c.written);
  });
}

const LINE = '{"id":"c_store0001","by":{"id":"u_alice01","name":"alice","kind":"human"},"at":"2026-10-01T10:00:00Z","body":"note"}';

test('a doc without a sidecar has none; writing one leaves no temp file', async () => {
  const docPath = await tempDoc();
  assert.equal(await readSidecarText(docPath), null);
  await writeAtomic(sidecarPath(docPath), `{"comments":3}\n${LINE}\n`);
  assert.equal(await readSidecarText(docPath), `{"comments":3}\n${LINE}\n`);
  assert.deepEqual((await readdir(dirname(docPath))).sort(), ['plan.md', 'plan.md.comments.jsonl']);
});

test('moveDoc renames the doc and its sidecar together, never over another file', async () => {
  const docPath = await tempDoc();
  await writeFile(sidecarPath(docPath), `{"comments":3}\n${LINE}\n`);
  const target = join(dirname(docPath), 'renamed.md');
  await moveDoc(docPath, target);
  assert.deepEqual((await readdir(dirname(docPath))).sort(), ['renamed.md', 'renamed.md.comments.jsonl']);
  assert.equal(await readSidecarText(target), `{"comments":3}\n${LINE}\n`, 'byte for byte');
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
    await writeAtomic(sidecarPath(docPath), `{"comments":3}\n${LINE}\n`);
    const deadline = Date.now() + 2000;
    while (calls === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls > 0);
  } finally {
    stop();
  }
});

const git = (cwd, ...args) => promisify(execFile)('git', args, { cwd });

test('a sidecar written in a git work tree is excluded, once; a repo made later is covered', async () => {
  const docPath = await tempDoc();
  const dir = dirname(docPath);
  await writeSidecar(docPath, `{"comments":3}\n${LINE}\n`);
  await git(dir, 'init', '-q');
  await writeSidecar(docPath, `{"comments":3}\n${LINE}\n`);
  await writeSidecar(docPath, `{"comments":3}\n${LINE}\n${LINE}\n`);
  assert.equal((await git(dir, 'status', '--porcelain', '-uall')).stdout.includes('comments.jsonl'), false);
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '*.comments.jsonl').length, 1);
});

test('a sidecar outside a git work tree is written as before', async () => {
  const docPath = await tempDoc();
  await writeSidecar(docPath, `{"comments":3}\n`);
  assert.equal(await readSidecarText(docPath), `{"comments":3}\n`);
  assert.deepEqual((await readdir(dirname(docPath))).sort(), ['plan.md', 'plan.md.comments.jsonl']);
});

test('writeAtomic resolves to the stat it wrote, or leaves the file alone when, just before, it should not', async () => {
  const path = await tempDoc('before\n');
  const written = await writeAtomic(path, 'mine\n');
  const now = await stat(path);
  assert.deepEqual([written.size, written.mtimeMs, written.ino], [now.size, now.mtimeMs, now.ino]);
  assert.equal(await writeAtomic(path, 'not written\n', async () => false), null);
  assert.equal(readFileSync(path, 'utf8'), 'mine\n');
  assert.deepEqual((await readdir(dirname(path))).sort(), ['plan.md'], 'no temp file left');
});
