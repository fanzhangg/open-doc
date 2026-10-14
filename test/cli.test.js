import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, EXIT } from '../src/cli/main.js';
import { sidecarPath } from '../src/store/files.js';
import { SAMPLE, tempDoc } from './helpers.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'opendoc.js');

async function run(...argv) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    env: {},
  });
  return { code, stdout, stderr };
}

const asHuman = ['--as', 'fzhan', '--kind', 'human'];
const asClaude = ['--as', 'claude'];

async function json(...argv) {
  const result = await run(...argv, '--json');
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('help and usage errors', async () => {
  assert.match((await run()).stdout, /Usage:/);
  assert.equal((await run('frobnicate')).code, EXIT.badInput);
  assert.equal((await run('comments')).code, EXIT.badInput);
  assert.equal((await run('comments', 'x.md', '--bogus')).code, EXIT.badInput);
  const noId = await run('inbox', await tempDoc());
  assert.equal(noId.code, EXIT.badInput);
  assert.match(noId.stderr, /--as/);
});

test('comment on a quote, list it with a line number, reply, resolve, reopen', async () => {
  const doc = await tempDoc();
  const created = await json('comment', doc, '--quote', 'ship **all six** features', 'Is six realistic?', ...asHuman);
  const [thread] = created.threads;
  assert.equal(thread.anchor.exact, 'ship all six features');
  assert.equal(thread.line, 3);
  assert.equal(thread.messages[0].author.kind, 'human');

  const listed = await run('comments', doc);
  assert.match(listed.stdout, new RegExp(`${thread.id}  open  line 3  "ship all six features"`));
  assert.match(listed.stdout, /fzhan \(human\): Is six realistic\?/);

  await json('reply', doc, thread.id, 'Cut to three.', ...asClaude);
  const resolved = await json('resolve', doc, thread.id, ...asClaude);
  assert.equal(resolved.threads[0].status, 'resolved');
  assert.equal(resolved.threads[0].resolvedBy, 'claude');
  assert.equal((await json('comments', doc)).threads.length, 0, 'open is the default filter');
  assert.equal((await json('comments', doc, '--status', 'all')).threads.length, 1);

  const reopened = await json('reopen', doc, thread.id, ...asHuman);
  assert.equal(reopened.threads[0].status, 'open');
});

test('doc-level comments have no anchor', async () => {
  const doc = await tempDoc();
  const { threads: [thread] } = await json('comment', doc, 'Overall', 'too', 'long.', ...asHuman);
  assert.equal(thread.anchor, null);
  assert.equal(thread.messages[0].body, 'Overall too long.');
  assert.match((await run('comments', doc)).stdout, /open  doc/);
});

test('bad quotes and unknown threads exit 2 and write nothing', async () => {
  const doc = await tempDoc();
  const ambiguous = await run('comment', doc, '--quote', 'the', 'x', ...asHuman);
  assert.equal(ambiguous.code, EXIT.badInput);
  assert.match(ambiguous.stderr, /appears \d+ times/);
  assert.equal((await run('comment', doc, '--quote', 'not there', 'x', ...asHuman)).code, EXIT.badInput);
  assert.deepEqual(await readdir(dirname(doc)), ['plan.md']);
  const picked = await json('comment', doc, '--quote', 'the', '--occurrence', '2', 'x', ...asHuman);
  assert.equal(picked.threads[0].anchor.exact, 'the');
  assert.equal((await run('reply', doc, 't_nothere', 'x', ...asClaude)).code, EXIT.badInput);
});

test('inbox follows the mention rule', async () => {
  const doc = await tempDoc();
  await run('wait', doc, ...asClaude, '--timeout', '0.01'); // joins claude as a participant
  await run('comment', doc, '--quote', 'extra load', '@claude quantify?', ...asHuman);
  await run('comment', doc, 'General: tighten this.', ...asHuman);
  await run('comment', doc, '@fzhan note to self', ...asHuman);
  const waiting = await json('inbox', doc, ...asClaude);
  assert.deepEqual(waiting.threads.map((t) => t.messages[0].body), ['@claude quantify?', 'General: tighten this.']);
  assert.match((await run('inbox', doc, '--as', 'nobody')).stdout, /quantify|tighten/);
});

test('agent edits to the doc move anchors; deleted text detaches', async () => {
  const doc = await tempDoc();
  const { threads: [a] } = await json('comment', doc, '--quote', 'extra load', 'a', ...asHuman);
  const { threads: [b] } = await json('comment', doc, '--quote', 'gather feedback', 'b', ...asHuman);
  await writeFile(doc, '# New intro\n\n' + SAMPLE.replace('extra load', 'extra peak load').replace('then gather feedback from the\nbeta cohort ', ''));
  const { threads } = await json('comments', doc);
  const byId = Object.fromEntries(threads.map((t) => [t.id, t]));
  assert.equal(byId[a.id].anchor.exact, 'extra peak load');
  assert.equal(byId[a.id].line, 9);
  assert.equal(byId[b.id].detached, true);
  assert.match((await run('comments', doc)).stdout, /open  detached/);
});

test('mv moves the doc and its sidecar', async () => {
  const doc = await tempDoc();
  await run('comment', doc, 'hello', ...asHuman);
  const target = join(dirname(doc), 'moved.md');
  assert.equal((await run('mv', doc, target)).code, 0);
  assert.deepEqual((await readdir(dirname(doc))).sort(), ['moved.md', 'moved.md.opendoc.json']);
  assert.equal((await json('comments', target)).threads.length, 1);
});

test('wait times out with exit 3 when nothing is waiting', async () => {
  const doc = await tempDoc();
  const started = Date.now();
  const result = await run('wait', doc, ...asClaude, '--timeout', '0.3');
  assert.equal(result.code, EXIT.timeout);
  assert.ok(Date.now() - started < 3000);
  const stored = JSON.parse(await readFile(sidecarPath(doc), 'utf8'));
  assert.deepEqual(stored.participants, [{ name: 'claude', kind: 'agent' }], 'waiting joins the participant list');
});

test('end to end: a blocked wait wakes on a human comment and marks it working', { timeout: 20_000 }, async () => {
  const doc = await tempDoc();
  const child = spawn(process.execPath, [BIN, 'wait', doc, '--as', 'claude', '--timeout', '15', '--json']);
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));

  // Give wait time to join and start watching, then comment.
  const joinDeadline = Date.now() + 5000;
  for (;;) {
    try {
      const s = JSON.parse(await readFile(sidecarPath(doc), 'utf8'));
      if (s.participants.some((p) => p.name === 'claude')) break;
    } catch {}
    if (Date.now() > joinDeadline) throw new Error('wait never joined');
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 100));

  const posted = Date.now();
  await run('comment', doc, '--quote', 'extra load', '@claude can we quantify this?', ...asHuman);
  const code = await exited;
  const latency = Date.now() - posted;

  assert.equal(code, 0);
  const { threads } = JSON.parse(stdout);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].working.by, 'claude');
  assert.equal(threads[0].line, 8);
  assert.ok(latency < 1500, `wait woke after ${latency} ms`);
  console.log(`  wait woke ${latency} ms after the comment was posted (includes process exit)`);

  // While claude is working on it, a re-armed wait does not hand it out again.
  assert.equal((await run('wait', doc, ...asClaude, '--timeout', '0.2')).code, EXIT.timeout);
  // Claude's reply clears the working flag and empties the inbox.
  const replied = await json('reply', doc, threads[0].id, 'About 3x peak; added to the doc.', ...asClaude);
  assert.equal(replied.threads[0].working, null);
  assert.equal((await json('inbox', doc, ...asClaude)).threads.length, 0);
});
