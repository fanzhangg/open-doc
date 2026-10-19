// The markdown editor's bridge to the doc's text: the projection of the
// markdown (src/markdown/project.js) and the editor's projection of
// its own document (web/pm-text.js) must produce the same rendered text, so
// an anchor on the doc's text can be drawn in the editor and a selection
// there becomes an anchor on the doc's text. Checked against
// fixtures/rendered-text.json, and on every markdown file in this repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAnchor, locate } from '../src/core/anchor.js';
import { project, renderedAnchor, sourceAnchor } from '../src/markdown/project.js';
import { splice } from '../src/markdown/splice.js';
import { docRange, projectDoc, textRange } from '../web/pm-text.js';
import { editorParser, editorSerializer } from './milkdown.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const { cases } = JSON.parse(readFileSync(new URL('./fixtures/rendered-text.json', import.meta.url), 'utf8'));

// Cases the editor cannot pass yet, with why. Each is a bug to fix, not an
// exception to the spec.
const EDITOR_TODO = {};

for (const { name, markdown, text } of cases) {
  test(`core: ${name}`, () => {
    assert.equal(project(markdown).text, text);
  });
  test(`editor: ${name}`, { todo: EDITOR_TODO[name] }, async () => {
    const parse = await editorParser();
    assert.equal(projectDoc(parse(markdown)).text, text);
  });
}

test('editor and core agree on every markdown file in the repository', async () => {
  const parse = await editorParser();
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.length > 0);
  for (const file of files) {
    const markdown = readFileSync(new URL(file, new URL('..', import.meta.url)), 'utf8');
    assert.equal(projectDoc(parse(markdown)).text, project(markdown).text, file);
  }
});

test('a selection starting at raw HTML starts with its first character', async () => {
  const parse = await editorParser();
  const doc = parse('Press <kbd>Ctrl</kbd> + C');
  const projection = projectDoc(doc);
  let atom = null;
  doc.descendants((node, pos) => {
    if (atom === null && node.type.name === 'html') atom = pos;
  });
  const range = textRange(projection, atom, doc.content.size);
  assert.equal(projection.text.slice(range.start, range.end), '<kbd>Ctrl</kbd> + C');
  // and the text range maps back over the whole atom
  assert.equal(docRange(projection, range.start, range.start + 5).from, atom);
  assert.equal(docRange(projection, range.start, range.start + 5).to, atom + 1);
});

test('an anchor on the text is drawn on the same words in the editor, and comes back the same', async () => {
  const parse = await editorParser();
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const file of files) {
    const markdown = readFileSync(new URL(file, new URL('..', import.meta.url)), 'utf8');
    const editor = projectDoc(parse(markdown));
    const words = [...markdown.matchAll(/[\p{L}\p{N}]{4,}(?: [\p{L}\p{N}]{2,}){0,3}/gu)].filter((_, i) => i % 7 === 0);
    for (const { index, 0: quote } of words) {
      const anchor = createAnchor(markdown, index, index + quote.length);
      const drawn = renderedAnchor(markdown, anchor);
      if (!drawn) continue; // in markup only, such as a link's URL
      const at = locate(editor.text, drawn);
      const range = docRange(editor, at.start, at.end);
      const back = textRange(editor, range.from, range.to);
      const selected = editor.text.slice(back.start, back.end);
      // Raw HTML is one atom in the editor: selecting part of it selects all of it.
      if (selected !== drawn.exact) {
        assert.ok(selected.startsWith('<') && selected.includes(drawn.exact), `${file}: ${anchor.exact}`);
        continue;
      }
      const again = sourceAnchor(markdown, createAnchor(editor.text, back.start, back.end));
      assert.equal(again.exact, anchor.exact, `${file}: ${anchor.exact}`);
    }
  }
});

test('a selection becomes an anchor on the text as it will be saved, other blocks as they were written', async () => {
  const parse = await editorParser();
  const serialize = await editorSerializer();
  const disk = 'Some __bold__ text.\n\nNext.\n';
  const doc = parse('Some __bold__ text.\n\nNext one.\n'); // the human typed in the second paragraph
  const text = splice(disk, serialize(doc));
  assert.ok(text.startsWith('Some __bold__ text.\n\nNext one.'), text);
  const editor = projectDoc(doc);
  const start = editor.text.indexOf('bold text');
  const anchor = sourceAnchor(text, createAnchor(editor.text, start, start + 'bold text'.length));
  assert.equal(anchor.exact, 'bold__ text');
  assert.equal(renderedAnchor(text, anchor).exact, 'bold text');
});
