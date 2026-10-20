// Which top-level blocks differ between two docs, so a change from disk
// replaces only those (web/views/markdown/view.js) and the caret stays put;
// and the doc's text and document worked out a few changed blocks at a time,
// for a long doc that others change while one types.

import { Fragment, Mark } from '@milkdown/kit/prose/model';
import { blockRanges } from '../src/markdown/project.js';
import { splice } from '../src/markdown/splice.js';

/**
 * Runs of children that differ between two nodes, aligned by a longest
 * common subsequence of equal children: [{ a0, a1, b0, b1 }], in order.
 */
export function diffBlocks(a, b) {
  return diffSeq(a.childCount, b.childCount, (x, y) => sameBlock(a.child(x), b.child(y)));
}

/**
 * Turn doc `a` into doc `b` in `tr` (a transaction on `a`), replacing the runs
 * of blocks in `hunks` (from diffBlocks). A block replaced by one of the same
 * type keeps what did not change, so a caret in it stays where it was.
 */
export function replaceBlocks(tr, a, b, hunks) {
  for (const h of [...hunks].reverse()) {
    const from = childPos(a, h.a0);
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
      const nodes = [];
      for (let k = h.b0; k < h.b1; k++) nodes.push(b.child(k));
      tr.replaceWith(from, childPos(a, h.a1), Fragment.from(nodes));
    }
  }
  return tr;
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
 * that changed, with a kept one on either side, written by `serialize`
 * (nodes → markdown) and spliced into `given` as a save is
 * (src/markdown/splice.js). Returns { text, blocks }, `blocks` the ranges of
 * `doc`'s children in `text`, or null when a run does not pair up with them.
 */
export function textOfDoc(doc, base, given, blocks, serialize) {
  let text = '';
  let from = 0; // how much of `given` is passed
  let a = 0;
  const out = [];
  const keep = (to, by) => {
    for (; a < to; a++) out.push(moved(blocks[a], by));
  };
  for (const run of changedRuns(base, doc)) {
    if (run.a1 === run.a0) return null;
    const start = blocks[run.a0].start;
    const end = blocks[run.a1 - 1].end;
    keep(run.a0, text.length - from);
    text += given.slice(from, start);
    const nodes = [];
    for (let k = run.b0; k < run.b1; k++) nodes.push(doc.child(k));
    const piece = splice(given.slice(start, end), serialize(nodes).replace(/\n$/, ''));
    const ranges = pairRanges(nodes, blockRanges(piece), run.b1 === doc.childCount);
    if (!ranges) return null;
    for (const range of ranges) out.push(moved(range, text.length));
    text += piece;
    from = end;
    a = run.a1;
  }
  keep(blocks.length, text.length - from);
  return { text: text + given.slice(from), blocks: out };
}

/**
 * Document `doc`, whose text is `text` and its children's ranges in it
 * `blocks`, made into text `next` by parsing (`parse`: markdown → document)
 * only the blocks covering where the two differ, with a kept one on either
 * side: { from, to, nodes, blocks }, children [from, to) of `doc` to be
 * `nodes`, and the ranges of the new children in `next`. Null when that is
 * not sure to read as the whole text would: the change is outside every
 * block, or a kept block reads differently on its own (a fence opened in
 * the change runs on past it).
 */
export function parseRun(doc, text, blocks, next, parse) {
  const max = Math.min(text.length, next.length);
  let head = 0;
  while (head < max && text.charCodeAt(head) === next.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < max - head && text.charCodeAt(text.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail++;
  const changedEnd = text.length - tail;
  let from = blocks.findIndex((b) => b.end >= head);
  if (from === -1) from = blocks.length;
  let to = blocks.length;
  while (to > 0 && blocks[to - 1].start > changedEnd) to--;
  from = Math.max(0, from - 1);
  to = Math.min(blocks.length, to + 1);
  if (from >= to || blocks[from].start > head || blocks[to - 1].end < changedEnd) return null;

  const start = blocks[from].start;
  const shift = next.length - text.length;
  const piece = next.slice(start, blocks[to - 1].end + shift);
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
