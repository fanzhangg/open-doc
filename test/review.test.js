import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editItems } from '../web/review.js';
import { diffEdits } from '../src/core/diff.js';
import { project } from '../src/formats/markdown/project.js';
import { locate } from '../src/core/anchor.js';
import { SAMPLE } from './helpers.js';

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
