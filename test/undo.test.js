// Undo and history (docs/architecture.md, Undo): a buddy's edit is
// undone from its reply; an outside change never beats typing; every undo
// and restore is a version. Buddies run the fake agent script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { merge3 } from '../src/core/merge.js';
import { SAMPLE, fakeConfig, openTestDoc, tempDoc, until } from './helpers.js';

async function withDoc(fn) {
  const docPath = await tempDoc();
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
  // Save as the page does: on the doc as last read.
  const type = async (from, to) => {
    const now = await opened.state();
    assert.ok(now.markdown.includes(from), from);
    await opened.call('saveDoc', { markdown: now.markdown.replace(from, to), baseHash: now.docHash });
  };
  try {
    await fn({ ...opened, docPath, versions, disk, ask, type });
  } finally {
    await opened.doc.close();
  }
}

test('Undo on a reply removes that buddy\'s edit and keeps later edits, yours and another buddy\'s', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, ask, type, disk, versions }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    const run = (await state()).edits[ada.id];
    assert.deepEqual({ ...run, hash: undefined, version: undefined }, { state: 'edited', by: 'Ada', changes: 1, hash: undefined, version: undefined }, 'the receipt: who, how many places');
    assert.equal(run.hash, (await state()).docHash, 'the page tells the run that wrote the doc by its hash');
    assert.equal((await call('version', { id: run.version })).version.reply, ada.id, 'the page shows the run\'s edits from its version');
    await type('week one', 'week 1');
    await ask('@Ben replace "beta cohort" with "beta group"');

    await call('undoReply', { id: ada.id });
    const text = await disk();
    assert.match(text, /the extra load\./);
    assert.match(text, /week 1/);
    assert.match(text, /beta group/);
    assert.equal((await state()).edits[ada.id].state, 'undone');
    const last = (await versions()).at(-1);
    assert.deepEqual([last.kind, last.undid, last.author.name], ['undo', ada.id, 'fzhan']);

    await assert.rejects(call('undoReply', { id: 'c_nothere1' }), (error) => error.code === 'not_found');
  });
});

test('where you changed the buddy\'s text since, Undo leaves your text and asks nothing', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, ask, type, disk }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    await ask('@Ben replace "week one" with "week two"');
    await type('extra peak load', 'extra huge load');
    await call('undoReply', { id: ada.id });
    const text = await disk();
    assert.match(text, /the extra huge load\./);
    assert.match(text, /week two/);
  });
});

test('where another buddy changed the run\'s text since, Undo leaves that change and takes back the rest', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, ask, disk }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    await ask('@Ada replace "week one" with "week two"').then(() => null);
    const both = await ask('@Ada replace "beta cohort" with "beta group"');
    await ask('@Ben replace "beta group" with "beta crew"');
    await call('undoReply', { id: both.id });
    assert.match(await disk(), /beta crew/, "Ben's change of the run's text stays");
    await call('undoReply', { id: ada.id });
    const text = await disk();
    assert.match(text, /the extra load\./);
    assert.match(text, /week two/);
  });
});

test('an outside change (git pull) to the paragraph being typed: the typing stays, the pulled version is in history', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, docPath, disk, versions }) => {
    const before = await state();
    const typed = before.markdown.replace('extra load.', 'extra load at launch.');
    const pulled = SAMPLE.replace('The main risk is', 'The risk we see is');
    await writeFile(docPath, pulled);
    const saved = await call('saveDoc', { markdown: typed, baseHash: before.docHash });
    assert.equal(saved.conflict, true, 'the page learns the file changed');
    // The page merges what it has into the file, its own text first (web/main.js).
    const merged = merge3(before.markdown, typed, saved.markdown, { prefer: 'ours' });
    await call('saveDoc', { markdown: merged.text, baseHash: saved.docHash });
    assert.match(await disk(), /The risk we see is .* extra load at launch\./);
    const external = (await versions()).filter((v) => v.kind === 'external');
    assert.equal(external.length, 1);
    assert.equal((await call('version', { id: external[0].id })).markdown, pulled);

    // Where the two overlap, the typing wins and the pulled text is only in history.
    const now = await state();
    const mine = now.markdown.replace('beta cohort', 'beta testers');
    const theirs = now.markdown.replace('beta cohort', 'early users');
    await writeFile(docPath, theirs);
    const again = await call('saveDoc', { markdown: mine, baseHash: now.docHash });
    await call('saveDoc', { markdown: merge3(now.markdown, mine, again.markdown, { prefer: 'ours' }).text, baseHash: again.docHash });
    assert.match(await disk(), /beta testers/);
    const history = await Promise.all((await versions()).map(async (v) => (await call('version', { id: v.id })).markdown));
    assert.ok(history.includes(theirs), 'the pulled version is saved');
  });
});

test('every undo and restore can itself be restored', { timeout: 30_000 }, async () => {
  await withDoc(async ({ call, state, ask, disk, versions }) => {
    const ada = await ask('@Ada replace "extra load" with "extra peak load"');
    const edited = await disk();
    await call('undoReply', { id: ada.id });
    const undone = await disk();
    assert.notEqual(undone, edited);

    const restore = async (text) => {
      const list = await versions();
      const found = [];
      for (const v of list) if ((await call('version', { id: v.id })).markdown === text) found.push(v);
      await call('restoreVersion', { id: found.at(-1).id, baseHash: (await state()).docHash });
    };
    await restore(edited); // undo the undo
    assert.equal(await disk(), edited);
    assert.equal((await versions()).at(-1).kind, 'restore');
    await restore(undone); // and that restore
    assert.equal(await disk(), undone);
  });
});
