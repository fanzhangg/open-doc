import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { COALESCE_MS, MAX_SPAN_MS, historyDir, moveHistory, readHistory, readVersion, recordVersion } from '../src/store/history.js';
import { SAMPLE, fakeConfig, openTestDoc, tempDoc, until } from './helpers.js';

const me = { name: 'fzhan', kind: 'human' };
const bot = { name: 'claude', kind: 'agent' };
const edit = (author, extra = {}) => ({ kind: 'edit', author, ...extra });
const configRoot = () => mkdtemp(join(tmpdir(), 'opendoc-config-'));

test('versions record who changed the doc and how much', async () => {
  const root = await configRoot();
  const doc = await tempDoc();
  const t0 = Date.parse('2026-10-15T09:00:00Z');
  const first = await recordVersion(doc, root, 'one\n', { kind: 'external', author: null }, t0);
  assert.equal(first.kind, 'opened', 'the doc as first seen');
  assert.equal(await recordVersion(doc, root, 'one\n', edit(me), t0 + 1000), null, 'no change, no version');
  await recordVersion(doc, root, 'one two\n', edit(me), t0 + 1000);
  await recordVersion(doc, root, 'one two three\n', edit(bot, { thread: 'c_aaaaaa', reply: 'c_bbbbbb' }), t0 + 2000);
  await recordVersion(doc, root, 'one two three four\n', edit(bot, { thread: 'c_aaaaaa', reply: 'c_cccccc' }), t0 + 3000);

  const versions = await readHistory(doc, root);
  assert.deepEqual(versions.map((v) => [v.kind, v.author?.name ?? null]), [['opened', null], ['edit', 'fzhan'], ['edit', 'claude'], ['edit', 'claude']], 'each buddy edit a version of its own');
  assert.deepEqual([versions[1].added, versions[1].removed], [4, 0]);
  assert.deepEqual([versions[2].thread, versions[2].reply], ['c_aaaaaa', 'c_bbbbbb']);

  const shown = await readVersion(doc, root, versions[2].id);
  assert.equal(shown.markdown, 'one two three\n');
  assert.equal(shown.before, 'one two\n');
  assert.equal((await readVersion(doc, root, versions[0].id)).before, null);
  assert.equal(await readVersion(doc, root, 'v_missing1'), null);
});

test('a burst of changes by one author is one version', async () => {
  const root = await configRoot();
  const doc = await tempDoc();
  const t0 = Date.parse('2026-10-15T09:00:00Z');
  await recordVersion(doc, root, 'a\n', { kind: 'external', author: null }, t0);
  const typed = await recordVersion(doc, root, 'ab\n', edit(me), t0 + 1000);
  const more = await recordVersion(doc, root, 'abc\n', edit(me), t0 + 2000);
  assert.equal(more.id, typed.id, 'still typing: the same version');
  assert.equal(more.startedAt, typed.startedAt);
  assert.deepEqual([more.added, more.removed], [2, 0], 'counted from the version before the burst');

  // The agent's change in between starts a new version, and so does the human's after it.
  await recordVersion(doc, root, 'abcd\n', edit(bot), t0 + 3000);
  await recordVersion(doc, root, 'abcde\n', edit(me), t0 + 4000);
  // A pause longer than COALESCE_MS starts a new one too.
  await recordVersion(doc, root, 'abcdef\n', edit(me), t0 + 4000 + COALESCE_MS);
  assert.equal((await readHistory(doc, root)).length, 5);

  // A long session is cut into versions even without a pause.
  let at = t0 + 10 * MAX_SPAN_MS;
  for (let i = 0; at < t0 + 11 * MAX_SPAN_MS + 1000; i++, at += 60_000) await recordVersion(doc, root, `x${i}\n`, edit(me), at);
  assert.equal((await readHistory(doc, root)).length, 7);

  // Typing that ends where the version before began leaves no version behind.
  const doc2 = await tempDoc();
  await recordVersion(doc2, root, 'a\n', { kind: 'external', author: null }, t0);
  await recordVersion(doc2, root, 'ab\n', edit(me), t0 + 1000);
  await recordVersion(doc2, root, 'a\n', edit(me), t0 + 2000);
  assert.equal((await readHistory(doc2, root)).length, 1);
  assert.equal((await readdir(historyDir(doc2, root))).filter((f) => f.endsWith('.md')).length, 1, 'unused text is removed');
});

test('history follows a renamed doc', async () => {
  const root = await configRoot();
  const doc = await tempDoc();
  await recordVersion(doc, root, 'a\n', edit(me));
  const moved = join(dirname(doc), 'renamed.md');
  await moveHistory(doc, moved, root);
  assert.equal((await readHistory(moved, root)).length, 1);
  assert.equal((await readHistory(doc, root)).length, 0);
});

// ---- through the server ----

// The doc's buddy, histbot, runs the fake agent script.
async function withDoc(fn) {
  const docPath = await tempDoc(SAMPLE);
  const settingsDir = await fakeConfig({ buddies: { histbot: '\n' } });
  const { doc, call, state } = await openTestDoc(docPath, { settingsDir });
  try {
    await fn({ call, state, docPath, versions: async () => (await call('history')).versions });
  } finally {
    await doc.close();
  }
}

test('the doc service records saves, changes on disk and restores', async () => {
  await withDoc(async ({ call, state, docPath, versions }) => {
    assert.deepEqual((await versions()).map((v) => v.kind), ['opened']);
    const before = await state();
    assert.ok(!(await call('saveDoc', { markdown: SAMPLE.replace('six', 'seven'), baseHash: before.docHash })).conflict);

    // Written by another program: noticed by the watcher.
    await writeFile(docPath, SAMPLE.replace('six', 'eight'));
    await until(async () => (await versions()).length === 3, 'the outside change to be recorded');
    const list = await versions();
    assert.deepEqual(list.map((v) => [v.kind, v.author?.name ?? null]), [['opened', null], ['edit', 'fzhan'], ['external', null]]);

    const shown = await call('version', { id: list[1].id });
    assert.equal(shown.markdown, SAMPLE.replace('six', 'seven'));
    assert.equal(shown.before, SAMPLE);

    // Restoring needs the doc the page last saw.
    assert.equal((await call('restoreVersion', { id: list[0].id, baseHash: before.docHash })).conflict, true);
    const restored = await call('restoreVersion', { id: list[0].id, baseHash: (await state()).docHash });
    assert.equal(restored.markdown, SAMPLE);
    assert.equal(await readFile(docPath, 'utf8'), SAMPLE);
    const last = (await versions()).at(-1);
    assert.equal(last.kind, 'restore');
    assert.equal(last.restoredFrom, list[0].id);
    assert.equal(last.author.name, 'fzhan');
    assert.equal((await versions()).length, 4, 'restoring keeps every version');

    await assert.rejects(call('version', { id: '../index' }), (error) => error.code === 'bad_input');
    await assert.rejects(call('version', { id: 'v_nothere1' }), (error) => error.code === 'not_found');
  });
});

test("a buddy's merged edit is recorded as its own", { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, versions }) => {
    const { id } = await call('comment', { anchor: null, body: '@histbot replace "extra load" with "extra peak load"' });
    await until(async () => (await versions()).length === 2, 'the buddy\'s edit to be recorded');
    const [, agentVersion] = await versions();
    assert.deepEqual(agentVersion.author, { name: 'histbot', kind: 'agent' });
    const thread = (await call('state')).threads.find((t) => t.id === id);
    assert.deepEqual([agentVersion.thread, agentVersion.reply], [id, thread.comments[1].id], 'tagged with its reply');
  });
});
