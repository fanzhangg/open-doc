// Which top-level blocks differ between two docs, so a change from disk
// replaces only those (web/editor.js) and the caret stays put.

import { Fragment, Mark } from '@milkdown/kit/prose/model';

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

// Equal blocks, ignoring heading ids: the live editor derives them from the
// text after parsing, so a freshly parsed copy of the same heading lacks one.
export function sameBlock(a, b) {
  if (a.eq(b)) return true;
  return a.type === b.type && a.content.eq(b.content) && Mark.sameSet(a.marks, b.marks) && sameAttrs(a, b);
}

function sameAttrs(a, b) {
  const { id: _a, ...restA } = a.attrs;
  const { id: _b, ...restB } = b.attrs;
  return JSON.stringify(restA) === JSON.stringify(restB);
}
