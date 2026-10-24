// Which top-level blocks differ between two docs, so a change from disk
// replaces only those (web/views/markdown/view.js) and the caret stays put;
// and the doc's text and document worked out a few changed blocks at a time,
// for a long doc that others change while one types.

import { Fragment, Mark } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { Transform, replaceStep } from '@milkdown/kit/prose/transform';
import { blockRanges, definesLinks, project, startsFrontMatter } from '../../../src/markdown/project.js';
import { projectDoc } from '../../pm-text.js';
import { splice } from '../../../src/markdown/splice.js';
import { sameEnd, sameStart } from '../../../src/core/diff.js';

/**
 * Runs of children that differ between two nodes, aligned by a longest
 * common subsequence of equal children: [{ a0, a1, b0, b1 }], in order.
 */
export function diffBlocks(a, b) {
  return diffSeq(a.childCount, b.childCount, (x, y) => sameBlock(a.child(x), b.child(y)));
}

/**
 * Turn doc `a` into doc `b` in `tr` (a transaction on `a`), changing the runs
 * of blocks in `hunks` (from diffBlocks) by the smallest step, so a caret
 * and the undo history in what did not change stay: a block replaced by one
 * of the same type keeps what did not change; one that keeps its text is
 * made the other type, wrapped (made a list item or a quote) or split
 * (reshape); otherwise only what lies between the first and the last
 * position that differ is replaced, and a caret in it is kept at the same
 * character of the text, moved along with what changed before it.
 */
export function replaceBlocks(tr, a, b, hunks) {
  const { selection } = tr;
  const kept = new Map(); // a position of the selection in `a` → where it is in `b`
  for (const h of [...hunks].reverse()) {
    const from = childPos(a, h.a0);
    const nodes = [];
    for (let k = h.b0; k < h.b1; k++) nodes.push(b.child(k));
    if (h.a1 - h.a0 === 1 && h.b1 - h.b0 === 1 && a.child(h.a0).type === b.child(h.b0).type) {
      const old = a.child(h.a0);
      const next = b.child(h.b0);
      if (!sameAttrs(old, next)) tr.setNodeMarkup(from, null, next.attrs);
      const start = old.content.findDiffStart(next.content);
      if (start === null) continue;
      let { a: endA, b: endB } = old.content.findDiffEnd(next.content);
      // Repeated text can make the common end overlap the common start.
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      tr.replace(from + 1 + start, from + 1 + endA, next.slice(start, endB));
    } else {
      const reshaped = h.a1 - h.a0 === 1 && reshape(tr.doc, from, a.child(h.a0), nodes);
      if (reshaped && makes(reshaped.doc, tr.doc, h, nodes)) {
        for (const step of reshaped.steps) tr.step(step);
        continue;
      }
      const to = childPos(a, h.a1);
      const at = childPos(b, h.b0);
      const old = a.slice(from, to).content;
      const next = Fragment.from(nodes);
      const start = old.findDiffStart(next) ?? 0;
      let { a: endA, b: endB } = old.findDiffEnd(next) ?? { a: old.size, b: next.size };
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      // As one step, if it makes just these blocks (a table cut through is
      // made whole again otherwise); else they are replaced whole.
      const step = replaceStep(tr.doc, from + start, from + endA, b.slice(at + start, at + endB));
      const whole = !step || !makes(step.apply(tr.doc).doc, tr.doc, h, nodes);
      if (selection instanceof TextSelection) {
        for (const pos of [selection.anchor, selection.head]) {
          if (whole ? pos > from && pos < to : pos > from + start && pos < from + endA) kept.set(pos, sameCharacter(a, from, h.a1, pos, nodes, at));
        }
      }
      if (whole) tr.replaceWith(from, to, next);
      else tr.step(step);
    }
  }
  if (kept.size > 0) {
    const at = (pos) => kept.get(pos) ?? tr.mapping.map(pos);
    tr.setSelection(TextSelection.between(tr.doc.resolve(at(selection.anchor)), tr.doc.resolve(at(selection.head))));
  }
  return tr;
}

