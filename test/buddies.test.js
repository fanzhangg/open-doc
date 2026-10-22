// Buddies (spec/PROJECT.md): Clippy, in every doc and changed in the user's
// config folder, and a project's files in .opendoc/buddies/. Runs use the
// fake agent script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIPPY, buddiesHere, buddyText, colorSlots, defaultName, parseBuddy, tagline } from '../src/core/buddies.js';
import { readSettings } from '../src/store/settings.js';
import { SAMPLE, fakeConfig, fakeRuns, openTestDoc, tempDoc, until } from './helpers.js';

const refused = (code) => (error) => error.code === code;
const who = async (opened) => (await opened.state()).agents.map((a) => [a.name, a.about, a.where]);

// A project folder with plan.md and the buddies `files` ({ name: text }) in .opendoc/buddies/.
async function projectFolder(files = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'ponjo-project-'));
  await writeFile(join(folder, 'plan.md'), SAMPLE);
  if (Object.keys(files).length > 0) await mkdir(join(folder, '.opendoc', 'buddies'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(folder, '.opendoc', 'buddies', `${name}.md`), text);
  return folder;
}

async function opening(docPath, options, fn) {
  const opened = await openTestDoc(docPath, options);
  try {
    return await fn(opened);
  } finally {
    await opened.doc.close();
  }
}

test('a buddy file: the name is the file name, the text who it is, its first line the tagline', () => {
  const critic = parseBuddy('Critic', 'Checks every claim.\r\n\r\nQuote the line.\nBe brief.\n');
  assert.deepEqual(critic, { id: 'Critic', name: 'Critic', about: 'Checks every claim.\n\nQuote the line.\nBe brief.' });
  assert.equal(tagline(critic), 'Checks every claim.');
  assert.deepEqual(parseBuddy('Empty', ''), { id: 'Empty', name: 'Empty', about: '' }, 'a file without an id is a buddy by its name');
  const kept = parseBuddy('Critic', '---\nid: b_abc123\n---\nChecks every claim.\n');
  assert.deepEqual(kept, { id: 'b_abc123', name: 'Critic', about: 'Checks every claim.' }, 'the id is not part of who it is');
  assert.equal(buddyText(kept), '---\nid: b_abc123\n---\nChecks every claim.\n');
  assert.equal(buddyText(critic), 'Checks every claim.\n\nQuote the line.\nBe brief.\n');
  assert.deepEqual(parseBuddy('Critic', buddyText(critic)), critic);
  const here = buddiesHere([{ name: 'critic', about: 'project' }, { name: 'clippy', about: 'theirs' }, { name: 'Ada', about: 'project' }]);
  assert.deepEqual(here.map((b) => [b.name, b.where]), [['Clippy', 'app'], ['Ada', 'project'], ['critic', 'project']], "Clippy first, then by name; a project's Clippy is not one");
  assert.equal(here[0], CLIPPY);
});

test('a new buddy is named a common first name, not one taken (in any case), then with a number', () => {
  assert.equal(defaultName([], () => 0), 'Alice');
  assert.equal(defaultName(['alice'], () => 0), 'Ben', 'a taken name is skipped');
  const all = ['Alice', 'Ben', 'Chloe', 'Daniel', 'Emma', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack', 'Kate', 'Leo', 'Maya', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rose', 'Sam', 'Tina', 'Victor', 'Wendy', 'Zoe', 'John'];
  assert.equal(defaultName(all, () => 0), 'Alice2');
  assert.equal(defaultName([...all, 'Alice2'], () => 0), 'Alice3');
});

const CLIPPY_ROW = ['Clippy', CLIPPY.about, 'app'];

test('buddy colors: Clippy has its own; up to seven others get different ones, the same in any order', () => {
  // Seven names that would all pick the same color on their own.
  const alone = (name) => colorSlots([name]).get(name);
  const names = [];
  for (let i = 0; names.length < 7; i++) if (alone(`b${i}`) === alone('b0')) names.push(`b${i}`);
  const slots = colorSlots(['Clippy', ...names]);
  assert.equal(slots.get('clippy'), 0);
  assert.deepEqual(new Set(names.map((n) => slots.get(n))), new Set([1, 2, 3, 4, 5, 6, 7]), 'all seven differ, none is Clippy\'s');
  assert.deepEqual(colorSlots([...names].reverse()), slots, 'the same buddies, the same colors');
  assert.equal(colorSlots(['Ada', 'Critic']).get('ada'), colorSlots(['ada']).get('ada'), 'the first by name keeps the one its name picks');
});

