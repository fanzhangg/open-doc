// Byte-preserving saves: the editor sends its serialized markdown, which may
// format untouched blocks differently from the file (`__x__` vs `**x**`, hard
// wraps, list markers). Keep the original bytes of every top-level block whose
// meaning did not change, so `git diff` shows only real edits. A list or a
// table that did change keeps the bytes of its untouched items or rows.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly';
import { gfmFromMarkdown } from 'mdast-util-gfm';

const MAX_DIFF_CELLS = 4_000_000;

/** @returns {string} the doc to write */
export function splice(oldSource, newSource) {
  if (oldSource === newSource) return oldSource;
  const oldBlocks = blocksOf(oldSource);
  const newBlocks = blocksOf(newSource);
  if (oldBlocks.length === 0 || newBlocks.length === 0) return newSource;

  const match = align(oldBlocks.map((b) => b.key), newBlocks.map((b) => b.key));
  // A changed list or table, paired with the old one it replaces, is
  // written item by item: `texts[i]` is its text, `match[i]` the old block.
  const texts = [];
  for (const [i, m] of pairChanged(oldBlocks, newBlocks, match)) {
    const text = spliceChildren(oldSource, oldBlocks[m], newSource, newBlocks[i]);
    if (text === null) continue;
    texts[i] = text;
    match[i] = m;
  }
  const out = join(oldSource, oldBlocks, newSource, newBlocks, match, (i, m) => (m === -1
    ? newSource.slice(newBlocks[i].start, newBlocks[i].end)
    : texts[i] ?? oldSource.slice(oldBlocks[m].start, oldBlocks[m].end)));

  // Context can change how a kept block parses (a list absorbing a neighbour,
  // a lazy continuation). If the result does not mean what the editor sent,
  // write the editor's markdown instead.
  const check = blocksOf(out);
  const same = check.length === newBlocks.length && check.every((b, i) => b.key === newBlocks[i].key);
  return same ? out : newSource;
}

// `newParts` (spans of `newSource`) joined: `text(i, m)` is part i, paired by
// `match` with old part m (or -1), and the space between two parts paired
// with neighbours is taken from `oldSource`, the rest from `newSource`.
function join(oldSource, oldParts, newSource, newParts, match, text) {
  const last = newParts.length - 1;
  let out = match[0] === 0
    ? oldSource.slice(oldParts.start, oldParts[0].start)
    : newSource.slice(newParts.start, newParts[0].start);
  for (let i = 0; i <= last; i++) {
    const m = match[i];
    out += text(i, m);
    if (i < last) {
      out += m !== -1 && match[i + 1] === m + 1
        ? oldSource.slice(oldParts[m].end, oldParts[m + 1].start)
        : newSource.slice(newParts[i].end, newParts[i + 1].start);
    }
  }
  out += match[last] === oldParts.length - 1
    ? oldSource.slice(oldParts.at(-1).end, oldParts.end)
    : newSource.slice(newParts[last].end, newParts.end);
  return out;
}

// [new index, old index] for each changed list or table that has an old one
// of the same kind to pair with: between two kept blocks, the first unkept
// old block of its kind, in order.
function pairChanged(oldBlocks, newBlocks, match) {
  const pairs = [];
  let from = 0; // first old block not yet passed
  for (let i = 0; i < newBlocks.length; i++) {
    if (match[i] !== -1) {
      from = match[i] + 1;
      continue;
    }
    if (!newBlocks[i].children) continue;
    const next = match.slice(i).find((m) => m !== -1) ?? oldBlocks.length;
    for (let m = from; m < next; m++) {
      if (oldBlocks[m].kind === newBlocks[i].kind && oldBlocks[m].children) {
        pairs.push([i, m]);
        from = m + 1;
        break;
      }
    }
  }
  return pairs;
}