// Block `old` at `from` of `doc` made the blocks `nodes` by steps that keep
// its text: made another type (a paragraph a heading), wrapped (in a list
// item, a quote) or split in two: a Transform, or null when it is none of those.
function reshape(doc, from, old, nodes) {
  if (!old.isTextblock) return null;
  const t = new Transform(doc);
  if (nodes.length === 2 && nodes.every((node) => node.type === old.type && sameAttrs(node, old)) && old.content.eq(nodes[0].content.append(nodes[1].content))) {
    return t.split(from + 1 + nodes[0].content.size);
  }
  let inner = nodes[0];
  const wrappers = [];
  while (nodes.length === 1 && !inner.isTextblock && inner.childCount === 1) {
    wrappers.push({ type: inner.type, attrs: inner.attrs });
    inner = inner.firstChild;
  }
  if (nodes.length !== 1 || !inner.isTextblock || !inner.content.eq(old.content)) return null;
  try {
    if (inner.type !== old.type || !sameAttrs(inner, old)) t.setNodeMarkup(from, inner.type, inner.attrs);
    if (wrappers.length > 0) t.wrap(t.doc.resolve(from + 1).blockRange(), wrappers);
  } catch {
    return null; // a wrap the schema does not allow there
  }
  return t;
}

// Whether `made`, `doc` with hunk `h` changed, has `nodes` in its place.
const makes = (made, doc, h, nodes) => made.childCount === doc.childCount - (h.a1 - h.a0) + nodes.length && nodes.every((node, k) => sameBlock(made.child(h.a0 + k), node));

// Where position `pos` (in children from `from` up to child `end` of doc `a`)
// is in `nodes`, which replace them at `at`: at the same character of their
// text, moved by what changed before it.
function sameCharacter(a, from, end, pos, nodes, at) {
  let before = '';
  let offset = 0;
  a.nodesBetween(from, childPos(a, end), (node, p) => {
    if (!node.isText) return true;
    if (p < pos) offset = before.length + Math.min(node.text.length, pos - p);
    before += node.text;
    return false;
  });
  const after = nodes.map((node) => node.textContent).join('');
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  if (offset > head) offset = offset >= before.length - tail ? offset + after.length - before.length : after.length - tail;
  for (const node of nodes) {
    if (offset <= node.textContent.length) return textPos(node, at, offset);
    offset -= node.textContent.length;
    at += node.nodeSize;
  }
  return at;
}

/** Document position of text offset `offset` inside top-level `node` at `nodePos`. */
export function textPos(node, nodePos, offset) {
  let seen = 0;
  let result = null;
  node.descendants((child, pos) => {
    if (result !== null) return false;
    if (!child.isText) return true;
    if (offset <= seen + child.text.length) {
      result = nodePos + 1 + pos + (offset - seen);
      return false;
    }
    seen += child.text.length;
    return true;
  });
  return result ?? nodePos + node.nodeSize - 1;
}

/** Document position where top-level child `index` of `doc` starts. */
export function childPos(doc, index) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/**
 * The text of document `doc`, from text `given` of an earlier document
 * `base` whose children's ranges in it are `blocks`: each run of children
 * that changed, with a kept one on either side, written into `given`. A
 * block only typed or deleted in keeps its own bytes but for those
 * characters (typedInto); any other run is written by `serialize` (nodes →
 * markdown) and spliced in as a save is (src/markdown/splice.js). In a doc
 * that may define links (definesLinks), a block's links read with the
 * doc's definitions, the text between its blocks, and a run not only typed
 * into is left to a save of the whole doc. Returns { text, blocks },
 * `blocks` the ranges of `doc`'s children in `text`, or null when a run
 * does not pair up with them, or is left so.
 */