test('Clippy is in every doc: who it is is the user\'s, in their config folder; it keeps its name and stays', { timeout: 30_000 }, async () => {
  const settingsDir = await fakeConfig();
  const folder = await projectFolder();
  const mine = ['Clippy', 'Mine now.\n\nReply in French.', 'app'];
  await opening(join(folder, 'plan.md'), { settingsDir, folder }, async (opened) => {
    assert.deepEqual(await who(opened), [CLIPPY_ROW]);
    await assert.rejects(readdir(join(settingsDir, 'buddies')), { code: 'ENOENT' }, 'nothing written until it is changed');
    await opened.call('updateBuddy', { id: 'Clippy', patch: { about: 'Mine now.\n\nReply in French.' } });
    assert.equal(await readFile(join(settingsDir, 'buddies', 'Clippy.md'), 'utf8'), 'Mine now.\n\nReply in French.\n');
    assert.deepEqual(await who(opened), [mine]);
    await assert.rejects(opened.call('updateBuddy', { id: 'Clippy', patch: { name: 'Clip' } }), refused('bad_input'));
    await assert.rejects(opened.call('deleteBuddy', { id: 'Clippy' }), refused('bad_input'));
    await assert.rejects(opened.call('createBuddy', { buddy: { name: 'clippy' } }), /the name clippy is taken/);
    const { agents } = await opened.call('createBuddy', { buddy: { name: 'Ada' } });
    await assert.rejects(opened.call('updateBuddy', { id: agents.find((a) => a.name === 'Ada').id, patch: { name: 'Clippy' } }), /the name Clippy is taken/);
    for (const name of ['clippy', 'ada']) await assert.rejects(opened.call('saveSettings', { name }), /is taken/, 'your name is no buddy\'s');
  });
  // Any other doc has the same Clippy, and its runs say who it is now.
  const doc = join(await mkdtemp(join(tmpdir(), 'ponjo-doc-')), 'notes.md');
  await writeFile(doc, SAMPLE);
  await opening(doc, { settingsDir }, async (opened) => {
    assert.deepEqual(await who(opened), [mine]);
    const { id } = await opened.call('comment', { anchor: null, body: '@Clippy look' });
    await until(async () => (await opened.state()).threads.find((t) => t.id === id).comments.length === 2, 'the reply');
    const [run] = await fakeRuns(settingsDir);
    assert.match(run.prompt, /Mine now\.\n\nReply in French\./);
    await opened.call('updateBuddy', { id: 'Clippy', patch: { about: '' } });
    assert.deepEqual(await who(opened), [CLIPPY_ROW], 'cleared: Clippy as it ships');
  });
});

test('a doc opened from Finder reaches Clippy only, even inside a project folder', async () => {
  const settingsDir = await fakeConfig();
  const folder = await projectFolder({ Critic: 'The project\'s.\n' });
  await opening(join(folder, 'plan.md'), { settingsDir }, async (opened) => {
    assert.deepEqual(await who(opened), [CLIPPY_ROW]);
    assert.equal((await opened.state()).project, false);
    await assert.rejects(opened.call('createBuddy', { buddy: { name: 'Bob' } }), refused('bad_input'), 'no project to put it in');
  });
});

test('a folder opened from the home page reaches Clippy and its own; its Clippy.md is not a buddy; @ runs the right one', { timeout: 30_000 }, async () => {
  const settingsDir = await fakeConfig();
  const folder = await projectFolder({ critic: 'Checks every claim.\n\nQuote the line you rely on.\n', Clippy: 'An impostor.\n' });
  await opening(join(folder, 'plan.md'), { settingsDir, folder }, async (opened) => {
    assert.deepEqual(await who(opened), [CLIPPY_ROW, ['critic', 'Checks every claim.\n\nQuote the line you rely on.', 'project']]);
    const { id } = await opened.call('comment', { anchor: null, body: '@Critic look' });
    await until(async () => (await opened.state()).threads.find((t) => t.id === id).comments.length === 2, 'the reply');
    const [run] = await fakeRuns(settingsDir);
    assert.equal(run.buddy, 'critic');
    assert.match(run.prompt, /Checks every claim\.[\s\S]*Quote the line you rely on\./);
  });
});

