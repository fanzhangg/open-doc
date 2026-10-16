// Doc Watcher: agents that see every change to the doc, with who made it,
// and act on their own (src/server/agents/dispatcher.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/server.js';
import { buildPrompt, customAdapter } from '../src/server/agents/adapters.js';
import { MAX_RELAYS } from '../src/server/agents/dispatcher.js';
import { editAgents, updateSettings } from '../src/store/settings.js';
import { sidecarPath } from '../src/store/files.js';
import { tempDoc } from './helpers.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.js');
const SETTLE_MS = 300;
const command = (mode, runLog) => `"${process.execPath}" "${FAKE}" {threadsFile} ${mode} "${runLog}"`;

// A server for a doc whose agent `claude` (from flags) runs the fake agent in
// `mode`; `scorer` (a mode) adds a second agent, Scorer, from the settings.
async function withWatcher({ mode = 'watch', watch = true, scorer = null }, fn) {
  const docPath = await tempDoc();
  const runLog = join(dirname(docPath), 'runs.log');
  await writeFile(runLog, '');
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  await updateSettings({ name: 'fzhan' }, settingsDir);
  if (scorer) {
    await editAgents(() => [{
      id: 'a_scorer01', name: 'Scorer', starred: true, crew: true, runtime: 'custom', command: command(scorer, runLog), editMode: 'auto', watchDoc: true,
    }], settingsDir);
  }
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const agent = { name: 'claude', adapter: customAdapter(command(mode, runLog)), editMode: 'auto', watch };
  const server = await startServer(docPath, { assetsDir, settingsDir, agent, agentFromSettings: Boolean(scorer), watchSettleMs: SETTLE_MS });
  const log = async () => (await readFile(runLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  try {
    await until(() => server.team.statuses().length === (scorer ? 2 : 1) && server.team.statuses().every((s) => s.state === 'ready'), { what: 'agents ready' });
    await fn({
      server,
      docPath,
      runs: async () => (await log()).filter((entry) => entry.threads),
      sidecar: async () => JSON.parse(await readFile(sidecarPath(docPath), 'utf8')),
      // The human types in the editor: the page saves the doc.
      save: async (edit) => {
        const state = (await call(server, 'GET', '/api/state')).body;
        const res = await call(server, 'PUT', '/api/doc', { body: { markdown: edit(state.markdown), baseHash: state.docHash } });
        assert.equal(res.status, 200);
      },
      idle: () => until(() => server.team.statuses().every((s) => s.state === 'ready' && s.threads === 0), { what: 'idle' }),
    });
  } finally {
    await server.close();
  }
}

function call(server, method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      method,
      path,
      headers: { host: `127.0.0.1:${server.port}`, 'x-opendoc-token': server.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function until(check, { timeout = 15_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a Doc Watcher runs once the human pauses, handed what changed and who changed it', { timeout: 30_000 }, async () => {
  await withWatcher({}, async ({ runs, save }) => {
    await save((md) => md.replace('six features', 'five features'));
    await save((md) => md.replace('`sync` service', '`sync` server'));
    const [run] = await until(async () => (await runs()).length > 0 && runs(), { what: 'a watch run' });
    assert.deepEqual(run.threads, [], 'no comment asked for it');
    assert.equal(run.changes.length, 1, 'one author in a row is one change');
    assert.equal(run.changes[0].by, 'fzhan');
    assert.equal(run.changes[0].kind, 'human');
    assert.deepEqual(run.changes[0].edits.map((e) => [e.before, e.after]), [['six', 'five'], ['service', 'server']]);
    await sleep(SETTLE_MS * 4);
    assert.equal((await runs()).length, 1, 'nothing new: no second run');
  });
});

test('without Doc Watcher, changing the doc runs no one', { timeout: 30_000 }, async () => {
  await withWatcher({ watch: false }, async ({ runs, save, server }) => {
    assert.equal(server.team.statuses()[0].watch, false);
    await save((md) => md.replace('six features', 'five features'));
    await sleep(SETTLE_MS * 4);
    assert.equal((await runs()).length, 0);
  });
});

test('a watcher reports its edit in a comment of its own, which holds the edit, and its edit does not wake it', { timeout: 30_000 }, async () => {
  await withWatcher({ mode: 'watch-edit' }, async ({ runs, save, sidecar, idle }) => {
    await save((md) => md.replace('six features', 'five features'));
    await until(async () => (await runs()).length === 1, { what: 'a watch run' });
    await idle();
    const [thread] = (await sidecar()).threads;
    assert.equal(thread.anchor.exact, 'Seen by claude 1');
    const [comment] = thread.messages;
    assert.equal(comment.author.name, 'claude');
    assert.equal(comment.body, 'Noted the change');
    assert.deepEqual(comment.edits.map((e) => e.after.trim()), ['Seen by claude 1']);
    await sleep(SETTLE_MS * 4);
    assert.equal((await runs()).length, 1, 'its own edit does not wake it');
  });
});

test('a watcher that edits without a word gets a comment holding its edit', { timeout: 30_000 }, async () => {
  await withWatcher({ mode: 'watch-edit-silent' }, async ({ runs, save, sidecar, idle }) => {
    await save((md) => md.replace('six features', 'five features'));
    await until(async () => (await runs()).length === 1, { what: 'a watch run' });
    await idle();
    const [thread] = (await sidecar()).threads;
    assert.equal(thread.messages.length, 1);
    assert.equal(thread.messages[0].body, 'Edited the doc.');
    assert.match(thread.anchor.exact, /Seen by claude 1/);
    assert.deepEqual(thread.messages[0].edits.map((e) => e.after.trim()), ['Seen by claude 1']);
  });
});

test('watchers set each other off, up to a limit; the human changing the doc lets them go again', { timeout: 60_000 }, async () => {
  await withWatcher({ mode: 'watch-edit', scorer: 'watch-edit' }, async ({ server, runs, save, idle }) => {
    await save((md) => md.replace('six features', 'five features'));
    // Both see the human's change; after that, each edit sets the other off.
    await until(async () => (await runs()).length >= 2 + MAX_RELAYS, { what: 'the relay' });
    await idle();
    await sleep(SETTLE_MS * 4);
    const first = await runs();
    assert.equal(first.length, 2 + MAX_RELAYS, 'they stop at the limit');
    assert.equal(server.team.floor.relays, MAX_RELAYS);
    assert.deepEqual(new Set(first.map((r) => r.as)), new Set(['claude', 'Scorer']));
    const relayed = first.slice(2);
    assert.ok(relayed.every((r) => r.changes.every((c) => c.kind === 'agent')), 'set off by agents alone');
    assert.ok(relayed.every((r) => r.changes.every((c) => c.by !== r.as)), 'never by its own change');

    await save((md) => md.replace('beta cohort', 'beta group'));
    await until(async () => (await runs()).length > first.length, { what: 'a run after the human' });
    const next = (await runs())[first.length];
    assert.ok(next.changes.some((c) => c.kind === 'human' && c.by === 'fzhan'));
  });
});

test('the prompt: the human by name, and for a watch run what to do with the changes', () => {
  const base = { name: 'Scorer', docFile: 'plan.md', persona: 'keeps score' };
  const asked = buildPrompt({ ...base, human: 'fzhan' });
  assert.match(asked, /with a human, fzhan,/);
  assert.match(asked, /"I", "me" or "my" .* is fzhan/);
  assert.doesNotMatch(asked, /You watch this doc/);
  assert.match(asked, /Stop when every thread has a reply/);

  const watching = buildPrompt({ ...base, asked: false, watching: true });
  assert.match(watching, /You watch this doc\. `changes` in the JSON/);
  assert.match(watching, /Most changes need nothing from you/);
  assert.match(watching, /opendoc comment plan\.md --quote/);
  assert.match(watching, /No comment waits on you this time/);
  assert.doesNotMatch(watching, /Handle exactly those threads/);
  assert.match(watching, /Stop when you are done\./);
  assert.doesNotMatch(watching, /with a human,/, 'no name, no claim');

  assert.match(buildPrompt({ ...base, editMode: 'approve', watching: true }), /do not edit the doc: start a comment .* then propose the change on that thread/);
  assert.match(buildPrompt({ ...base, editMode: 'none', watching: true }), /do not edit the doc or propose changes: start a comment/);
  assert.match(buildPrompt({ ...base, watching: true }), /Handle exactly those threads/, 'asked and watching at once');
});
