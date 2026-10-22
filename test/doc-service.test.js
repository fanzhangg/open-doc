// DocService (src/host/doc-service.js) on real files, called as a window
// calls it. Buddies run the fake agent script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { appendFile, chmod, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sidecarPath } from '../src/store/files.js';
import { openDoc } from '../src/host/doc-service.js';
import { apply } from '../src/core/ot.js';
import { readHistory } from '../src/store/history.js';
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

test('state returns the doc, its revision, its threads and who you are', async () => {
  await withDoc(async ({ state }) => {
    const now = await state();
    assert.equal(now.doc, 'plan.md');
    assert.equal(now.text, SAMPLE);
    assert.equal(now.rev, 0);
    assert.match(now.epoch, /^e_/);
    assert.deepEqual(now.threads, []);
    assert.equal(now.notice, null);
    assert.deepEqual(now.me, { id: now.me.id, name: 'fzhan', kind: 'human' });
    assert.match(now.me.id, /^u_/);
  });
});

test('an edit lands on its revision, is written, then told to every window; one on a revision gone is stale', async () => {
  await withDoc(async ({ call, edit, state, events, docPath }) => {
    const before = await state();
    const next = SAMPLE.replace('## Risks', '## Main risks');
    assert.deepEqual(await edit(next), { rev: 1 });
    assert.equal(await readFile(docPath, 'utf8'), next);
    const told = events.filter(([name]) => name === 'ops').map(([, data]) => data);
    assert.deepEqual(told.map(({ epoch, rev, id }) => [epoch, rev, id]), [[before.epoch, 1, 'test.1']].map(([e, r]) => [e, r, told[0].id]));
    assert.match(told[0].id, /^test\./);
    assert.equal(apply(SAMPLE, told[0].ops), next);

    // From the revision before: moved over what landed since, by character.
    await edit(SAMPLE.replace('Q4', 'Q1'), before);
    assert.equal(await readFile(docPath, 'utf8'), next.replace('Q4', 'Q1'));
    assert.equal((await state()).rev, 2);

    for (const from of [{ ...before, epoch: 'e_gone' }, { ...before, rev: 7 }]) await assert.rejects(edit('x', from), refused('stale'));
    for (const ops of [null, [{ from: 2, to: 1, insert: '' }], [{ from: 5, to: 6, insert: 'a' }, { from: 3, to: 3, insert: 'b' }]]) {
      await assert.rejects(call('submit', { ops, rev: 2, epoch: before.epoch, id: 'x' }), refused('bad_input'));
    }
    await assert.rejects(call('submit', { ops: [{ from: 0, to: 9999, insert: '' }], rev: 2, epoch: before.epoch, id: 'x' }), refused('bad_input'));
  });
});

test('A3: an edit sent again with its id lands once, and is answered as it was', async () => {
  await withDoc(async ({ call, state, docPath }) => {
    const before = await state();
    const submit = { ops: [{ from: 0, to: 0, insert: 'Hello ' }], rev: before.rev, epoch: before.epoch, id: 'page.1' };
    assert.deepEqual(await call('submit', submit), { rev: 1 });
    await call('submit', { ops: [{ from: 0, to: 0, insert: '> ' }], rev: 1, epoch: before.epoch, id: 'other.1' });
    assert.deepEqual(await call('submit', submit), { rev: 1 }, 'sent again: the line dropped before its answer');
    assert.equal(await readFile(docPath, 'utf8'), `> Hello ${SAMPLE}`);
  });
});

test('C5: state since a rev gives the events missed, as they were told, while the log holds them', async () => {
  await withDoc(async ({ call, edit, state, events }) => {
    const before = await state();
    await edit(`A${SAMPLE}`);
    await edit(`AB${SAMPLE}`);
    const told = events.filter(([name]) => name === 'ops').map(([, data]) => data);
    assert.deepEqual((await call('state', { since: { epoch: before.epoch, rev: 0 } })).events, told);
    assert.deepEqual((await call('state', { since: { epoch: before.epoch, rev: 2 } })).events, []);
    for (const since of [{ epoch: 'e_gone', rev: 0 }, { epoch: before.epoch, rev: 3 }, undefined]) assert.equal((await call('state', { since })).events, undefined);
  });
});

