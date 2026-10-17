// Runner: a buddy's run is a filter (docs/architecture-v2.md, A run). The
// agent is always the fake script (test/fixtures/fake-agent.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentScript, installAgents, listAgents } from '../src/store/agents.js';
import { SAMPLE, fakeConfig, fakeRuns, openTestDoc, tempDoc, until } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIPPY = [{ id: 'a_clippy01', name: 'Clippy', persona: 'Helps with docs', instructions: 'Be brief.', starred: true }];

async function withDoc(fn, { agents = CLIPPY, folder = null, content = SAMPLE } = {}) {
  const docPath = await tempDoc(content);
  const settingsDir = await fakeConfig({ agents });
  let opened = await openTestDoc(docPath, { settingsDir, folder });
  const release = (buddy) => writeFile(join(settingsDir, `release-${buddy}`), '');
  const restart = async () => {
    await opened.doc.close();
    opened = await openTestDoc(docPath, { settingsDir, folder });
  };
  try {
    await fn({
      docPath, settingsDir, release, restart,
      call: (type, arg) => opened.call(type, arg),
      state: () => opened.state(),
      runs: () => fakeRuns(settingsDir),
    });
  } finally {
    await opened.doc.close();
  }
}

let ids = 0;
const nextId = (prefix) => `${prefix}_test${String(++ids).padStart(4, '0')}`;
const comment = (call, body, anchor = null) => {
  const id = nextId('t');
  return call('op', { op: { type: 'addThread', id, anchor, message: { id: nextId('m'), author: { name: 'fzhan', kind: 'human' }, body } } }).then(() => id);
};
const reply = (call, threadId, body) => call('op', { op: { type: 'addMessage', threadId, message: { id: nextId('m'), author: { name: 'fzhan', kind: 'human' }, body } } });
const threadOf = async (state, id) => (await state()).sidecar.threads.find((t) => t.id === id);
const repliesIn = async (state, id) => (await threadOf(state, id)).messages.filter((m) => m.author.kind === 'agent');

test('a run edits its copy and prints its reply: the doc has the edit, the thread the reply; the run sees only the copy', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, state, runs }) => {
    const id = await comment(call, '@Clippy replace "extra load" with "extra peak load"');
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
    await until(() => !existsSync(run.cwd), 'the folder to be gone after', 5000);
  });
});

test('the human edits the same text during a run: theirs stays, the buddy\'s change there is dropped, the reply says conflict', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, state, runs, release }) => {
    const id = await comment(call, '@Clippy hold replace "extra load" with "extra peak load"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    const now = await state();
    const saved = await call('saveDoc', { markdown: now.markdown.replace('extra load', 'extra traffic'), baseHash: now.docHash });
    assert.ok(!saved.conflict);
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
  await withDoc(async ({ docPath, call, state, runs, release }) => {
    const first = await comment(call, '@Clippy hold replace "extra load" with "extra peak load"');
    const second = await comment(call, '@Ada hold replace "week one" with "week two"');
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
  await withDoc(async ({ settingsDir, call, state, runs }) => {
    const id = await comment(call, '@Clippy fail');
    const [failed] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(failed.failed, true);
    assert.match(failed.body, /some output/);
    assert.match(failed.body, /fake agent: something went wrong/);
    assert.ok(failed.body.includes(agentScript('fake', settingsDir)), 'it names the script, to run by hand');
    await sleep(500);
    assert.equal((await runs()).length, 1, 'not retried on its own');

    await reply(call, id, '@Clippy replace "week one" with "week 1"');
    await until(async () => (await repliesIn(state, id)).length === 2, 'the second reply');
    assert.equal((await runs()).length, 2);
    assert.ok(!(await repliesIn(state, id))[1].failed);
  });
});

test('a comment that mentions no one asks no one; a buddy\'s reply asks no one', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, runs }) => {
    const quiet = await comment(call, 'Clippy, is this clear?');
    const id = await comment(call, '@Clippy say @Clippy');
    await until(async () => (await repliesIn(state, id)).length, 'the reply');
    await sleep(800);
    assert.equal((await runs()).length, 1);
    assert.equal((await repliesIn(state, quiet)).length, 0);
  });
});

test('in project mode the run is told the project folder', { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'opendoc-project-'));
  await withDoc(async ({ call, state, runs }) => {
    const id = await comment(call, '@Clippy look around');
    await until(async () => (await repliesIn(state, id)).length, 'the reply');
    const [run] = await runs();
    assert.equal(run.project, folder);
    assert.ok(run.prompt.includes(folder));
  }, { folder });
});

test('after a restart, an unanswered ask runs again', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, runs, release, restart }) => {
    const id = await comment(call, '@Clippy hold replace "extra load" with "extra peak load"');
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
