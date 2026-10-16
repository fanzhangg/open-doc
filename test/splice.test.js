import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splice } from '../src/server/splice.js';

const ORIGINAL = `Intro with __old-style bold__ and a hard
wrapped line, plus a [link](./a.md "Title").

* star bullet one
* star bullet two

| a  |  b |
|----|---:|
| 1  |  2 |

Last paragraph stays.
`;

// What an editor might send back after reformatting everything.
const REFORMATTED = `Intro with **old-style bold** and a hard wrapped line, plus a [link](./a.md "Title").

- star bullet one
- star bullet two

| a | b |
| - | -: |
| 1 | 2 |

Last paragraph stays.
`;

test('reformatting alone keeps the file byte for byte', () => {
  assert.equal(splice(ORIGINAL, REFORMATTED), ORIGINAL);
});

test('only the edited block takes the editor formatting', () => {
  const edited = REFORMATTED.replace('Last paragraph stays.', 'Last paragraph changed.');
  assert.equal(splice(ORIGINAL, edited), ORIGINAL.replace('Last paragraph stays.', 'Last paragraph changed.'));
});

test('an edit in the middle keeps neighbours and their spacing', () => {
  const edited = REFORMATTED.replace('- star bullet two', '- star bullet two\n- star bullet three');
  const out = splice(ORIGINAL, edited);
  assert.ok(out.startsWith('Intro with __old-style bold__ and a hard\nwrapped line'));
  assert.ok(out.includes('* star bullet one\n* star bullet two\n* star bullet three'));
  assert.ok(out.includes('| a  |  b |\n|----|---:|'));
  assert.ok(out.endsWith('Last paragraph stays.\n'));
});

test('a table edit rewrites only the edited row', () => {
  const before = '| Agent | Job |\n| --- | --- |\n| Clippy | Drafts |\n| Rocky | Fixes typos |\n| Will | Polishes |\n';
  const after = '| Agent  | Job         |\n| ------ | ----------- |\n| Clippy | Drafts      |\n| Rocky  | Fixes typos |\n| Will!  | Polishes    |\n';
  // The table's cells are not padded, so neither is the edited row.
  assert.equal(splice(before, after), '| Agent | Job |\n| --- | --- |\n| Clippy | Drafts |\n| Rocky | Fixes typos |\n| Will! | Polishes |\n');
});

test('a row edited in a padded table stays padded', () => {
  const before = '| Agent  | Job    |\n| ------ | ------ |\n| Clippy | Drafts |\n| Will   | Polish |\n';
  const after = before.replace('| Will   | Polish |', '| Will!  | Polish |');
  assert.equal(splice(before, after), after);
});

test('a table edit keeps the header and delimiter row', () => {
  const before = '| a | b |\n|:--|--:|\n| 1 | 2 |\n';
  const after = '| a | b |\n| :- | -: |\n| 1 | 2 |\n| 3 | 4 |\n';
  assert.equal(splice(before, after), '| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n');
});

test('a changed column alignment rewrites the table', () => {
  const before = '| a | b |\n|---|---|\n| 1 | 2 |\n';
  const after = '| a | b |\n| - | -: |\n| 1 | 2 |\n';
  assert.equal(splice(before, after), after);
});

test('a list edit rewrites only the edited item, in the list\'s own markers', () => {
  const before = '+ one\n+ two with a\n  wrapped line\n+ three\n\n1) first\n2) second\n';
  const after = '- one\n- two with a wrapped line\n- three, changed\n- four\n\n1. first\n2. second\n3. third\n';
  assert.equal(splice(before, after), '+ one\n+ two with a\n  wrapped line\n+ three, changed\n+ four\n\n1) first\n2) second\n3) third\n');
});

test('an item edit keeps the nested lists of untouched items', () => {
  const before = '* a\n    * nested one\n    * nested two\n* b\n';
  const after = '- a\n  - nested one\n  - nested two\n- b, changed\n';
  assert.equal(splice(before, after), '* a\n    * nested one\n    * nested two\n* b, changed\n');
});

test('a list that turns loose is rewritten whole', () => {
  const before = '* a\n* b\n';
  const after = '- a\n\n- b\n\n- c\n';
  assert.equal(splice(before, after), after);
});

test('inserted and deleted blocks', () => {
  const inserted = REFORMATTED.replace('Last paragraph stays.', 'A new paragraph.\n\nLast paragraph stays.');
  assert.equal(
    splice(ORIGINAL, inserted),
    ORIGINAL.replace('Last paragraph stays.', 'A new paragraph.\n\nLast paragraph stays.'),
  );
  const deleted = REFORMATTED.replace('- star bullet one\n- star bullet two\n\n', '');
  assert.equal(splice(ORIGINAL, deleted), ORIGINAL.replace('* star bullet one\n* star bullet two\n\n', ''));
});

test('code block whitespace counts as a change', () => {
  const before = '```\na  b\n```\n';
  const after = '```\na b\n```\n';
  assert.equal(splice(before, after), after);
});

test('an item added to a kept list takes its marker', () => {
  assert.equal(splice('* a\n\npara\n', '- a\n- b\n'), '* a\n* b\n');
});

test('falls back to the editor output when a kept block would parse differently', () => {
  // Deleting the paragraph between two `*` lists: kept as they were, they
  // would join into one list, which the editor did not mean.
  const before = '* a\n\npara\n\n* c\n';
  const after = '- a\n\n* c\n';
  assert.equal(splice(before, after), after);
});

test('empty documents', () => {
  assert.equal(splice('', 'hello\n'), 'hello\n');
  assert.equal(splice('hello\n', ''), '');
});
