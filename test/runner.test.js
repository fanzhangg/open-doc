// Runner: a buddy's run is a filter (docs/architecture-v2.md, A run). The
// agent is always the fake script (test/fixtures/fake-agent.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { startServer } from '../src/server/server.js';
import { agentScript, installAgents, listAgents } from '../src/store/agents.js';
import { SAMPLE, tempDoc } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-agent.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// The fake agent as the agent script `fake`, in a fresh config folder.
async function fakeConfig(agents = [{ id: 'a_clippy01', name: 'Clippy', persona: 'Helps with docs', instructions: 'Be brief.', starred: true }]) {
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-runner-'));
  await mkdir(join(settingsDir, 'agents'));
  await writeFile(join(settingsDir, 'agents', 'fake'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}"\n`);
  await chmod(join(settingsDir, 'agents', 'fake'), 0o755);
  await writeFile(join(settingsDir, 'agents', 'fake.cmd'), `@"${process.execPath}" "${FAKE}"\r\n`);
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agent: 'fake', agents }));
  return settingsDir;
}

async function withDoc(fn, { agents, folder = null, content = SAMPLE } = {}) {
  const docPath = await tempDoc(content);
  const settingsDir = await fakeConfig(agents);
  const fakeDir = await mkdtemp(join(tmpdir(), 'opendoc-fake-'));
  process.env.FAKE_DIR = fakeDir;
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  let server = await startServer(docPath, { settingsDir, assetsDir, folder });
  const api = (method, path, body) => call(server, method, path, body);
  const state = async () => (await api('GET', '/api/state')).body;
  const runs = async () => (await readFile(join(fakeDir, 'runs.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const release = (buddy) => writeFile(join(fakeDir, `release-${buddy}`), '');
  const restart = async () => {
    await server.close();
    server = await startServer(docPath, { settingsDir, assetsDir, folder });
  };
  try {
    await fn({ docPath, settingsDir, api, state, runs, release, restart, server: () => server });
  } finally {
    await server.close();
  }
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

let ids = 0;
const nextId = (prefix) => `${prefix}_test${String(++ids).padStart(4, '0')}`;
const comment = (api, body, anchor = null) => {
  const id = nextId('t');
  return api('POST', '/api/ops', { op: { type: 'addThread', id, anchor, message: { id: nextId('m'), author: { name: 'fzhan', kind: 'human' }, body } } }).then(() => id);
};
const reply = (api, threadId, body) => api('POST', '/api/ops', { op: { type: 'addMessage', threadId, message: { id: nextId('m'), author: { name: 'fzhan', kind: 'human' }, body } } });
const threadOf = async (state, id) => (await state()).sidecar.threads.find((t) => t.id === id);
const repliesIn = async (state, id) => (await threadOf(state, id)).messages.filter((m) => m.author.kind === 'agent');

test('a run edits its copy and prints its reply: the doc has the edit, the thread the reply; the run sees only the copy', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, api, state, runs }) => {
    const id = await comment(api, '@Clippy replace "extra load" with "extra peak load"');
    const [answer] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(answer.author.name, 'Clippy');
    assert.equal(answer.body, 'Replaced "extra load".');
    assert.ok(!answer.conflict && !answer.failed);
    assert.match(await readFile(docPath, 'utf8'), /the extra peak load\./);

    const [run] = await runs();
    assert.deepEqual(run.files, ['plan.md'], 'its folder holds only the copy');
    assert.notEqual(run.cwd, dirname(docPath));
    assert.equal(run.doc, join(run.cwd, 'plan.md'));
    assert.equal(run.buddy, 'Clippy');
    assert.equal(run.project, '');
    assert.equal(run.opendoc, false, 'no opendoc to call');
    assert.match(run.prompt, /Helps with docs/);
    assert.match(run.prompt, /Be brief\./);
    assert.match(run.prompt, /fzhan: @Clippy replace/);
    assert.ok(!existsSync(run.cwd), 'the folder is gone after');
  });
});

test('the human edits the same text during a run: theirs stays, the buddy\'s change there is dropped, the reply says conflict', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, api, state, runs, release }) => {
    const id = await comment(api, '@Clippy hold replace "extra load" with "extra peak load"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    const now = await state();
    const saved = await api('PUT', '/api/doc', { markdown: now.markdown.replace('extra load', 'extra traffic'), baseHash: now.docHash });
    assert.equal(saved.status, 200);
    await release('Clippy');
    const [answer] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(answer.conflict, true);
    const text = await readFile(docPath, 'utf8');
    assert.match(text, /the extra traffic\./);
    assert.doesNotMatch(text, /peak/);
  });
});

test('two buddies run at once on one doc; both edits land', { timeout: 30_000 }, async () => {
  const agents = [
    { id: 'a_clippy01', name: 'Clippy', starred: true },
    { id: 'a_ada00001', name: 'Ada', starred: true },
  ];
  await withDoc(async ({ docPath, api, state, runs, release }) => {
    const first = await comment(api, '@Clippy hold replace "extra load" with "extra peak load"');
    const second = await comment(api, '@Ada hold replace "week one" with "week two"');
    await until(async () => (await runs()).length === 2, 'both runs to start');
    assert.deepEqual((await state()).agents.filter((a) => a.state === 'running').map((a) => a.name).sort(), ['Ada', 'Clippy']);
    await Promise.all([release('Clippy'), release('Ada')]);
    await until(async () => (await repliesIn(state, first)).length && (await repliesIn(state, second)).length, 'both replies');
    const text = await readFile(docPath, 'utf8');
    assert.match(text, /extra peak load/);
    assert.match(text, /week two/);
    for (const id of [first, second]) assert.ok(!(await repliesIn(state, id))[0].conflict);
  }, { agents });
});

