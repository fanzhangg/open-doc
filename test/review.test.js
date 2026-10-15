import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appliedBy, canApply, editItems, openProposal, previewItems } from '../web/review.js';
import { diffEdits } from '../src/core/diff.js';
import { proposeChanges } from '../src/core/diff.js';
import { project } from '../src/core/project.js';
import { locate } from '../src/core/anchor.js';
import { SAMPLE } from './helpers.js';

const human = { name: 'fzhan', kind: 'human' };
const claude = { name: 'claude', kind: 'agent' };
const message = (id, author, extra = {}) => ({ id, author, body: 'x', mentions: [], createdAt: '2026-10-14T18:00:00Z', ...extra });
const thread = (messages, status = 'open') => ({ id: 't_review01', status, messages });

test('a proposal can be applied while its text is there; applied until the apply is undone', () => {
  const proposal = proposeChanges(SAMPLE, [{ before: 'extra load', after: 'extra peak load' }]);
  const proposed = message('m_prop0001', claude, { proposal });
  assert.equal(canApply(SAMPLE, proposed), true);
  assert.equal(canApply(SAMPLE.replace('extra load', 'extra heavy load'), proposed), false);

  const t = thread([message('m_ask0001', human), proposed]);
  assert.equal(openProposal(t), proposed);
  const applied = message('m_apply001', human, { applies: 'm_prop0001', edits: [] });
  t.messages.push(applied);
  assert.equal(appliedBy(t, proposed), applied);
  assert.equal(openProposal(t), null);
  t.messages.push(message('m_undo0001', human, { undoes: 'm_apply001' }));
  assert.equal(appliedBy(t, proposed), null, 'undoing the apply makes it available again');
  assert.equal(openProposal(t), proposed);
});

test('the preview strikes the rendered before text and inserts the rendered after text', () => {
  const proposal = proposeChanges(SAMPLE, [
    { before: '**ship all six features**', after: '**ship three features**' },
    { before: '`sync`', after: '`sync` and `queue`' },
  ]);
  const items = previewItems(SAMPLE, proposal);
  const { text } = project(SAMPLE);
  assert.deepEqual(items.map((i) => [i.anchor.exact, i.mark, i.widget]), [
    ['ship all six features', 'del', { side: 'after', kind: 'ins', text: 'ship three features' }],
    ['sync', 'del', { side: 'after', kind: 'ins', text: 'sync and queue' }],
  ]);
  for (const item of items) assert.equal(locate(text, item.anchor).method, 'exact');
  assert.deepEqual(previewItems(SAMPLE.replace('`sync`', '`async`'), proposal).length, 1, 'a change no longer found has no preview');
});

test('a past edit shows as a revision: new text marked, removed text struck where it was', () => {
  // Lines 3 and 9 change; adjacent changed lines would be recorded as one edit.
  const after = SAMPLE.replace('**ship all six features**', '**ship three features**').replace(' for details', '');
  const items = editItems(after, diffEdits(SAMPLE, after).map((c) => c.edit));
  const { text } = project(after);
  assert.deepEqual(items.map((i) => [i.anchor.exact, i.mark, i.widget]), [
    ['three', 'ins', { side: 'before', kind: 'del', text: 'all six' }],
    ['.', null, { side: 'before', kind: 'del', text: 'for details' }],
  ]);
  for (const item of items) assert.equal(locate(text, item.anchor).method, 'exact');
  assert.deepEqual(editItems(after.replace('three', 'four'), diffEdits(SAMPLE, after).map((c) => c.edit)).length, 1, 'an edit changed since is left out');
});
