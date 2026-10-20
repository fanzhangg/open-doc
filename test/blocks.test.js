import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Fragment, Node, Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { diffBlocks, pairRanges, parseRun, replaceBlocks, sameBlock, textOfDoc } from '../web/blocks.js';
import { blockRanges, project, projectBlocks } from '../src/markdown/project.js';
import { splice } from '../src/markdown/splice.js';
import { projectDoc } from '../web/pm-text.js';
import { editorParser, editorSerializer } from './milkdown.js';

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

// A long doc changed a few blocks at a time (web/views/markdown/view.js): the
// text and projections worked out per block are those worked out whole.

const CORPUS = [
  ...JSON.parse(readFileSync(new URL('fixtures/rendered-text.json', import.meta.url), 'utf8')).cases.map((c) => c.markdown)
    .filter((markdown) => !markdown.includes(']:')), // a definition ties blocks together: worked out whole
  'Setext\n======', '* one\n* two\n\n  more', '1) a\n2) b', '> quote\nlazy', '| a | b |\n|---|:-:|\n| c | d |', '```js\nx\n```',
  'A hard\nwrapped __line__.', '<br />', '---', '- [ ] task',
].join('\n\n') + '\n\n| last | table |\n| - | - |\n| x | y |\n';

test('a doc changed in a few blocks reads, writes and projects as it would whole', async () => {
  const parse = await editorParser();
  const serialize = await editorSerializer();
  const serializeNodes = (nodes) => serialize(parse('').type.create(null, nodes));
  let seed = 3;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const words = ['x', ' word', '**b**', '\n', '\n\n', '- ', '```', '# ', '|', '>', '<br />', '\\'];
  let wholes = 0;
  const runs = 150;
  for (let run = 0; run < runs; run++) {
    // In: text `given` with a change, read only around it.
    const given = CORPUS;
    const base = parse(given);
    const blocks = pairRanges(base.content.content, blockRanges(given), true);
    assert.ok(blocks, 'the corpus pairs up');
    const at = random(given.length);
    const next = given.slice(0, at) + words[random(words.length)] + given.slice(at + random(4));
    const read = parseRun(base, given, blocks, next, parse);
    const whole = parse(next);
    if (!read) {
      wholes++;
      continue;
    }
    const kept = base.content.content;
    const doc = base.copy(Fragment.from([...kept.slice(0, read.from), ...read.nodes, ...kept.slice(read.to)]));
    assert.equal(doc.childCount, whole.childCount, `run ${run}: ${JSON.stringify(next.slice(at - 20, at + 20))}`);
    doc.forEach((node, _, i) => assert.ok(sameBlock(node, whole.child(i)), `run ${run}, block ${i}`));
    assert.deepEqual(read.blocks, pairRanges(whole.content.content, blockRanges(next), true));

    // Out: `doc`, with one block of it changed, written only around the change.
    // (Where the editor cannot hold a block as written, such as a table row
    // with a cell too many, a whole save rewrites it too; one around the
    // change leaves it, so those are not compared.)
    if (splice(next, serialize(whole)) !== next) continue;
    const i = random(doc.childCount);
    const edited = parse(serializeNodes([doc.child(i)]) + 'typed').content.content;
    const after = doc.copy(Fragment.from([...doc.content.content.slice(0, i), ...edited, ...doc.content.content.slice(i + 1)]));
    const ours = serialize(after);
    const expected = ours === serialize(parse(next)) ? next : splice(next, ours);
    const written = textOfDoc(after, doc, next, read.blocks, serializeNodes);
    if (!written) {
      wholes++;
      continue;
    }
    assert.equal(written.text, expected, `run ${run}`);
    assert.deepEqual(written.blocks, pairRanges(after.content.content, blockRanges(written.text), true));
    const cache = new Map();
    for (const text of [next, written.text]) {
      const blocksOfText = text === next ? read.blocks : written.blocks;
      assert.deepEqual(projectBlocks(text, blocksOfText, cache), project(text));
    }
    assert.deepEqual(projectDoc(after), projectDoc(Node.fromJSON(after.type.schema, after.toJSON())), 'kept lines are the same as fresh ones');
  }
  assert.ok(wholes < runs / 5, `${wholes} of ${runs} worked out whole`);
});