test('a script that exits 1 is answered with a reply marked failed; @mentioning the buddy again runs it again', { timeout: 30_000 }, async () => {
  await withDoc(async ({ settingsDir, api, state, runs }) => {
    const id = await comment(api, '@Clippy fail');
    const [failed] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(failed.failed, true);
    assert.match(failed.body, /some output/);
    assert.match(failed.body, /fake agent: something went wrong/);
    assert.ok(failed.body.includes(agentScript('fake', settingsDir)), 'it names the script, to run by hand');
    await sleep(500);
    assert.equal((await runs()).length, 1, 'not retried on its own');

    await reply(api, id, '@Clippy replace "week one" with "week 1"');
    await until(async () => (await repliesIn(state, id)).length === 2, 'the second reply');
    assert.equal((await runs()).length, 2);
    assert.ok(!(await repliesIn(state, id))[1].failed);
  });
});

test('a comment that mentions no one asks no one; a buddy\'s reply asks no one', { timeout: 30_000 }, async () => {
  await withDoc(async ({ api, state, runs }) => {
    const quiet = await comment(api, 'Clippy, is this clear?');
    const id = await comment(api, '@Clippy say @Clippy');
    await until(async () => (await repliesIn(state, id)).length, 'the reply');
    await sleep(800);
    assert.equal((await runs()).length, 1);
    assert.equal((await repliesIn(state, quiet)).length, 0);
  });
});

test('in project mode the run is told the project folder', { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'opendoc-project-'));
  await withDoc(async ({ api, state, runs }) => {
    const id = await comment(api, '@Clippy look around');
    await until(async () => (await repliesIn(state, id)).length, 'the reply');
    const [run] = await runs();
    assert.equal(run.project, folder);
    assert.ok(run.prompt.includes(folder));
  }, { folder });
});

test('after a restart, an unanswered ask runs again', { timeout: 30_000 }, async () => {
  await withDoc(async ({ api, state, runs, release, restart }) => {
    const id = await comment(api, '@Clippy hold replace "extra load" with "extra peak load"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    await restart(); // ends the run with no answer
    assert.equal((await repliesIn(state, id)).length, 0);
    await until(async () => (await runs()).length === 2, 'the run to start again');
    await release('Clippy');
    await until(async () => (await repliesIn(state, id)).length === 1, 'one reply');
  });
});

test('the shipped scripts pass the project folder only when there is one', () => {
  for (const name of ['claude', 'codex']) {
    const cmd = readFileSync(join(ROOT, 'agents', `${name}.cmd`), 'utf8');
    assert.match(cmd, /if defined OPENDOC_PROJECT set ADD=--add-dir "%OPENDOC_PROJECT%"/, `${name}.cmd`);
    assert.match(cmd, /\r\n/, `${name}.cmd has Windows line ends`);
  }
  if (process.platform === 'win32') return;
  // A fake `claude` and `codex` on PATH print the arguments they get.
  const bin = execFileSync('mktemp', ['-d']).toString().trim();
  execFileSync('sh', ['-c', `printf '#!/bin/sh\\necho "$@"\\n' > "${bin}/claude"; printf '#!/bin/sh\\nwhile [ "$1" != "--output-last-message" ]; do shift; done; echo reply > "$2"\\n' > "${bin}/codex"; chmod +x "${bin}/claude" "${bin}/codex"`]);
  const run = (name, project) => execFileSync(join(ROOT, 'agents', name), { input: 'prompt', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, OPENDOC_PROJECT: project }, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  assert.equal(run('claude', ''), '-p --permission-mode acceptEdits --no-session-persistence');
  assert.equal(run('claude', '/work/my project'), '-p --permission-mode acceptEdits --no-session-persistence --add-dir /work/my project');
  assert.equal(run('codex', ''), 'reply', 'codex prints only its last message');
});

test('the shipped agent scripts are written when missing, then left alone; Reset writes one again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-agents-'));
  await installAgents(dir, { platform: 'linux' });
  await installAgents(dir, { platform: 'win32' });
  assert.deepEqual(await listAgents(dir, 'linux'), ['claude', 'codex']);
  assert.deepEqual(await listAgents(dir, 'win32'), ['claude', 'codex']);
  const claude = agentScript('claude', dir, 'linux');
  assert.equal(basename(agentScript('claude', dir, 'win32')), 'claude.cmd');
  await writeFile(claude, '#!/bin/sh\necho mine\n');
  await installAgents(dir, { platform: 'linux' });
  assert.equal(await readFile(claude, 'utf8'), '#!/bin/sh\necho mine\n', 'yours once written');
  await installAgents(dir, { platform: 'linux', reset: 'claude' });
  assert.equal(await readFile(claude, 'utf8'), await readFile(join(ROOT, 'agents', 'claude'), 'utf8'));
});
