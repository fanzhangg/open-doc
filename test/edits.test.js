import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffEdits, findEdit, revertEdits } from '../src/core/diff.js';
import { project, createAnchor, findQuote } from '../src/core/index.js';
import { attributeEdits } from '../src/server/agents/dispatcher.js';
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

test('attribution: the thread whose anchor the change touches, else the run', () => {
  const text = project(SAMPLE).text;
  const thread = (id, quote) => {
    const { start, end } = findQuote(text, quote);
    return { id, anchor: createAnchor(text, start, end), detached: false };
  };
  const load = thread('t_load01', 'extra load');
  const ship = thread('t_ship01', 'ship all six features');
  const docLevel = { id: 't_doc001', anchor: null, detached: false };

  const both = attributeEdits([load, ship], SAMPLE, peak);
  assert.deepEqual([...both.keys()], ['t_load01']);
  assert.equal(both.get('t_load01')[0].after, 'peak ');

  const heading = SAMPLE.replace('# Q4 Launch Plan', '# Q4 Launch Plan (draft)');
  const unclaimed = attributeEdits([load, ship], SAMPLE, heading);
  assert.deepEqual([...unclaimed.keys()], ['t_load01', 't_ship01']);
  assert.equal(unclaimed.get('t_ship01')[0].scope, 'run');

  const alone = attributeEdits([docLevel], SAMPLE, heading);
  assert.equal(alone.get('t_doc001')[0].after, ' (draft)');
  assert.equal(alone.get('t_doc001')[0].scope, undefined);
});