test('the doc is its text: a byte order mark and CRLF line ends are kept on disk only', async () => {
  await withDoc(async ({ edit, state, docPath }) => {
    const now = await state();
    assert.equal(now.text, '# Title\n\nOld text.\n');
    await edit('# Title\n\nNew text.\n', now);
    assert.equal(await readFile(docPath, 'utf8'), '\uFEFF# Title\r\n\r\nNew text.\r\n');
  }, { content: '\uFEFF# Title\r\n\r\nOld text.\r\n' });
});

test('a doc that is not UTF-8 does not open, and is left as it is', async () => {
  const gbk = Buffer.from([0x23, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]); // "# 你好" in GBK
  const docPath = await tempDoc(gbk);
  await assert.rejects(openDoc(docPath, { settingsDir: await fakeConfig() }), refused('not_text'));
  assert.deepEqual(await readFile(docPath), gbk);
});

test('A5: a line added to a doc of mixed line ends ends as the line before it; every other line ends as it did; the file keeps its permissions', async () => {
  const content = 'One\r\nTwo\nThree\r\n';
  await withDoc(async ({ edit, state, docPath }) => {
    if (process.platform !== 'win32') await chmod(docPath, 0o750);
    await edit('One\nTwo\nAdded\nThree\n', await state());
    assert.equal(await readFile(docPath, 'utf8'), 'One\r\nTwo\nAdded\nThree\r\n');
    if (process.platform !== 'win32') assert.equal((await stat(docPath)).mode & 0o777, 0o750);
  }, { content });
});

test('C4: a doc made other than UTF-8 outside says Not saved at once, until it is text again', async () => {
  await withDoc(async ({ events, docPath, edit, state }) => {
    const saved = () => events.filter(([name]) => name === 'saved').map(([, data]) => data.error);
    await writeFile(docPath, Buffer.from('\uFEFF# Title\n', 'utf16le'));
    await until(() => saved().length === 1, 'Not saved told');
    assert.match(saved()[0], /other than UTF-8/);
    await assert.rejects(edit('# Title\n\nTyped.\n', await state()), refused('not_saved'));
    await writeFile(docPath, '# Title\n\nOld text.\n');
    await until(() => saved().length === 2, 'saved told');
    assert.equal(saved()[1], null);
    assert.equal(await readFile(docPath, 'utf8'), '# Title\n\nTyped.\n');
  }, { content: '# Title\n\nOld text.\n' });
});

test('comments: written as the user, one line each; the anchor is never rewritten, and a reader finds it', async () => {
  await withDoc(async ({ call, edit, state, docPath }) => {
    const anchor = { exact: 'extra load', prefix: 'service cannot handle the ', suffix: '.', start: SAMPLE.indexOf('extra load') };
    const { id, threads } = await call('comment', { anchor, body: 'Is this right?' });
    assert.match(id, /^c_/);
    const [first] = threads[0].comments;
    assert.equal(first.by.id, (await state()).me.id, 'the page cannot post as someone else');
    await call('comment', { thread: id, body: 'More.' });
    const lines = (await readFile(sidecarPath(docPath), 'utf8')).trimEnd().split('\n');
    assert.equal(lines[0], '{"comments":3}');
    assert.deepEqual(lines.slice(1).map((l) => JSON.parse(l).body), ['Is this right?', 'More.']);
    assert.deepEqual(JSON.parse(lines[1]).anchor, anchor);

    await edit(SAMPLE.replace('The main risk', 'The one main risk'));
    const moved = (await threadOf(state, id)).anchor;
    assert.deepEqual([moved.exact, moved.start], ['extra load', anchor.start + 4], 'found where its text is now');
    assert.deepEqual(JSON.parse((await readFile(sidecarPath(docPath), 'utf8')).split('\n')[1]).anchor, anchor, 'never rewritten');
    await edit(SAMPLE.replace('The main risk is that the `sync` service cannot handle the extra load.\n', ''));
    assert.equal((await threadOf(state, id)).detached, true);

    for (const bad of [{ body: '' }, { anchor: { exact: '' }, body: 'x' }, { body: 'x', resolved: true }]) await assert.rejects(call('comment', bad), refused('bad_input'));
    await assert.rejects(call('comment', { thread: 'c_nothere1', body: 'x' }), refused('not_found'));
    await assert.rejects(call('nope'), refused('bad_input'));
  });
});

