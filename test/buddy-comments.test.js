// Buddies comment (docs/agent-config.md, Comments): a run gets a copy of
// the sidecar, and the lines it appends are added as the buddy's comments.
// The agent is the fake script (test/fixtures/fake-agent.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appendedComments } from '../src/core/comments.js';
import { sidecarPath } from '../src/store/files.js';
import { fakeConfig, fakeRuns, openTestDoc, tempDoc, until } from './helpers.js';

async function withDoc(fn) {
  const docPath = await tempDoc();
  const settingsDir = await fakeConfig();
  const opened = await openTestDoc(docPath, { settingsDir });
  try {
    await fn({ ...opened, docPath, settingsDir });
  } finally {
    await opened.doc.close();
  }
}

// Post `body` and wait for Clippy's reply to it: the threads then.
async function ask(call, state, body) {
  const { id } = await call('comment', { anchor: null, body });
  await until(async () => (await state()).threads.find((t) => t.id === id)?.comments.some((c) => c.by.kind === 'ai'), 'the reply');
  return { id, threads: (await state()).threads };
}

const BY = { id: 'Clippy', name: 'Clippy', kind: 'ai' };
const AT = '2026-10-17T10:00:00.000Z';

test('appended lines are comments; changed lines, unknown threads and bad lines are not', () => {
  const before = '{"opendoc":2}\n{"id":"c_first01","by":{"id":"u_1","name":"fzhan","kind":"human"},"at":"2026-10-17T09:00:00Z","body":"Hi"}\n';
  const after = before.replace('"Hi"', '"Changed"') + [
    '{"anchor":{"exact":"beta cohort"},"body":"Who is in it?"}',
    '{"anchor":{"exact":"gather\\nfeedback"},"body":"From whom?"}',
    '{"anchor":{"exact":"the"},"body":"Everywhere."}',
    '{"body":"Fine overall."}',
    '{"thread":"c_first01","body":"Agreed.","resolved":true}',
    '{"thread":"c_nothere","body":"Lost."}',
    '{"body":"  "}',
    'not json',
  ].join('\n') + '\n';
  const text = 'We gather feedback from the beta cohort before the release.';
  const added = appendedComments(before, after, { text, by: BY, at: AT, threads: new Set(['c_first01']) });
  assert.deepEqual(added.map(({ id, ...c }) => c), [
    { by: BY, at: AT, body: 'Who is in it?', anchor: { exact: 'beta cohort', prefix: 'We gather feedback from the ', suffix: ' before the release.', start: 28 } },
    { by: BY, at: AT, body: 'From whom?', anchor: { exact: 'gather feedback', prefix: 'We ', suffix: ' from the beta cohort before the', start: 3 } },
    { by: BY, at: AT, body: 'Everywhere.', anchor: null },
    { by: BY, at: AT, body: 'Fine overall.', anchor: null },
    { by: BY, at: AT, body: 'Agreed.', thread: 'c_first01' },
  ], 'a quote with a line break matches its spaces; a quote found twice is on the whole doc; resolved is dropped; the changed line is not new');
});

test('a run appends a thread on a quote, one on the whole doc and a reply, and prints nothing: all are the buddy\'s', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir }) => {
    const { id: earlier } = await call('comment', { anchor: null, body: 'Is week one too soon?' });
    const { id, threads } = await ask(call, state, '@Clippy quiet append {"anchor":{"exact":"beta cohort"},"body":"Who is in it?"};; append {"body":"Reads well."};; reply-first Yes, make it week two.');
    const [run] = await fakeRuns(settingsDir);
    assert.deepEqual(run.files.sort(), ['plan.md', 'plan.md.opendoc.jsonl'], 'its folder holds the copies');
    assert.match(run.prompt, /plan\.md\.opendoc\.jsonl holds the doc's comments/);

    const asked = threads.find((t) => t.id === id);
    assert.deepEqual(asked.comments.map((c) => [c.by.name, c.body]), [['fzhan', asked.comments[0].body], ['Clippy', '']], 'the reply is empty');
    const quote = threads.find((t) => t.anchor?.exact === 'beta cohort');
    assert.deepEqual(quote.comments.map((c) => [c.by.kind, c.body]), [['ai', 'Who is in it?']]);
    assert.match(quote.anchor.prefix, /gather feedback from the $/);
    const whole = threads.find((t) => t.comments[0].body === 'Reads well.');
    assert.equal(whole.anchor, null);
    assert.deepEqual(threads.find((t) => t.id === earlier).comments.map((c) => [c.by.name, c.body]), [['fzhan', 'Is week one too soon?'], ['Clippy', 'Yes, make it week two.']]);
    assert.equal((await fakeRuns(settingsDir)).length, 1, 'its comments ask no one');
  });
});

test('a run that rewrites a line, resolves a thread or quotes text found twice changes nothing it may not', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, docPath }) => {
    const { id: earlier } = await call('comment', { anchor: null, body: 'Keep this.' });
    const { threads } = await ask(call, state, '@Clippy tamper;; append {"anchor":{"exact":"the"},"body":"Which one?"}');
    const kept = threads.find((t) => t.id === earlier);
    assert.equal(kept.comments[0].body, 'Keep this.', 'the line it changed is not taken');
    assert.ok(!kept.resolved, 'it cannot resolve');
    assert.equal(kept.comments.at(-1).body, 'Closing.');
    assert.equal(threads.find((t) => t.comments[0].body === 'Which one?').anchor, null, 'a quote found twice is on the whole doc');
    assert.ok(!(await readFile(sidecarPath(docPath), 'utf8')).includes('Tampered.'));
  });
});

test('a buddy\'s comment that @mentions a buddy runs nothing', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir }) => {
    await ask(call, state, '@Clippy quiet append {"body":"@Clippy look again"}');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await fakeRuns(settingsDir)).length, 1);
  });
});
