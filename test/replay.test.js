import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { tableEditing, tableNodes } from '@milkdown/kit/prose/tables';
import { byHuman, diffBlocks, mapOp, planReplay, replayAll, replayKey, runOp } from '../web/replay.js';

// A small schema shaped like the editor's: headings carry an id the editor
// derives, lists hold paragraphs, code blocks hold plain text.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 }, id: { default: '' } } },
    code_block: { group: 'block', content: 'text*', marks: '', code: true },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph block*' },
    hr: { group: 'block' },
    text: { group: 'inline' },
    hardbreak: { group: 'inline', inline: true },
  },
  marks: { strong: {}, emphasis: {} },
});
const { nodes, marks } = schema;
const t = (text, ...markNames) => schema.text(text, markNames.map((m) => marks[m].create()));
const p = (...content) => nodes.paragraph.create(null, content.map((c) => (typeof c === 'string' ? t(c) : c)));
const h = (level, text, id = '') => nodes.heading.create({ level, id }, text ? [t(text)] : []);
const list = (...items) => nodes.bullet_list.create(null, items.map((text) => nodes.list_item.create(null, [p(text)])));
const doc = (...blocks) => nodes.doc.create(null, blocks);

function reaches(before, after) {
  const ops = planReplay(before, after);
  const planned = ops.map((op) => ({ ...op, units: op.units && [...op.units] })); // running consumes units
  const end = replayAll(EditorState.create({ doc: before }), ops);
  assert.deepEqual(diffBlocks(end.doc, after), [], `replay of ${ops.length} ops did not reach the target:\n${end.doc}\n${after}`);
  return planned;
}

const kinds = (ops) => ops.filter((op) => op.kind !== 'pause').map((op) => op.kind);

test('nothing changed: nothing to replay', () => {
  const d = doc(h(1, 'Plan'), p('Intro.'));
  assert.deepEqual(planReplay(d, doc(h(1, 'Plan', 'plan'), p('Intro.'))), []);
});

test('a changed word is selected, removed and typed; the rest stays', () => {
  const ops = reaches(doc(p('The plan has three steps.')), doc(p('The plan has four steps.')));
  assert.deepEqual(kinds(ops), ['select', 'delete', 'type']);
  const typed = ops.find((op) => op.kind === 'type');
  assert.equal(typed.units.map((u) => u.text).join(''), 'four');
});

test('words separated only by spaces change as one phrase', () => {
  const ops = reaches(doc(p('the quick brown fox')), doc(p('a slow brown fox')));
  assert.deepEqual(kinds(ops), ['select', 'delete', 'type']);
});

test('CJK text changes character by character', () => {
  const ops = reaches(doc(p('我们计划下周发布。')), doc(p('我们计划本周发布。')));
  const typed = ops.find((op) => op.kind === 'type');
  assert.equal(typed.units.map((u) => u.text).join(''), '本');
});

test('formatting only: the same text is replaced with its new marks', () => {
  const ops = reaches(doc(p('Ship ', 'now', '.')), doc(p('Ship ', t('now', 'strong'), '.')));
  assert.deepEqual(kinds(ops), ['select', 'replace']);
});

test('several changed paragraphs are replayed paragraph by paragraph', () => {
  const ops = reaches(
    doc(h(2, 'Risks'), p('One risk.'), p('Two risks.'), p('Three risks.')),
    doc(h(2, 'Risks'), p('One known risk.'), p('Two risks!'), p('Three new risks.')),
  );
  assert.ok(!ops.some((op) => op.kind === 'swap' || op.kind === 'block'), 'no paragraph is retyped whole');
  assert.equal(new Set(ops.map((op) => op.group)).size, 3);
});

test('new blocks are inserted empty and typed, including lists', () => {
  const ops = reaches(doc(p('Intro.')), doc(p('Intro.'), h(2, 'Next'), list('first', 'second'), nodes.hr.create(), p('End.')));
  assert.ok(ops.filter((op) => op.kind === 'block').length === 4);
});

test('removed blocks, a heading level change, list items and code blocks', () => {
  reaches(doc(p('A'), p('B'), p('C')), doc(p('A'), p('C')));
  reaches(doc(p('Title')), doc(h(2, 'Title')));
  reaches(doc(list('one', 'two', 'three')), doc(list('one', 'two!', 'four', 'three')));
  reaches(doc(nodes.code_block.create(null, [t('let a = 1;\nlet b = 2;')])), doc(nodes.code_block.create(null, [t('let a = 1;\nlet b = 3;\nlet c = 4;')])));
  reaches(doc(p('A list:')), doc(list('only')));
});

