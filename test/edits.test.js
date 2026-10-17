import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffEdits, findEdit, revertEdits } from '../src/core/diff.js';
import { SAMPLE } from './helpers.js';

const edits = (before, after) => diffEdits(before, after).map((c) => c.edit);
const peak = SAMPLE.replace('extra load', 'extra peak load');

test('an insertion between words is just the new words, positioned in the new text', () => {
  const [edit] = edits(SAMPLE, peak);
  assert.equal(edit.before, '');
  assert.equal(edit.after, 'peak ');
  assert.equal(peak.slice(edit.start, edit.start + edit.after.length), 'peak ');
  assert.equal(edit.prefix, peak.slice(edit.start - 32, edit.start));
  assert.equal(edit.suffix, peak.slice(edit.start + edit.after.length).slice(0, 32));
});

test('changes in different paragraphs are separate edits', () => {
  const after = peak.replace('ship all six features', 'ship three features').replace('## Risks', '## Open risks');
  const all = edits(SAMPLE, after);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => [e.before, e.after]), [['all six', 'three'], ['Risks', 'Open risks'], ['', 'peak ']]);
  assert.deepEqual(diffEdits(SAMPLE, SAMPLE), []);
});

test('a change inside a word covers the whole word', () => {
  const after = SAMPLE.replace('handle', 'handel');
  assert.deepEqual(edits(SAMPLE, after).map((e) => [e.before, e.after]), [['handle', 'handel']]);
  assert.deepEqual(edits(SAMPLE, SAMPLE.replace('extra load', 'extra loads')).map((e) => [e.before, e.after]), [['load', 'loads']]);
});

test('a deletion is found again by its context', () => {
  const after = SAMPLE.replace(' for details', '');
  const all = edits(SAMPLE, after);
  assert.equal(all.length, 1);
  assert.equal(all[0].after, '');
  assert.deepEqual(findEdit(after, all[0]), { start: all[0].start, end: all[0].start });
});

test('an edit changed since is not found', () => {
  const all = edits(SAMPLE, peak);
  assert.equal(findEdit(peak.replace('peak load', 'load'), all[0]), null);
  assert.ok(findEdit(peak.replace('# Q4 Launch Plan', '# Q4 Plan'), all[0]), 'edits elsewhere do not get in the way');
});

test('undo by changes: each change still in place is put back; one changed since is skipped', () => {
  // Three changes, on lines apart (changed lines next to each other are one change).
  const run = SAMPLE.replace('Q4 Launch', 'Q1 Launch').replace('week one', 'week two').replace('extra load', 'extra peak load');
  assert.equal(revertEdits(run, SAMPLE, run), SAMPLE);
  const later = run.replace('week two', 'week three').replace('## Risks', '## Open risks');
  assert.equal(revertEdits(later, SAMPLE, run), SAMPLE.replace('week one', 'week three').replace('## Risks', '## Open risks'), 'the touched change stays, the rest go, later edits stay');
});
