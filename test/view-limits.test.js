import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettings } from '../src/core/settings.js';
import { viewFor } from '../web/views/index.js';
import { markdown } from '../web/views/markdown/index.js';
import { plain } from '../web/views/plain/index.js';

const settings = resolveSettings({});
const paragraphs = (chars) => 'A paragraph of words.\n\n'.repeat(Math.ceil(chars / 23)).slice(0, chars);

test('a doc opens in the Markdown view up to its limits, then as plain text, then read-only', () => {
  const choose = (text) => {
    const { id, editable, tooLong } = viewFor('notes.md', settings, text);
    return { id, editable, tooLong };
  };
  assert.deepEqual(choose(paragraphs(markdown.limits.chars)), { id: 'markdown', editable: true, tooLong: false });
  assert.deepEqual(choose(paragraphs(markdown.limits.chars + 1)), { id: 'plain', editable: true, tooLong: true });
  const verses = 'Genesis 1:1\tIn the beginning.\n'.repeat(Math.ceil(markdown.limits.blockChars / 30) + 1);
  assert.deepEqual(choose(verses), { id: 'plain', editable: true, tooLong: true }, 'one block past its limit');
  const crlf = paragraphs(markdown.limits.chars).replace(/\n/g, '\r\n').slice(0, markdown.limits.chars);
  assert.deepEqual(choose(crlf), { id: 'markdown', editable: true, tooLong: false }, 'blank lines ending in \\r\\n part blocks');
  assert.deepEqual(choose(paragraphs(plain.limits.chars)), { id: 'plain', editable: true, tooLong: true });
  assert.deepEqual(choose(paragraphs(plain.limits.chars + 1)), { id: 'plain', editable: false, tooLong: true });
  const chosen = (text) => {
    const { id, editable, tooLong } = viewFor('notes.md', settings, text, { anySize: true });
    return { id, editable, tooLong };
  };
  assert.deepEqual(chosen(paragraphs(markdown.limits.chars + 1)), { id: 'markdown', editable: true, tooLong: true }, 'the Markdown view chosen anyway');
  assert.deepEqual(chosen(paragraphs(plain.limits.chars + 1)), { id: 'plain', editable: false, tooLong: true }, 'but not past every view\'s limits');
  const run = (chars) => 'word '.repeat(chars / 5);
  assert.equal(viewFor('notes.md', settings, run(plain.limits.colorBlockChars)).color, true);
  assert.equal(viewFor('notes.md', settings, run(plain.limits.colorBlockChars + 5)).color, false, 'no colour past one run\'s limit');
  const txt = viewFor('notes.txt', settings, paragraphs(plain.limits.chars + 1));
  assert.deepEqual([txt.id, txt.editable, txt.tooLong], ['plain', false, false], 'plain text was never the Markdown view\'s');
});
