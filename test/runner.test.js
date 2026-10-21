// Runner: a buddy's run is a filter (docs/architecture.md, A run). The
// agent is always the fake script (test/fixtures/fake-agent.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from '../src/host/runner.js';
import { agentScript, installAgents, listAgents } from '../src/store/agents.js';
import { SAMPLE, fakeConfig, fakeRuns, openTestDoc, tempDoc, until } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withDoc(fn, { buddies = null, folder = null, content = SAMPLE, settings = {} } = {}) {
  const docPath = await tempDoc(content);
  const settingsDir = await fakeConfig(settings);
  let opened = await openTestDoc(docPath, { settingsDir, folder, buddies });
  const release = (buddy) => writeFile(join(settingsDir, `release-${buddy}`), '');
  const restart = async () => {
    await opened.doc.close();
    opened = await openTestDoc(docPath, { settingsDir, folder, buddies });
  };
  try {
    await fn({
      docPath, settingsDir, release, restart,
      call: (type, arg) => opened.call(type, arg),
      edit: opened.edit,
      state: () => opened.state(),
      runs: () => fakeRuns(settingsDir),
    });
  } finally {
    await opened.doc.close();
  }
}

const runLog = async (settingsDir) => (await readFile(join(settingsDir, 'logs', 'runs.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const comment = (call, body, anchor = null) => call('comment', { anchor, body }).then((r) => r.id);
const reply = (call, thread, body) => call('comment', { thread, body });
const threadOf = async (state, id) => (await state()).threads.find((t) => t.id === id);
const repliesIn = async (state, id) => (await threadOf(state, id)).comments.filter((c) => c.by.kind === 'ai');

test('a run edits its copy and prints its reply: the doc has the edit, the thread the reply; the run sees only the copy', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, state, runs }) => {
    const id = await comment(call, '@Clippy replace "extra load" with "extra peak load"');
    const [answer] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(answer.by.name, 'Clippy');
    assert.equal(answer.body, 'Replaced "extra load".');
    assert.ok(!answer.conflict && !answer.failed);
    assert.match(await readFile(docPath, 'utf8'), /the extra peak load\./);

    const [run] = await runs();
    assert.deepEqual(run.files.sort(), ['plan.md', 'plan.md.opendoc.jsonl'], 'its folder holds only the copies');
    assert.notEqual(run.cwd, dirname(docPath));
    assert.equal(join(basename(dirname(run.doc)), basename(run.doc)), join(basename(run.cwd), 'plan.md'), 'the copy, in its folder (macOS may name /var as /private/var)');
    assert.equal(run.buddy, 'Clippy');
    assert.equal(run.project, '');
    assert.equal(run.opendoc, false, 'no opendoc to call');
    assert.match(run.prompt, /A general writing assistant/, 'Clippy is built in');
    assert.match(run.prompt, /fzhan: @Clippy replace/);
    await until(() => !existsSync(run.cwd), 'the folder to be gone after', 5000);
  });
});

test('the human edits the same text during a run: theirs stays, the buddy\'s change there is dropped, the reply says conflict', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, edit, state, runs, release }) => {
    const id = await comment(call, '@Clippy hold replace "extra load" with "extra peak load"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    await edit((await state()).text.replace('extra load', 'extra traffic'));
    await release('Clippy');
    const [answer] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(answer.conflict, true);
    const text = await readFile(docPath, 'utf8');
    assert.match(text, /the extra traffic\./);
    assert.doesNotMatch(text, /peak/);
  });
});

test('a buddy\'s edit to a line the human changed too: the Markdown rule refuses a character merge that changes how it renders; switched off, it merges', { timeout: 30_000 }, async () => {
  // Taking out one `*` and adding another elsewhere would pair them into new emphasis.
  for (const on of [true, false]) {
    await withDoc(async ({ docPath, call, edit, state, runs, release }) => {
      const id = await comment(call, '@Clippy hold replace "1 *2* 3" with "1 *2* 3 4*"');
      await until(async () => (await runs()).length === 1, 'the run to start');
      await edit('1 *2 3\n');
      await release('Clippy');
      const [answer] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
      assert.equal(Boolean(answer.conflict), on);
      assert.equal(await readFile(docPath, 'utf8'), on ? '1 *2 3\n' : '1 *2 3 4*\n');
    }, { content: '1 *2* 3\n', settings: { rules: { 'markdown-rule': { enabled: on } } } });
  }
});

test('two buddies run at once on one doc; both edits land', { timeout: 30_000 }, async () => {
  const buddies = { Clippy: '\n', Ada: '\n' };
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
  }, { buddies });
});

