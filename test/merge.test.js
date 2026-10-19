import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followLines, merge3 } from '../src/core/merge.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';
import { harnessOf } from '../src/plugins/index.js';

const doc = (...lines) => lines.join('\n');
const BASE = doc('# Plan', '', 'Intro.', '', 'Middle.', '', 'End.');

test('one side changed: take it', () => {
  const theirs = BASE.replace('Middle.', 'Middle, revised.');
  assert.deepEqual(merge3(BASE, BASE, theirs), { text: theirs, conflict: false, dropped: [] });
  assert.deepEqual(merge3(BASE, theirs, BASE), { text: theirs, conflict: false, dropped: [] });
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
  assert.deepEqual(merge3(BASE, ours, theirs), { text: doc('# Plan', '', 'Intro!', '', 'End.'), conflict: false, dropped: [] });
});

test('the same edit on both sides is not a conflict', () => {
  const both = BASE.replace('Middle.', 'Same change.');
  assert.deepEqual(merge3(BASE, both, both), { text: both, conflict: false, dropped: [] });
});

test('different edits to the same paragraph conflict', () => {
  const ours = BASE.replace('Middle.', 'Mine.');
  const theirs = BASE.replace('Middle.', 'Theirs.');
  assert.deepEqual(merge3(BASE, ours, theirs), { text: null, conflict: true });
});

test('edits to different parts of the same paragraph merge by character', () => {
  const base = doc('Intro.', '', 'The plan has three steps and one risk.');
  const ours = base.replace('three steps', 'four steps');
  const theirs = base.replace('one risk.', 'one known risk.');
  assert.deepEqual(merge3(base, ours, theirs), { text: doc('Intro.', '', 'The plan has four steps and one known risk.'), conflict: false, dropped: [] });
});

test('two insertions at the same place in a line conflict', () => {
  const ours = BASE.replace('Middle.', 'Middle. A');
  const theirs = BASE.replace('Middle.', 'Middle. B');
  assert.deepEqual(merge3(BASE, ours, theirs), { text: null, conflict: true });
});

test('a character merge never splits a surrogate pair', () => {
  const base = 'a 😀 b';
  const ours = 'a 😁 b';
  const theirs = 'a 😀 b!';
  assert.equal(merge3(base, ours, theirs).text, 'a 😁 b!');
});

test('preferring ours keeps our side of a conflict and reports theirs as dropped', () => {
  const ours = BASE.replace('Middle.', 'Mine.').replace('End.', 'End!');
  const theirs = BASE.replace('Middle.', 'Theirs.').replace('Intro.', 'Intro, agent.');
  assert.deepEqual(merge3(BASE, ours, theirs, { prefer: 'ours' }), {
    text: doc('# Plan', '', 'Intro, agent.', '', 'Mine.', '', 'End!'),
    conflict: false,
    dropped: [{ at: 4, count: 1, base: 'Middle.', ours: 'Mine.', theirs: 'Theirs.' }],
  });
});

test('with the Markdown harness on, a character merge that would change how the line renders conflicts; off, or in plain text, it merges', () => {
  // Taking out one `*` and adding another elsewhere would pair them into new emphasis.
  const off = { ...DEFAULT_SETTINGS, plugins: { 'markdown-harness': { enabled: false } } };
  assert.deepEqual(merge3('1 *2* 3', '1 *2 3', '1 *2* 3 4*', { harness: harnessOf('plan.md', DEFAULT_SETTINGS) }), { text: null, conflict: true });
  for (const harness of [harnessOf('plan.md', off), harnessOf('notes.txt', DEFAULT_SETTINGS)]) {
    assert.deepEqual(merge3('1 *2* 3', '1 *2 3', '1 *2* 3 4*', { harness }), { text: '1 *2 3 4*', conflict: false, dropped: [] });
  }
});

test('a doc\'s harness is found by its extension, any case, and only while it is on', () => {
  assert.equal(harnessOf('a/README.MD', DEFAULT_SETTINGS), harnessOf('b.markdown', DEFAULT_SETTINGS));
  assert.ok(harnessOf('b.markdown', DEFAULT_SETTINGS));
  assert.equal(harnessOf('b.markdown', { ...DEFAULT_SETTINGS, plugins: { markdown: { enabled: false } } }), harnessOf('b.markdown', DEFAULT_SETTINGS), 'the editor plugin is another switch');
  assert.equal(harnessOf('main.js', DEFAULT_SETTINGS), undefined);
  assert.equal(harnessOf('Makefile', DEFAULT_SETTINGS), undefined);
});

test('following lines into a later version takes in what changed around them', () => {
  const from = doc('# Plan', '', 'Mine.', '', 'End.');
  assert.deepEqual(followLines(from, doc('# Plan', '', 'Mine, and more.', '', 'End.'), 2, 1), { start: 2, end: 3 });
  assert.deepEqual(followLines(from, doc('# Plan', '', 'Mine.', 'More.', '', 'End.'), 2, 1), { start: 2, end: 4 });
  assert.deepEqual(followLines(from, doc('Intro.', '', '# Plan', '', 'Mine.', '', 'End.'), 2, 1), { start: 4, end: 5 });
});