test('an outside change found when an edit is written lands where the edit did not change the line; where it did, the edit stays', async () => {
  await withDoc(async ({ edit, state, docPath, settingsDir }) => {
    const before = await state();
    const typed = edit(SAMPLE.replace('## Risks', '## Main risks').replace('beta cohort', 'beta testers'));
    writeFileSync(docPath, SAMPLE.replace('Q4', 'Q1').replace('beta cohort', 'early users')); // before the edit lands
    await typed;
    const text = (await state()).text;
    assert.equal(text, SAMPLE.replace('Q4', 'Q1').replace('## Risks', '## Main risks').replace('beta cohort', 'beta testers'));
    assert.equal(await readFile(docPath, 'utf8'), text);
    const versions = await readHistory(docPath, settingsDir);
    assert.deepEqual(versions.map((v) => v.kind), ['opened', 'external', 'edit'], 'the outside version is in history');
    assert.notEqual(before.rev, (await state()).rev);
  });
});

test('an edit after a buddy\'s, on the same text: undoing the buddy\'s keeps what the person changed, and takes back the rest', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, edit, state }) => {
    const { id } = await call('comment', { anchor: null, body: '@Pilot replace "extra load" with "peak load"' });
    const replyId = (await until(async () => (await threadOf(state, id)).comments.length === 2 && (await threadOf(state, id)).comments, 'the reply')).at(-1).id;
    await edit((await state()).text.replace('peak load', 'traffic').replace('Q4', 'Q1'));
    const { versions } = await call('history');
    assert.equal(versions.at(-2).reply, replyId);
    assert.equal(versions.at(-1).reply, undefined);
    await call('undoReply', { id: replyId });
    assert.match((await state()).text, /handle the traffic\./, 'the buddy\'s change there was the person\'s to keep');
    assert.match((await state()).text, /Q1 Launch Plan/);
  });
});