export function textOfDoc(doc, base, given, blocks, serialize, parse) {
  const links = definesLinks(given);
  const between = (i) => given.slice(i > 0 ? blocks[i - 1].end : 0, i < blocks.length ? blocks[i].start : given.length);
  const definitions = links ? blocks.map((_, i) => between(i)).concat(between(blocks.length)).join('').trim() : '';
  let text = '';
  let from = 0; // how much of `given` is passed
  let a = 0;
  const out = [];
  const keep = (to, by) => {
    for (; a < to; a++) out.push(moved(blocks[a], by));
  };
  // The run's text with each changed block typed into where it stands, or null.
  // (A last empty paragraph, which saves as nothing, may come or go.)
  const typed = (run) => {
    if (Math.abs(run.a1 - run.a0 - (run.b1 - run.b0)) > 1) return null;
    const count = Math.min(run.a1 - run.a0, run.b1 - run.b0);
    const extra = (node, end, length) => end === length && node.childCount === 0 && node.type.name === 'paragraph';
    if (run.a1 - run.a0 > count && !extra(base.child(run.a1 - 1), run.a1, base.childCount)) return null;
    if (run.b1 - run.b0 > count && !extra(doc.child(run.b1 - 1), run.b1, doc.childCount)) return null;
    let piece = '';
    let at = blocks[run.a0].start;
    const ranges = [];
    for (let k = 0; k < count; k++) {
      const { start, end } = blocks[run.a0 + k];
      const node = doc.child(run.b0 + k);
      const own = node === base.child(run.a0 + k) ? given.slice(start, end) : typedInto(given.slice(start, end), node, parse, definitions);
      if (own === null) return null;
      piece += given.slice(at, start);
      ranges.push({ start: piece.length, end: piece.length + own.length });
      piece += own;
      at = end;
    }
    if (run.b1 - run.b0 > count) ranges.push({ start: piece.length, end: piece.length });
    return { piece, ranges };
  };
  for (const run of changedRuns(base, doc)) {
    if (run.a1 === run.a0) return null;
    const start = blocks[run.a0].start;
    const end = blocks[run.a1 - 1].end;
    keep(run.a0, text.length - from);
    text += given.slice(from, start);
    let found = typed(run);
    if (!found) {
      if (links) return null;
      const nodes = [];
      for (let k = run.b0; k < run.b1; k++) nodes.push(doc.child(k));
      const written = serialize(nodes).replace(/\n$/, '');
      if (start > 0 && (startsFrontMatter(given.slice(start, end)) || startsFrontMatter(written))) return null;
      const piece = splice(given.slice(start, end), written);
      const ranges = pairRanges(nodes, blockRanges(piece), run.b1 === doc.childCount);
      if (!ranges) return null;
      found = { piece, ranges };
    }
    for (const range of found.ranges) out.push(moved(range, text.length));
    text += found.piece;
    from = end;
    a = run.a1;
  }
  keep(blocks.length, text.length - from);
  return { text: text + given.slice(from), blocks: out };
}

