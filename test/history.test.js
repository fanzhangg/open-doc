import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COALESCE_MS, MAX_SPAN_MS, historyDir, moveHistory, readHistory, readVersion, recordVersion } from '../src/store/history.js';
import { startServer } from '../src/server/server.js';
import { SAMPLE, tempDoc } from './helpers.js';

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.js');
const me = { name: 'fzhan', kind: 'human' };
const bot = { name: 'claude', kind: 'agent' };
const edit = (author, extra = {}) => ({ kind: 'edit', author, ...extra });
const configRoot = () => mkdtemp(join(tmpdir(), 'opendoc-config-'));

test('versions record who changed the doc and how much', async () => {
  const root = await configRoot();
  const doc = await tempDoc();
  const t0 = Date.parse('2026-10-15T09:00:00Z');
  const first = await recordVersion(doc, root, 'one\n', { kind: 'external', author: null }, t0);
  assert.equal(first.kind, 'opened', 'the doc as first seen');
  assert.equal(await recordVersion(doc, root, 'one\n', edit(me), t0 + 1000), null, 'no change, no version');
  await recordVersion(doc, root, 'one two\n', edit(me), t0 + 1000);
  await recordVersion(doc, root, 'one two three\n', edit(bot, { threadIds: ['t_aaaaaa'] }), t0 + 2000);

  const versions = await readHistory(doc, root);
  assert.deepEqual(versions.map((v) => [v.kind, v.author?.name ?? null]), [['opened', null], ['edit', 'fzhan'], ['edit', 'claude']]);
  assert.deepEqual([versions[1].added, versions[1].removed], [4, 0]);
  assert.deepEqual(versions[2].threadIds, ['t_aaaaaa']);

  const shown = await readVersion(doc, root, versions[2].id);
  assert.equal(shown.markdown, 'one two three\n');
  assert.equal(shown.before, 'one two\n');
  assert.equal((await readVersion(doc, root, versions[0].id)).before, null);
  assert.equal(await readVersion(doc, root, 'v_missing1'), null);
});

test('a burst of changes by one author is one version', async () => {
  const root = await configRoot();
  const doc = await tempDoc();
  const t0 = Date.parse('2026-10-15T09:00:00Z');
  await recordVersion(doc, root, 'a\n', { kind: 'external', author: null }, t0);
  const typed = await recordVersion(doc, root, 'ab\n', edit(me), t0 + 1000);
  const more = await recordVersion(doc, root, 'abc\n', edit(me), t0 + 2000);
  assert.equal(more.id, typed.id, 'still typing: the same version');
  assert.equal(more.startedAt, typed.startedAt);
  assert.deepEqual([more.added, more.removed], [2, 0], 'counted from the version before the burst');

  // The agent's change in between starts a new version, and so does the human's after it.
  await recordVersion(doc, root, 'abcd\n', edit(bot), t0 + 3000);
  await recordVersion(doc, root, 'abcde\n', edit(me), t0 + 4000);
  // A pause longer than COALESCE_MS starts a new one too.
  await recordVersion(doc, root, 'abcdef\n', edit(me), t0 + 4000 + COALESCE_MS);
  assert.equal((await readHistory(doc, root)).length, 5);

  // A long session is cut into versions even without a pause.
  let at = t0 + 10 * MAX_SPAN_MS;
  for (let i = 0; at < t0 + 11 * MAX_SPAN_MS + 1000; i++, at += 60_000) await recordVersion(doc, root, `x${i}\n`, edit(me), at);
  assert.equal((await readHistory(doc, root)).length, 7);

  // Typing that ends where the version before began leaves no version behind.
  const doc2 = await tempDoc();
  await recordVersion(doc2, root, 'a\n', { kind: 'external', author: null }, t0);
  await recordVersion(doc2, root, 'ab\n', edit(me), t0 + 1000);
  await recordVersion(doc2, root, 'a\n', edit(me), t0 + 2000);
  assert.equal((await readHistory(doc2, root)).length, 1);
  assert.equal((await readdir(historyDir(doc2, root))).filter((f) => f.endsWith('.md')).length, 1, 'unused text is removed');
});

