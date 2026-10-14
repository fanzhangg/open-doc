import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge3 } from '../web/merge.js';

const doc = (...lines) => lines.join('\n');
const BASE = doc('# Plan', '', 'Intro.', '', 'Middle.', '', 'End.');

test('one side changed: take it', () => {
  const theirs = BASE.replace('Middle.', 'Middle, revised.');
  assert.deepEqual(merge3(BASE, BASE, theirs), { text: theirs, conflict: false });
  assert.deepEqual(merge3(BASE, theirs, BASE), { text: theirs, conflict: false });
});

test('edits to different paragraphs merge', () => {
  const ours = BASE.replace('Intro.', 'Intro, typed by the human.');
  const theirs = BASE.replace('End.', 'End, edited by the agent.');
  const { text, conflict } = merge3(BASE, ours, theirs);
  assert.equal(conflict, false);
  assert.equal(text, doc('# Plan', '', 'Intro, typed by the human.', '', 'Middle.', '', 'End, edited by the agent.'));
});

test('an insertion merges with an edit elsewhere', () => {
  const ours = BASE + '\n\nA new last paragraph.';
  const theirs = BASE.replace('Intro.', 'Intro.\n\nAn inserted paragraph.');
  const { text, conflict } = merge3(BASE, ours, theirs);
  assert.equal(conflict, false);
  assert.equal(text, doc('# Plan', '', 'Intro.', '', 'An inserted paragraph.', '', 'Middle.', '', 'End.', '', 'A new last paragraph.'));
});

test('a deletion merges with an edit elsewhere', () => {
  const ours = BASE.replace('Intro.', 'Intro!');
  const theirs = BASE.replace('Middle.\n\n', '');
  assert.deepEqual(merge3(BASE, ours, theirs), { text: doc('# Plan', '', 'Intro!', '', 'End.'), conflict: false });
});

test('the same edit on both sides is not a conflict', () => {
  const both = BASE.replace('Middle.', 'Same change.');
  assert.deepEqual(merge3(BASE, both, both), { text: both, conflict: false });
});

test('different edits to the same paragraph conflict', () => {
  const ours = BASE.replace('Middle.', 'Mine.');
  const theirs = BASE.replace('Middle.', 'Theirs.');
  assert.deepEqual(merge3(BASE, ours, theirs), { text: null, conflict: true });
});
