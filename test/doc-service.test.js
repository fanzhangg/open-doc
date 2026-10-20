// DocService (src/host/doc-service.js) on real files, called as a window
// calls it. Buddies run the fake agent script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sidecarPath } from '../src/store/files.js';
import { openDoc } from '../src/host/doc-service.js';
import { SAMPLE, fakeConfig, fakeRuns, openTestDoc, tempDoc, until } from './helpers.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PILOT = { Pilot: 'You answer everything.\n' };

async function withDoc(fn, { content = SAMPLE, buddies = PILOT, sidecar = null } = {}) {
  const docPath = await tempDoc(content);
  if (sidecar !== null) await writeFile(sidecarPath(docPath), sidecar);
  const settingsDir = await fakeConfig();
  const opened = await openTestDoc(docPath, { settingsDir, buddies });
  try {
    await fn({ ...opened, docPath, settingsDir });
  } finally {
    await opened.doc.close();
  }
}

const refused = (code) => (error) => error.code === code;
const threadOf = async (state, id) => (await state()).threads.find((t) => t.id === id);
const line = (comment) => JSON.stringify(comment);

test('state returns the doc, its hash, its threads and who you are', async () => {
  await withDoc(async ({ state }) => {
    const now = await state();
    assert.equal(now.doc, 'plan.md');
    assert.equal(now.text, SAMPLE);
    assert.match(now.docHash, /^sha256:/);
    assert.deepEqual(now.threads, []);
    assert.equal(now.notice, null);
    assert.deepEqual(now.me, { id: now.me.id, name: 'fzhan', kind: 'human' });
    assert.match(now.me.id, /^u_/);
  });
});

test('saves are conditional and write the text as sent', async () => {
  await withDoc(async ({ call, state, docPath }) => {
    const before = await state();
    const stale = await call('saveDoc', { text: 'x', baseHash: 'sha256:0' });
    assert.deepEqual([stale.conflict, stale.text], [true, SAMPLE]);

    const next = SAMPLE.replace('## Risks', '## Main risks');
    const saved = await call('saveDoc', { text: next, baseHash: before.docHash });
    assert.ok(!saved.conflict);
    assert.equal(await readFile(docPath, 'utf8'), next);
    assert.notEqual(saved.docHash, before.docHash);
    assert.equal(saved.text, next, 'the save says what is on disk now');
  });
});

test('the doc is its text: a byte order mark and CRLF line ends are kept on disk only', async () => {
  await withDoc(async ({ call, state, docPath }) => {
    const now = await state();
    assert.equal(now.text, '# Title\n\nOld text.\n');
    await call('saveDoc', { text: '# Title\n\nNew text.\n', baseHash: now.docHash });
    assert.equal(await readFile(docPath, 'utf8'), '\uFEFF# Title\r\n\r\nNew text.\r\n');
  }, { content: '\uFEFF# Title\r\n\r\nOld text.\r\n' });
});

test('a doc that is not UTF-8 does not open, and is left as it is', async () => {
  const gbk = Buffer.from([0x23, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]); // "# 你好" in GBK
  const docPath = await tempDoc(gbk);
  await assert.rejects(openDoc(docPath, { settingsDir: await fakeConfig() }), refused('not_text'));
  assert.deepEqual(await readFile(docPath), gbk);
});

test('comments: written as the user, one line each; the anchor is never rewritten, and a reader finds it', async () => {
  await withDoc(async ({ call, state, docPath }) => {
    const anchor = { exact: 'extra load', prefix: 'service cannot handle the ', suffix: '.', start: SAMPLE.indexOf('extra load') };
    const { id, threads } = await call('comment', { anchor, body: 'Is this right?' });
    assert.match(id, /^c_/);
    const [first] = threads[0].comments;
    assert.equal(first.by.id, (await state()).me.id, 'the page cannot post as someone else');
    await call('comment', { thread: id, body: 'More.' });
    const lines = (await readFile(sidecarPath(docPath), 'utf8')).trimEnd().split('\n');
    assert.equal(lines[0], '{"opendoc":3}');
    assert.deepEqual(lines.slice(1).map((l) => JSON.parse(l).body), ['Is this right?', 'More.']);
    assert.deepEqual(JSON.parse(lines[1]).anchor, anchor);

    await call('saveDoc', { text: SAMPLE.replace('The main risk', 'The one main risk'), baseHash: (await state()).docHash });
    const moved = (await threadOf(state, id)).anchor;
    assert.deepEqual([moved.exact, moved.start], ['extra load', anchor.start + 4], 'found where its text is now');
    assert.deepEqual(JSON.parse((await readFile(sidecarPath(docPath), 'utf8')).split('\n')[1]).anchor, anchor, 'never rewritten');
    await call('saveDoc', { text: SAMPLE.replace('The main risk is that the `sync` service cannot handle the extra load.\n', ''), baseHash: (await state()).docHash });
    assert.equal((await threadOf(state, id)).detached, true);

    for (const bad of [{ body: '' }, { anchor: { exact: '' }, body: 'x' }, { body: 'x', resolved: true }]) await assert.rejects(call('comment', bad), refused('bad_input'));
    await assert.rejects(call('comment', { thread: 'c_nothere1', body: 'x' }), refused('not_found'));
    await assert.rejects(call('nope'), refused('bad_input'));
  });
});