test('a person\'s edit that started before a buddy\'s turn landed wins its line, and the turn is marked conflict', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, edit, state }) => {
    const before = await state();
    const ask = async (body) => {
      const { id } = await call('comment', { anchor: null, body });
      return (await until(async () => (await threadOf(state, id)).comments.length === 2 && (await threadOf(state, id)).comments, 'the reply')).at(-1).id;
    };
    const apart = await ask('@Pilot replace "Q4 Launch" with "Q1 Launch"');
    await edit(before.text.replace('beta cohort', 'beta testers'), before); // typed on the text before the turn
    assert.equal((await state()).edits[apart].conflict, false, 'on another line: nothing taken back');
    const now = await state();
    const same = await ask('@Pilot replace "beta testers" with "beta group"');
    await edit(now.text.replace('beta testers', 'beta folks'), now); // the same word
    const after = await state();
    assert.match(after.text, /Q1 Launch Plan/);
    assert.match(after.text, /beta folks/);
    assert.doesNotMatch(after.text, /group/);
    assert.equal(after.edits[same].conflict, true);
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

test('the door: each call needs a level, and a comment is by whoever calls, never by what the call says', async () => {
  await withDoc(async ({ doc, state }) => {
    const owner = await doc.owner();
    const at = (level) => ({ ...owner, level });
    assert.equal((await doc.call('state', undefined, at('read'))).rev, 0);
    await assert.rejects(doc.call('comment', { anchor: null, body: 'x' }, at('read')), refused('forbidden'));
    await assert.rejects(doc.call('saveSettings', { theme: 'dark' }, at('write')), refused('forbidden'));
    await assert.rejects(doc.call('state'), refused('forbidden'), 'no one may do anything');
    const pilot = { id: 'Pilot', name: 'Pilot', kind: 'ai', level: 'write' };
    const { rev, epoch } = await state();
    await doc.call('submit', { ops: [{ from: 0, to: 0, insert: '> ' }], rev, epoch, id: 'p.1' }, pilot);
    const { id } = await doc.call('comment', { anchor: null, body: 'Mine.', by: owner }, pilot);
    assert.deepEqual((await threadOf(state, id)).comments[0].by, { id: 'Pilot', name: 'Pilot', kind: 'ai' });
    await doc.call('comment', { thread: id, body: '', resolved: true }, pilot);
    assert.equal((await threadOf(state, id)).resolved, true, 'a buddy that may write resolves');
  });
});

test('the project\'s files, at the door: whoever may read lists, reads and opens what the project shows', async () => {
  await withDoc(async ({ doc, docPath, settingsDir }) => {
    const reader = { ...(await doc.owner()), level: 'read' };
    assert.deepEqual(await doc.call('list', { path: '' }, reader), [{ name: 'plan.md', folder: false, ignored: false }], '.ponjo is not shown');
    assert.deepEqual(await doc.call('read', { path: 'plan.md' }, reader), { text: SAMPLE });
    assert.deepEqual(await doc.call('open', { path: 'plan.md' }, reader), { path: 'plan.md' }, 'the real path is the owner\'s');
    assert.deepEqual(await doc.call('open', { path: 'plan.md' }, await doc.owner()), { path: await realpath(docPath) });
    await assert.rejects(doc.call('read', { path: '.ponjo/buddies/Pilot.md' }, reader), refused('not_found'));
    await assert.rejects(doc.call('list', { path: '' }), refused('forbidden'), 'no one may list');
    const alone = await openTestDoc(await tempDoc(), { settingsDir });
    try {
      await assert.rejects(alone.call('list', { path: '' }), refused('bad_input'), 'a doc on its own has no project');
    } finally {
      await alone.doc.close();
    }
  });
});

test('a buddy asked to resolve resolves its thread with its reply; the other buddies there stop', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir }) => {
    const { id } = await call('comment', { anchor: null, body: '@Clippy @Pilot hold;; resolve' });
    await until(async () => (await fakeRuns(settingsDir)).length === 2, 'both runs');
    await writeFile(join(settingsDir, 'release-Clippy'), '');
    await until(async () => (await threadOf(state, id)).resolved, 'the thread resolved');
    await until(async () => (await state()).agents.every((a) => a.state !== 'running'), 'Pilot to stop');
    await writeFile(join(settingsDir, 'release-Pilot'), '');
    await pause(500);
    const { comments } = await threadOf(state, id);
    assert.deepEqual(comments.map((c) => [c.by.name, c.body, c.resolved ?? false]), [['fzhan', '@Clippy @Pilot hold;; resolve', false], ['Clippy', 'Nothing to change.', true]]);
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

test('a thread resolved in the file, not by a call, stops its buddy too', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir, docPath }) => {
    const { id } = await call('comment', { anchor: null, body: '@Pilot hold replace "extra load" with "peak load"' });
    await until(async () => (await fakeRuns(settingsDir)).length === 1, 'the run');
    const { me } = await state();
    const resolving = { id: 'c_byhand001', thread: id, by: me, at: new Date(Date.now() + 1000).toISOString(), body: '', resolved: true };
    await appendFile(sidecarPath(docPath), `${JSON.stringify(resolving)}\n`);
    await until(async () => (await state()).agents.every((a) => a.state !== 'running'), 'the run to stop');
    await writeFile(join(settingsDir, 'release-Pilot'), '');
    await pause(500);
    assert.equal((await threadOf(state, id)).comments.length, 2, 'no reply landed');
    assert.match((await state()).text, /extra load/);
  });
});