test('adding the first buddy to a project creates .opendoc/; buddies are made, renamed and deleted as files', async () => {
  const settingsDir = await fakeConfig();
  const folder = await projectFolder();
  await opening(join(folder, 'plan.md'), { settingsDir, folder }, async (opened) => {
    await assert.rejects(readdir(join(folder, '.opendoc')), { code: 'ENOENT' });
    await opened.call('createBuddy', { buddy: { name: 'Critic', about: 'Checks claims.\n\nQuote lines.' } });
    const written = await readFile(join(folder, '.opendoc', 'buddies', 'Critic.md'), 'utf8');
    const id = /^---\nid: (b_[a-z0-9]{10})\n---\nChecks claims\.\n\nQuote lines\.\n$/.exec(written)?.[1];
    assert.ok(id, 'a new buddy gets a random id in its file');
    await opened.call('createBuddy', { buddy: { name: 'Ada' } });

    await assert.rejects(opened.call('createBuddy', { buddy: { name: 'critic' } }), /the name critic is taken/);
    await assert.rejects(opened.call('createBuddy', { buddy: { name: 'fzhan' } }), refused('bad_input'), "not the human's name");
    await assert.rejects(opened.call('createBuddy', { buddy: { name: 'Bob', face: 'x' } }), refused('bad_input'), 'no stored faces');
    await assert.rejects(opened.call('createBuddy', { buddy: { name: '../evil' } }), refused('bad_input'));

    const renamed = await opened.call('updateBuddy', { id, patch: { name: 'Reviewer' } });
    assert.deepEqual(renamed.agents.map((a) => a.name), ['Clippy', 'Ada', 'Reviewer']);
    assert.deepEqual((await readdir(join(folder, '.opendoc', 'buddies'))).sort(), ['Ada.md', 'Reviewer.md']);
    assert.equal(await readFile(join(folder, '.opendoc', 'buddies', 'Reviewer.md'), 'utf8'), written, 'a rename keeps the id');
    assert.equal(renamed.agents.find((a) => a.name === 'Reviewer').id, id);
    await opened.call('deleteBuddy', { id });
    assert.deepEqual(await readdir(join(folder, '.opendoc', 'buddies')), ['Ada.md']);
    await assert.rejects(opened.call('deleteBuddy', { id }), refused('not_found'));
  });
});

test('renaming a buddy whose file has no id keeps its old name as its id, so its comments stay its own', async () => {
  const folder = await projectFolder({ Critic: 'Checks every claim.\n' });
  await opening(join(folder, 'plan.md'), { settingsDir: await fakeConfig(), folder }, async (opened) => {
    const renamed = await opened.call('updateBuddy', { id: 'Critic', patch: { name: 'Reviewer' } });
    assert.equal(renamed.agents.find((a) => a.name === 'Reviewer').id, 'Critic');
    assert.equal(await readFile(join(folder, '.opendoc', 'buddies', 'Reviewer.md'), 'utf8'), '---\nid: Critic\n---\nChecks every claim.\n');
    await opened.call('updateBuddy', { id: 'Critic', patch: { about: 'Changed.' } });
    assert.match(await readFile(join(folder, '.opendoc', 'buddies', 'Reviewer.md'), 'utf8'), /^---\nid: Critic\n---\nChanged\.\n$/);
  });
});

