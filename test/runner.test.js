// Runner: a buddy's run is a filter (docs/architecture.md, A run). The
// agent is always the fake script (test/fixtures/fake-agent.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mirrorDir } from '../src/host/mirror.js';
import { buildPrompt } from '../src/host/runner.js';
import { agentScript, agentsDir, installAgents, listAgents } from '../src/store/agents.js';
import { readSecrets, secretTails, writeSecrets } from '../src/store/secrets.js';
import { SAMPLE, fakeConfig, fakeRuns, openTestDoc, readOnly, tempDoc, until } from './helpers.js';

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
    assert.deepEqual(run.files.sort(), ['plan.md', 'plan.md.comments.jsonl'], 'its folder holds only the copies');
    assert.notEqual(run.cwd, dirname(docPath));
    assert.equal(join(basename(dirname(run.doc)), basename(run.doc)), join(basename(run.cwd), 'plan.md'), 'the copy, in its folder (macOS may name /var as /private/var)');
    assert.equal(run.buddy, 'Clippy');
    assert.equal(run.project, '');
    assert.equal(run.ponjo, false, 'no ponjo to call');
    assert.deepEqual(run.settings, {}, 'an agent with no manifest has no settings');
    assert.match(run.prompt, /A general writing assistant/, 'Clippy, written on first run');
    assert.match(run.prompt, /fzhan: @Clippy replace/);
    await until(() => !existsSync(run.cwd), 'the folder to be gone after', 5000);
  });
});

test('the human edits the same lines during a run: the turn runs once more, on the doc as it is now, told what it and they changed', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, edit, state, runs, release }) => {
    const id = await comment(call, '@Clippy hold replace "extra load" with "extra peak load"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    await edit((await state()).text.replace('extra load', 'extra traffic'));
    await release('Clippy');
    await until(async () => (await repliesIn(state, id)).length, 'the reply');
    const [first, again] = await runs();
    assert.doesNotMatch(first.prompt, /was not applied/);
    assert.match(again.prompt, /your edit was not applied/);
    assert.match(again.prompt, /\n-The main risk is that the `sync` service cannot handle the extra load\.\n\+The main risk is that the `sync` service cannot handle the extra peak load\.\n/);
    assert.match(again.prompt, /What members changed meanwhile:\n\n-The main risk .* extra load\.\n\+The main risk .* extra traffic\.\n/);
    const text = await readFile(docPath, 'utf8');
    assert.match(text, /the extra traffic\./);
    assert.doesNotMatch(text, /peak/);
  });
});

test('a turn that collides again when run once more lands where no one changed its lines, and its version says conflict', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, edit, state, runs, release }) => {
    const id = await comment(call, '@Clippy wait replace "extra load" with "extra peak load" replace "week one" with "week two" replace "## Risks" with "## Open risks"');
    await until(async () => (await runs()).length === 1, 'the run to start');
    await edit((await state()).text.replace('extra load', 'extra traffic'));
    await release('Clippy');
    await until(async () => (await runs()).length === 2, 'the run once more');
    await edit((await state()).text.replace('week one', 'week 1'));
    await release('Clippy');
    await until(async () => (await repliesIn(state, id)).length, 'the reply');
    const text = await readFile(docPath, 'utf8');
    assert.match(text, /in week 1,/);
    assert.match(text, /## Open risks/);
    assert.match(text, /the extra traffic\./);
    assert.equal((await runs()).length, 2, 'once more, no more');
    const [reply] = await repliesIn(state, id);
    assert.equal((await state()).edits[reply.id].conflict, true);
    assert.equal(reply.conflict, undefined, 'nothing of it in the comments\' file');
  });
});