test('a sidecar that cannot be written ends the runs: a reply could not be posted', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir, docPath }) => {
    const { id } = await call('comment', { anchor: null, body: '@Pilot hold replace "extra load" with "peak load"' });
    await until(async () => (await fakeRuns(settingsDir)).length === 1, 'the run');
    const before = await readFile(sidecarPath(docPath), 'utf8');
    await writeFile(sidecarPath(docPath), before.replace('{"comments":3}', '{"comments":9}'));
    await until(async () => (await state()).agents.every((a) => a.state !== 'running'), 'the run to stop');
    await writeFile(join(settingsDir, 'release-Pilot'), '');
    await pause(500);
    assert.match((await state()).text, /extra load/, 'nothing it did landed');
    assert.ok((await state()).readOnly, `thread ${id} is read-only`);
  });
});

test('a buddy that has answered is not run again by its own reply', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir }) => {
    const { id } = await call('comment', { anchor: null, body: '@Pilot replace "extra load" with "peak load"' });
    await until(async () => (await threadOf(state, id)).comments.length === 2, 'the reply');
    await pause(1500);
    assert.equal((await fakeRuns(settingsDir)).length, 1);
    assert.equal((await threadOf(state, id)).comments.length, 2);
  });
});

test('deleting a buddy stops its runs', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir }) => {
    const { id } = await call('comment', { anchor: null, body: '@Pilot hold replace "extra load" with "peak load"' });
    await until(async () => (await fakeRuns(settingsDir)).length === 1, 'the run');
    await call('deleteBuddy', { id: 'Pilot' });
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
  }, { sidecar: `{"comments":3}\n${line(theirs)}\n` });
});

test('a comment of yours that reached the sidecar from outside is shown but runs nothing; the same text through a call does', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir, docPath }) => {
    const { me } = await state();
    const outside = { id: 'c_outside1', by: me, at: new Date().toISOString(), body: '@Pilot replace "extra load" with "peak load"' };
    await writeFile(sidecarPath(docPath), `{"comments":3}\n${line(outside)}\n`);
    await until(async () => threadOf(state, outside.id), 'the comment shown');
    await pause(1000);
    assert.deepEqual(await fakeRuns(settingsDir), []);
    const { id } = await call('comment', { anchor: null, body: outside.body });
    await until(async () => (await threadOf(state, id)).comments.length === 2, 'Pilot\'s reply');
    assert.equal((await fakeRuns(settingsDir)).length, 1);
  });
});

test('a comment changed outside since it was taken stops asking', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, settingsDir, docPath }) => {
    const { id } = await call('comment', { anchor: null, body: '@Pilot hold replace "extra load" with "peak load"' });
    await until(async () => (await fakeRuns(settingsDir)).length === 1, 'the run');
    await writeFile(sidecarPath(docPath), (await readFile(sidecarPath(docPath), 'utf8')).replace('peak load', 'any load'));
    await until(async () => (await state()).agents.every((a) => a.state !== 'running'), 'the run to stop');
    await writeFile(join(settingsDir, 'release-Pilot'), '');
    await pause(1000);
    assert.equal((await threadOf(state, id)).comments.length, 1, 'no reply landed');
    assert.match((await state()).text, /extra load/);
    assert.equal((await fakeRuns(settingsDir)).length, 1);
  });
});

test('a taken ask still unanswered asks again when the doc opens again, and after a rename in the app', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc();
  const settingsDir = await fakeConfig();
  const first = await openTestDoc(docPath, { settingsDir, buddies: PILOT });
  await first.call('comment', { anchor: null, body: '@Pilot hold' });
  await until(async () => (await fakeRuns(settingsDir)).length === 1, 'the run');
  await first.doc.close();
  const again = await openTestDoc(docPath, { settingsDir, buddies: PILOT });
  try {
    await until(async () => (await fakeRuns(settingsDir)).length === 2, 'the run after opening again');
    await again.doc.moveTo(join(dirname(docPath), 'launch.md'));
    await until(async () => (await fakeRuns(settingsDir)).length === 3, 'the run at the new name');
  } finally {
    await again.doc.close();
  }
});

