import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/server.js';
import { DENIED_READS, agentEnv, claudeAdapter, customAdapter, splitCommand } from '../src/server/agents/adapters.js';
import { main, waitForInbox } from '../src/cli/main.js';
import { revertEdits } from '../src/core/diff.js';

import { sidecarPath } from '../src/store/files.js';
import { SAMPLE, tempDoc } from './helpers.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.js');
const quiet = { stdout: { write() {} }, stderr: { write() {} }, env: {} };
const human = ['--as', 'fzhan', '--kind', 'human'];

async function withAgent(mode, fn, limits = {}, { mentionsOnly = false } = {}) {
  const docPath = await tempDoc();
  const runLog = join(dirname(docPath), 'runs.log');
  await writeFile(runLog, '');
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const adapter = customAdapter(`"${process.execPath}" "${FAKE}" {threadsFile} ${mode} "${runLog}"`);
  const statuses = [];
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter, limits, mentionsOnly } });
  server.dispatcher.onStatus = (s) => statuses.push(s.state);
  try {
    await fn({
      docPath,
      dispatcher: server.dispatcher,
      statuses,
      runs: async () => (await readFile(runLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
      sidecar: async () => JSON.parse(await readFile(sidecarPath(docPath), 'utf8')),
      comment: (...args) => main(['comment', docPath, ...args, ...human], quiet),
      reply: (id, body) => main(['reply', docPath, id, body, ...human], quiet),
    });
  } finally {
    await server.close();
  }
}

async function until(check, { timeout = 10_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const replies = (thread) => thread.messages.filter((m) => m.author.name === 'claude');

test('an @mention launches a run that replies, as the agent, in the doc folder', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ docPath, dispatcher, runs, sidecar, comment }) => {
    assert.ok((await sidecar()).participants.some((p) => p.name === 'claude'), 'the agent joins at startup');
    await comment('--quote', 'extra load', '@claude quantify this');
    const s = await until(async () => {
      const current = await sidecar();
      return replies(current.threads[0]).length === 1 && current;
    }, { what: 'a reply' });
    assert.equal(s.threads[0].working, null);
    const [run] = await runs();
    assert.equal(run.as, 'claude');
    assert.equal(run.cwd.toLowerCase(), dirname(docPath).toLowerCase());
    await until(() => dispatcher.status().state === 'ready', { what: 'ready' });
    assert.equal(dispatcher.status().lastRun.ok, true);
  });
});

test('a comment that mentions no one launches a run by default', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ comment, sidecar }) => {
    await comment('--quote', 'extra load', 'Tighten this.');
    await until(async () => replies((await sidecar()).threads[0]).length === 1, { what: 'a reply' });
  });
});

test('a comment addressed to someone else does not launch a run', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ docPath, runs, comment, sidecar }) => {
    // dana joins by commenting; that comment mentions no one, so claude answers it.
    await main(['comment', docPath, 'Joining.', '--as', 'dana', '--kind', 'human'], quiet);
    await until(async () => replies((await sidecar()).threads[0]).length === 1, { what: 'a reply' });
    await comment('@dana can you check this?');
    await sleep(1200);
    const forDana = (await sidecar()).threads[1];
    assert.deepEqual(replies(forDana), []);
    assert.ok((await runs()).every((run) => !run.threads.includes(forDana.id)));
  });
});

test('with mentionsOnly, a comment without a mention does not launch a run', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ runs, comment, dispatcher }) => {
    assert.equal(dispatcher.status().mentionsOnly, true);
    await comment('Note to self: tighten this.');
    await sleep(1200);
    assert.deepEqual(await runs(), []);
  }, {}, { mentionsOnly: true });
});

test('a burst of comments becomes one run', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ runs, comment, sidecar }) => {
    await comment('--quote', 'extra load', '@claude one');
    await comment('--quote', 'gather feedback', '@claude two');
    await comment('@claude three');
    await until(async () => (await sidecar()).threads.every((t) => replies(t).length === 1), { what: 'three replies' });
    const all = await runs();
    assert.equal(all.length, 1);
    assert.equal(all[0].threads.length, 3);
  });
});