test('A3 C4: a turn that ends while the doc cannot be written lands once and runs once; the file has its edit once it can be', { timeout: 30_000 }, async () => {
  await withDoc(async ({ docPath, call, state, runs, release }) => {
    await comment(call, '@Clippy hold, then replace "extra load" with "extra extra load"');
    await until(async () => (await runs()).length === 1, 'the turn started');
    await readOnly(docPath, true); // the doc and its comments
    try {
      await release('Clippy');
      await until(async () => (await state()).text.includes('extra extra load'), 'the edit landed');
      await sleep(1500); // a turn whose answer could not be written is not run again
      assert.equal((await runs()).length, 1);
    } finally {
      await readOnly(docPath, false);
    }
    await until(async () => (await readFile(docPath, 'utf8')).includes('extra extra load'), 'the edit written');
    assert.equal((await readFile(docPath, 'utf8')).split('extra extra load').length, 2, 'once');
    assert.equal((await runs()).length, 1);
  });
});

test('D8: a thread whose text its buddy rewrote is on the new text: the reply carries its anchor', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state }) => {
    const text = (await state()).text;
    const start = text.indexOf('six features');
    const id = await comment(call, '@Clippy replace "six features" with "the six features we promised the beta cohort last spring"', { exact: 'six features', prefix: text.slice(start - 32, start), suffix: text.slice(start + 12, start + 44), start });
    const [answer] = await until(async () => (await repliesIn(state, id)).length && repliesIn(state, id), 'the reply');
    assert.equal(answer.anchor.exact, 'the six features we promised the beta cohort last spring');
    const thread = await threadOf(state, id);
    assert.equal(thread.detached, false);
    assert.equal(thread.anchor.exact, 'the six features we promised the beta cohort last spring');
  });
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

test('a log past 10 MB keeps its newest half, from a line\'s start: runs.jsonl and an agent\'s', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, settingsDir }) => {
    const logs = join(settingsDir, 'logs');
    await mkdir(logs, { recursive: true });
    const old = `${JSON.stringify({ old: 'x'.repeat(1000) })}\n`.repeat(11 * 1024);
    await writeFile(join(logs, 'runs.jsonl'), old);
    await writeFile(join(logs, 'ponjo.jsonl'), old);
    const id = await comment(call, '@Clippy replace "extra load" with "extra peak load"');
    const sizes = () => Promise.all(['runs.jsonl', 'ponjo.jsonl'].map(async (name) => (await stat(join(logs, name))).size));
    await until(async () => (await sizes()).every((size) => size <= 5 * 1024 * 1024), 'the logs trimmed');
    assert.equal((await runLog(settingsDir)).at(-1).thread, id, 'the new line is kept');
    const agents = (await readFile(join(logs, 'ponjo.jsonl'), 'utf8')).trim().split('\n');
    assert.ok(agents.every((line) => JSON.parse(line).old), 'whole lines');
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

test('in project mode a run gets its own copy of what the project shows, gone once it ends', { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ponjo-project-'));
  await writeFile(join(folder, 'notes.md'), 'Notes.\n');
  await writeFile(join(folder, '.env'), 'KEY=secret\n');
  await withDoc(async ({ settingsDir, call, state, runs }) => {
    const id = await comment(call, '@Clippy look around');
    await until(async () => (await repliesIn(state, id)).length, 'the reply');
    const [run] = await runs();
    assert.equal(basename(run.project), basename(folder));
    assert.ok(!run.project.startsWith(settingsDir), 'not the mirror itself');
    assert.deepEqual(run.projectFiles, ['notes.md']);
    assert.ok(run.prompt.includes(run.project) && !run.prompt.includes(`${folder}/`));
    assert.match(run.prompt, /path in a comment is relative to the project folder/);
    await until(() => !existsSync(run.project), 'its copy to be gone after', 5000);
  }, { folder });
});

test('runs at once never see each other\'s writes to the project, nor does the mirror', { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ponjo-project-'));
  await writeFile(join(folder, 'notes.md'), 'Notes.\n');
  await withDoc(async ({ settingsDir, call, state, runs, release }) => {
    const first = await comment(call, '@Clippy write stray.md ;; hold');
    await until(async () => (await runs()).length === 1 && existsSync(join((await runs())[0].project, 'stray.md')), 'the first run to write');
    const second = await comment(call, '@Clippy look around');
    await until(async () => (await repliesIn(state, second)).length, 'the second reply');
    const [, run] = await runs();
    assert.deepEqual(run.projectFiles, ['notes.md']);
    assert.ok(!existsSync(join(mirrorDir(folder, settingsDir), 'stray.md')));
    await release('Clippy');
    await until(async () => (await repliesIn(state, first)).length, 'the first reply');
    assert.ok(!existsSync(join(folder, 'stray.md')));
  }, { folder });
});

test('a buddy\'s new comment is anchored on the text it quoted, though a person edited that text meanwhile', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, edit, state, runs, release }) => {
    await comment(call, '@Clippy hold ;; append {"anchor":{"exact":"cannot handle the extra load"},"body":"Is this measured?"}');
    await until(async () => (await runs()).length === 1, 'the run to start');
    await edit((await state()).text.replace('the extra load', 'the extra holiday load'));
    await release('Clippy');
    const thread = await until(async () => (await state()).threads.find((t) => t.comments[0].body === 'Is this measured?'), 'its comment');
    assert.equal(thread.detached, false);
    assert.equal(thread.anchor.exact, 'cannot handle the extra holiday load');
  });
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