test('resolving is a comment with resolved; any later comment reopens', async () => {
  await withDoc(async ({ call, state, docPath }) => {
    const { id } = await call('comment', { anchor: null, body: 'Fix this' });
    assert.equal((await call('comment', { thread: id, body: '', resolved: true })).threads[0].resolved, true);
    const resolving = JSON.parse((await readFile(sidecarPath(docPath), 'utf8')).trimEnd().split('\n').at(-1));
    assert.deepEqual([resolving.thread, resolving.body, resolving.resolved], [id, '', true]);
    await pause(2); // comments are ordered by their time, to the millisecond
    assert.equal((await call('comment', { thread: id, body: 'Not yet' })).threads[0].resolved, false);
    await call('comment', { thread: id, body: '', resolved: true });
    await pause(2);
    assert.equal((await call('comment', { thread: id, body: '' })).threads[0].resolved, false);
    assert.deepEqual((await threadOf(state, id)).comments.map((c) => c.body), ['Fix this', '', 'Not yet', '', ''], 'reopening is an empty reply');
  });
});

test('a comment written while a buddy works asks it again once it replies', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir }) => {
    const { id } = await call('comment', { anchor: null, body: '@Pilot hold' });
    await until(async () => (await fakeRuns(settingsDir)).length === 1, 'the run');
    await call('comment', { thread: id, body: '@Pilot say again' });
    await writeFile(join(settingsDir, 'release-Pilot'), '');
    await until(async () => (await threadOf(state, id)).comments.at(-1).body === 'again', 'the second reply');
    assert.deepEqual((await threadOf(state, id)).comments.map((c) => c.body), ['@Pilot hold', 'Nothing to change.', '@Pilot say again', 'again']);
  });
});

test('resolving stops the thread\'s buddy, with nothing it did landing; reopening asks no one', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir }) => {
    const { id } = await call('comment', { anchor: null, body: '@Pilot hold replace "extra load" with "peak load"' });
    await until(async () => (await fakeRuns(settingsDir)).length === 1, 'the run');
    await call('comment', { thread: id, body: '', resolved: true });
    await until(async () => (await state()).agents.every((a) => a.state !== 'running'), 'the run to stop');
    await writeFile(join(settingsDir, 'release-Pilot'), '');
    await pause(500);
    assert.equal((await threadOf(state, id)).resolved, true);
    assert.equal((await threadOf(state, id)).comments.length, 2);
    assert.match((await state()).text, /extra load/);
    await call('comment', { thread: id, body: '' });
    await pause(1000);
    assert.equal((await fakeRuns(settingsDir)).length, 1);
    assert.equal((await threadOf(state, id)).resolved, false);
  });
});

test('deleting a buddy stops its runs', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir }) => {
    const { id } = await call('comment', { anchor: null, body: '@Pilot hold replace "extra load" with "peak load"' });
    await until(async () => (await fakeRuns(settingsDir)).length === 1, 'the run');
    await call('deleteBuddy', { name: 'Pilot' });
    await writeFile(join(settingsDir, 'release-Pilot'), '');
    await pause(1000);
    assert.equal((await threadOf(state, id)).comments.length, 1);
    assert.match((await state()).text, /extra load/);
  });
});

