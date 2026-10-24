import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Fragment, Node, Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { blocksOf, diffBlocks, pairRanges, parseRun, replaceBlocks, sameBlock, textOfDoc, typedInto } from '../web/views/markdown/blocks.js';
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

test('a block replaced whole keeps the caret at the same character', () => {
  // the caret after "Alpha" in the second block, which becomes a heading
  assert.equal(apply(doc(p('x'), p('Alpha one')), doc(p('x'), h('Alpha one')), 9).caret, 9);
  // text added before the caret in the same change moves it along
  assert.equal(apply(doc(p('x'), p('Alpha one')), doc(p('x'), h('Hi Alpha one')), 9).caret, 12);
  // and a caret in a block another one replaces stays at its text when blocks around it go
  assert.equal(apply(doc(p('x'), p('Alpha one')), doc(h('Alpha one')), 9).caret, 6);
});

// A long doc changed a few blocks at a time (web/views/markdown/view.js): the
// text and projections worked out per block are those worked out whole.

const CORPUS = [
  ...JSON.parse(readFileSync(new URL('fixtures/rendered-text.json', import.meta.url), 'utf8')).cases.map((c) => c.markdown)
    .filter((markdown) => !markdown.includes(']:')), // a definition ties blocks together: worked out whole
  'Setext\n======', '* one\n* two\n\n  more', '1) a\n2) b', '> quote\nlazy', '| a | b |\n|---|:-:|\n| c | d |', '```js\nx\n```',
  'A hard\nwrapped __line__.', '      ', '---', '- [ ] task', // '      ': blank lines, an empty paragraph
].join('\n\n') + '\n\n| last | table |\n| - | - |\n| x | y |\n';

test('an empty paragraph, blank lines, reads and writes with a block beside it, not the whole doc', async () => {
  const parse = await editorParser();
  const serialize = await editorSerializer();
  const serializeNodes = (nodes) => serialize(parse('').type.create(null, nodes));
  const given = 'Alpha.\n\n\n\nBeta.\n\nGamma.\n';
  const base = parse(given);
  assert.deepEqual(base.content.content.map((node) => node.type.name), ['paragraph', 'paragraph', 'paragraph', 'paragraph']);
  const blocks = blocksOf(base, given);
  const after = base.copy(Fragment.from([parse('# Alpha.').child(0), ...base.content.content.slice(1)]));
  const written = textOfDoc(after, base, given, blocks, serializeNodes, parse);
  assert.equal(written?.text, given.replace('Alpha.', '# Alpha.'));
  assert.deepEqual(parseRun(base, given, blocks, written.text, parse)?.blocks, written.blocks);
  assert.equal(serialize(after), written.text, 'and whole, the same');
});

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
  let typedOwn = 0;
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

    // Out: `doc`, with one block of it changed, written only around the
    // change: typed at its end, or written anew in the editor's style. It
    // reads as `doc` does, every other block keeps its bytes, and a block
    // only typed into keeps its own. (Where the editor cannot hold a block as
    // written, such as a table row with a cell too many, it rewrites it, so
    // those are left out.)
    if (splice(next, serialize(whole)) !== next) continue;
    const i = random(doc.childCount);
    const own = next.slice(read.blocks[i].start, read.blocks[i].end);
    const typing = random(2) === 0;
    const edited = parse((typing ? own : serializeNodes([doc.child(i)])) + 'typed').content.content;
    const rewritten = parse(serializeNodes(edited)).content.content;
    if (rewritten.length !== edited.length || edited.some((node, k) => !sameBlock(node, rewritten[k]))) continue;
    const after = doc.copy(Fragment.from([...doc.content.content.slice(0, i), ...edited, ...doc.content.content.slice(i + 1)]));
    const written = textOfDoc(after, doc, next, read.blocks, serializeNodes, parse);
    if (!written) {
      wholes++;
      continue;
    }
    const reread = parse(written.text);
    assert.equal(reread.childCount, after.childCount, `run ${run}`);
    after.forEach((node, _, k) => assert.ok(sameBlock(node, reread.child(k)), `run ${run}, block ${k}`));
    const bytes = (blocksOf, text, k) => text.slice(blocksOf[k].start, blocksOf[k].end);
    for (let k = 0; k < after.childCount; k++) {
      const old = k < i ? k : k >= i + edited.length ? k - edited.length + 1 : -1;
      if (old !== -1) assert.equal(bytes(written.blocks, written.text, k), bytes(read.blocks, next, old), `run ${run}: block ${k} kept`);
    }
    if (typing && edited.length === 1 && bytes(written.blocks, written.text, i) === `${own}typed`) typedOwn++;
    assert.deepEqual(written.blocks, pairRanges(after.content.content, blockRanges(written.text), true));
    const cache = new Map();
    for (const text of [next, written.text]) {
      const blocksOfText = text === next ? read.blocks : written.blocks;
      assert.deepEqual(projectBlocks(text, blocksOfText, cache), project(text));
    }
    assert.deepEqual(projectDoc(after), projectDoc(Node.fromJSON(after.type.schema, after.toJSON())), 'kept lines are the same as fresh ones');
  }
  console.log('WHOLES', wholes, typedOwn);
  assert.ok(wholes < runs / 5, `${wholes} of ${runs} worked out whole`);
  assert.ok(typedOwn > runs / 4, `${typedOwn} of ${runs} typed into in their own style`);
});

