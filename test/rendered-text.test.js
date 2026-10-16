// Rendered-text conformance (SPEC.md §3.1): the core projection, which the
// server anchors comments with, and the editor's projection of its own
// document, which the page highlights them with, must produce the same text.
// Both are checked against spec/conformance/rendered-text.json, and against
// each other on every markdown file in this repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { project } from '../src/core/project.js';
import { docRange, projectDoc, textRange } from '../web/pm-text.js';
import { editorParser } from './milkdown.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const { cases } = JSON.parse(readFileSync(new URL('../spec/conformance/rendered-text.json', import.meta.url), 'utf8'));

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
