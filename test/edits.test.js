import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProposal, diffEdits, findEdit, findProposal, proposeChanges, revertEdits } from '../src/core/diff.js';
import { OpError } from '../src/core/ops.js';
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

test('changes in different paragraphs are separate edits; a reverted doc is the original', () => {
  const after = peak.replace('ship all six features', 'ship three features').replace('## Risks', '## Open risks');
  const all = edits(SAMPLE, after);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => [e.before, e.after]), [['all six', 'three'], ['Risks', 'Open risks'], ['', 'peak ']]);
  assert.equal(revertEdits(after, all), SAMPLE);
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
  assert.equal(revertEdits(after, all), SAMPLE);
});

test('undo is refused once the changed text is gone or rewritten', () => {
  const all = edits(SAMPLE, peak);
  assert.equal(revertEdits(peak.replace('extra peak load', 'extra heavy load'), all), null);
  assert.equal(findEdit(peak.replace('peak load', 'load'), all[0]), null);
  // Other edits elsewhere do not get in the way.
  const elsewhere = peak.replace('# Q4 Launch Plan', '# Q4 Plan');
  assert.equal(revertEdits(elsewhere, all), SAMPLE.replace('# Q4 Launch Plan', '# Q4 Plan'));
});

test('CRLF sources round-trip', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const after = crlf.replace('extra load', 'extra peak load');
  assert.equal(revertEdits(after, edits(crlf, after)), crlf);
});

test('proposals: before must be unique; applying finds it again after other edits', () => {
  const proposal = proposeChanges(SAMPLE, [
    { before: 'extra load', after: 'extra peak load' },
    { before: 'six features', after: 'three features' },
  ]);
  assert.deepEqual(proposal[0], {
    before: 'extra load', after: 'extra peak load',
    prefix: SAMPLE.slice(SAMPLE.indexOf('extra load') - 32, SAMPLE.indexOf('extra load')),
    suffix: SAMPLE.slice(SAMPLE.indexOf('extra load') + 10, SAMPLE.indexOf('extra load') + 42),
    start: SAMPLE.indexOf('extra load'),
  });
  const applied = applyProposal(SAMPLE, proposal);
  assert.equal(applied, SAMPLE.replace('extra load', 'extra peak load').replace('six features', 'three features'));

  // Edits elsewhere do not matter; a change to the proposed-on text does.
  const elsewhere = '# Intro\n\nNew paragraph.\n\n' + SAMPLE;
  assert.equal(applyProposal(elsewhere, proposal), '# Intro\n\nNew paragraph.\n\n' + applied);
  assert.equal(findProposal(SAMPLE.replace('extra load', 'extra heavy load'), proposal[0]), null);
  assert.equal(applyProposal(SAMPLE.replace('extra load', 'extra heavy load'), proposal), null, 'all or nothing');

  // A deletion, and the edits it leaves can be undone.
  const [deletion] = proposeChanges(SAMPLE, [{ before: ' for details', after: '' }]);
  const deleted = applyProposal(SAMPLE, [deletion]);
  assert.equal(deleted, SAMPLE.replace(' for details', ''));
  assert.equal(revertEdits(deleted, diffEdits(SAMPLE, deleted).map((c) => c.edit)), SAMPLE);

  const refused = (changes, pattern) => assert.throws(() => proposeChanges(SAMPLE, changes), (e) => e instanceof OpError && e.code === 'bad_input' && pattern.test(e.message));
  refused([{ before: 'the', after: 'a' }], /more than once/);
  refused([{ before: 'missing text', after: 'a' }], /does not appear/);
  refused([{ before: '', after: 'a' }], /empty/);
  refused([{ before: 'extra load', after: 'extra load' }], /the same/);
  refused([{ before: 'extra load', after: 'a' }, { before: 'load.', after: 'b' }], /overlap/);
  refused([], /at least one/);
  refused([{ before: 'extra load' }], /strings/);
});

test('proposals on a CRLF doc use its line endings', () => {
  const crlf = 'One line.\r\nTwo line.\r\n';
  const [change] = proposeChanges(crlf, [{ before: 'One line.\nTwo', after: 'One\nTwo' }]);
  assert.equal(change.before, 'One line.\r\nTwo');
  assert.equal(applyProposal(crlf, [change]), 'One\r\nTwo line.\r\n');
});
