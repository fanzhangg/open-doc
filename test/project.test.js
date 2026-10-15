import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, sourceRange, lineOf } from '../src/core/project.js';

const textOf = (md) => project(md).text;

test('blocks become lines and markup is removed', () => {
  assert.equal(
    textOf('# Title *here*\n\nSome **bold**, _italic_, ~~gone~~ and [a link](https://x.dev).\n'),
    'Title here\nSome bold, italic, gone and a link.',
  );
});

test('list items, quotes and tables contribute their text blocks only', () => {
  assert.equal(textOf('- one\n- two\n  - nested\n\n> quoted\n'), 'one\ntwo\nnested\nquoted');
  assert.equal(textOf('| a | b |\n|---|---|\n| c | d |\n'), 'a\nb\nc\nd');
});

test('whitespace collapses, soft and hard breaks become spaces', () => {
  assert.equal(textOf('one\n   two\t\tthree  \nfour\\\nfive\n'), 'one two three four five');
});

test('code blocks keep their whitespace; inline code keeps its content', () => {
  assert.equal(textOf('```js\nlet  x = 1;\n  y();\n```\n'), 'let  x = 1;\n  y();');
  assert.equal(textOf('call `run()` now\n'), 'call run() now');
});

test('escapes and entities are decoded', () => {
  assert.equal(textOf('a \\*star\\* &amp; &copy;\n'), 'a *star* & ©');
});

test('images, thematic breaks and definitions contribute nothing', () => {
  assert.equal(textOf('before ![alt](i.png) after\n\n---\n\n[ref]: https://x.dev\n\nend\n'), 'before after\nend');
});

test('raw HTML is kept as written text', () => {
  assert.equal(textOf('<div>hi</div>\n\na <b>b</b> c\n'), '<div>hi</div>\na <b>b</b> c');
});

test('empty doc projects to empty text', () => {
  const p = project('');
  assert.equal(p.text, '');
  assert.deepEqual(Array.from(p.offsets), [0]);
});

test('offsets map rendered text back to source', () => {
  const md = '# Plan\n\nWe will **ship all six** features.\n';
  const p = project(md);
  const start = p.text.indexOf('ship all six');
  const range = sourceRange(p, start, start + 'ship all six'.length);
  assert.equal(md.slice(range.start, range.end), 'ship all six');
  assert.equal(lineOf(md, range.start), 3);
  assert.equal(p.offsets.length, p.text.length + 1);
});

test('offsets skip escape characters', () => {
  const md = 'a \\*b\n';
  const p = project(md);
  assert.equal(p.text, 'a *b');
  assert.equal(md[p.offsets[2]], '*');
});

test('CRLF line endings project like LF', () => {
  assert.equal(textOf('# A\r\n\r\none\r\ntwo\r\n'), textOf('# A\n\none\ntwo\n'));
});

test('bold that ends on full-width punctuation before CJK text is still bold', () => {
  // Plain CommonMark keeps these asterisks as text; the CJK-friendly rule does not.
  assert.equal(textOf('- **熟悉：**直接继承\n- **实时：**agent在后台\n'), '熟悉：直接继承\n实时：agent在后台');
  assert.equal(textOf('这是**重要**的。'), '这是重要的。');
  assert.equal(textOf('a **b** c and 2 * 3 * 4'), 'a b c and 2 * 3 * 4', 'other text is unchanged');
});
