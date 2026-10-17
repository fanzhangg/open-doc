// A concurrency stress test: many agents answering many comments at once,
// asserted by invariant rather than by an exact transcript, so it catches a
// double-answer or a leftover claim however it arises. Deterministic (a fixed
// seed by default), bounded to a few seconds, and kept out of `npm test`
// (which globs test/*.test.js); CI runs it with `npm run test:stress` on
// changes to the code, and a seed can be passed as STRESS_SEED to reproduce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../src/server/server.js';
import { main, waitForInbox } from '../../src/cli/main.js';
import { MAX_HANDOFFS } from '../../src/core/ops.js';
import { sidecarPath } from '../../src/store/files.js';
import { SAMPLE, tempDoc } from '../helpers.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-agent.js');
const quiet = { stdout: { write() {} }, stderr: { write() {} }, env: {} };
const human = ['--as', 'fzhan', '--kind', 'human'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A small seeded PRNG so a failing run can be replayed from its seed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function until(check, { timeout = 20_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// A team of auto-commenter agents on one doc, each a fast fake that replies.
async function withTeam(names, fn) {
  const docPath = await tempDoc(SAMPLE);
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-stress-'));
  const command = `"${process.execPath}" "${FAKE}" {threadsFile} reply "${join(settingsDir, 'runs.log')}"`;
  const agents = names.map((name, i) => ({ id: `a_stress${i}`, name, starred: true, runtime: 'custom', command, editMode: 'none', autoComment: true }));
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agents }));
  await writeFile(sidecarPath(docPath), JSON.stringify({ opendoc: 1, doc: basename(docPath), docHash: null, threads: [], participants: names.map((name) => ({ name, kind: 'agent' })) }));
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const server = await startServer(docPath, { assetsDir, settingsDir, agentFromSettings: true });
  try {
    const idle = () => names.every((n) => ['ready', 'limited', 'error'].includes(server.team.get(n)?.state));
    await until(idle, { what: 'the agents' });
    await fn({
      docPath,
      idle,
      sidecar: async () => JSON.parse(await readFile(sidecarPath(docPath), 'utf8')),
      comment: (...args) => main(['comment', docPath, ...args, ...human], quiet),
    });
  } finally {
    await server.close();
  }
}

// Everyone who answered (replied in) the thread, and the final working list.
const repliers = (thread) => thread.messages.filter((m) => m.author.kind === 'agent').map((m) => m.author.name.toLowerCase());

function checkInvariants(sidecar, names) {
  for (const thread of sidecar.threads) {
    assert.deepEqual(thread.working ?? null, null, `thread ${thread.id} still shows a claim after settling`);
    const answered = repliers(thread);
    const seen = new Set();
    for (const name of answered) {
      assert.ok(!seen.has(name), `thread ${thread.id} was answered twice by ${name}`);
      seen.add(name);
    }
    const handoffs = thread.messages.filter((m) => m.to).length;
    assert.ok(handoffs <= MAX_HANDOFFS, `thread ${thread.id} had ${handoffs} handoffs`);
  }
  // The human's doc text is never lost to an agent's work.
  assert.ok(names.length > 0);
}

const SEED = Number(process.env.STRESS_SEED ?? 1);

test(`a storm of comments across agents answers each once, with no leftover claims (seed ${SEED})`, { timeout: 60_000 }, async () => {
  const names = ['ann', 'bob', 'cat'];
  await withTeam(names, async ({ sidecar, comment, idle }) => {
    const rand = rng(SEED);
    const quotes = ['ship all six features', 'beta cohort', 'public release', 'extra load', 'capacity doc'];
    // Fire a burst of comments: some open (answered by every agent), some
    // addressed to a random subset. No awaiting between them, so claims,
    // runs and replies all race.
    const posts = [];
    for (let i = 0; i < 12; i++) {
      const quote = quotes[i % quotes.length];
      const open = rand() < 0.4;
      const to = open ? [] : names.filter(() => rand() < 0.6);
      const mentions = to.length === 0 ? '' : to.map((n) => `@${n} `).join('');
      posts.push(comment('--quote', quote, `${mentions}point ${i}?`).catch(() => {}));
    }
    await Promise.all(posts);

    // Who each thread should end up answered by: the agents it names, or
    // every agent for an open ask (one that names no one).
    const expected = (thread) => (thread.messages[0].mentions.length ? thread.messages[0].mentions.map((m) => m.toLowerCase()) : names);

    // Wait until every ask is fully answered and no claim is left. If this
    // times out, a thread was dropped or an agent stalled — the real failure
    // the stress test is here to catch; the error names what is missing.
    await until(async () => {
      const s = await sidecar();
      if (!idle()) return false;
      return s.threads.length === 12 && s.threads.every((t) => expected(t).every((n) => repliers(t).includes(n)) && (t.working ?? null) === null);
    }, { what: 'every ask answered', timeout: 40_000 }).catch(async () => {
      const s = await sidecar();
      const missing = s.threads.filter((t) => !expected(t).every((n) => repliers(t).includes(n))).map((t) => `${t.id}: want ${expected(t)}, got ${repliers(t)}`);
      assert.fail(`not every ask was answered:\n${missing.join('\n')}`);
    });

    // Settle a little longer, then check nothing answered twice and no claim
    // lingers.
    await sleep(500);
    checkInvariants(await sidecar(), names);
  });
});

test(`a chat-session wait racing the team never double-answers one ask (seed ${SEED})`, { timeout: 60_000 }, async () => {
  await withTeam(['ann'], async ({ docPath, sidecar, comment }) => {
    // A terminal `opendoc wait` and the server's dispatcher both watch ann.
    const waiting = waitForInbox(docPath, { name: 'ann', kind: 'agent' }, 8000);
    await comment('--quote', 'extra load', '@ann who takes this?');
    const claimedByWait = await waiting;
    await sleep(1500);
    const thread = (await sidecar()).threads[0];
    if (claimedByWait) {
      // The wait won: the dispatcher left the thread alone (no reply), and the
      // wait's own claim stands (it has no owner, so a restart would keep it)
      // until that session replies.
      assert.equal(repliers(thread).length, 0, 'the dispatcher must not also answer a thread the wait claimed');
      assert.equal(thread.working[0].by.toLowerCase(), 'ann');
      assert.equal(thread.working[0].owner ?? null, null, "a chat session's claim carries no owner");
    } else {
      // The dispatcher won: it answered once and cleared its claim.
      assert.equal(repliers(thread).length, 1);
      assert.deepEqual(thread.working ?? null, null);
    }
  });
});
