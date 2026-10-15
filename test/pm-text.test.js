import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { CellSelection, tableNodes } from '@milkdown/kit/prose/tables';
import { projectDoc, selectionSpan, textRange } from '../web/pm-text.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    text: {},
    ...tableNodes({ tableGroup: 'block', cellContent: 'paragraph', cellAttributes: {} }),
  },
});
const { nodes } = schema;
const p = (text) => nodes.paragraph.create(null, text ? schema.text(text) : null);
const cell = (type, text) => type.create(null, p(text));
const doc = nodes.doc.create(null, [
  p('Before'),
  nodes.table.create(null, [
    nodes.table_row.create(null, [cell(nodes.table_header, 'Kind'), cell(nodes.table_header, 'Pro')]),
    nodes.table_row.create(null, [cell(nodes.table_cell, 'Docs'), cell(nodes.table_cell, 'Shared')]),
  ]),
  p('After'),
]);

// Position of the cell whose text is `text`.
function cellPos(text) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found === null && node.type.spec.tableRole?.includes('cell') && node.textContent === text) found = pos;
  });
  return found;
}

const quoteOf = (selection) => {
  const projection = projectDoc(doc);
  const { from, to } = selectionSpan(selection);
  const range = textRange(projection, from, to);
  return projection.text.slice(range.start, range.end);
};

test('a selection of table cells spans every selected cell, not only the first', () => {
  const all = CellSelection.create(doc, cellPos('Kind'), cellPos('Shared'));
  assert.equal(all.ranges.length, 4);
  assert.equal(quoteOf(all), 'Kind\nPro\nDocs\nShared');
});

test('a text selection spans what it always did', () => {
  const projection = projectDoc(doc);
  const start = projection.positions[projection.text.indexOf('fore')];
  const end = projection.positions[projection.text.indexOf('Kind') + 2];
  const selection = TextSelection.create(doc, start, end);
  assert.deepEqual(selectionSpan(selection), { from: selection.from, to: selection.to });
  assert.equal(quoteOf(selection), 'fore\nKi');
});
