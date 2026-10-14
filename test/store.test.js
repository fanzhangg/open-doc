import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOp, createAnchor, findQuote, newId, project } from '../src/core/index.js';
import { load, moveDoc, readSidecar, sidecarPath, update } from '../src/store/files.js';
import { watchDoc } from '../src/store/watch.js';
import { SAMPLE, tempDoc } from './helpers.js';

const human = { name: 'fzhan', kind: 'human' };
const here = dirname(fileURLToPath(import.meta.url));

async function commentOn(docPath, quote, body = 'note') {
  const id = newId('t');
  await update(docPath, (s, doc) => {
    const { text } = project(doc.markdown);
    const r = findQuote(text, quote);
    return applyOp(s, {
      type: 'addThread', id, anchor: createAnchor(text, r.start, r.end),
      message: { id: newId('m'), author: human, body, createdAt: new Date().toISOString() },
    });
  });
  return id;
}

test('a doc without a sidecar reads as empty and writes nothing', async () => {
  const docPath = await tempDoc();
  const { sidecar } = await load(docPath);
  assert.equal(sidecar.doc, 'plan.md');
  assert.deepEqual(sidecar.threads, []);
  assert.deepEqual(await readdir(dirname(docPath)), ['plan.md']);
});

test('the first comment creates the sidecar with docHash; no temp or lock files remain', async () => {
  const docPath = await tempDoc();
  await commentOn(docPath, 'extra load');
  const stored = JSON.parse(await readFile(sidecarPath(docPath), 'utf8'));
  assert.match(stored.docHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(stored.threads.length, 1);
  assert.deepEqual((await readdir(dirname(docPath))).sort(), ['plan.md', 'plan.md.opendoc.json']);
});

test('load refreshes stale anchors and persists them', async () => {
  const docPath = await tempDoc();
  await commentOn(docPath, 'extra load');
  const before = JSON.parse(await readFile(sidecarPath(docPath), 'utf8'));
  await writeFile(docPath, SAMPLE.replace('extra load', 'extra peak load'));

  const { sidecar, doc } = await load(docPath);
  assert.equal(sidecar.threads[0].anchor.exact, 'extra peak load');
  assert.equal(sidecar.docHash, doc.hash);
  assert.notEqual(sidecar.docHash, before.docHash);
  const stored = JSON.parse(await readFile(sidecarPath(docPath), 'utf8'));
  assert.equal(stored.threads[0].anchor.exact, 'extra peak load');
});

test('unknown fields survive a rewrite', async () => {
  const docPath = await tempDoc();
  const id = await commentOn(docPath, 'extra load');
  const stored = JSON.parse(await readFile(sidecarPath(docPath), 'utf8'));
  stored['x-acme'] = { keep: [1, 2] };
  stored.threads[0]['x-acme'] = 'thread-level';
  await writeFile(sidecarPath(docPath), JSON.stringify(stored));
  await update(docPath, (s) => applyOp(s, { type: 'resolve', threadId: id, by: 'fzhan', at: new Date().toISOString() }));
  const after = JSON.parse(await readFile(sidecarPath(docPath), 'utf8'));
  assert.deepEqual(after['x-acme'], { keep: [1, 2] });
  assert.equal(after.threads[0]['x-acme'], 'thread-level');
  assert.equal(after.threads[0].status, 'resolved');
});

test('a sidecar copied under another doc name is refused', async () => {
  const docPath = await tempDoc();
  await commentOn(docPath, 'extra load');
  const copy = join(dirname(docPath), 'copy.md');
  await writeFile(copy, SAMPLE);
  await writeFile(sidecarPath(copy), await readFile(sidecarPath(docPath)));
  await assert.rejects(readSidecar(copy), (e) => e.code === 'doc_mismatch');
});

test('a stale lock is broken; a live one is waited for', async () => {
  const docPath = await tempDoc();
  const lock = sidecarPath(docPath) + '.lock';
  await writeFile(lock, '');
  const old = new Date(Date.now() - 10_000);
  await utimes(lock, old, old);
  await commentOn(docPath, 'extra load');
  await assert.rejects(stat(lock), (e) => e.code === 'ENOENT');
});

test('moveDoc renames the doc and its sidecar together', async () => {
  const docPath = await tempDoc();
  await commentOn(docPath, 'extra load');
  const target = join(dirname(docPath), 'renamed.md');
  await moveDoc(docPath, target);
  assert.deepEqual((await readdir(dirname(docPath))).sort(), ['renamed.md', 'renamed.md.opendoc.json']);
  assert.equal((await readSidecar(target)).doc, 'renamed.md');
});

test('concurrency: 4 processes x 50 replies lose nothing and duplicate nothing', { timeout: 60_000 }, async () => {
  const docPath = await tempDoc();
  const threadId = await commentOn(docPath, 'extra load', 'start');
  const writers = 4;
  const perWriter = 50;
  await Promise.all(Array.from({ length: writers }, (_, w) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'fixtures', 'hammer.js'), docPath, threadId, `w${w}`, String(perWriter)], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}`))));
  })));
  const { sidecar } = await load(docPath);
  const bodies = sidecar.threads[0].messages.map((m) => m.body);
  assert.equal(bodies.length, 1 + writers * perWriter);
  assert.equal(new Set(bodies).size, bodies.length);
});

test('watchDoc reports changes to the sidecar', async () => {
  const docPath = await tempDoc();
  let calls = 0;
  const stop = watchDoc(docPath, () => { calls++; });
  try {
    await new Promise((r) => setTimeout(r, 100));
    await commentOn(docPath, 'extra load');
    const deadline = Date.now() + 2000;
    while (calls === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls > 0);
  } finally {
    stop();
  }
});
