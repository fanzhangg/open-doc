// Buddies (spec/PROJECT.md): Clippy, built in, and a project's files in
// .opendoc/buddies/. Runs use the fake agent script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIPPY, buddiesHere, buddyText, colorSlots, parseBuddy } from '../src/core/buddies.js';
import { readSettings } from '../src/store/settings.js';
import { SAMPLE, fakeConfig, fakeRuns, openTestDoc, until } from './helpers.js';

const refused = (code) => (error) => error.code === code;
const who = async (opened) => (await opened.state()).agents.map((a) => [a.name, a.persona, a.where]);

// A project folder with plan.md and the buddies `files` ({ name: text }) in .opendoc/buddies/.
async function projectFolder(files = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'opendoc-project-'));
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

test('a buddy file: the name is the file name, the first line the persona, the rest the instructions', () => {
  assert.deepEqual(parseBuddy('Critic', 'Checks every claim.\r\n\r\nQuote the line.\nBe brief.\n'),
    { name: 'Critic', persona: 'Checks every claim.', instructions: 'Quote the line.\nBe brief.' });
  assert.deepEqual(parseBuddy('Empty', ''), { name: 'Empty', persona: '', instructions: '' });
  const text = buddyText({ persona: 'Checks every claim.', instructions: 'Quote the line.' });
  assert.equal(text, 'Checks every claim.\n\nQuote the line.\n');
  assert.deepEqual(parseBuddy('Critic', text), { name: 'Critic', persona: 'Checks every claim.', instructions: 'Quote the line.' });
  const here = buddiesHere([{ name: 'critic', persona: 'project' }, { name: 'clippy', persona: 'theirs' }, { name: 'Ada', persona: 'project' }]);
  assert.deepEqual(here.map((b) => [b.name, b.where]), [['Clippy', 'app'], ['Ada', 'project'], ['critic', 'project']], "Clippy first, then by name; a project's Clippy is not one");
  assert.equal(here[0], CLIPPY);
});

const CLIPPY_ROW = ['Clippy', CLIPPY.persona, 'app'];

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

test('Clippy is built in: in every doc, and nothing can change it', async () => {
  const settingsDir = await fakeConfig();
  const folder = await projectFolder();
  await opening(join(folder, 'plan.md'), { settingsDir, folder }, async (opened) => {
    assert.deepEqual(await who(opened), [CLIPPY_ROW]);
    await assert.rejects(opened.call('updateBuddy', { name: 'clippy', patch: { persona: 'Mine now.' } }), refused('bad_input'));
    await assert.rejects(opened.call('deleteBuddy', { name: 'Clippy' }), refused('bad_input'));
    await assert.rejects(opened.call('createBuddy', { buddy: { name: 'clippy' } }), /the name clippy is taken/);
    await opened.call('createBuddy', { buddy: { name: 'Ada' } });
    await assert.rejects(opened.call('updateBuddy', { name: 'Ada', patch: { name: 'Clippy' } }), /the name Clippy is taken/);
  });
  await assert.rejects(readdir(join(settingsDir, 'buddies')), { code: 'ENOENT' }, 'no buddies in the config folder');
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
    assert.deepEqual(await who(opened), [CLIPPY_ROW, ['critic', 'Checks every claim.', 'project']]);
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
    await opened.call('createBuddy', { buddy: { name: 'Critic', persona: 'Checks claims.', instructions: 'Quote lines.' } });
    assert.equal(await readFile(join(folder, '.opendoc', 'buddies', 'Critic.md'), 'utf8'), 'Checks claims.\n\nQuote lines.\n');
    await opened.call('createBuddy', { buddy: { name: 'Ada' } });

    await assert.rejects(opened.call('createBuddy', { buddy: { name: 'critic' } }), /the name critic is taken/);
    await assert.rejects(opened.call('createBuddy', { buddy: { name: 'fzhan' } }), refused('bad_input'), "not the human's name");
    await assert.rejects(opened.call('createBuddy', { buddy: { name: 'Bob', face: 'x' } }), refused('bad_input'), 'no stored faces');
    await assert.rejects(opened.call('createBuddy', { buddy: { name: '../evil' } }), refused('bad_input'));

    const renamed = await opened.call('updateBuddy', { name: 'critic', patch: { name: 'Reviewer', persona: 'Reviews.' } });
    assert.deepEqual(renamed.agents.map((a) => a.name), ['Clippy', 'Ada', 'Reviewer']);
    assert.deepEqual((await readdir(join(folder, '.opendoc', 'buddies'))).sort(), ['Ada.md', 'Reviewer.md']);
    assert.equal(await readFile(join(folder, '.opendoc', 'buddies', 'Reviewer.md'), 'utf8'), 'Reviews.\n\nQuote lines.\n');
    await opened.call('deleteBuddy', { name: 'Reviewer' });
    assert.deepEqual(await readdir(join(folder, '.opendoc', 'buddies')), ['Ada.md']);
    await assert.rejects(opened.call('deleteBuddy', { name: 'Reviewer' }), refused('not_found'));
  });
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
    });
  });
});

test('a project cloned on another machine, or moved, has the same buddies and the same avatars', async () => {
  const folder = await projectFolder({ Critic: 'Checks every claim.\n' });
  const here = await fakeConfig();
  const there = await fakeConfig();
  const clone = join(await mkdtemp(join(tmpdir(), 'opendoc-clone-')), 'project');
  await cp(folder, clone, { recursive: true });
  const seen = await opening(join(folder, 'plan.md'), { settingsDir: here, folder }, (opened) => opened.state());
  const cloned = await opening(join(clone, 'plan.md'), { settingsDir: there, folder: clone }, (opened) => opened.state());
  assert.deepEqual(cloned.agents, seen.agents);
  // A face is drawn from the name alone: a buddy carries nothing else to draw it from.
  assert.deepEqual(Object.keys(seen.agents[1]).sort(), ['instructions', 'name', 'persona', 'state', 'threadIds', 'where']);

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
    await opened.call('createBuddy', { buddy: { name: 'Ada', persona: 'Mine.' } });
    await opened.call('saveSettings', { font: 'serif' });
  });
  const stored = JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['font', 'id', 'version']);
  assert.equal(stored.version, 2);
  assert.notEqual(stored.id, v1.id);
});
