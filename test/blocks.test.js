import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { diffBlocks, replaceBlocks } from '../web/blocks.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 }, id: { default: '' } } },
    text: { group: 'inline' },
  },
});
const p = (text) => schema.nodes.paragraph.create(null, text ? [schema.text(text)] : []);
const h = (text, id = '') => schema.nodes.heading.create({ id }, [schema.text(text)]);
const doc = (...blocks) => schema.nodes.doc.create(null, blocks);

test('blocks that differ, aligned by the ones that are the same', () => {
  assert.deepEqual(diffBlocks(doc(h('A'), p('one'), p('two')), doc(h('A', 'a'), p('one'), p('2'))), [{ a0: 2, a1: 3, b0: 2, b1: 3 }], 'a heading id is not a change');
  assert.deepEqual(diffBlocks(doc(p('one'), p('two')), doc(p('zero'), p('one'), p('two'))), [{ a0: 0, a1: 0, b0: 0, b1: 1 }]);
  assert.deepEqual(diffBlocks(doc(p('one'), p('two')), doc(p('one'))), [{ a0: 1, a1: 2, b0: 1, b1: 1 }]);
  assert.deepEqual(diffBlocks(doc(p('same')), doc(p('same'))), []);
});

// `a` turned into `b` with the caret at `caret` first: the doc and the caret after.
function apply(a, b, caret) {
  const state = EditorState.create({ doc: a, selection: TextSelection.create(a, caret) });
  const tr = replaceBlocks(state.tr, a, b, diffBlocks(a, b));
  return { doc: tr.doc, caret: tr.selection.from };
}

test('a change in the block holding the caret leaves the caret where it was', () => {
  // the caret after "Alpha" (1 + 5), text added further on in the same paragraph
  const changed = apply(doc(p('Alpha one'), p('Beta')), doc(p('Alpha one two'), p('Beta')), 6);
  assert.ok(changed.doc.eq(doc(p('Alpha one two'), p('Beta'))));
  assert.equal(changed.caret, 6);
  // text added before the caret moves it along with its text
  assert.equal(apply(doc(p('Alpha one')), doc(p('Hi Alpha one')), 6).caret, 9);
  // a heading made a paragraph is replaced whole, and blocks can be added at the end
  assert.ok(apply(doc(h('A'), p('one')), doc(p('A'), p('one'), p('two')), 1).doc.eq(doc(p('A'), p('one'), p('two'))));
});
