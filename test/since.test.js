// What changed since you last looked (src/host/doc-service.js, since; src/core/diff.js,
// changesBy): each change after the version a person last saw, credited to who made it,
// theirs left out, until they say they have seen it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesBy, findEdit } from '../src/core/diff.js';
import { diffOps } from '../src/core/ot.js';
import { SAMPLE, fakeConfig, openTestDoc, tempDoc, until } from './helpers.js';

const SAM = { id: 'p_sam', name: 'Sam', kind: 'human', level: 'write' };

test('changesBy credits each change to who made it, from the text as it was, and leaves out the reader\'s', () => {
  const base = 'Alpha one.\n\nBeta two.\n\nGamma three.\n';
  const s1 = base.replace('one', 'ONE');
  const s2 = s1.replace('Gamma', 'GAMMA');
  const s3 = s2.replace('ONE', 'uno');
  const s4 = s3.replace('Beta two.\n\n', '');
  const changes = changesBy(base, [{ text: s1, by: 'Ada' }, { text: s2, by: null }, { text: s3, by: 'Ben' }, { text: s4, by: '' }]);
  assert.deepEqual(changes.map((c) => [c.before, c.after, c.by]), [['one', 'uno', 'Ben'], ['Beta two.\n\n', '', '']], 'Ben rewrote Ada\'s change; the reader\'s own is not shown');
  for (const change of changes) assert.ok(findEdit(s4, change), 'found in the text as it is');
  assert.deepEqual(changesBy('a b c', [{ text: 'a B c', by: 'X' }, { text: 'a b c', by: 'Y' }]), [], 'a change put back is no change');
});

test('since: what others changed after you last looked, by whom, until you have seen it', { timeout: 30_000 }, async () => {
  const settingsDir = await fakeConfig();
  const { doc, call, edit, state } = await openTestDoc(await tempDoc(SAMPLE), { settingsDir, buddies: { Pilot: '\n' } });
  const as = (who) => (type, arg) => doc.call(type, arg, who);
  const sam = as(SAM);
  const samTypes = async (from, to) => {
    const now = await sam('state');
    await sam('submit', { ops: diffOps(now.text, now.text.replace(from, to)), rev: now.rev, epoch: now.epoch, id: `sam.${from}` });
    await sam('history'); // a version now, not once Sam pauses
  };
  try {
    assert.deepEqual((await call('since')).edits, [], 'a first look sees nothing new');
    assert.deepEqual((await sam('since')).edits, []);
    await samTypes('week one', 'week 1');
    await edit((await state()).text.replace('Q4 Launch', 'Q1 Launch'));
    await call('history');
    const { id } = await call('comment', { anchor: null, body: '@Pilot replace "extra load" with "extra peak load"' });
    await until(async () => (await state()).threads.find((t) => t.id === id).comments.length === 2, 'the reply');

    const mine = await call('since');
    assert.deepEqual(mine.edits.map((e) => [e.after, e.by]), [['1', 'Sam'], ['peak ', 'Pilot']], 'Sam\'s and the buddy\'s, not mine');
    assert.deepEqual(mine.authors.map((a) => a.name), ['Sam', 'Pilot']);
    assert.deepEqual((await sam('since')).edits.map((e) => e.after), ['Q1', 'peak '], 'Sam sees the owner\'s and the buddy\'s');

    await call('seen', { id: mine.head });
    assert.deepEqual((await call('since')).edits, [], 'seen');
    await samTypes('beta cohort', 'beta group');
    assert.deepEqual((await call('since')).edits.map((e) => [e.after, e.by]), [['group', 'Sam']], 'only what came after');
    assert.equal((await sam('since')).edits.length, 2, 'Sam has not said they have seen');
  } finally {
    await doc.close();
  }
});
