// A concurrency stress test: many buddies answering many asks at once while
// the human types, asserted by invariant rather than by an exact transcript:
// every ask gets one reply, every buddy edit lands, and no human text is
// lost. Deterministic (a fixed seed by default), bounded to a few seconds,
// and kept out of `npm test` (which globs test/*.test.js); CI runs it with
// `npm run test:stress`, and a seed can be passed as STRESS_SEED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../src/server/server.js';
import { tempDoc } from '../helpers.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-agent.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A small seeded PRNG so a failing run can be replayed from its seed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function call(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: server.port, method, path,
      headers: { host: `127.0.0.1:${server.port}`, 'x-opendoc-token': server.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('buddies x asks while the human types: one reply each, every edit lands, no human text lost', { timeout: 120_000 }, async () => {
  const seed = Number(process.env.STRESS_SEED ?? 7);
  const random = rng(seed);
  const buddies = ['Ana', 'Ben', 'Cy', 'Di'];
  const asksEach = 5;
  // One paragraph per ask for the buddies, and some for the human.
  const asks = buddies.flatMap((name) => Array.from({ length: asksEach }, (_, i) => ({ name, key: `${name}-${i}` })));
  const human = Array.from({ length: 10 }, (_, i) => `human-${i}`);
  const doc = ['# Stress', ...asks.map((a) => `Para ${a.key} old.`), ...human.map((h) => `Para ${h} old.`)].join('\n\n') + '\n';
  const docPath = await tempDoc(doc);

  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-stress-'));
  process.env.FAKE_DIR = settingsDir;
  await mkdir(join(settingsDir, 'agents'));
  await writeFile(join(settingsDir, 'agents', 'fake'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}"\n`, { mode: 0o755 });
  await writeFile(join(settingsDir, 'agents', 'fake.cmd'), `@"${process.execPath}" "${FAKE}"\r\n`);
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agent: 'fake', agents: buddies.map((name, i) => ({ id: `a_stress${i}`, name, starred: true })) }));
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const server = await startServer(docPath, { settingsDir, assetsDir });
  const state = async () => (await call(server, 'GET', '/api/state')).body;
  try {
    // Every ask at once, in a random order, while the human edits their own paragraphs.
    const order = asks.map((a) => [random(), a]).sort((x, y) => x[0] - y[0]).map(([, a]) => a);
    const posting = Promise.all(order.map((a, i) => call(server, 'POST', '/api/ops', { op: {
      type: 'addThread', id: `t_stress${String(i).padStart(3, '0')}`, anchor: null,
      message: { id: `m_stress${String(i).padStart(3, '0')}`, author: { name: 'fzhan', kind: 'human' }, body: `@${a.name} replace "Para ${a.key} old." with "Para ${a.key} new."` },
    } })));
    for (const h of human) {
      for (;;) {
        const now = await state();
        const saved = await call(server, 'PUT', '/api/doc', { markdown: now.markdown.replace(`Para ${h} old.`, `Para ${h} typed.`), baseHash: now.docHash });
        if (saved.status === 200) break; // 409: a buddy's merge landed first; read again
      }
      await sleep(Math.floor(random() * 40));
    }
    await posting;

    const deadline = Date.now() + 90_000;
    let threads;
    for (;;) {
      threads = (await state()).sidecar.threads;
      if (threads.length === asks.length && threads.every((t) => t.messages.length >= 2)) break;
      if (Date.now() > deadline) throw new Error(`seed ${seed}: not every ask was answered`);
      await sleep(100);
    }
    await sleep(500); // nothing more arrives
    threads = (await state()).sidecar.threads;
    for (const t of threads) assert.equal(t.messages.length, 2, `seed ${seed}: ${t.id} answered once`);
    assert.ok(threads.every((t) => !t.messages[1].failed && !t.messages[1].conflict), `seed ${seed}: no run failed or lost its edit`);
    const text = await readFile(docPath, 'utf8');
    for (const a of asks) assert.ok(text.includes(`Para ${a.key} new.`), `seed ${seed}: ${a.key}'s edit landed`);
    for (const h of human) assert.ok(text.includes(`Para ${h} typed.`), `seed ${seed}: ${h} kept`);
  } finally {
    await server.close();
  }
});
