import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../src/store/files.js';
import { MAX_HISTORY_CHARS, historyDir, moveHistory, readHistory, readVersion, recordVersion } from '../src/store/history.js';
import { SAMPLE, fakeConfig, openTestDoc, tempDoc, until } from './helpers.js';

const me = { name: 'fzhan', kind: 'human' };
const bot = { name: 'claude', kind: 'agent' };
const edit = (author, extra = {}) => ({ kind: 'edit', author, ...extra });
const configRoot = () => mkdtemp(join(tmpdir(), 'ponjo-config-'));

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
  assert.equal(shown.text, 'one two three\n');
  assert.equal(shown.before, 'one two\n');
  assert.equal((await readVersion(doc, root, versions[0].id)).before, null);
  assert.equal(await readVersion(doc, root, 'v_missing1'), null);
});

test('a version is never changed: each names its parent, and its change can still be read after 600 more', { timeout: 60_000 }, async () => {
  const root = await configRoot();
  const doc = await tempDoc();
  const t0 = Date.parse('2026-10-15T09:00:00Z');
  const opened = await recordVersion(doc, root, 'a\n', { kind: 'external', author: null }, t0);
  const typed = await recordVersion(doc, root, 'ab\n', edit(me), t0 + 1000);
  const more = await recordVersion(doc, root, 'abc\n', edit(me), t0 + 2000);
  assert.notEqual(more.id, typed.id, 'typing on: a version of its own');
  assert.deepEqual([opened.parent, typed.parent, more.parent], [null, opened.id, typed.id]);
  assert.equal((await readVersion(doc, root, more.id)).before, 'ab\n', 'its change is from its parent');
  const turn = await recordVersion(doc, root, 'abcd\n', edit(bot, { thread: 'c_aaaaaa', reply: 'c_bbbbbb' }), t0 + 3000);
  for (let i = 0; i < 600; i++) await recordVersion(doc, root, `abcd ${i}\n`, edit(me), t0 + 4000 + i * 1000);
  const kept = await readVersion(doc, root, turn.id);
  assert.deepEqual([kept.before, kept.text], ['abc\n', 'abcd\n']);
  assert.deepEqual((await readHistory(doc, root)).slice(0, 4).map((v) => v.id), [opened.id, typed.id, more.id, turn.id], 'the versions before are as they were');
});

test('an older version, written before versions named their parent, has the one before it as its parent', async () => {
  const root = await configRoot();
  const doc = await tempDoc();
  await mkdir(historyDir(doc, root), { recursive: true });
  await writeAtomic(join(historyDir(doc, root), 'index.json'), JSON.stringify({ history: 1, doc, versions: [
    { id: 'v_aaaaaa', kind: 'opened', author: null, at: '2026-10-15T09:00:00Z', hash: 'sha256:x' },
    { id: 'v_bbbbbb', kind: 'edit', author: me, at: '2026-10-15T09:01:00Z', hash: 'sha256:y' },
  ] }));
  assert.deepEqual((await readHistory(doc, root)).map((v) => v.parent), [null, 'v_aaaaaa']);
});

test('of a very long doc, history keeps the latest versions that fit', { timeout: 60_000 }, async () => {
  const root = await configRoot();
  const doc = await tempDoc();
  const t0 = Date.parse('2026-10-15T09:00:00Z');
  const size = MAX_HISTORY_CHARS * 0.4;
  for (const [k, ch] of ['a', 'b', 'c'].entries()) await recordVersion(doc, root, ch.repeat(size), edit(k === 1 ? bot : me), t0 + k * 1000);
  const versions = await readHistory(doc, root);
  assert.deepEqual(versions.map((v) => v.size), [size, size]);
  assert.equal((await readVersion(doc, root, versions[0].id)).text[0], 'b', 'the oldest went');
  assert.equal((await readdir(historyDir(doc, root))).filter((f) => f.endsWith('.md')).length, 2, 'and its text with it');
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
  const settingsDir = await fakeConfig();
  const { doc, call, edit, state } = await openTestDoc(docPath, { settingsDir, buddies: { histbot: '\n' } });
  try {
    await fn({ call, edit, state, docPath, versions: async () => (await call('history')).versions });
  } finally {
    await doc.close();
  }
}

test('the doc service records saves, changes on disk and restores', async () => {
  await withDoc(async ({ call, edit, state, docPath, versions }) => {
    assert.deepEqual((await versions()).map((v) => v.kind), ['opened']);
    await edit(SAMPLE.replace('six', 'seven'));

    // Written by another program: noticed by the watcher. Atomically, as an
    // in-place write can be read half done and is then a version of its own.
    await writeAtomic(docPath, SAMPLE.replace('six', 'eight'));
    await until(async () => (await versions()).length === 3, 'the outside change to be recorded');
    const list = await versions();
    assert.deepEqual(list.map((v) => [v.kind, v.author?.name ?? null]), [['opened', null], ['edit', 'fzhan'], ['external', null]]);

    const shown = await call('version', { id: list[1].id });
    assert.equal(shown.text, SAMPLE.replace('six', 'seven'));
    assert.equal(shown.before, SAMPLE);

    await call('restoreVersion', { id: list[0].id });
    assert.equal((await state()).text, SAMPLE);
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
    // The edit is recorded before the reply is posted: wait for both.
    const thread = async () => (await call('state')).threads.find((t) => t.id === id);
    await until(async () => (await versions()).length === 2 && (await thread()).comments.length === 2, 'the buddy\'s edit and reply');
    const [, agentVersion] = await versions();
    assert.deepEqual(agentVersion.author, { id: 'histbot', name: 'histbot', kind: 'agent' });
    const { comments } = await thread();
    assert.deepEqual([agentVersion.thread, agentVersion.reply], [id, comments[1].id], 'tagged with its reply');
  });
});
