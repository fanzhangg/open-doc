import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splice } from '../src/formats/markdown/splice.js';

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
  assert.ok(out.includes('- star bullet one\n- star bullet two\n- star bullet three'));
  assert.ok(out.includes('| a  |  b |\n|----|---:|'));
  assert.ok(out.endsWith('Last paragraph stays.\n'));
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

test('falls back to the editor output when a kept block would parse differently', () => {
  // Kept "* a" next to a new "- b" stays two lists; joining "- a" + "- b"
  // must not silently merge or split lists in a way the editor did not mean.
  const before = '* a\n\npara\n';
  const after = '- a\n- b\n';
  const out = splice(before, after);
  assert.equal(out, after);
});

test('empty documents', () => {
  assert.equal(splice('', 'hello\n'), 'hello\n');
  assert.equal(splice('hello\n', ''), '');
});