// A changed list or table written with the old bytes of its unchanged items
// or rows; null when that would not mean what the editor sent.
function spliceChildren(oldSource, oldBlock, newSource, newBlock) {
  const oldParts = Object.assign([...oldBlock.children], { start: oldBlock.start, end: oldBlock.end });
  const newParts = Object.assign([...newBlock.children], { start: newBlock.start, end: newBlock.end });
  const match = align(oldParts.map((c) => c.key), newParts.map((c) => c.key));
  if (match.every((m) => m === -1)) return null;
  const out = join(oldSource, oldParts, newSource, newParts, match, (i, m) => (m === -1
    ? inStyleOf(oldBlock, newSource.slice(newParts[i].start, newParts[i].end))
    : oldSource.slice(oldParts[m].start, oldParts[m].end)));
  const check = blocksOf(out);
  return check.length === 1 && check[0].key === newBlock.key ? out : null;
}

// A new item or row written like the old block's: a list item with its
// marker (`*` for `-`, `1)` for `1.`), or it would start a list of its own;
// a row without padding in a table whose cells are not padded to align.
function inStyleOf(block, part) {
  if (block.compact) return part.replace(/ {2,}\|/g, ' |');
  const { marker } = block;
  if (!marker) return part;
  return part.replace(/^([-*+]|(\d{1,9})[.)])/, (mark, _whole, number) => {
    if (number !== undefined) return /\d/.test(marker) ? number + marker.at(-1) : mark;
    return /\d/.test(marker) ? mark : marker;
  });
}

function blocksOf(source) {
  const tree = fromMarkdown(source, { extensions: [gfm(), cjkFriendlyExtension()], mdastExtensions: [gfmFromMarkdown()] });
  const blocks = tree.children
    .filter((node) => node.position)
    .map((node) => {
      const block = { start: node.position.start.offset, end: node.position.end.offset, key: keyOf(node), kind: kindOf(node) };
      if (block.kind) {
        block.children = node.children.map((child) => ({ start: child.position.start.offset, end: child.position.end.offset, key: keyOf(child) }));
      }
      const text = source.slice(block.start, block.end);
      if (node.type === 'list') block.marker = text.match(/^[-*+]|^\d{1,9}[.)]/)?.[0];
      if (node.type === 'table') block.compact = !/ {2}\|/.test(text);
      return block;
    });
  return Object.assign(blocks, { start: 0, end: source.length });
}

// Lists and tables that may be spliced item by item, when they agree on what
// the items do not say themselves: list kind and looseness, column alignment.
function kindOf(node) {
  if (node.type === 'list') return `list:${node.ordered}:${node.start ?? ''}:${node.spread}`;
  if (node.type === 'table') return `table:${JSON.stringify(node.align)}`;
  return null;
}

// What a block means, ignoring positions and whitespace differences in text.
function keyOf(node) {
  return JSON.stringify(node, (name, value) => {
    if (name === 'position' || value === null || value === undefined) return undefined;
    if (name === 'value' && typeof value === 'string' && node.type !== 'code') return value.replace(/\s+/g, ' ').trim();
    return value;
  });
}

// For each new block, the index of the old block it keeps, or -1. Common
// prefix and suffix first (the usual edit touches few blocks), then a longest
// common subsequence over the rest.
function align(oldKeys, newKeys) {
  const match = new Array(newKeys.length).fill(-1);
  let head = 0;
  while (head < oldKeys.length && head < newKeys.length && oldKeys[head] === newKeys[head]) {
    match[head] = head;
    head++;
  }
  let oldTail = oldKeys.length;
  let newTail = newKeys.length;
  while (oldTail > head && newTail > head && oldKeys[oldTail - 1] === newKeys[newTail - 1]) {
    oldTail--;
    newTail--;
    match[newTail] = oldTail;
  }
  const a = oldKeys.slice(head, oldTail);
  const b = newKeys.slice(head, newTail);
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_DIFF_CELLS) return match;

  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      match[head + j] = head + i;
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return match;
}