test('a sidecar of another version, or without a header, is shown read-only; a bad line is reported and kept', async () => {
  const theirs = { id: 'c_theirs1', anchor: null, by: { id: 'u_sam', name: 'Sam', kind: 'human' }, at: '2026-01-01T00:00:00Z', body: 'Hi' };
  for (const [header, readOnly] of [['{"comments":2}', 'older'], ['{"comments":4}', 'newer'], ['<<<<<<< HEAD', 'invalid']]) {
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
    assert.match((await state()).notice, /A line of plan\.md\.comments\.jsonl could not be read/);
    assert.equal((await state()).readOnly, null);
    await call('comment', { anchor: null, body: 'x' });
    assert.equal((await readFile(sidecarPath(docPath), 'utf8')).split('\n')[1], 'not json', 'kept as it is');
  }, { sidecar: '{"comments":3}\nnot json\n' });
});

test('events: the sidecar changed on disk; the doc changed outside lands as an edit', { timeout: 15_000 }, async () => {
  await withDoc(async ({ events, docPath, state }) => {
    await writeFile(sidecarPath(docPath), '{"comments":3}\n');
    await until(() => events.some(([name]) => name === 'sidecar'), 'a sidecar event');
    await writeFile(docPath, SAMPLE.replace('Q4 Launch Plan', 'Q4 Plan'));
    const [, landed] = await until(() => events.find(([name]) => name === 'ops'), 'an ops event');
    assert.deepEqual([landed.rev, landed.id], [1, null]);
    assert.equal((await state()).text, SAMPLE.replace('Q4 Launch Plan', 'Q4 Plan'));
  });
});

test('a doc renamed while open is found at its new path, with its comments', async () => {
  await withDoc(async ({ doc, call, edit, state, docPath }) => {
    await call('comment', { anchor: null, body: 'keep me' });
    const newPath = join(dirname(docPath), 'launch.md');
    // An edit sent while the rename runs waits for it, then lands in the new file.
    const [moved] = await Promise.all([doc.moveTo(newPath), edit(SAMPLE.replace('Q4', 'Q1'))]);
    assert.equal(moved, newPath);
    assert.equal(doc.docPath(), newPath);
    assert.deepEqual((await readdir(dirname(docPath))).filter((f) => f !== '.ponjo').sort(), ['launch.md', 'launch.md.comments.jsonl']);
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

test('a doc deleted while open: missing event, edits kept but not written, recreate writes it back', { timeout: 15_000 }, async () => {
  await withDoc(async ({ doc, call, edit, state, events, docPath }) => {
    const last = (name) => events.filter(([n]) => n === name).at(-1)?.[1];
    await pause(200);
    await rm(docPath);
    await until(() => last('missing')?.missing === true, 'the missing event');
    assert.equal(last('missing').doc, 'plan.md');
    assert.equal(doc.hello().missing, true, 'a window that connects now hears it too');
    await edit('# Back\n');
    await assert.rejects(readFile(docPath), /ENOENT/);
    assert.equal(last('ops').rev, 1, 'told, though not written');
    await call('recreate');
    assert.equal(await readFile(docPath, 'utf8'), '# Back\n');
    await until(() => last('missing')?.missing === false, 'the doc back');
    assert.equal((await state()).text, '# Back\n');
    await call('recreate'); // a doc that is there: nothing to do
    assert.equal(await readFile(docPath, 'utf8'), '# Back\n');
  });
});

test('an @name typed in the doc text is plain text: it asks no one', { timeout: 15_000 }, async () => {
  await withDoc(async ({ edit, state, settingsDir }) => {
    await edit(`${SAMPLE}\nShip it. @Pilot add the risks here.\n`);
    await pause(1500);
    assert.deepEqual((await state()).threads, []);
    assert.deepEqual(await fakeRuns(settingsDir), []);
  });
});

test('several docs open at once: each saves, comments and runs its buddies', { timeout: 30_000 }, async () => {
  const settingsDir = await fakeConfig();
  const opened = await Promise.all([0, 1, 2].map(async () => openTestDoc(await tempDoc(), { settingsDir, buddies: PILOT })));
  try {
    await Promise.all(opened.map(async ({ call, edit }, i) => {
      await edit(SAMPLE.replace('Q4', `Q${i}`));
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
  }, { sidecar: `{"comments":3}\n${line(old)}\n${line(later)}\n` });
});