test('a comment during a run starts the next run', { timeout: 30_000 }, async () => {
  await withAgent('slow', async ({ runs, comment, sidecar, dispatcher }) => {
    await comment('--quote', 'extra load', '@claude first');
    await until(() => dispatcher.status().state === 'running', { what: 'running' });
    await comment('--quote', 'gather feedback', '@claude second');
    await until(async () => (await sidecar()).threads.every((t) => replies(t).length === 1), { what: 'both replies', timeout: 15_000 });
    const all = await runs();
    assert.equal(all.length, 2);
    assert.equal(all[0].threads.length, 1);
    assert.equal(all[1].threads.length, 1);
    assert.notEqual(all[0].threads[0], all[1].threads[0]);
  });
});

test('an agent that edits the doc and resolves', { timeout: 30_000 }, async () => {
  await withAgent('edit', async ({ docPath, sidecar, comment }) => {
    await comment('--quote', 'extra load', '@claude add "peak"');
    const s = await until(async () => {
      const current = await sidecar();
      return current.threads[0].status === 'resolved' && current;
    }, { what: 'resolved' });
    assert.match(await readFile(docPath, 'utf8'), /extra peak load/);
    assert.equal(s.threads[0].anchor.exact, 'extra peak load');
  });
});

test('the agent reply records what the run changed, and undoing it restores the doc', { timeout: 30_000 }, async () => {
  await withAgent('edit', async ({ docPath, sidecar, comment }) => {
    await comment('--quote', 'extra load', '@claude add "peak"');
    const s = await until(async () => {
      const current = await sidecar();
      return replies(current.threads[0])[0]?.edits && current;
    }, { what: 'recorded edits' });
    const [reply] = replies(s.threads[0]);
    assert.equal(reply.body, 'Handled by fake agent');
    assert.equal(reply.edits.length, 1);
    const [edit] = reply.edits;
    assert.deepEqual({ before: edit.before, after: edit.after, scope: edit.scope }, { before: '', after: 'peak ', scope: undefined });
    const markdown = await readFile(docPath, 'utf8');
    assert.equal(markdown.slice(edit.start - edit.prefix.length, edit.start + edit.after.length + edit.suffix.length), edit.prefix + edit.after + edit.suffix);
    assert.equal(revertEdits(markdown, reply.edits), SAMPLE);
  });
});

test('in a run for several threads, a change goes to the thread whose quote it touches', { timeout: 30_000 }, async () => {
  await withAgent('edit', async ({ runs, sidecar, comment }) => {
    await comment('--quote', 'gather feedback', '@claude one');
    await comment('--quote', 'extra load', '@claude two');
    const s = await until(async () => {
      const current = await sidecar();
      return current.threads.some((t) => replies(t)[0]?.edits) && current;
    }, { what: 'recorded edits' });
    assert.ok(s.threads.every((t) => t.status === 'resolved' && replies(t).length === 1));
    assert.equal((await runs()).length, 1, 'one run handled both');
    const [feedback, load] = s.threads;
    assert.equal(replies(feedback)[0].edits, undefined);
    assert.deepEqual(replies(load)[0].edits.map((e) => [e.before, e.after]), [['', 'peak ']]);
  });
});

test('a failing run clears working, reports the error, and does not loop', { timeout: 30_000 }, async () => {
  await withAgent('fail', async ({ dispatcher, runs, sidecar, comment, reply }) => {
    await comment('--quote', 'extra load', '@claude quantify this');
    await until(() => dispatcher.status().state === 'error', { what: 'error state' });
    assert.match(dispatcher.status().error, /exited with code 1: fake agent: something went wrong/);
    assert.equal((await sidecar()).threads[0].working, null);
    await sleep(1200);
    assert.equal((await runs()).length, 1, 'no automatic relaunch');

    // A new human message is a reason to try again.
    await reply((await sidecar()).threads[0].id, '@claude try again');
    await until(async () => (await runs()).length === 2, { what: 'second run' });
  });
});

test('a hanging run is killed at the timeout', { timeout: 30_000 }, async () => {
  await withAgent('hang', async ({ dispatcher, sidecar, comment }) => {
    await comment('--quote', 'extra load', '@claude quantify this');
    await until(() => dispatcher.status().state === 'error', { what: 'timeout', timeout: 15_000 });
    assert.match(dispatcher.status().error, /timed out/);
    assert.equal((await sidecar()).threads[0].working, null);
  }, { timeoutMs: 1500 });
});

test('pause holds comments; resume handles them', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ dispatcher, runs, comment }) => {
    await until(() => dispatcher.status().state === 'ready', { what: 'ready' });
    dispatcher.pause();
    await comment('@claude while paused');
    await sleep(1200);
    assert.deepEqual(await runs(), []);
    dispatcher.resume();
    await until(async () => (await runs()).length === 1, { what: 'run after resume' });
  });
});

