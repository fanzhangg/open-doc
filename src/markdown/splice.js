// Byte-preserving saves: the editor sends its serialized markdown, which may
// format untouched blocks differently from the file (`__x__` vs `**x**`, hard
// wraps, list markers). Keep the original bytes of every top-level block whose
// meaning did not change, so `git diff` shows only real edits.

import { lineMatches } from '../core/diff.js';
import { parseMarkdown } from './project.js';

/** @returns {string} the doc to write */
export function splice(oldSource, newSource) {
  if (oldSource === newSource) return oldSource;
  const oldBlocks = blocksOf(oldSource);
  const newBlocks = blocksOf(newSource);
  if (oldBlocks.length === 0 || newBlocks.length === 0) return newSource;

  const match = align(oldBlocks.map((b) => b.key), newBlocks.map((b) => b.key));
  const last = newBlocks.length - 1;
  let out = match[0] === 0
    ? oldSource.slice(0, oldBlocks[0].start)
    : newSource.slice(0, newBlocks[0].start);
  for (let i = 0; i <= last; i++) {
    const m = match[i];
    out += m === -1 ? newSource.slice(newBlocks[i].start, newBlocks[i].end) : oldSource.slice(oldBlocks[m].start, oldBlocks[m].end);
    if (i < last) {
      out += m !== -1 && match[i + 1] === m + 1
        ? oldSource.slice(oldBlocks[m].end, oldBlocks[m + 1].start)
        : newSource.slice(newBlocks[i].end, newBlocks[i + 1].start);
    }
  }
  out += match[last] === oldBlocks.length - 1
    ? oldSource.slice(oldBlocks.at(-1).end)
    : newSource.slice(newBlocks[last].end);

  // Context can change how a kept block parses (a list absorbing a neighbour,
  // a lazy continuation). If the result does not mean what the editor sent,
  // write the editor's markdown instead.
  const check = blocksOf(out);
  const same = check.length === newBlocks.length && check.every((b, i) => b.key === newBlocks[i].key);
  return same ? out : newSource;
}

function blocksOf(source) {
  return parseMarkdown(source).children
    .filter((node) => node.position)
    .map((node) => ({ start: node.position.start.offset, end: node.position.end.offset, key: keyOf(node) }));
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
// common subsequence over the rest (lineMatches).
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
  const matches = lineMatches(oldKeys.slice(head, oldTail), newKeys.slice(head, newTail)) ?? [];
  matches.forEach((j, i) => {
    if (j !== -1) match[head + j] = head + i;
  });
  return match;
}
