import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/server.js';
import { CODEX_DENIED_GLOBS, DENIED_READS, SKILL_PATH, agentEnv, buildPrompt, claudeAdapter, codexAdapter, codexPermissions, customAdapter, findCodex, privateWorkdir, rulePath, splitCommand, userCodexConfig } from '../src/server/agents/adapters.js';
import { main, waitForInbox } from '../src/cli/main.js';
import { revertEdits } from '../src/core/diff.js';

import { sidecarPath } from '../src/store/files.js';
import { SAMPLE, tempDoc } from './helpers.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.js');
const quiet = { stdout: { write() {} }, stderr: { write() {} }, env: {} };
const human = ['--as', 'fzhan', '--kind', 'human'];

async function withAgent(mode, fn, limits = {}, { editMode = 'auto', workdir = null, prepare = null } = {}) {
  const docPath = await tempDoc();
  const runLog = join(dirname(docPath), 'runs.log');
  await writeFile(runLog, '');
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const adapter = customAdapter(`"${process.execPath}" "${FAKE}" {threadsFile} ${mode} "${runLog}"`);
  if (workdir) adapter.workdir = () => workdir;
  if (prepare) adapter.prepare = prepare;
  const statuses = [];
  const log = async () => (await readFile(runLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter, limits, editMode } });
  const dispatcher = server.team.get('claude');
  dispatcher.onStatus = (s) => statuses.push(s.state);
  try {
    await fn({
      docPath,
      dispatcher,
      statuses,
      runs: async () => (await log()).filter((entry) => entry.threads),
      log,
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

test('a run kept to the doc starts in its own folder and names the doc by absolute path', { timeout: 30_000 }, async () => {
  const workdir = join(await mkdtemp(join(tmpdir(), 'opendoc-workdir-')), 'not-yet');
  const prepared = [];
  const prepare = async (options) => { prepared.push({ ...options, made: existsSync(options.workdir) }); };
  await withAgent('reply', async ({ docPath, runs, sidecar, comment }) => {
    await comment('--quote', 'extra load', '@claude quantify this');
    await until(async () => replies((await sidecar()).threads[0]).length === 1, { what: 'a reply' });
    const [run] = await runs();
    assert.equal(run.cwd.toLowerCase(), workdir.toLowerCase(), 'the folder is made if missing');
    assert.equal(run.doc, docPath.replaceAll('\\', '/'));
    // The adapter readies the folder before each run, once it exists.
    assert.deepEqual(prepared, [{ workdir, docPath, editMode: 'auto', made: true }]);
  }, {}, { workdir, prepare });
});

test('a comment that mentions no one launches a run, and so does a follow-up', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ comment, reply, sidecar }) => {
    await comment('--quote', 'extra load', 'Tighten this.');
    await until(async () => replies((await sidecar()).threads[0]).length === 1, { what: 'a reply' });
    await reply((await sidecar()).threads[0].id, 'Shorter, please.');
    await until(async () => replies((await sidecar()).threads[0]).length === 2, { what: 'a second reply' });
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

test('an agent that edits the doc replies and leaves the thread open for the human', { timeout: 30_000 }, async () => {
  await withAgent('edit', async ({ docPath, dispatcher, sidecar, comment, log }) => {
    await comment('--quote', 'extra load', '@claude add "peak"');
    await until(async () => (await log()).some((entry) => 'resolveRefused' in entry), { what: 'the resolve attempt' });
    await until(() => dispatcher.status().state === 'ready', { what: 'run finished' });
    const s = await sidecar();
    assert.equal(s.threads[0].status, 'open');
    assert.equal(s.threads[0].messages.at(-1).author.name, 'claude', 'its reply is the latest message');
    assert.ok((await log()).find((entry) => 'resolveRefused' in entry).resolveRefused, 'the CLI refused to let it resolve');
    assert.match(await readFile(docPath, 'utf8'), /extra peak load/);
    assert.equal(s.threads[0].anchor.exact, 'extra peak load');
  });
});

test('in approve mode the run proposes instead of editing; the doc is unchanged', { timeout: 30_000 }, async () => {
  await withAgent('propose', async ({ docPath, dispatcher, sidecar, comment }) => {
    assert.equal(dispatcher.status().editMode, 'approve');
    await comment('--quote', 'extra load', '@claude add "peak"');
    const s = await until(async () => {
      const current = await sidecar();
      return replies(current.threads[0]).length === 1 && current;
    }, { what: 'a proposal' });
    const [reply] = replies(s.threads[0]);
    assert.deepEqual(reply.proposal.map((c) => [c.before, c.after]), [['extra load', 'extra peak load']]);
    assert.equal(reply.edits, undefined);
    assert.equal(s.threads[0].status, 'open');
    assert.equal(await readFile(docPath, 'utf8'), SAMPLE);
  }, {}, { editMode: 'approve' });
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
    assert.ok(s.threads.every((t) => t.status === 'open' && replies(t).length === 1));
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

test('a run that ends without replying counts as failed and is not repeated', { timeout: 30_000 }, async () => {
  await withAgent('silent', async ({ dispatcher, runs, sidecar, comment }) => {
    await comment('--quote', 'extra load', '@claude quantify this');
    await until(() => dispatcher.status().state === 'error', { what: 'error state' });
    assert.match(dispatcher.status().error, /finished without replying to a comment/);
    assert.equal(dispatcher.status().lastRun.ok, false);
    assert.equal((await sidecar()).threads[0].working, null);
    await sleep(1200);
    assert.equal((await runs()).length, 1, 'no automatic relaunch');
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

test('do not disturb answers only @mentions; back online, the rest is answered', { timeout: 30_000 }, async () => {
  await withAgent('reply', async ({ dispatcher, runs, comment, sidecar }) => {
    await until(() => dispatcher.status().state === 'ready', { what: 'ready' });
    dispatcher.setPresence('dnd');
    assert.equal(dispatcher.status().presence, 'dnd');
    await comment('A note while it is on do not disturb');
    await sleep(1200);
    assert.deepEqual(await runs(), []);
    await comment('@claude this one, please');
    await until(async () => (await runs()).length === 1, { what: 'a run for the mention' });
    assert.equal((await runs())[0].threads.length, 1);
    dispatcher.setPresence('online');
    await until(async () => (await sidecar()).threads.every((t) => replies(t).length === 1), { what: 'the note answered' });
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
  const docPath = join(tmpdir(), 'docs', 'plan.md');
  const { command, args } = adapter.command({ prompt: 'PROMPT', docFile: 'plan.md', docPath, sessionId: 'abc' });
  assert.equal(command, 'claude');
  assert.deepEqual(args.slice(0, 2), ['-p', 'PROMPT']);
  assert.ok(args.includes('dontAsk'));
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'abc']);
  // Kept to the doc by default: one file, by absolute path, from a private folder.
  assert.equal(adapter.workdir(docPath), privateWorkdir(docPath));
  assert.notEqual(privateWorkdir(docPath), dirname(docPath));
  const doc = rulePath(docPath);
  assert.match(doc, /^\/\/[^/]/);
  assert.doesNotMatch(doc, /[\\:]/);
  const kept = adapter.command({ prompt: 'PROMPT', docFile: 'plan.md', docPath }).args;
  assert.deepEqual(kept.slice(kept.indexOf('--allowedTools') + 1), [`Read(${doc})`, `Edit(${doc})`, 'Bash(opendoc *)', 'PowerShell(opendoc *)']);
  assert.ok(!kept.some((a) => a.startsWith('Web')));
  const deny = args.indexOf('--disallowedTools');
  assert.deepEqual(args.slice(deny + 1, deny + 1 + DENIED_READS.length), DENIED_READS);
  assert.ok(DENIED_READS.includes('Read(//**/.env*)'));
  assert.ok(!args.includes('--bare'));

  // Each switch on its own. The web: still only the doc, from the private folder.
  const allowed = (options) => {
    const a = claudeAdapter({ bin: 'claude', ...options }).command({ prompt: 'PROMPT', docFile: 'plan.md', docPath }).args;
    return a.slice(a.indexOf('--allowedTools') + 1);
  };
  assert.equal(claudeAdapter({ bin: 'claude', webAccess: true }).workdir(docPath), privateWorkdir(docPath));
  assert.deepEqual(allowed({ webAccess: true }), [`Read(${doc})`, `Edit(${doc})`, 'WebSearch', 'WebFetch', 'Bash(opendoc *)', 'PowerShell(opendoc *)']);
  // Other files: any file (but the denied ones), from the doc's folder, no web.
  assert.equal(claudeAdapter({ bin: 'claude', fileAccess: true }).workdir(docPath), null);
  assert.deepEqual(allowed({ fileAccess: true }), ['Read', 'Edit(./plan.md)', 'Bash(opendoc *)', 'PowerShell(opendoc *)']);
  assert.deepEqual(allowed({ webAccess: true, fileAccess: true }), ['Read', 'Edit(./plan.md)', 'WebSearch', 'WebFetch', 'Bash(opendoc *)', 'PowerShell(opendoc *)']);

  // Approve mode: the doc is not editable; the prompt asks for proposals.
  const approve = adapter.command({ prompt: 'PROMPT', docFile: 'plan.md', docPath, editMode: 'approve' }).args;
  assert.deepEqual(approve.slice(approve.indexOf('--allowedTools') + 1), [`Read(${doc})`, 'Bash(opendoc *)', 'PowerShell(opendoc *)']);
  assert.ok(!approve.some((a) => a.startsWith('Edit')));
  const approvePrompt = buildPrompt({ name: 'claude', docFile: 'plan.md', editMode: 'approve' });
  assert.match(approvePrompt, /opendoc propose plan\.md <thread-id> --as claude/);
  assert.match(approvePrompt, /do not edit it/);
  const absolute = buildPrompt({ name: 'claude', docFile: 'C:/My Docs/plan.md' });
  assert.match(absolute, /opendoc reply "C:\/My Docs\/plan\.md" <thread-id>/);
  assert.doesNotMatch(absolute, /working directory/);
  for (const prompt of [approvePrompt, buildPrompt({ name: 'claude', docFile: 'plan.md' })]) {
    assert.doesNotMatch(prompt, /opendoc resolve/);
    assert.match(prompt, /Never resolve a thread/);
  }

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

test('Codex adapter: command line and result parsing', async () => {
  const noConfig = await mkdtemp(join(tmpdir(), 'opendoc-codex-home-'));
  const adapter = codexAdapter({ bin: 'codex', agentName: 'codex', model: 'gpt-5', codexHome: noConfig });
  const docPath = join(tmpdir(), 'docs', 'plan.md');
  const { command, args } = adapter.command({ prompt: 'PROMPT', docFile: 'plan.md', docPath, editMode: 'auto' });
  assert.equal(command, 'codex');
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--skip-git-repo-check'));
  // The user's config.toml stays out (a sandbox_mode there would switch the
  // permission profile off), and so do the legacy sandbox flags. No prompts.
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(!args.includes('--sandbox') && !args.includes('--add-dir'));
  assert.ok(!args.some((a) => /^sandbox_/.test(a)));
  assert.ok(args.includes('approval_policy="never"'));
  // The profile is in the private folder's project config, trusted here.
  assert.ok(args.includes('default_permissions="opendoc"'));
  assert.ok(args.includes(`projects={ ${JSON.stringify(privateWorkdir(docPath, 'codex'))} = { "trust_level" = "trusted" } }`));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(codexAdapter({ bin: 'codex', webAccess: true, codexHome: noConfig }).command({ prompt: 'P', docPath }).args.includes('web_search="live"'));
  assert.equal(adapter.workdir(docPath), privateWorkdir(docPath, 'codex'));
  // The skill rides along as developer instructions, a TOML string.
  const skill = args.find((a) => a.startsWith('developer_instructions='));
  assert.equal(JSON.parse(skill.slice('developer_instructions='.length)), await readFile(SKILL_PATH, 'utf8'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-5']);
  assert.equal(args.at(-1), 'PROMPT');
  assert.ok(!args.includes('resume'));
  // Resuming: every flag comes before `resume <id> <prompt>`.
  const resumed = adapter.command({ prompt: 'PROMPT', docFile: 'plan.md', docPath, sessionId: 'thread-1' }).args;
  assert.deepEqual(resumed.slice(-3), ['resume', 'thread-1', 'PROMPT']);
  assert.deepEqual(resumed.slice(0, -3), args.slice(0, -1));

  const lines = (...events) => events.map((e) => JSON.stringify(e)).join('\n');
  const ok = adapter.parse({
    stdout: lines(
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      { type: 'error', message: 'Reconnecting... 1/5' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Done.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ),
    stderr: '',
    code: 0,
  });
  assert.deepEqual(ok, { ok: true, error: null, sessionId: 't1' });
  const failed = adapter.parse({ stdout: lines({ type: 'thread.started', thread_id: 't2' }, { type: 'turn.failed', error: { message: 'usage limit reached' } }), stderr: '', code: 1 });
  assert.deepEqual(failed, { ok: false, error: 'usage limit reached', sessionId: 't2' });
  const errored = adapter.parse({ stdout: lines({ type: 'thread.started', thread_id: 't3' }, { type: 'error', message: 'stream disconnected' }), stderr: '', code: 1 });
  assert.equal(errored.error, 'stream disconnected');
  const none = adapter.parse({ stdout: 'not json', stderr: 'boom', code: 2 });
  assert.equal(none.ok, false);
  assert.match(none.error, /exited with code 2 and no result: boom/);
});

test('Codex permissions: in the doc folder only the doc and its sidecar; secrets denied above it', async () => {
  const home = join(tmpdir(), 'home');
  const folder = join(tmpdir(), 'work', 'docs');
  const docPath = join(folder, 'plan.md');
  const siblings = ['plan.md', 'plan.md.opendoc.json', 'plan.md.opendoc.json.lock', 'secret.txt', '.env', 'drafts'];
  const table = codexPermissions(docPath, { siblings, home });
  assert.equal(table[':root'], 'read', "Codex's elevated Windows sandbox needs the whole disk readable");
  // The folder is writable so the sandboxed `opendoc reply` can make the
  // sidecar's lock and temp files; every other file there is denied.
  assert.deepEqual(table[folder], {
    '.': 'write',
    '.env': 'deny',
    drafts: 'deny',
    'secret.txt': 'deny',
    'plan.md': 'write',
    'plan.md.opendoc.json': 'read',
  });
  assert.equal(codexPermissions(docPath, { siblings, home, editMode: 'approve' })[folder]['plan.md'], 'read', 'approve mode: the doc is read-only');
  for (const dir of [join(tmpdir(), 'work'), tmpdir(), join(tmpdir(), '..')]) {
    assert.deepEqual(Object.keys(table[resolve(dir)] ?? {}), CODEX_DENIED_GLOBS, `secrets denied in ${dir}`);
  }
  for (const dir of ['.ssh', '.aws', '.codex']) assert.equal(table[join(home, dir)], 'deny');
  assert.equal(codexPermissions(docPath, { home, codexHome: join(tmpdir(), 'codex') })[join(tmpdir(), 'codex')], 'deny');

  // prepare writes it to the private folder's project config, where the run's -c names it.
  const doc = await tempDoc();
  await writeFile(join(dirname(doc), 'secret.txt'), 'x');
  const workdir = await mkdtemp(join(tmpdir(), 'opendoc-codex-run-'));
  await codexAdapter({ bin: 'codex' }).prepare({ workdir, docPath: doc, editMode: 'approve' });
  const config = await readFile(join(workdir, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /^\[permissions\.opendoc\.filesystem\]$/m);
  assert.match(config, /^\[permissions\.opendoc\.network\]\nenabled = false$/m);
  const line = config.split('\n').find((l) => l.startsWith(JSON.stringify(dirname(doc))));
  assert.ok(line.includes('"secret.txt" = "deny"'));
  assert.ok(line.includes(`${JSON.stringify(basename(doc))} = "read"`));
});

test("Codex runs keep only the model and Windows sandbox of the user's config", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'opendoc-codex-home-'));
  const docPath = join(tmpdir(), 'docs', 'plan.md');
  await writeFile(join(codexHome, 'config.toml'), [
    'model = "gpt-6"',
    'sandbox_mode = "danger-full-access"',
    '[mcp_servers.repl]',
    'command = "repl.exe"',
    '[windows]',
    "sandbox = 'elevated' # set up once",
    '',
  ].join('\r\n'));
  assert.deepEqual(userCodexConfig(codexHome), { model: 'gpt-6', windowsSandbox: 'elevated' });
  const args = codexAdapter({ bin: 'codex', codexHome }).command({ prompt: 'P', docPath }).args;
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-6']);
  assert.ok(args.includes('windows.sandbox="elevated"'));
  assert.ok(!args.some((a) => a.includes('danger-full-access') || a.includes('repl.exe')));
  // The agent's own model wins; a model of another provider is not carried over.
  const own = codexAdapter({ bin: 'codex', codexHome, model: 'gpt-5' }).command({ prompt: 'P', docPath }).args;
  assert.equal(own[own.indexOf('--model') + 1], 'gpt-5');
  await writeFile(join(codexHome, 'config.toml'), 'model = "llama3"\nmodel_provider = "ollama"\n');
  assert.deepEqual(userCodexConfig(codexHome), {});
  assert.deepEqual(userCodexConfig(join(tmpdir(), 'no-such-codex-home')), {});
});

test('Codex preflight: says why when Codex is missing, cannot run or is signed out', async () => {
  const saved = { PATH: process.env.PATH, CODEX_API_KEY: process.env.CODEX_API_KEY };
  delete process.env.CODEX_API_KEY;
  try {
    process.env.PATH = await mkdtemp(join(tmpdir(), 'opendoc-nopath-'));
    assert.equal(findCodex(), null);
    const missing = await codexAdapter().preflight();
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Codex was not found; install it/);
    process.env.PATH = saved.PATH;
    const broken = await codexAdapter({ bin: join(tmpdir(), 'definitely-not-codex.exe') }).preflight();
    assert.match(broken.error, /could not run/);
    // Exiting 1 for `login status` (node finds no "login" script) is how a signed-out Codex answers.
    const signedOut = await codexAdapter({ bin: process.execPath }).preflight();
    assert.equal(signedOut.ok, false);
    assert.match(signedOut.error, /Codex is not signed in; run "codex login"/);
    process.env.CODEX_API_KEY = 'test-key';
    assert.equal((await codexAdapter({ bin: process.execPath }).preflight()).ok, true);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.CODEX_API_KEY === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = saved.CODEX_API_KEY;
  }
});

test('an unavailable agent does not launch and says why', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const adapter = claudeAdapter({ bin: join(tmpdir(), 'definitely-not-claude.exe') });
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter } });
  try {
    assert.equal(server.team.get('claude').status().state, 'unavailable');
    assert.match(server.team.get('claude').status().error, /could not run/);
  } finally {
    await server.close();
  }
});

test('the guard: a hook on Edit when the run may edit, and the prompt names the paragraph being typed in', () => {
  const docPath = join(tmpdir(), 'plan.md');
  const args = (options) => claudeAdapter({ bin: 'claude' }).command({ prompt: 'PROMPT', docFile: 'plan.md', docPath, ...options }).args;
  const settings = (list) => (list.includes('--settings') ? JSON.parse(list[list.indexOf('--settings') + 1]) : null);
  assert.deepEqual(settings(args({ guard: true })), { hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'opendoc guard', timeout: 10 }] }] } });
  assert.equal(settings(args({ guard: true, editMode: 'approve' })), null, 'nothing to guard when the run cannot edit');
  assert.equal(settings(args({})), null);

  assert.match(buildPrompt({ name: 'claude', docFile: 'plan.md', typing: 'The main risk is' }), /typing in the paragraph that starts "The main risk is"/);
  assert.doesNotMatch(buildPrompt({ name: 'claude', docFile: 'plan.md' }), /typing in the paragraph/);
});

test('permissions asked at first use: their tools stay out of the allowed ones and a guard hook asks; no guard, no access', () => {
  const docPath = join(tmpdir(), 'plan.md');
  const doc = rulePath(docPath);
  const run = (options, command = {}) => claudeAdapter({ bin: 'claude', ...options }).command({ prompt: 'PROMPT', docFile: 'plan.md', docPath, guard: true, ...command }).args;
  const allowed = (a) => a.slice(a.indexOf('--allowedTools') + 1);
  const hooks = (a) => (a.includes('--settings') ? JSON.parse(a[a.indexOf('--settings') + 1]).hooks.PreToolUse : []);

  const both = run({ asks: ['web', 'files'] });
  assert.deepEqual(allowed(both), [`Read(${doc})`, `Edit(${doc})`, 'Bash(opendoc *)', 'PowerShell(opendoc *)'], 'only the doc is allowed outright');
  assert.deepEqual(hooks(both).map((h) => h.matcher), ['Edit', 'WebSearch|WebFetch|Read|Glob|Grep']);
  assert.ok(hooks(both)[1].hooks[0].timeout > 300, 'the hook outlasts the wait for the human');
  assert.equal(claudeAdapter({ bin: 'claude', asks: ['files'] }).workdir(docPath), privateWorkdir(docPath), 'asking for files still starts in a private folder');

  assert.deepEqual(hooks(run({ asks: ['web'] }, { editMode: 'approve' })).map((h) => h.matcher), ['WebSearch|WebFetch']);
  assert.deepEqual(hooks(run({ asks: ['web'] }, { guard: false })), [], 'without the guard nothing can say yes: the tools stay denied');
  assert.deepEqual(hooks(run({ asks: ['web'], webAccess: true })).map((h) => h.matcher), ['Edit'], 'granted outright (serve flags): nothing to ask');

  const prompt = buildPrompt({ name: 'Merlin', docFile: 'plan.md', asks: ['files'], docFolder: '/home/me/notes' });
  assert.match(prompt, /read the human's other files \(the doc is in \/home\/me\/notes\)/);
  assert.match(prompt, /approves this access the first time you use it/);
  assert.doesNotMatch(buildPrompt({ name: 'Rocky', docFile: 'plan.md' }), /approves this access/);
});