test('history follows a renamed doc', async () => {
  const root = await configRoot();
  const doc = await tempDoc();
  await recordVersion(doc, root, 'a\n', edit(me));
  const moved = join(dirname(doc), 'renamed.md');
  await moveHistory(doc, moved, root);
  assert.equal((await readHistory(moved, root)).length, 1);
  assert.equal((await readHistory(doc, root)).length, 0);
});

// ---- through the server ----

function call(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      method,
      path,
      headers: {
        host: `127.0.0.1:${server.port}`,
        'x-opendoc-token': server.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
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

async function waitUntil(check, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// The doc's buddy, histbot, runs the fake agent script.
async function withServer(fn) {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const settingsDir = await configRoot();
  process.env.FAKE_DIR = settingsDir;
  await mkdir(join(settingsDir, 'agents'));
  await writeFile(join(settingsDir, 'agents', 'fake'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}"\n`, { mode: 0o755 });
  await writeFile(join(settingsDir, 'agents', 'fake.cmd'), `@"${process.execPath}" "${FAKE_AGENT}"\r\n`);
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agent: 'fake', agents: [{ id: 'a_histbot', name: 'histbot', starred: true }] }));
  const server = await startServer(docPath, { assetsDir, settingsDir });
  try {
    await fn({ server, docPath, versions: async () => (await call(server, 'GET', '/api/history')).body.versions });
  } finally {
    await server.close();
  }
}

test('the server records saves, changes on disk and restores', async () => {
  await withServer(async ({ server, docPath, versions }) => {
    assert.deepEqual((await versions()).map((v) => v.kind), ['opened']);
    const { body: state } = await call(server, 'GET', '/api/state');
    const saved = await call(server, 'PUT', '/api/doc', { markdown: SAMPLE.replace('six', 'seven'), baseHash: state.docHash });
    assert.equal(saved.status, 200);

    // Written by another program: noticed by the watcher.
    await writeFile(docPath, SAMPLE.replace('six', 'eight'));
    assert.ok(await waitUntil(async () => (await versions()).length === 3), 'the outside change was recorded');
    const list = await versions();
    assert.deepEqual(list.map((v) => [v.kind, v.author?.name ?? null]), [['opened', null], ['edit', 'fzhan'], ['external', null]]);

    const shown = await call(server, 'GET', `/api/history/version?id=${list[1].id}`);
    assert.equal(shown.body.markdown, SAMPLE.replace('six', 'seven'));
    assert.equal(shown.body.before, SAMPLE);

    // Restoring needs the doc the page last saw.
    const stale = await call(server, 'POST', '/api/history/restore', { id: list[0].id, baseHash: state.docHash });
    assert.equal(stale.status, 409);
    const { body: now } = await call(server, 'GET', '/api/state');
    const restored = await call(server, 'POST', '/api/history/restore', { id: list[0].id, baseHash: now.docHash });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.markdown, SAMPLE);
    assert.equal(await readFile(docPath, 'utf8'), SAMPLE);
    const last = (await versions()).at(-1);
    assert.equal(last.kind, 'restore');
    assert.equal(last.restoredFrom, list[0].id);
    assert.equal(last.author.name, 'fzhan');
    assert.equal((await versions()).length, 4, 'restoring keeps every version');

    assert.equal((await call(server, 'GET', '/api/history/version?id=../index')).status, 400);
    assert.equal((await call(server, 'GET', '/api/history/version?id=v_nothere1')).status, 404);
  });
});

test("a buddy's merged edit is recorded as its own", { timeout: 30_000 }, async () => {
  await withServer(async ({ server, versions }) => {
    const message = { id: 'm_hist0001', author: me, body: '@histbot replace "extra load" with "extra peak load"' };
    await call(server, 'POST', '/api/ops', { op: { type: 'addThread', id: 't_hist0001', anchor: null, message } });
    assert.ok(await waitUntil(async () => (await versions()).length === 2), 'the agent edit was recorded');
    const [, agentVersion] = await versions();
    assert.deepEqual(agentVersion.author, { name: 'histbot', kind: 'agent' });
    assert.deepEqual(agentVersion.threadIds, ['t_hist0001']);
  });
});