test('a doc that defines a link, at any depth, pairs up but is read whole', async () => {
  const parse = await editorParser();
  for (const definition of ['[a]: https://x', '> [a]: https://x', '- [a]: https://x', '1. > [^a]: a note']) {
    const text = `${definition}\n\nOne.\n\nTwo.\n\nSee [a] here.\n\nLast.\n`;
    const doc = parse(text);
    const blocks = blocksOf(doc, text);
    assert.ok(blocks, definition);
    assert.equal(parseRun(doc, text, blocks, text.replace('Two.', 'Too.'), parse), null, definition);
    // Even from a doc that paired up, a change that defines one is read whole.
    const plain = text.replace(definition, 'Plain.');
    assert.equal(parseRun(parse(plain), plain, blocksOf(parse(plain), plain), text, parse), null, definition);
  }
});

test('A5: typing in a doc that defines links keeps its definitions, and its links as written', async () => {
  const parse = await editorParser();
  const serialize = await editorSerializer();
  const serializeNodes = (nodes) => serialize(parse('').type.create(null, nodes));
  const definitions = '[a]: https://x\n[b]: https://y "Why"';
  const text = `[a]: https://x\n\nOne.\n\nSee [a] and [b][a] here.\n\n[b]: https://y "Why"\n`;
  const base = parse(text);
  const blocks = blocksOf(base, text);
  assert.equal(base.childCount, 2, 'the document has no definitions');
  for (const [i, was] of [[0, 'One.'], [1, 'See [a] and [b][a] here.']]) {
    const edited = parse(`${was}typed\n\n${definitions}`).child(0);
    const after = base.copy(Fragment.from(base.content.content.map((node, k) => (k === i ? edited : node))));
    assert.equal(textOfDoc(after, base, text, blocks, serializeNodes, parse).text, text.replace(was, `${was}typed`), was);
  }
});

test('a block typed into keeps its own style; one formatted anew is written in the editor\'s', async () => {
  const parse = await editorParser();
  const typed = (source, edited) => typedInto(source, parse(edited).child(0), parse);
  assert.equal(typed('Title\n=====', 'BTitleA\n====='), 'BTitleA\n=====');
  assert.equal(typed('* one\n* two', '* one\n* BtwoA'), '* one\n* BtwoA');
  assert.equal(typed('|a|b|\n|-|-|\n|cell|d|', '|a|b|\n|-|-|\n|BcellA|d|'), '|a|b|\n|-|-|\n|BcellA|d|');
  assert.equal(typed('Some __bold__ here.', 'Some __boldly__ here.'), 'Some __boldly__ here.', 'typed inside bold, inside its markup');
  assert.equal(typed('Some text.', 'Some \\*\\*x\\*\\* text.'), 'Some \\*\\*x\\*\\* text.', 'typed Markdown stays text, escaped');
  assert.equal(typed('Some text.', 'Some **text**.'), null, 'formatting is the editor\'s to write');
  assert.equal(typed('* [ ] one\n* [X] two', '- [x] one\n- [x] two'), '* [x] one\n* [X] two', 'a task ticked');
  assert.equal(typed('1. [ ] one\n2. [X] two', '1. [x] one\n2. [ ] two'), '1. [x] one\n2. [ ] two', 'tasks ticked and unticked');
});