test('a script that exits 1 is answered with a reply marked failed; @mentioning the buddy again runs it again', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, settingsDir, call, state, runs }) => {
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
    const logged = await runLog(settingsDir);
    assert.deepEqual(logged.map((l) => [l.doc, l.buddy, l.thread, l.outcome, l.code]), [[docPath, 'Clippy', id, 'failed', 1], [docPath, 'Clippy', id, 'ok', 0]], 'each run is logged');
    assert.ok(logged.every((l) => Number.isInteger(l.ms) && !Number.isNaN(Date.parse(l.at))));
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
    assert.match(run.prompt, /path in a comment is relative to the project folder/);
  }, { folder });
});

test('after a restart, an unanswered ask runs again', { timeout: 30_000 }, async () => {
  await withDoc(async ({ settingsDir, call, state, runs, release, restart }) => {
    const id = await comment(call, '@Clippy hold replace "extra load" with "extra peak load"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    await restart(); // ends the run with no answer
    assert.equal((await repliesIn(state, id)).length, 0);
    assert.equal((await runLog(settingsDir))[0].outcome, 'stopped', 'a stopped run is logged');
    await until(async () => (await runs()).length === 2, 'the run to start again');
    await release('Clippy');
    await until(async () => (await repliesIn(state, id)).length === 1, 'one reply');
  });
});

test('the shipped scripts pass the project folder only when there is one', () => {
  for (const name of ['claude', 'codex']) assert.match(readFileSync(join(ROOT, 'agents', `${name}.cmd`), 'utf8'), /\r\n/, `${name}.cmd has Windows line ends`);
  assert.match(readFileSync(join(ROOT, 'agents', 'claude.cmd'), 'utf8'), /set ADD=--add-dir "%OPENDOC_PROJECT%" --disallowedTools "Edit\(\/%P%\/\*\*\)"/, 'claude.cmd keeps the project read only');
  assert.doesNotMatch(readFileSync(join(ROOT, 'agents', 'codex.cmd'), 'utf8'), /codex exec[^\r]*--add-dir/, 'Codex reads the project without it');
  if (process.platform === 'win32') return;
  // A fake `claude` and `codex` on PATH read the prompt (else writing it can
  // fail with EPIPE) and print the arguments they get.
  const bin = execFileSync('mktemp', ['-d']).toString().trim();
  execFileSync('sh', ['-c', `printf '#!/bin/sh\\ncat >/dev/null; echo "$@"\\n' > "${bin}/claude"; printf '#!/bin/sh\\ncat >/dev/null; while [ "$1" != "--output-last-message" ]; do shift; done; echo reply > "$2"\\n' > "${bin}/codex"; chmod +x "${bin}/claude" "${bin}/codex"`]);
  const run = (name, project) => execFileSync(join(ROOT, 'agents', name), { input: 'prompt', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, OPENDOC_PROJECT: project, OPENDOC_DOC: '/run/my doc.md' }, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  assert.equal(run('claude', ''), '-p @"/run/my doc.md" --permission-mode acceptEdits --no-session-persistence', 'Claude gets the doc copy as already read');
  assert.equal(run('claude', '/work/my project'), '-p @"/run/my doc.md" --permission-mode acceptEdits --no-session-persistence --add-dir /work/my project --disallowedTools Edit(//work/my project/**)', 'the project is read only');
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

test('the prompt tells a buddy who the other members are, as the app shows them', () => {
  const thread = { anchor: null, comments: [{ by: { name: 'fzhan', kind: 'human' }, body: 'hi' }] };
  const buddies = [{ id: 'b_ada', name: 'Ada', about: 'Edits for tone.' }, { id: 'b_bo', name: 'Bo', about: '' }, { id: 'b_cy', name: 'Cy', about: 'Checks facts.' }];
  const prompt = buildPrompt({ buddy: buddies[0], buddies, docName: 'a.md', thread });
  assert.match(prompt, /The other members of the doc:\n\nBo\n\nCy: Checks facts\./);
  assert.doesNotMatch(prompt, /Ada: /, 'not itself');
  const withUser = buildPrompt({ buddy: buddies[0], buddies, docName: 'a.md', thread, human: { name: 'fzhan', about: 'I write novels.' } });
  assert.match(withUser, /The other members of the doc:\n\nfzhan \(owner\): I write novels\.\n\nBo/);
  assert.match(withUser, /Only fzhan resolves threads/);
  assert.doesNotMatch(prompt, /I write novels/, 'nothing about an owner who wrote nothing');
});