// A task list item's box: its `[ ]` or `[x]` and what comes before its mark.
const TASK = /^([ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/gm;

/**
 * Block `source` with the characters typed into or deleted from it to make
 * block `node`, and nothing else: its own style kept (a setext heading, `*`
 * bullets, a table's padding), so others typing in it at once merge by
 * character. Null when that does not read as `node` (`parse`: markdown →
 * document), such as when formatting changed or typed Markdown would read
 * as syntax; then the editor writes the block in its own style.
 * `definitions` are the doc's link definitions, for its links to read as in the doc.
 */
export function typedInto(source, node, parse, definitions = '') {
  const parsed = (block) => parse(definitions ? `${block}\n\n${definitions}` : block);
  const before = project(definitions ? `${source}\n\n${definitions}` : source);
  const after = projectDoc(node.type.schema.topNodeType.create(null, [node])).text;
  // No text changed: tasks were ticked or unticked, so each `[ ]` or `[x]` says what its item does.
  if (before.text === after) {
    const checked = [];
    node.descendants((child) => {
      if (child.attrs.checked != null) checked.push(child.attrs.checked);
    });
    let i = 0;
    const candidate = source.replace(TASK, (_, head, mark) => `${head}${checked[i++] ? mark.trim() || 'x' : ' '}]`);
    const read = parsed(candidate);
    if (read.childCount === 1 && sameBlock(read.child(0), node)) return candidate;
  }
  const max = Math.min(before.text.length, after.length);
  let head = 0;
  while (head < max && before.text[head] === after[head]) head++;
  let tail = 0;
  while (tail < max - head && before.text[before.text.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const { offsets } = before;
  const removed = before.text.length - tail;
  const inserted = after.slice(head, after.length - tail);
  // Where the change goes in the source: over the removed characters, or
  // between two kept ones, before the next (outside its markup) or after the last.
  const spans = removed > head
    ? [[offsets[head], offsets[removed - 1] + 1]]
    : [head < before.text.length && offsets[head], head > 0 && offsets[head - 1] + 1].filter((at) => at !== false).map((at) => [at, at]);
  for (const [from, to] of spans) {
    for (const text of [inserted, inserted.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, '\\$&')]) {
      const candidate = source.slice(0, from) + text + source.slice(to);
      const read = parsed(candidate);
      if (read.childCount === 1 && sameBlock(read.child(0), node)) return candidate;
    }
  }
  return null;
}

/**
 * Document `doc`, whose text is `text` and its children's ranges in it
 * `blocks`, made into text `next` by parsing (`parse`: markdown → document)
 * only the blocks covering where the two differ, with a kept one on either
 * side: { from, to, nodes, blocks }, children [from, to) of `doc` to be
 * `nodes`, and the ranges of the new children in `next`. Null when that is
 * not sure to read as the whole text would: either text may define a link
 * (definesLinks), the change is outside every block, or a kept block reads
 * differently on its own (a fence opened in the change runs on past it).
 */
export function parseRun(doc, text, blocks, next, parse) {
  if (definesLinks(text) || definesLinks(next)) return null;
  const head = sameStart(text, next);
  const tail = sameEnd(text, next, Math.min(text.length, next.length) - head);
  const changedEnd = text.length - tail;
  let from = blocks.findIndex((b) => b.end >= head);
  if (from === -1) from = blocks.length;
  let to = blocks.length;
  while (to > 0 && blocks[to - 1].start > changedEnd) to--;
  from = Math.max(0, from - 1);
  to = Math.min(blocks.length, to + 1);
  // An empty paragraph is blank lines (withBlankParagraphs): read with those
  // on both sides of it, up to a block with text.
  while (from > 0 && blocks[from].start === blocks[from].end) from--;
  while (to < blocks.length && blocks[to - 1].start === blocks[to - 1].end) to++;
  if (from >= to || blocks[from].start > head || blocks[to - 1].end < changedEnd) return null;

  const start = blocks[from].start;
  const shift = next.length - text.length;
  const piece = next.slice(start, blocks[to - 1].end + shift);
  if (start > 0 && startsFrontMatter(piece)) return null;
  const nodes = parse(piece).content.content;
  const ranges = pairRanges(nodes, blockRanges(piece), to === doc.childCount);
  if (!ranges) return null;
  if (from > 0 && !sameBlock(nodes[0], doc.child(from))) return null;
  if (to < doc.childCount && !sameBlock(nodes.at(-1), doc.child(to - 1))) return null;
  return {
    from, to, nodes,
    blocks: [...blocks.slice(0, from), ...ranges.map((r) => moved(r, start)), ...blocks.slice(to).map((r) => moved(r, shift))],
  };
}

/**
 * The ranges in `text` of the children of `doc`, its document, or null when
 * they do not pair up. Link definitions lie between them (blockRanges).
 */
export function blocksOf(doc, text) {
  return pairRanges(doc.content.content, blockRanges(text), true);
}

/**
 * `ranges` as the ranges of `nodes`, one each; a last empty paragraph of the
 * doc (`atEnd`; the editor keeps one after a last table, and it saves as
 * nothing) has an empty range. Null when they do not pair up.
 */
export function pairRanges(nodes, ranges, atEnd) {
  if (nodes.length === ranges.length) return ranges;
  const last = nodes.at(-1);
  if (!atEnd || nodes.length !== ranges.length + 1 || last.type.name !== 'paragraph' || last.childCount > 0) return null;
  const end = ranges.at(-1)?.end ?? 0;
  return [...ranges, { start: end, end }];
}

// Runs of children of `b` that are not children of `a` (a ProseMirror
// document keeps the very nodes a change did not touch), each with a kept
// child on either side where there is one: [{ a0, a1, b0, b1 }], in order.
function changedRuns(a, b) {
  const index = new Map();
  a.forEach((node, _, i) => index.set(node, i));
  const runs = [];
  let keptA = -1;
  let keptB = -1;
  for (let j = 0; j <= b.childCount; j++) {
    const k = j < b.childCount ? index.get(b.child(j)) : a.childCount;
    if (k === undefined || k <= keptA) continue;
    if (k > keptA + 1 || j > keptB + 1) {
      const run = { a0: Math.max(0, keptA), a1: Math.min(a.childCount, k + 1), b0: Math.max(0, keptB), b1: Math.min(b.childCount, j + 1) };
      // An empty paragraph is blank lines (withBlankParagraphs): a run takes
      // in the kept ones beside it, up to a block with text.
      while (run.a0 > 0 && run.b0 > 0 && blank(a.child(run.a0)) && a.child(run.a0 - 1) === b.child(run.b0 - 1)) {
        run.a0--;
        run.b0--;
      }
      while (run.a1 < a.childCount && run.b1 < b.childCount && blank(a.child(run.a1 - 1)) && a.child(run.a1) === b.child(run.b1)) {
        run.a1++;
        run.b1++;
      }
      const last = runs.at(-1);
      if (last && run.a0 < last.a1) Object.assign(last, { a1: run.a1, b1: run.b1 });
      else runs.push(run);
    }
    keptA = k;
    keptB = j;
  }
  return runs;
}

const moved = (range, by) => ({ start: range.start + by, end: range.end + by });
const blank = (node) => node.type.name === 'paragraph' && node.childCount === 0;

// Runs where two sequences of length n and m differ, given equality by index.
function diffSeq(n, m, eq) {
  let start = 0;
  while (start < n && start < m && eq(start, start)) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && eq(endA - 1, endB - 1)) {
    endA--;
    endB--;
  }
  const rows = endA - start;
  const cols = endB - start;
  if (rows === 0 && cols === 0) return [];
  if (rows === 0 || cols === 0 || rows * cols > 1_000_000) return [{ a0: start, a1: endA, b0: start, b1: endB }];

  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  const same = (x, y) => eq(start + x, start + y);
  for (let x = rows - 1; x >= 0; x--) {
    for (let y = cols - 1; y >= 0; y--) {
      table[x * width + y] = same(x, y) ? table[(x + 1) * width + y + 1] + 1 : Math.max(table[(x + 1) * width + y], table[x * width + y + 1]);
    }
  }
  const runs = [];
  let x = 0;
  let y = 0;
  let open = null;
  const close = () => {
    if (open) runs.push({ a0: start + open.x, a1: start + x, b0: start + open.y, b1: start + y });
    open = null;
  };
  while (x < rows || y < cols) {
    if (x < rows && y < cols && same(x, y)) {
      close();
      x++;
      y++;
    } else {
      open ??= { x, y };
      if (y >= cols || (x < rows && table[(x + 1) * width + y] >= table[x * width + y + 1])) x++;
      else y++;
    }
  }
  close();
  return runs;
}

// Equal blocks, ignoring heading ids: a heading pasted from a web page keeps
// the page's id, which a freshly parsed copy of the same heading lacks.
export function sameBlock(a, b) {
  if (a.eq(b)) return true;
  return a.type === b.type && a.content.eq(b.content) && Mark.sameSet(a.marks, b.marks) && sameAttrs(a, b);
}

function sameAttrs(a, b) {
  const { id: _a, ...restA } = a.attrs;
  const { id: _b, ...restB } = b.attrs;
  return JSON.stringify(restA) === JSON.stringify(restB);
}
