import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { main, EXIT } from '../src/cli/main.js';
import { SAMPLE, tempDoc } from './helpers.js';

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

const asHuman = ['--as', 'fzhan'];

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
  const noId = await run('comment', await tempDoc(), 'hi');
  assert.equal(noId.code, EXIT.badInput);
  assert.match(noId.stderr, /--as/);
});

test('comment on a quote, list it with a line number, resolve, reopen', async () => {
  const doc = await tempDoc();
  const created = await json('comment', doc, '--quote', 'ship **all six** features', 'Is six realistic?', ...asHuman);
  const [thread] = created.threads;
  assert.equal(thread.anchor.exact, 'ship all six features');
  assert.equal(thread.line, 3);
  assert.equal(thread.messages[0].author.kind, 'human');

  const listed = await run('comments', doc);
  assert.match(listed.stdout, new RegExp(`${thread.id}  open  line 3  "ship all six features"`));
  assert.match(listed.stdout, /fzhan \(human\): Is six realistic\?/);

  const resolved = await json('resolve', doc, thread.id, ...asHuman);
  assert.equal(resolved.threads[0].status, 'resolved');
  assert.equal(resolved.threads[0].resolvedBy, 'fzhan');
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
  assert.equal((await run('resolve', doc, 't_nothere', ...asHuman)).code, EXIT.badInput);
});

test('edits to the doc move anchors; deleted text detaches', async () => {
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

