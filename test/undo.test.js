// Undo and history (docs/architecture.md, Undoing changes): a buddy's edit
// is undone from its reply; an outside change never beats typing; every
// undo and restore is a version. Buddies run the fake agent script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { recordVersion } from '../src/store/history.js';
import { SAMPLE, fakeConfig, openTestDoc, tempDoc, until } from './helpers.js';

async function withDoc(fn, content = SAMPLE) {
  const docPath = await tempDoc(content);
  const settingsDir = await fakeConfig();
  const opened = await openTestDoc(docPath, { settingsDir, buddies: { Ada: '\n', Ben: '\n' } });
  const versions = async () => (await opened.call('history')).versions;
  const disk = () => readFile(docPath, 'utf8');
  // Ask a buddy in a comment; its reply once the edit is in.
  const ask = async (body) => {
    const { id } = await opened.call('comment', { anchor: null, body });
    const thread = await until(async () => (await opened.state()).threads.find((t) => t.id === id && t.comments.length === 2), 'the reply');
    return thread.comments[1];
  };
  // Type as the page does: on the doc as last read.
  const type = async (from, to) => {
    const now = await opened.state();
    assert.ok(now.text.includes(from), from);
    await opened.edit(now.text.replace(from, to), now);
  };
  // Undo the edit of buddy reply `id`, as its Undo button does.
  const undoReply = async (id) => opened.call('undo', { id: (await opened.state()).edits[id]?.version ?? 'v_nothere1' });
  try {
    await fn({ ...opened, docPath, settingsDir, versions, disk, ask, type, undoReply });
  } finally {
    await opened.doc.close();
  }
}

test('a buddy\'s edit and its Undo keep the file\'s byte order mark and CRLF line ends', { timeout: 30_000 }, async () => {
  const file = `\uFEFF${SAMPLE.replace(/\n/g, '\r\n')}`;
  await withDoc(async ({ call, ask, docPath, undoReply }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    assert.equal(await readFile(docPath, 'utf8'), file.replace('extra load', 'extra peak load'));
    await undoReply(ada.id);
    assert.equal(await readFile(docPath, 'utf8'), file);
  }, file);
});

test('Undo on a reply removes that buddy\'s edit and keeps later edits, yours and another buddy\'s', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, ask, type, disk, versions, undoReply }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    const run = (await state()).edits[ada.id];
    assert.deepEqual({ ...run, version: undefined }, { state: 'edited', by: 'Ada', changes: 1, version: undefined, conflict: false }, 'the receipt: who, how many places');
    assert.equal((await call('version', { id: run.version })).version.reply, ada.id, 'the page shows the run\'s edits from its version');
    await type('week one', 'week 1');
    await ask('@Ben replace "beta cohort" with "beta group"');

    await undoReply(ada.id);
    const text = await disk();
    assert.match(text, /the extra load\./);
    assert.match(text, /week 1/);
    assert.match(text, /beta group/);
    assert.equal((await state()).edits[ada.id].state, 'undone');
    const last = (await versions()).at(-1);
    assert.deepEqual([last.kind, last.undid, last.author.name], ['undo', run.version, 'fzhan']);

    await assert.rejects(undoReply('c_nothere1'), (error) => error.code === 'not_found');
  });
});

test('where you changed the buddy\'s text since, Undo leaves your text and asks nothing', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, ask, type, disk, undoReply }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    await ask('@Ben replace "week one" with "week two"');
    await type('extra peak load', 'extra huge load');
    await undoReply(ada.id);
    const text = await disk();
    assert.match(text, /the extra huge load\./);
    assert.match(text, /week two/);
  });
});

test('where another buddy changed the run\'s text since, Undo leaves that change and takes back the rest', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, ask, disk, undoReply }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    await ask('@Ada replace "week one" with "week two"').then(() => null);
    const both = await ask('@Ada replace "beta cohort" with "beta group"');
    await ask('@Ben replace "beta group" with "beta crew"');
    await undoReply(both.id);
    assert.match(await disk(), /beta crew/, "Ben's change of the run's text stays");
    await undoReply(ada.id);
    const text = await disk();
    assert.match(text, /the extra load\./);
    assert.match(text, /week two/);
  });
});

test('an outside change (git pull) while typing: it merges where they changed different lines; where both changed a line, the typing stays and the pulled version is in history', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, edit, state, docPath, disk, versions }) => {
    const before = await state();
    const typed = before.text.replace('extra load.', 'extra load at launch.');
    const pulled = SAMPLE.replace('# Q4 Launch Plan', '# Q4 Launch Plan (draft)');
    const typing = edit(typed, before);
    writeFileSync(docPath, pulled); // before the typing lands
    await typing;
    assert.match((await state()).text, /Plan \(draft\)[\s\S]* extra load at launch\./);
    assert.match(await disk(), /Plan \(draft\)[\s\S]* extra load at launch\./);
    const external = (await versions()).filter((v) => v.kind === 'external');
    assert.equal(external.length, 1);
    assert.equal((await call('version', { id: external[0].id })).text, pulled);

    // Where both changed a line, the typing wins and the pulled text is only in history.
    const now = await state();
    const mine = now.text.replace('beta cohort', 'beta testers');
    const theirs = now.text.replace('beta cohort', 'early users');
    const again = edit(mine, now);
    writeFileSync(docPath, theirs);
    await again;
    assert.equal((await state()).text, mine);
    assert.match(await disk(), /beta testers/);
    const history = await Promise.all((await versions()).map(async (v) => (await call('version', { id: v.id })).text));
    assert.ok(history.includes(theirs), 'the pulled version is saved');
  });
});

test('every undo and restore can itself be restored', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, ask, disk, versions, undoReply }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    const edited = await disk();
    await undoReply(ada.id);
    const undone = await disk();
    assert.notEqual(undone, edited);

    const restore = async (text) => {
      const list = await versions();
      const found = [];
      for (const v of list) if ((await call('version', { id: v.id })).text === text) found.push(v);
      await call('restoreVersion', { id: found.at(-1).id });
    };
    await restore(edited); // undo the undo
    assert.equal(await disk(), edited);
    assert.equal((await versions()).at(-1).kind, 'restore');
    await restore(undone); // and that restore
    assert.equal(await disk(), undone);
  });
});

test('a buddy\'s turn is undone after 600 later versions', { timeout: 60_000 }, async () => {
  await withDoc(async ({ ask, disk, docPath, settingsDir, undoReply }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    const text = await disk();
    for (let i = 0; i < 600; i++) await recordVersion(docPath, settingsDir, `${text}${i}\n`, { kind: 'edit', author: { name: 'fzhan', kind: 'human' } });
    await undoReply(ada.id);
    assert.match(await disk(), /the extra load\./);
  });
});

test('any change can be undone from history, a person\'s too, keeping what changed since', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, type, disk, versions }) => {
    await type('week one', 'week 1');
    await until(async () => (await versions()).at(-1).kind === 'edit', 'the typing as a version');
    const typed = (await versions()).at(-1);
    await type('beta cohort', 'beta group');
    await call('history'); // the typing so far is a version too
    await call('undo', { id: typed.id });
    const text = await disk();
    assert.match(text, /week one/);
    assert.match(text, /beta group/);
    await assert.rejects(call('undo', { id: (await versions())[0].id }), (error) => error.code === 'not_found', 'the first version has no change to undo');
  });
});