test('a hard break and an emoji are typed whole', () => {
  reaches(doc(p('Line')), doc(p('Line', nodes.hardbreak.create(), 'next 😀')));
});

test('typing elsewhere meanwhile: the rest of the replay still lands in place', () => {
  const before = doc(p('Alpha beta.'), p('Gamma delta.'));
  const after = doc(p('Alpha beta.'), p('Gamma epsilon delta.'));
  const queue = planReplay(before, after);
  let state = EditorState.create({ doc: before });
  // The human types at the start of the first paragraph before anything runs.
  const human = state.tr.insertText('Oh. ', 1);
  state = state.apply(human);
  for (const op of queue) mapOp(op, human.mapping);
  while (queue.length > 0) {
    const op = queue.shift();
    const result = runOp(state, op);
    if (!result.tr) continue;
    state = state.apply(result.tr);
    for (const rest of queue) mapOp(rest, result.tr.mapping);
    queue.unshift(...result.more);
  }
  assert.equal(state.doc.textBetween(0, state.doc.content.size, '\n'), 'Oh. Alpha beta.\nGamma epsilon delta.');
});

// Tables, with the table plugin the editor runs: it pads a row that is
// shorter than the others with empty cells after every transaction.
const tableSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    text: {},
    ...tableNodes({ tableGroup: 'block', cellContent: 'paragraph', cellAttributes: {} }),
  },
});
const tn = tableSchema.nodes;
const cellOf = (type, text) => type.create(null, tn.paragraph.create(null, text ? tableSchema.text(text) : null));
// table(['Kind', 'Pro'], ['Docs', 'Shared'], ...): a header row, then body rows.
const table = (header, ...body) => tableSchema.node('doc', null, [tn.table.create(null, [
  tn.table_row.create(null, header.map((text) => cellOf(tn.table_header, text))),
  ...body.map((cells) => tn.table_row.create(null, cells.map((text) => cellOf(tn.table_cell, text)))),
])]);
const rowsOf = (d) => d.firstChild.content.content.map((row) => row.content.content.map((c) => c.textContent));

function reachesWithTables(before, after) {
  const ops = planReplay(before, after);
  const end = replayAll(EditorState.create({ doc: before, plugins: [tableEditing()] }), ops);
  assert.deepEqual(rowsOf(end.doc), rowsOf(after));
  return ops;
}

test('a removed column: the table is retyped whole, so no row is padded at the front', () => {
  const ops = reachesWithTables(
    table(['Kind', 'Pro', 'Con', 'Ours'], ['Docs', 'Shared', 'Closed', 'Open'], ['Chat', 'Quick', 'No comments', 'Comments']),
    table(['Kind', 'Pro', 'Con'], ['Docs', 'Shared', 'Closed'], ['Chat', 'Quick', 'No comments']),
  );
  assert.deepEqual(kinds(ops), ['select', 'swap']);
});

test('an added column or row also retypes the table', () => {
  reachesWithTables(table(['Kind', 'Pro'], ['Docs', 'Shared']), table(['Kind', 'Pro', 'Con'], ['Docs', 'Shared', 'Closed']));
  reachesWithTables(table(['Kind', 'Pro'], ['Docs', 'Shared']), table(['Kind', 'Pro'], ['Docs', 'Shared'], ['Chat', 'Quick']));
});

test('same rows and columns: changed cells are typed in place', () => {
  const ops = reachesWithTables(table(['Kind', 'Pro'], ['Docs', 'Shared editing']), table(['Kind', 'Pro'], ['Docs', 'Live shared editing']));
  assert.ok(!ops.some((op) => op.kind === 'swap' || op.kind === 'block'));
});

test("the table plugin's fix after a replay step is not the human's edit; after the human's, it is", () => {
  const state = EditorState.create({ doc: table(['Kind', 'Pro'], ['Docs', 'Shared']), plugins: [tableEditing()] });
  const lastHeaderCell = state.doc.firstChild.firstChild.lastChild;
  const from = 1 + 1 + state.doc.firstChild.firstChild.firstChild.nodeSize; // inside the table, inside the header row, after its first cell
  const ragged = () => state.tr.delete(from, from + lastHeaderCell.nodeSize);
  for (const [tr, human] of [[ragged().setMeta(replayKey, true), false], [ragged(), true]]) {
    const { transactions } = state.applyTransaction(tr);
    assert.equal(transactions.length, 2, 'the table plugin padded the short row');
    assert.equal(byHuman(transactions[1]), human);
  }
});