test('a run gets each of its agent\'s settings as PONJO_SETTING_<KEY>: the stored value or the default', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc();
  const settingsDir = await fakeConfig({ agents: { fake: { model: 'small', effort: 'high', other: 'x' }, claude: { model: 'opus' } } });
  await writeFile(join(settingsDir, 'agents', 'fake.json'), JSON.stringify({ name: 'Fake', settings: [
    { key: 'model', type: 'text', label: 'Model', default: 'big' },
    { key: 'effort', type: 'choice', label: 'Effort', options: [['low', 'Low'], ['high', 'High']], default: 'low' },
    { key: 'endpoint', type: 'text', label: 'Endpoint', default: '' },
    { key: 'tries', type: 'number', label: 'Tries', min: 1, max: 5, default: 3 },
    { key: 'fast', type: 'switch', label: 'Fast', default: false },
    { key: 'key', type: 'secret', label: 'Key' },
  ] }));
  const { doc, call } = await openTestDoc(docPath, { settingsDir });
  try {
    await call('comment', { anchor: null, body: '@Clippy quiet' });
    const [run] = await until(async () => (await fakeRuns(settingsDir)).length && fakeRuns(settingsDir), 'the run');
    assert.deepEqual(run.settings, {
      PONJO_SETTING_MODEL: 'small', PONJO_SETTING_EFFORT: 'high', PONJO_SETTING_ENDPOINT: '', PONJO_SETTING_TRIES: '3', PONJO_SETTING_FAST: 'false', PONJO_SETTING_KEY: '',
    }, 'every field, only its agent\'s; none set is empty');
  } finally {
    await doc.close();
  }
});

// A stand-in for Electron's safeStorage: not encryption, but not the text either.
const cipher = {
  encryptString: (text) => Buffer.from(text).reverse(),
  decryptString: (bytes) => Buffer.from(bytes).reverse().toString(),
};

test('a secret is kept encrypted in the config folder, reaches its agent\'s run, and never settings.json or a log', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc();
  const settingsDir = await fakeConfig({ agents: { fake: { model: 'small' } } });
  await writeFile(join(settingsDir, 'agents', 'fake.json'), JSON.stringify({ name: 'Fake', settings: [
    { key: 'model', type: 'text', label: 'Model', default: '' },
    { key: 'key', type: 'secret', label: 'API key' },
  ] }));
  assert.deepEqual(await readSecrets(cipher, settingsDir), {}, 'none yet');
  await writeSecrets(cipher, { fake: { key: 'sk-fake-123' }, other: { key: 'sk-other-456' } }, settingsDir);
  const secrets = await readSecrets(cipher, settingsDir);
  assert.deepEqual(secrets, { fake: { key: 'sk-fake-123' }, other: { key: 'sk-other-456' } });
  assert.deepEqual(secretTails(secrets), { fake: { key: '-123' }, other: { key: '-456' } }, 'Settings learns only their last 4 characters');
  const { doc, call } = await openTestDoc(docPath, { settingsDir, secrets: () => secrets });
  try {
    assert.deepEqual((await call('scripts')).secrets, { fake: { key: '-123' }, other: { key: '-456' } });
    const id = (await call('comment', { anchor: null, body: '@Clippy say done' })).id;
    await until(async () => (await call('state')).threads.find((t) => t.id === id).comments.length === 2, 'the reply');
    const [run] = await fakeRuns(settingsDir);
    assert.deepEqual(run.settings, { PONJO_SETTING_MODEL: 'small', PONJO_SETTING_KEY: 'sk-fake-123' }, 'its own agent\'s only');
  } finally {
    await doc.close();
  }
  const written = async (dir) => (await Promise.all((await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name !== 'runs.log').map((e) => readFile(join(e.parentPath, e.name), 'utf8')))).join('\n');
  assert.ok((await readdir(settingsDir)).includes('secrets.bin'));
  assert.doesNotMatch(await written(settingsDir), /sk-fake|sk-other/, 'not in settings.json, the runs\' log or any other file of the config folder');
});