test('a renamed buddy keeps its comments: it answers once, is not asked again, and replies under its id', { timeout: 30_000 }, async () => {
  const settingsDir = await fakeConfig();
  const docPath = await tempDoc('Some text.\n');
  const { doc, call, state } = await openTestDoc(docPath, { settingsDir, buddies: { Ada: 'Edits.\n' } });
  try {
    const { id } = await call('comment', { anchor: null, body: '@Ada hello' });
    const thread = async () => (await state()).threads.find((t) => t.id === id);
    await until(async () => (await thread()).comments.length === 2, 'its reply');
    const adaId = (await thread()).comments[1].by.id;
    assert.equal(adaId, 'Ada', 'an old file is a buddy by its name');
    await call('updateBuddy', { id: 'Ada', patch: { name: 'Bea' } });
    await call('comment', { thread: id, body: '@Bea and this' });
    await until(async () => (await thread()).comments.length === 4, 'the reply under its new name');
    assert.deepEqual((await thread()).comments.filter((c) => c.by.kind === 'ai').map((c) => [c.by.id, c.by.name]), [['Ada', 'Ada'], ['Ada', 'Bea']]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await thread()).comments.length, 4, 'nothing asks it again');
  } finally {
    await doc.close();
  }
});

test('a buddy file changed outside the app, or by another window, shows at once', { timeout: 15_000 }, async () => {
  const settingsDir = await fakeConfig();
  const folder = await projectFolder();
  await opening(join(folder, 'plan.md'), { settingsDir, folder }, async (a) => {
    await opening(join(folder, 'plan.md'), { settingsDir, folder }, async (b) => {
      await b.call('createBuddy', { buddy: { name: 'Ada' } });
      await until(() => a.events.some(([name, data]) => name === 'agents' && data.some((x) => x.name === 'Ada')), 'Ada in the other window');
      await mkdir(join(folder, '.opendoc', 'buddies'), { recursive: true });
      await writeFile(join(folder, '.opendoc', 'buddies', 'Critic.md'), 'Pulled from git.\n');
      await until(() => a.events.some(([name, data]) => name === 'agents' && data.some((x) => x.name === 'Critic')), 'Critic from the folder');
      await mkdir(join(settingsDir, 'buddies'), { recursive: true });
      await writeFile(join(settingsDir, 'buddies', 'Clippy.md'), 'Edited by hand.\n');
      await until(() => a.events.some(([name, data]) => name === 'agents' && data[0].about === 'Edited by hand.'), 'Clippy from the config folder');
    });
  });
});

test('a project cloned on another machine, or moved, has the same buddies and the same avatars', async () => {
  const folder = await projectFolder({ Critic: 'Checks every claim.\n' });
  const here = await fakeConfig();
  const there = await fakeConfig();
  const clone = join(await mkdtemp(join(tmpdir(), 'ponjo-clone-')), 'project');
  await cp(folder, clone, { recursive: true });
  const seen = await opening(join(folder, 'plan.md'), { settingsDir: here, folder }, (opened) => opened.state());
  const cloned = await opening(join(clone, 'plan.md'), { settingsDir: there, folder: clone }, (opened) => opened.state());
  assert.deepEqual(cloned.agents, seen.agents);
  // A face is drawn from the name alone: a buddy carries nothing else to draw it from.
  assert.deepEqual(Object.keys(seen.agents[1]).sort(), ['about', 'id', 'name', 'state', 'threadIds', 'where']);

  const moved = `${folder}-moved`;
  await rename(folder, moved);
  const after = await opening(join(moved, 'plan.md'), { settingsDir: here, folder: moved }, (opened) => opened.state());
  assert.deepEqual(after.agents, seen.agents);
});

test('settings.json holds no buddy; a v1 settings.json is discarded', async () => {
  const settingsDir = await fakeConfig();
  const v1 = { version: 1, id: 'u_old00001', name: 'old', face: 'seed', agents: [{ id: 'a_x00001', name: 'X', starred: true }] };
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify(v1));
  assert.equal((await readSettings(settingsDir)).settings.name, null, 'v1 is not read');
  const folder = await projectFolder();
  await opening(join(folder, 'plan.md'), { settingsDir, folder }, async (opened) => {
    await opened.call('createBuddy', { buddy: { name: 'Ada', about: 'Mine.' } });
    await opened.call('saveSettings', { theme: 'dark' });
  });
  const stored = JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['id', 'theme', 'version']);
  assert.equal(stored.version, 3);
  assert.notEqual(stored.id, v1.id);
});