test('a comment by another user that @mentions a buddy runs nothing; one by you does', { timeout: 30_000 }, async () => {
  const theirs = { id: 'c_theirs001', by: { id: 'u_someone1', name: 'sam', kind: 'human' }, at: '2026-10-01T10:00:00Z', body: '@Pilot replace "extra load" with "peak"' };
  await withDoc(async ({ call, state, settingsDir }) => {
    await pause(1000);
    assert.deepEqual(await fakeRuns(settingsDir), []);
    await call('comment', { thread: theirs.id, body: '@Pilot replace "extra load" with "peak load"' });
    await until(async () => (await threadOf(state, theirs.id)).comments.length === 3, 'Pilot\'s reply');
    assert.equal((await fakeRuns(settingsDir)).length, 1);
  }, { sidecar: `{"opendoc":3}\n${line(theirs)}\n` });
});

test('a v1 sidecar is not read, and its bytes are unchanged', async () => {
  const v1 = '{\n  "opendoc": 1,\n  "doc": "plan.md",\n  "threads": [],\n  "participants": []\n}\n';
  const docPath = await tempDoc();
  await writeFile(`${docPath}.opendoc.json`, v1);
  const settingsDir = await fakeConfig();
  const { doc, call, state } = await openTestDoc(docPath, { settingsDir, buddies: PILOT });
  try {
    const now = await state();
    assert.deepEqual(now.threads, []);
    assert.equal(now.notice, null);
    await call('comment', { anchor: null, body: 'New comments go to the new file' });
    await doc.moveTo(join(dirname(docPath), 'renamed.md'));
    assert.equal(await readFile(`${docPath}.opendoc.json`, 'utf8'), v1, 'byte for byte, where it was');
  } finally {
    await doc.close();
  }
});

test('a sidecar of another version, or without a header, is shown read-only; a bad line is reported and kept', async () => {
  const theirs = { id: 'c_theirs1', anchor: null, by: { id: 'u_sam', name: 'Sam', kind: 'human' }, at: '2026-01-01T00:00:00Z', body: 'Hi' };
  for (const [header, readOnly] of [['{"opendoc":2}', 'older'], ['{"opendoc":4}', 'newer'], ['<<<<<<< HEAD', 'invalid']]) {
    const sidecar = `${header}\n${JSON.stringify(theirs)}\n`;
    await withDoc(async ({ call, state, docPath }) => {
      const now = await state();
      assert.equal(now.readOnly, readOnly);
      assert.deepEqual(now.threads.map((t) => t.id), ['c_theirs1']);
      await assert.rejects(call('comment', { anchor: null, body: 'x' }), refused('read_only'));
      assert.equal(await readFile(sidecarPath(docPath), 'utf8'), sidecar);
    }, { sidecar });
  }
  await withDoc(async ({ call, state, docPath }) => {
    assert.match((await state()).notice, /A line of plan\.md\.opendoc\.jsonl could not be read/);
    assert.equal((await state()).readOnly, null);
    await call('comment', { anchor: null, body: 'x' });
    assert.equal((await readFile(sidecarPath(docPath), 'utf8')).split('\n')[1], 'not json', 'kept as it is');
  }, { sidecar: '{"opendoc":3}\nnot json\n' });
});

test('events: the sidecar and the doc changed on disk', { timeout: 15_000 }, async () => {
  await withDoc(async ({ events, docPath }) => {
    await writeFile(sidecarPath(docPath), '{"opendoc":3}\n');
    await until(() => events.some(([name]) => name === 'sidecar'), 'a sidecar event');
    await writeFile(docPath, SAMPLE.replace('Q4 Launch Plan', 'Q4 Plan'));
    await until(() => events.some(([name]) => name === 'doc'), 'a doc event');
  });
});

test('a doc renamed while open is found at its new path, with its comments', async () => {
  await withDoc(async ({ doc, call, state, docPath }) => {
    const before = await state();
    await call('comment', { anchor: null, body: 'keep me' });
    const newPath = join(dirname(docPath), 'launch.md');
    // A save sent while the rename runs waits for it, then lands in the new file.
    const [moved, saved] = await Promise.all([
      doc.moveTo(newPath),
      call('saveDoc', { text: SAMPLE.replace('Q4', 'Q1'), baseHash: before.docHash }),
    ]);
    assert.equal(moved, newPath);
    assert.equal(doc.docPath(), newPath);
    assert.ok(!saved.conflict);
    assert.deepEqual((await readdir(dirname(docPath))).filter((f) => f !== '.opendoc').sort(), ['launch.md', 'launch.md.opendoc.jsonl']);
    assert.match(await readFile(newPath, 'utf8'), /Q1 Launch Plan/);
    const after = await state();
    assert.equal(after.doc, 'launch.md');
    assert.equal(after.threads[0].comments[0].body, 'keep me');
    await assert.rejects(doc.moveTo(newPath), /already exists/);
  });
});

