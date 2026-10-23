// Teammates who can edit (docs/architecture.md, Sharing): a teammate at
// write comes through the door as the owner's windows do; their comments
// ask AI buddies, whose turns act with the asker's level as it is when they
// end; history credits whoever made each version. The agent is the fake
// script (test/fixtures/fake-agent.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createTeam } from '../src/host/team.js';
import { diffOps } from '../src/core/ot.js';
import { fakeConfig, fakeRuns, openTestDoc, tempDoc, until } from './helpers.js';

const TEXT = 'Alpha one.\n\nBeta two.\n';

// A project doc, its owner's line to it, and Sam's, a teammate who can edit.
async function shared(fn) {
  const docPath = await tempDoc(TEXT);
  const settingsDir = await fakeConfig();
  const team = createTeam(dirname(docPath), { settingsDir });
  await team.join({ id: 'p_sam', name: 'Sam' });
  await team.allow('p_sam', 'write');
  const owner = await openTestDoc(docPath, { settingsDir, team, buddies: { Pilot: '\n' } });
  // As the doc host asks it: Sam's level now.
  const sam = async (type, arg) => owner.doc.call(type, arg, { id: 'p_sam', name: 'Sam', kind: 'human', level: await team.levelOf('p_sam') });
  const type = async (call, next, id) => {
    const at = await call('state');
    return call('submit', { ops: diffOps(at.text, next), rev: at.rev, epoch: at.epoch, id });
  };
  try {
    await fn({ docPath, settingsDir, team, owner, sam, type });
  } finally {
    await owner.doc.close();
  }
}

const versions = async (call) => (await call('history')).versions;
const replies = async (call) => (await call('state')).threads.flatMap((t) => t.comments).filter((c) => c.by.kind === 'ai');

test('a teammate who can edit types, comments, resolves, reopens and restores; history credits each, and typing together is one version by both', async () => {
  await shared(async ({ docPath, owner, sam, type }) => {
    await type(sam, 'Alpha one, by Sam.\n\nBeta two.\n', 's.1');
    assert.equal(await readFile(docPath, 'utf8'), 'Alpha one, by Sam.\n\nBeta two.\n');
    let last = (await versions(owner.call)).at(-1);
    assert.deepEqual([last.kind, last.author.name, last.authors], ['edit', 'Sam', undefined]);

    // Both type before the pause ends: one version, by both.
    await owner.call('restoreVersion', { id: (await versions(owner.call))[0].id }); // a version of its own between the bursts
    await type(owner.call, 'Alpha one, by fzhan.\n\nBeta two.\n', 'o.1');
    await type(sam, 'Alpha one, by fzhan.\n\nBeta two, Sam.\n', 's.2');
    last = (await versions(owner.call)).at(-1);
    assert.deepEqual(last.authors.map((a) => a.name), ['fzhan', 'Sam']);

    const { id } = await sam('comment', { anchor: null, body: 'Is this clear?' });
    await sam('comment', { thread: id, body: '', resolved: true });
    await sam('comment', { thread: id, body: '' });
    const thread = (await owner.state()).threads.find((t) => t.id === id);
    assert.deepEqual(thread.comments.map((c) => c.by.name), ['Sam', 'Sam', 'Sam']);
    assert.equal(thread.resolved, false);

    await sam('restoreVersion', { id: (await versions(owner.call))[0].id });
    last = (await versions(owner.call)).at(-1);
    assert.deepEqual([last.kind, last.author.name], ['restore', 'Sam']);
    assert.equal(await readFile(docPath, 'utf8'), TEXT);
  });
});

test('a teammate\'s @mention starts a turn, undone by them; one whose asker is set to Read before it ends lands nothing', { timeout: 60_000 }, async () => {
  await shared(async ({ docPath, settingsDir, team, owner, sam }) => {
    const { id } = await sam('comment', { anchor: null, body: '@Pilot replace "Alpha" with "ALPHA"' });
    const [reply] = await until(async () => (await replies(owner.call)).length === 1 && replies(owner.call), 'the reply');
    assert.equal(reply.thread, id);
    assert.match(await readFile(docPath, 'utf8'), /^ALPHA one\./);
    await sam('undo', { id: (await owner.call('state')).edits[reply.id].version });
    assert.match(await readFile(docPath, 'utf8'), /^Alpha one\./);
    assert.deepEqual(['undo', 'Sam'], [(await versions(owner.call)).at(-1).kind, (await versions(owner.call)).at(-1).author.name]);

    await sam('comment', { anchor: null, body: '@Pilot hold replace "Beta" with "BETA"' });
    await until(async () => (await fakeRuns(settingsDir).catch(() => [])).length === 2, 'the second turn'); // its line may be half written
    await team.set('p_sam', { level: 'read' });
    await writeFile(join(settingsDir, 'release-Pilot'), '');
    await new Promise((done) => setTimeout(done, 1500));
    assert.equal((await replies(owner.call)).length, 1, 'no reply');
    assert.match(await readFile(docPath, 'utf8'), /\nBeta two\.\n$/, 'no edit');
    await assert.rejects(sam('comment', { anchor: null, body: '@Pilot again' }), { code: 'forbidden' });
  });
});
