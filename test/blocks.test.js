import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { diffBlocks } from '../web/blocks.js';

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