test('settings: saved for every window; a bad patch is refused; another window\'s change arrives as an event', { timeout: 15_000 }, async () => {
  await withDoc(async ({ call, events, settingsDir }) => {
    const saved = await call('saveSettings', { theme: 'dark' });
    assert.equal(saved.settings.theme, 'dark');
    assert.equal(JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8')).theme, 'dark');
    for (const patch of [{ theme: 'comic' }, { colour: 'red' }, { id: 'u_someone' }, { agents: [] }, { face: 'x' }]) {
      await assert.rejects(call('saveSettings', patch), refused('bad_input'), JSON.stringify(patch));
    }
    const other = await openTestDoc(await tempDoc(), { settingsDir });
    try {
      await other.call('saveSettings', { theme: 'light' });
      await until(() => events.some(([name, data]) => name === 'settings' && data.theme === 'light'), 'the settings event');
    } finally {
      await other.doc.close();
    }
  });
});

test('a doc deleted while open: missing event, saves refused, recreate writes it back', { timeout: 15_000 }, async () => {
  await withDoc(async ({ doc, call, state, events, docPath }) => {
    const before = await state();
    const last = (name) => events.filter(([n]) => n === name).at(-1)?.[1];
    await pause(200);
    await rm(docPath);
    await until(() => last('missing')?.missing === true, 'the missing event');
    assert.equal(last('missing').doc, 'plan.md');
    assert.equal(doc.hello().missing, true, 'a window that connects now hears it too');
    await assert.rejects(call('saveDoc', { text: '# Back\n', baseHash: before.docHash }), refused('no_doc'));
    await call('saveDoc', { text: '# Back\n', baseHash: before.docHash, recreate: true });
    assert.equal(await readFile(docPath, 'utf8'), '# Back\n');
    await until(() => last('missing')?.missing === false, 'the doc back');
    // Recreate on a doc that is there is an ordinary conditional save.
    assert.equal((await call('saveDoc', { text: 'x', baseHash: 'sha256:0', recreate: true })).conflict, true);
  });
});

test('an @name typed in the doc text is plain text: it asks no one', { timeout: 15_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir }) => {
    await call('saveDoc', { text: `${SAMPLE}\nShip it. @Pilot add the risks here.\n`, baseHash: (await state()).docHash });
    await pause(1500);
    assert.deepEqual((await state()).threads, []);
    assert.deepEqual(await fakeRuns(settingsDir), []);
  });
});

test('several docs open at once: each saves, comments and runs its buddies', { timeout: 30_000 }, async () => {
  const settingsDir = await fakeConfig();
  const opened = await Promise.all([0, 1, 2].map(async () => openTestDoc(await tempDoc(), { settingsDir, buddies: PILOT })));
  try {
    await Promise.all(opened.map(async ({ call, state }, i) => {
      await call('saveDoc', { text: SAMPLE.replace('Q4', `Q${i}`), baseHash: (await state()).docHash });
      await call('comment', { anchor: null, body: `@Pilot replace "extra load" with "load ${i}"` });
    }));
    for (const [i, { state, doc }] of opened.entries()) {
      await until(async () => (await state()).threads[0].comments.length === 2, `doc ${i}'s reply`);
      const text = await readFile(doc.docPath(), 'utf8');
      assert.match(text, new RegExp(`# Q${i} Launch Plan`));
      assert.match(text, new RegExp(`load ${i}\\.`));
    }
  } finally {
    await Promise.all(opened.map(({ doc }) => doc.close()));
  }
});

test('a person is shown by the name in their latest comment', async () => {
  const old = { id: 'c_frank0001', by: { id: 'u_frank001', name: 'fanzhang', kind: 'human' }, at: '2026-10-01T10:00:00Z', body: 'first' };
  const later = { id: 'c_frank0002', thread: old.id, by: { id: 'u_frank001', name: 'Frank', kind: 'human' }, at: '2026-10-02T10:00:00Z', body: 'second' };
  await withDoc(async ({ state }) => {
    assert.deepEqual((await state()).people, [{ id: 'u_frank001', name: 'Frank' }]);
  }, { sidecar: `{"opendoc":3}\n${line(old)}\n${line(later)}\n` });
});
