import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/server.js';
import { Floor } from '../src/server/agents/dispatcher.js';
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
    assert.equal(realpathSync(run.cwd).toLowerCase(), realpathSync(dirname(docPath)).toLowerCase());
    await until(() => dispatcher.status().state === 'ready', { what: 'ready' });
    assert.equal(dispatcher.status().lastRun.ok, true);
  });
});

test('a run kept to the doc starts in its own folder and names the doc by absolute path', { timeout: 30_000 }, async () => {
  const workdir = join(await mkdtemp(join(tmpdir(), 'opendoc-workdir-')), 'not-yet');
  const prepared = [];
  const prepare = async (options) => {
    prepared.push({ ...options, made: existsSync(options.workdir), left: readdirSync(options.workdir) });
    writeFileSync(join(options.workdir, 'notes.md'), 'what I learned last time');
  };
  await withAgent('reply', async ({ docPath, runs, sidecar, comment }) => {
    await comment('--quote', 'extra load', '@claude quantify this');
    await until(async () => replies((await sidecar()).threads[0]).length === 1, { what: 'a reply' });
    const [run] = await runs();
    assert.equal(realpathSync(run.cwd).toLowerCase(), realpathSync(workdir).toLowerCase(), 'the folder is made if missing');
    assert.equal(run.doc, docPath.replaceAll('\\', '/'));
    // The adapter readies the folder before each run, once it exists.
    assert.deepEqual(prepared, [{ workdir, docPath, editMode: 'auto', made: true, left: [] }]);
    // Nothing a run leaves in its folder reaches the next run.
    await comment('--quote', 'extra load', '@claude and again');
    await until(async () => prepared.length === 2, { what: 'a second run' });
    assert.deepEqual(prepared[1].left, []);
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

test('with Auto Commenter, an open comment left without a reply is passed on, not failed', { timeout: 30_000 }, async () => {
  await withAgent('silent', async ({ dispatcher, runs, sidecar, comment, reply, log }) => {
    await comment('--quote', 'extra load', 'Not my kind of comment');
    await until(async () => (await sidecar()).threads[0].passed?.length === 1, { what: 'a pass' });
    assert.deepEqual((await sidecar()).threads[0].passed, ['claude']);
    await until(() => dispatcher.status().state === 'ready', { what: 'ready' });
    assert.equal(dispatcher.status().lastRun.ok, true);
    assert.equal((await sidecar()).threads[0].working, null);
    await sleep(1200);
    assert.equal((await runs()).length, 1, 'not handed back');

    // A new ask from the human is open again.
    await reply((await sidecar()).threads[0].id, 'What about now?');
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

// Several agents in one doc, all in it from the start. `guarded`
// makes their program one whose every edit passes the guard's hooks, as
// Claude Code's does.
async function withTeam(names, mode, fn, { editMode = 'auto', guarded = false } = {}) {
  const docPath = await tempDoc();
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  const runLog = join(settingsDir, 'runs.log');
  await writeFile(runLog, '');
  const command = `"${process.execPath}" "${FAKE}" {threadsFile} ${mode} "${runLog}"`;
  const agents = names.map((name, i) => ({ id: `a_team0${i}`, name, starred: true, runtime: 'custom', command, editMode, autoComment: false }));
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agents }));
  const participants = names.map((name) => ({ name, kind: 'agent' }));
  await writeFile(sidecarPath(docPath), JSON.stringify({ opendoc: 1, doc: basename(docPath), docHash: null, threads: [], participants }));
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const server = await startServer(docPath, { assetsDir, settingsDir, agentFromSettings: true });
  const log = async () => (await readFile(runLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  try {
    await until(() => names.every((n) => server.team.get(n)?.state === 'ready'), { what: 'the agents' });
    for (const n of names) server.team.get(n).adapter.guardsEdits = guarded;
    await fn({
      docPath,
      server,
      log,
      runs: async () => (await log()).filter((e) => e.threads),
      sidecar: async () => JSON.parse(await readFile(sidecarPath(docPath), 'utf8')),
      comment: (...args) => main(['comment', docPath, ...args, ...human], quiet),
      reply: (id, body) => main(['reply', docPath, id, body, ...human], quiet),
    });
  } finally {
    await server.close();
  }
}

// Each agent's run, from start to end, in order of start.
async function spans(log) {
  const entries = await log();
  return entries.filter((e) => e.threads).map((run) => ({ as: run.as, start: run.start, end: entries.find((e) => e.end && e.as === run.as && e.end >= run.start)?.end }))
    .sort((a, b) => a.start - b.start);
}

test('a comment that @mentions three agents starts all three runs at once, and each answers', { timeout: 30_000 }, async () => {
  for (const options of [{ guarded: true }, { editMode: 'approve' }, { editMode: 'none' }]) {
    await withTeam(['ann', 'bob', 'cat'], 'slow', async ({ log, sidecar, comment, server }) => {
      await comment('--quote', 'extra load', '@ann @bob @cat what do you make of this?');
      // While they work, the thread shows all three.
      const working = await until(async () => {
        const list = (await sidecar()).threads[0].working;
        return list?.length === 3 && list;
      }, { what: 'three at work' });
      assert.deepEqual(working.map((w) => w.by).sort(), ['ann', 'bob', 'cat']);
      // The thread names an agent just before its run starts: wait for the runs.
      await until(() => server.team.statuses().every((a) => a.state === 'running'), { what: 'three runs' });

      const s = await until(async () => {
        const current = await sidecar();
        return current.threads[0].messages.length === 4 && current;
      }, { what: 'three answers' });
      assert.deepEqual(s.threads[0].messages.slice(1).map((m) => m.author.name).sort(), ['ann', 'bob', 'cat']);
      await until(async () => (await spans(log)).every((r) => r.end), { what: 'the runs to end' });
      const runs = await spans(log);
      assert.equal(runs.length, 3);
      // Each run sleeps 1.5 s before it replies: in turn, the last would
      // start 3 s after the first.
      assert.ok(runs[2].start < runs[0].end, `all three ran at once (${JSON.stringify(options)})`);
      assert.equal((await sidecar()).threads[0].working, null, 'their replies cleared it');
    }, options);
  }
});

test('agents that may edit without the guard still take turns', { timeout: 30_000 }, async () => {
  await withTeam(['ann', 'bob'], 'slow', async ({ log, sidecar, comment, server }) => {
    await comment('@ann @bob thoughts?');
    await until(async () => server.team.statuses().some((a) => a.state === 'queued'), { what: 'one waiting its turn' });
    await until(async () => (await sidecar()).threads[0].messages.length === 3, { what: 'both answers' });
    await until(async () => (await spans(log)).every((r) => r.end), { what: 'the runs to end' });
    const [first, second] = await spans(log);
    assert.ok(first.end <= second.start, 'the second run started after the first ended');
  });
});

// In 'handoff' mode each agent replies as the human's latest message says for
// it: `ann hands to bob` (opendoc reply --to bob) or `ann mentions bob`.
test('an agent that hands a thread to another agent wakes it', { timeout: 30_000 }, async () => {
  await withTeam(['ann', 'bob'], 'handoff', async ({ log, sidecar, comment }) => {
    await comment('--quote', 'extra load', '@ann ann hands to bob');
    const s = await until(async () => {
      const current = await sidecar();
      return current.threads[0].messages.length === 3 && current;
    }, { what: 'the handoff and the answer' });
    const [, handoff, answer] = s.threads[0].messages;
    assert.equal(handoff.author.name, 'ann');
    assert.equal(handoff.to, 'bob');
    assert.equal(handoff.body, '@bob Your turn', 'the reply names whom it went to');
    assert.equal(answer.author.name, 'bob');
    await until(async () => (await spans(log)).every((r) => r.end), { what: 'the runs to end' });
    await sleep(800);
    assert.deepEqual((await spans(log)).map((r) => r.as), ['ann', 'bob'], 'bob ran once, and ann was not woken by his answer');
  });
});

test('an agent that only @mentions another agent does not wake it', { timeout: 30_000 }, async () => {
  await withTeam(['ann', 'bob'], 'handoff', async ({ log, sidecar, comment }) => {
    await comment('--quote', 'extra load', '@ann ann mentions bob');
    await until(async () => (await sidecar()).threads[0].messages.length === 2, { what: 'ann to answer' });
    await sleep(1500);
    const [, answer] = (await sidecar()).threads[0].messages;
    assert.deepEqual(answer.mentions, ['bob']);
    assert.equal(answer.to, undefined);
    assert.equal((await sidecar()).threads[0].messages.length, 2);
    assert.deepEqual((await spans(log)).map((r) => r.as), ['ann']);
  });
});

// ann and bob hand the thread back and forth until the hop limit stops them.
async function pingPong({ log, sidecar }, { messages, refused }) {
  await until(async () => (await log()).filter((e) => e.handoffRefused).length === refused, { what: 'the hop limit' });
  await until(async () => (await sidecar()).threads[0].messages.length === messages, { what: 'the last reply' });
  await until(async () => (await spans(log)).every((r) => r.end), { what: 'the runs to end' });
  await sleep(800);
  return (await sidecar()).threads[0].messages;
}

test('agents handing a thread back and forth stop after four handoffs', { timeout: 30_000 }, async () => {
  await withTeam(['ann', 'bob'], 'handoff', async (team) => {
    await team.comment('--quote', 'extra load', '@ann ann hands to bob, bob hands to ann');
    const messages = await pingPong(team, { messages: 6, refused: 1 });
    assert.deepEqual(messages.slice(1).map((m) => [m.author.name, m.to ?? null]),
      [['ann', 'bob'], ['bob', 'ann'], ['ann', 'bob'], ['bob', 'ann'], ['ann', null]]);
    assert.deepEqual((await spans(team.log)).map((r) => r.as), ['ann', 'bob', 'ann', 'bob', 'ann'], 'the fifth handoff woke no one');
    const [refusal] = (await team.log()).filter((e) => e.handoffRefused);
    assert.equal(refusal.as, 'ann');
    assert.match(refusal.handoffRefused, /4 handoffs/);
  });
});

test('a new message from the human lets agents hand the thread on again', { timeout: 30_000 }, async () => {
  await withTeam(['ann', 'bob'], 'handoff', async (team) => {
    await team.comment('--quote', 'extra load', '@ann ann hands to bob, bob hands to ann');
    await pingPong(team, { messages: 6, refused: 1 });
    const [thread] = (await team.sidecar()).threads;
    await team.reply(thread.id, '@ann again: ann hands to bob, bob hands to ann');
    const messages = await pingPong(team, { messages: 12, refused: 2 });
    assert.deepEqual(messages.slice(7).map((m) => [m.author.name, m.to ?? null]),
      [['ann', 'bob'], ['bob', 'ann'], ['ann', 'bob'], ['bob', 'ann'], ['ann', null]]);
    assert.equal((await spans(team.log)).length, 10);
  });
});

test('two agents editing the doc at once each get only their own edits on their reply, and each undo works', { timeout: 30_000 }, async () => {
  await withTeam(['ann', 'bob'], 'guarded-edit', async ({ docPath, log, sidecar, comment }) => {
    await comment('--quote', 'six features', '@ann @bob fix both. ann: "ship all six features" -> "ship all seven features" bob: "extra load" -> "extra peak load"');
    const s = await until(async () => {
      const current = await sidecar();
      const answers = current.threads[0].messages.slice(1);
      return answers.length === 2 && answers.every((m) => m.edits) && current;
    }, { what: 'both answers with their edits' });
    const markdown = await readFile(docPath, 'utf8');
    assert.match(markdown, /ship all seven features[\s\S]*extra peak load/);
    const reply = (name) => s.threads[0].messages.find((m) => m.author.name === name);
    assert.deepEqual(reply('ann').edits.map((e) => [e.before, e.after]), [['six', 'seven']]);
    assert.deepEqual(reply('bob').edits.map((e) => [e.before, e.after]), [['', 'peak ']]);
    assert.equal(revertEdits(markdown, reply('ann').edits), markdown.replace('seven features', 'six features'));
    assert.equal(revertEdits(markdown, reply('bob').edits), markdown.replace('extra peak load', 'extra load'));
    assert.equal(revertEdits(revertEdits(markdown, reply('ann').edits), reply('bob').edits), SAMPLE);

    // They ran at once, and their edits took turns.
    const edits = (await log()).filter((e) => e.edit);
    assert.equal(edits.length, 2);
    assert.ok(edits.every((e) => !e.refused));
    const runs = await spans(log);
    assert.ok(runs[1].start < runs[0].end, 'the runs overlapped');
  }, { guarded: true });
});

test('the guard holds an edit while another agent writes the doc, and refuses it if that goes on', { timeout: 30_000 }, async () => {
  await withTeam(['ann', 'bob'], 'hang', async ({ server, comment, runs }) => {
    await comment('@ann @bob hold on');
    await until(async () => (await runs()).length === 2, { what: 'both runs' });
    const ann = server.team.get('ann');
    const bob = server.team.get('bob');
    assert.equal(await ann.startEdit(0), true, 'ann takes the floor');
    assert.equal(server.team.editing(), ann);
    const waited = Date.now();
    assert.equal(await bob.startEdit(300), false, 'bob is refused once ann keeps it too long');
    assert.ok(Date.now() - waited >= 280);
    const bobTurn = bob.startEdit(5000);
    await ann.endEdit();
    assert.equal(await bobTurn, true, 'bob goes once ann is done');
    assert.equal(server.team.editing(), bob);
    await bob.endEdit();
    assert.equal(server.team.editing(), null);
  }, { guarded: true });
});

test('the floor: a holder may take it again; it is free after the last release, and its change goes into the others\' bases', async () => {
  const seen = [];
  const a = { othersEdited: () => seen.push('a') };
  const b = { othersEdited: (before, after) => seen.push(['b', before, after]) };
  const floor = new Floor(() => [a, b]);
  assert.equal(await floor.acquire(a, 0), true);
  floor.before = 'one';
  assert.equal(await floor.acquire(a, 0), true, 'again, while it holds it');
  assert.equal(await floor.acquire(b, 0), false);
  floor.release(a, 'two');
  assert.equal(floor.holder, a, 'still held once');
  const waiting = floor.acquire(b, 1000);
  floor.release(a, 'two');
  assert.equal(await waiting, true);
  assert.deepEqual(seen, [['b', 'one', 'two']], 'only the other run takes in the change');
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
  const { command, args } = adapter.command({ prompt: 'PROMPT', docFile: 'plan.md', docPath });
  assert.equal(command, 'claude');
  assert.deepEqual(args.slice(0, 2), ['-p', 'PROMPT']);
  assert.ok(args.includes('dontAsk'));
  // Every run is a new session, and none is kept to resume.
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(!args.includes('--resume'));
  // The model asked for, at low effort unless told otherwise.
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'sonnet']);
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'low']);
  const high = claudeAdapter({ bin: 'claude', effort: 'high' }).command({ prompt: 'P', docFile: 'plan.md', docPath }).args;
  assert.equal(high[high.indexOf('--effort') + 1], 'high');
  // No model set: a fast one.
  assert.equal(high[high.indexOf('--model') + 1], 'haiku');
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
  // Opened from a folder: still the private folder, but the folder is a
  // working directory its read-only tools may look in; only the doc is editable.
  const folder = join(tmpdir(), 'docs');
  const inFolder = claudeAdapter({ bin: 'claude', folder });
  assert.equal(inFolder.workdir(docPath), privateWorkdir(docPath));
  const folderArgs = inFolder.command({ prompt: 'PROMPT', docFile: 'plan.md', docPath }).args;
  assert.deepEqual(folderArgs.slice(folderArgs.indexOf('--add-dir'), folderArgs.indexOf('--add-dir') + 3), ['--add-dir', folder, '--disallowedTools']);
  assert.deepEqual(allowed({ folder }), [`Read(${doc})`, `Read(${rulePath(folder)}/**)`, `Edit(${doc})`, 'Bash(opendoc *)', 'PowerShell(opendoc *)']);
  assert.ok(!claudeAdapter({ bin: 'claude', folder, fileAccess: true }).command({ prompt: 'PROMPT', docFile: 'plan.md', docPath }).args.includes('--add-dir'));
  assert.ok(!args.includes('--add-dir'));
  const folderPrompt = buildPrompt({ name: 'claude', docFile: 'plan.md', folder });
  assert.match(folderPrompt, new RegExp(`opened this doc from the folder ${folder.replaceAll('\\', '\\\\')}`));
  assert.match(folderPrompt, /never edit them/);
  assert.doesNotMatch(buildPrompt({ name: 'claude', docFile: 'plan.md', folder, fileAccess: true }), /opened this doc from the folder/);

  // Approve mode: the doc is not editable; the prompt asks for proposals.
  const approve = adapter.command({ prompt: 'PROMPT', docFile: 'plan.md', docPath, editMode: 'approve' }).args;
  assert.deepEqual(approve.slice(approve.indexOf('--allowedTools') + 1), [`Read(${doc})`, 'Bash(opendoc *)', 'PowerShell(opendoc *)']);
  assert.ok(!approve.some((a) => a.startsWith('Edit')));
  const approvePrompt = buildPrompt({ name: 'claude', docFile: 'plan.md', editMode: 'approve' });
  assert.match(approvePrompt, /opendoc propose plan\.md <thread-id> --as claude/);
  assert.match(approvePrompt, /do not edit it/);
  const absoluteDoc = process.platform === 'win32' ? 'C:/My Docs/plan.md' : '/My Docs/plan.md'; // absolute on this platform
  const absolute = buildPrompt({ name: 'claude', docFile: absoluteDoc });
  assert.ok(absolute.includes(`opendoc reply "${absoluteDoc}" <thread-id>`));
  assert.doesNotMatch(absolute, /working directory/);
  for (const prompt of [approvePrompt, buildPrompt({ name: 'claude', docFile: 'plan.md' })]) {
    assert.doesNotMatch(prompt, /opendoc resolve/);
    assert.match(prompt, /Never resolve a thread/);
  }

  const ok = adapter.parse({ stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', total_cost_usd: 0.02, num_turns: 4, permission_denials: [] }), stderr: '', code: 0 });
  assert.deepEqual(ok, { ok: true, error: null, costUsd: 0.02, turns: 4, denials: 0 });
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
  assert.ok(!args.includes('resume'), 'every run is a new session');
  assert.ok(args.includes('--ephemeral'), 'and none is kept');

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
  assert.deepEqual(ok, { ok: true, error: null });
  const failed = adapter.parse({ stdout: lines({ type: 'thread.started', thread_id: 't2' }, { type: 'turn.failed', error: { message: 'usage limit reached' } }), stderr: '', code: 1 });
  assert.deepEqual(failed, { ok: false, error: 'usage limit reached' });
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
  // Opened from a folder: the files next to the doc are read-only, secrets still denied.
  assert.deepEqual(codexPermissions(docPath, { siblings, home, readSiblings: true })[folder], {
    '.': 'write',
    ...Object.fromEntries(CODEX_DENIED_GLOBS.map((glob) => [glob, 'deny'])),
    '.env': 'deny',
    drafts: 'read',
    'secret.txt': 'read',
    'plan.md': 'write',
    'plan.md.opendoc.json': 'read',
  });
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
  assert.deepEqual(settings(args({ guard: true })), { hooks: {
    PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'opendoc guard', timeout: 30 }] }],
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'opendoc guard', timeout: 10 }] }],
  } });
  assert.equal(settings(args({ guard: true, editMode: 'approve' })), null, 'nothing to guard when the run cannot edit');
  assert.equal(settings(args({})), null);

  assert.match(buildPrompt({ name: 'claude', docFile: 'plan.md', typing: 'The main risk is' }), /typing in the paragraph that starts "The main risk is"/);
  const withOthers = buildPrompt({ name: 'claude', docFile: 'plan.md', others: ['muse', 'checker'] });
  assert.match(withOthers, /Other agents in this doc: @muse, @checker\. .*answering the same thread at the same time as you: answer from your own role without waiting on them/);
  assert.match(withOthers, /if an edit fails because the file changed, read it again and retry/);
  assert.doesNotMatch(buildPrompt({ name: 'claude', docFile: 'plan.md', others: ['muse'], editMode: 'none' }), /edit fails because the file changed/);
  assert.doesNotMatch(buildPrompt({ name: 'claude', docFile: 'plan.md' }), /typing in the paragraph/);
});