test('runs per hour are limited', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ dispatcher, runs, comment, sidecar }) => {
    await comment('@claude first');
    await until(async () => replies((await sidecar()).threads[0]).length === 1, { what: 'first reply' });
    await comment('@claude second');
    await until(() => dispatcher.status().state === 'limited', { what: 'limited' });
    assert.equal((await runs()).length, 1);
    assert.ok(dispatcher.status().retryAt);
  }, { runsPerHour: 1 });
});

test('a chat session waiting at the same time never double-answers', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ docPath, runs, comment, sidecar }) => {
    const waiting = waitForInbox(docPath, { name: 'claude', kind: 'agent' }, 5000);
    await comment('--quote', 'extra load', '@claude who takes this?');
    const claimedByWait = await waiting;
    await sleep(1500);
    const dispatcherRuns = (await runs()).length;
    assert.equal(Boolean(claimedByWait) + dispatcherRuns, 1, 'exactly one claimer');
    if (!claimedByWait) assert.equal(replies((await sidecar()).threads[0]).length, 1);
  });
});

test('agent runs do not inherit a host Claude Code session', () => {
  const host = { PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDE_AGENT_SDK_VERSION: 'y', CLAUDE_PID: '9', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: 'c' };
  assert.deepEqual(agentEnv(host), { PATH: 'p', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: 'c' });
  const plain = { PATH: 'p', ANTHROPIC_BASE_URL: 'https://gateway.example' };
  assert.deepEqual(agentEnv(plain), plain, 'outside a Claude Code session nothing is removed');
});

test('splitCommand honours quotes', () => {
  assert.deepEqual(splitCommand(`"C:\\Program Files\\node.exe" bot.js --x 'a b' {doc}`), ['C:\\Program Files\\node.exe', 'bot.js', '--x', 'a b', '{doc}']);
  assert.deepEqual(splitCommand('  a   "" b '), ['a', '', 'b']);
});

test('Claude adapter: command line and result parsing', () => {
  const adapter = claudeAdapter({ bin: 'claude', model: 'sonnet', maxTurns: 12, maxBudgetUsd: 0.5 });
  const { command, args } = adapter.command({ prompt: 'PROMPT', docFile: 'plan.md', sessionId: 'abc' });
  assert.equal(command, 'claude');
  assert.deepEqual(args.slice(0, 2), ['-p', 'PROMPT']);
  assert.ok(args.includes('dontAsk'));
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'abc']);
  assert.deepEqual(args.slice(-5), ['--allowedTools', 'Read', 'Edit(./plan.md)', 'Bash(opendoc *)', 'PowerShell(opendoc *)']);
  const deny = args.indexOf('--disallowedTools');
  assert.deepEqual(args.slice(deny + 1, deny + 1 + DENIED_READS.length), DENIED_READS);
  assert.ok(DENIED_READS.includes('Read(//**/.env*)'));
  assert.ok(!args.includes('--bare'));

  const ok = adapter.parse({ stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', total_cost_usd: 0.02, num_turns: 4, permission_denials: [] }), stderr: '', code: 0 });
  assert.deepEqual(ok, { ok: true, error: null, sessionId: 's1', costUsd: 0.02, turns: 4, denials: 0 });
  // Seen in practice: an auth failure reports subtype "success" with is_error true and exit code 0.
  const authFailure = adapter.parse({ stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate', session_id: 's2' }), stderr: '', code: 0 });
  assert.equal(authFailure.ok, false);
  assert.equal(authFailure.error, 'Failed to authenticate');
  const maxTurns = adapter.parse({ stdout: JSON.stringify({ subtype: 'error_max_turns', is_error: true, errors: ['max turns reached'] }), stderr: '', code: 1 });
  assert.equal(maxTurns.error, 'max turns reached');
  assert.equal(adapter.parse({ stdout: 'not json', stderr: 'boom', code: 2 }).ok, false);
});

test('an unavailable agent does not launch and says why', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const adapter = claudeAdapter({ bin: join(tmpdir(), 'definitely-not-claude.exe') });
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter } });
  try {
    assert.equal(server.dispatcher.status().state, 'unavailable');
    assert.match(server.dispatcher.status().error, /could not run/);
  } finally {
    await server.close();
  }
});
