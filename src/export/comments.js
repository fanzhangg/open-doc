// Comment threads in an export: which threads go in, their numbers, and
// where they sit in the doc's syntax tree. Each thread's text is wrapped in
// `odMark` nodes (one per stretch of a text node it covers) and followed by
// an `odRef` node carrying its number, so every format can mark it its own
// way: a highlight and a superscript in HTML.

import { locate } from '../core/anchor.js';
import { project, sourceRange, valueOffsets } from '../core/project.js';

export const COMMENT_CHOICES = Object.freeze(['none', 'open', 'all']);

/**
 * The threads `choice` takes ('none', 'open' or 'all'), numbered in the order
 * their text appears; threads whose text is gone (detached, or never on any
 * text) come last. Each: { n, thread, range: { start, end } | null } with
 * `range` in markdown source offsets.
 */
export function pickThreads(sidecar, markdown, choice) {
  if (choice === 'none') return [];
  const wanted = sidecar.threads.filter((t) => choice === 'all' || t.status === 'open');
  if (wanted.length === 0) return [];
  const projection = project(markdown);
  const placed = wanted.map((thread) => {
    const found = thread.anchor && !thread.detached ? locate(projection.text, thread.anchor) : null;
    return { thread, range: found ? sourceRange(projection, found.start, found.end) : null };
  });
  const at = (p) => (p.range ? p.range.start : Infinity);
  placed.sort((a, b) => at(a) - at(b));
  return placed.map((p, i) => ({ n: i + 1, ...p }));
}

/**
 * Wrap each picked thread's text in `tree` (parsed from `source`) in odMark
 * nodes and put an odRef after its last character (after the link, with
 * `outsideLinks`, when that character is in one). Threads whose text is in
 * no text node (code blocks, raw HTML) get no marks. Returns the numbers of
 * the threads that were marked.
 */
export function markThreads(tree, source, picked, { outsideLinks = false } = {}) {
  const ranged = picked.filter((p) => p.range && p.range.end > p.range.start);
  const marked = new Set();
  if (ranged.length === 0) return marked;

  // Pass 1: every text and inline-code node with its characters' offsets,
  // and for each thread the last character it covers.
  const nodes = [];
  const last = new Map(); // n → [node index, char index]
  visit(tree, null, (node, parent) => {
    if (node.type !== 'text' && node.type !== 'inlineCode') return;
    const offsets = valueOffsets(node, source);
    const index = nodes.push({ node, parent, offsets }) - 1;
    offsets.forEach((offset, i) => {
      for (const p of ranged) if (offset >= p.range.start && offset < p.range.end) last.set(p.n, [index, i]);
    });
  });

  // Pass 2: split each node into runs covered by the same threads.
  nodes.forEach(({ node, parent, offsets }, index) => {
    const covers = offsets.map((offset) => ranged.filter((p) => offset >= p.range.start && offset < p.range.end).map((p) => p.n));
    if (covers.every((c) => c.length === 0)) return;
    const pieces = [];
    let from = 0;
    for (let i = 1; i <= offsets.length; i++) {
      const ends = ranged.filter((p) => last.get(p.n)?.[0] === index && last.get(p.n)[1] === i - 1).map((p) => p.n);
      if (i < offsets.length && ends.length === 0 && same(covers[i], covers[from])) continue;
      const piece = { ...node, value: node.value.slice(from, i) };
      delete piece.position;
      if (covers[from].length > 0) {
        pieces.push({ type: 'odMark', threads: covers[from], children: [piece] });
        for (const n of covers[from]) marked.add(n);
      } else {
        pieces.push(piece);
      }
      for (const n of ends) pieces.push({ type: 'odRef', n });
      from = i;
    }
    const at = parent.children.indexOf(node);
    parent.children.splice(at, 1, ...pieces);
  });
  if (outsideLinks) hoistRefs(tree);
  return marked;
}

// In HTML a number is a link of its own, which cannot sit inside another.
function hoistRefs(node) {
  for (let i = 0; i < (node.children?.length ?? 0); i++) {
    const child = node.children[i];
    if (child.type === 'link' || child.type === 'linkReference') {
      const refs = [];
      takeRefs(child, refs);
      node.children.splice(i + 1, 0, ...refs);
      i += refs.length;
    } else {
      hoistRefs(child);
    }
  }
}

function takeRefs(node, refs) {
  if (!node.children) return;
  node.children = node.children.filter((child) => {
    if (child.type === 'odRef') {
      refs.push(child);
      return false;
    }
    takeRefs(child, refs);
    return true;
  });
}

function visit(node, parent, fn) {
  fn(node, parent);
  if (node.children) for (const child of [...node.children]) visit(child, node, fn);
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