test('Web Searcher and File Searcher are granted as switched on; Editor and Auto Editor decide what the doc allows', () => {
  const docPath = join(tmpdir(), 'plan.md');
  const doc = rulePath(docPath);
  const run = (options, command = {}) => claudeAdapter({ bin: 'claude', ...options }).command({ prompt: 'PROMPT', docFile: 'plan.md', docPath, guard: true, ...command }).args;
  const allowed = (a) => a.slice(a.indexOf('--allowedTools') + 1);

  assert.deepEqual(allowed(run({})), [`Read(${doc})`, `Edit(${doc})`, 'Bash(opendoc *)', 'PowerShell(opendoc *)'], 'only the doc');
  assert.deepEqual(allowed(run({ webAccess: true })), [`Read(${doc})`, `Edit(${doc})`, 'WebSearch', 'WebFetch', 'Bash(opendoc *)', 'PowerShell(opendoc *)']);
  assert.deepEqual(allowed(run({ fileAccess: true })), ['Read', 'Edit(./plan.md)', 'Bash(opendoc *)', 'PowerShell(opendoc *)']);
  assert.equal(claudeAdapter({ bin: 'claude', fileAccess: true }).workdir(docPath), null, 'File Searcher starts in the doc folder');
  assert.equal(claudeAdapter({ bin: 'claude' }).workdir(docPath), privateWorkdir(docPath));
  for (const editMode of ['approve', 'none']) {
    assert.deepEqual(allowed(run({}, { editMode })), [`Read(${doc})`, 'Bash(opendoc *)', 'PowerShell(opendoc *)'], `${editMode}: the doc is not editable`);
  }

  const prompt = buildPrompt({ name: 'Merlin', docFile: 'plan.md', fileAccess: true, docFolder: '/home/me/notes' });
  assert.match(prompt, /read the human's other files \(the doc is in \/home\/me\/notes\)/);
  assert.doesNotMatch(prompt, /search the web/);
  assert.match(buildPrompt({ name: 'Genius', docFile: 'plan.md', webAccess: true }), /You may search the web/);
  assert.doesNotMatch(buildPrompt({ name: 'Rocky', docFile: 'plan.md' }), /search the web|other files/);
  assert.match(buildPrompt({ name: 'Rocky', docFile: 'plan.md', editMode: 'none' }), /do not edit it or propose changes; you may only reply/);
});

test('the prompt: with Auto Commenter, an open comment is the agent\'s to take or leave', () => {
  const pilot = buildPrompt({ name: 'Clippy', docFile: 'plan.md', autoComment: true });
  assert.match(pilot, /"open": true/);
  assert.match(pilot, /only if it fits your persona/);
  assert.match(pilot, /Stop when every thread you take on has a reply/);
  const called = buildPrompt({ name: 'Rocky', docFile: 'plan.md' });
  assert.doesNotMatch(called, /"open": true/);
  assert.match(called, /answer only comments addressed to you/);
});