test('the shipped scripts pass the project folder only when there is one', () => {
  for (const name of ['claude', 'codex', 'ponjo']) assert.match(readFileSync(join(ROOT, 'agents', `${name}.cmd`), 'utf8'), /\r\n/, `${name}.cmd has Windows line ends`);
  assert.match(readFileSync(join(ROOT, 'agents', 'claude.cmd'), 'utf8'), /set ADD=--add-dir "%PONJO_PROJECT%" --disallowedTools "Edit\(\/%P%\/\*\*\)"/, 'claude.cmd keeps the project read only');
  assert.doesNotMatch(readFileSync(join(ROOT, 'agents', 'codex.cmd'), 'utf8'), /codex exec[^\r]*--add-dir/, 'Codex reads the project without it');
  if (process.platform === 'win32') return;
  // A fake `claude` and `codex` on PATH read the prompt (else writing it can
  // fail with EPIPE) and print the arguments they get.
  const bin = execFileSync('mktemp', ['-d']).toString().trim();
  execFileSync('sh', ['-c', `printf '#!/bin/sh\\ncat >/dev/null; echo "$@"\\n' > "${bin}/claude"; printf '#!/bin/sh\\ncat >/dev/null; while [ "$1" != "--output-last-message" ]; do shift; done; echo reply > "$2"\\n' > "${bin}/codex"; chmod +x "${bin}/claude" "${bin}/codex"`]);
  const run = (name, project, model = '') => execFileSync(join(ROOT, 'agents', name), { input: 'prompt', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PONJO_PROJECT: project, PONJO_DOC: '/run/my doc.md', PONJO_SETTING_MODEL: model }, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  assert.equal(run('claude', ''), '-p @"/run/my doc.md" --permission-mode acceptEdits --no-session-persistence', 'Claude gets the doc copy as already read');
  assert.equal(run('claude', '/work/my project'), '-p @"/run/my doc.md" --permission-mode acceptEdits --no-session-persistence --add-dir /work/my project --disallowedTools Edit(//work/my project/**)', 'the project is read only');
  assert.equal(run('claude', '', 'opus'), '-p @"/run/my doc.md" --permission-mode acceptEdits --no-session-persistence --model opus', 'the model, when set');
  assert.equal(run('codex', ''), 'reply', 'codex prints only its last message');
});

test('the shipped agents are written when missing, then updated until edited; Reset writes one again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-agents-'));
  await installAgents(dir, { platform: 'linux' });
  await installAgents(dir, { platform: 'win32' });
  const ids = async (platform) => (await listAgents(dir, platform)).map((a) => a.id);
  assert.deepEqual([await ids('linux'), await ids('win32')], [['claude', 'codex', 'ponjo'], ['claude', 'codex', 'ponjo']]);
  assert.deepEqual((await listAgents(dir, 'linux')).map((a) => [a.name, a.settings.map((f) => `${f.key}:${f.type}`).join()]), [
    ['Claude Code', 'model:text'], ['Codex', 'model:text'], ['Ponjo agent', 'provider:choice,endpoint:text,model:text,key:secret,effort:choice'],
  ], 'each with its manifest, all valid');
  const windows = await mkdtemp(join(tmpdir(), 'ponjo-agents-'));
  await installAgents(windows, { platform: 'win32' });
  assert.deepEqual((await readdir(agentsDir(windows))).sort(), ['.shipped.json', 'claude.cmd', 'claude.json', 'codex.cmd', 'codex.json', 'ponjo.cmd', 'ponjo.json', 'ponjo.mjs'], 'with the program the Ponjo agent runs, and what was written');
  await writeFile(join(agentsDir(dir), 'mine'), '#!/bin/sh\n');
  await writeFile(join(agentsDir(dir), 'broken'), '#!/bin/sh\n');
  await writeFile(join(agentsDir(dir), 'broken.json'), '{ "name": ');
  assert.deepEqual((await listAgents(dir, 'linux')).filter((a) => ['broken', 'mine'].includes(a.id)), [
    { id: 'broken', name: 'broken', about: '', settings: [] }, { id: 'mine', name: 'mine', about: '', settings: [] },
  ], 'without a manifest, or with one that is not JSON, an agent is its file name');
  const manifest = join(agentsDir(dir), 'claude.json');
  await writeFile(manifest, '{}');
  await installAgents(dir, { platform: 'linux', reset: 'claude' });
  assert.equal(await readFile(manifest, 'utf8'), await readFile(join(ROOT, 'agents', 'claude.json'), 'utf8'), 'Reset writes the manifest too');
  const claude = agentScript('claude', dir, 'linux');
  assert.equal(basename(agentScript('claude', dir, 'win32')), 'claude.cmd');
  await writeFile(claude, '#!/bin/sh\necho mine\n');
  await installAgents(dir, { platform: 'linux' });
  assert.equal(await readFile(claude, 'utf8'), '#!/bin/sh\necho mine\n', 'yours once edited');
  // As written by an older version: the record says so, and it was not edited.
  const codex = agentScript('codex', dir, 'linux');
  const written = join(agentsDir(dir), '.shipped.json');
  await writeFile(codex, '#!/bin/sh\necho old\n');
  await writeFile(written, JSON.stringify({ ...JSON.parse(await readFile(written, 'utf8')), codex: createHash('sha256').update('#!/bin/sh\necho old\n').digest('hex') }));
  await installAgents(dir, { platform: 'linux' });
  assert.equal(await readFile(codex, 'utf8'), await readFile(join(ROOT, 'agents', 'codex'), 'utf8'), 'an unedited older version is replaced');
  await installAgents(dir, { platform: 'linux', reset: 'claude' });
  assert.equal(await readFile(claude, 'utf8'), await readFile(join(ROOT, 'agents', 'claude'), 'utf8'));
});

test('the prompt tells a buddy who the other members are, as the app shows them', () => {
  const thread = { id: 'c_thread01', anchor: null, comments: [{ by: { name: 'fzhan', kind: 'human' }, body: 'hi' }] };
  const buddies = [{ id: 'b_ada', name: 'Ada', about: 'Edits for tone.' }, { id: 'b_bo', name: 'Bo', about: '' }, { id: 'b_cy', name: 'Cy', about: 'Checks facts.' }];
  const prompt = buildPrompt({ buddy: buddies[0], buddies, docName: 'a.md', thread });
  assert.match(prompt, /The other members of the doc:\n\nBo\n\nCy: Checks facts\./);
  assert.doesNotMatch(prompt, /Ada: /, 'not itself');
  const withUser = buildPrompt({ buddy: buddies[0], buddies, docName: 'a.md', thread, human: { name: 'fzhan', about: 'I write novels.' } });
  assert.match(withUser, /The other members of the doc:\n\nfzhan \(owner\): I write novels\.\n\nBo/);
  assert.match(withUser, /Resolve this thread only when the last comment asks you to: append \{"thread":"c_thread01","resolved":true\}/);
  assert.doesNotMatch(prompt, /I write novels/, 'nothing about an owner who wrote nothing');
});
