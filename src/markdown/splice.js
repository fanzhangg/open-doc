// Byte-preserving saves: the editor sends its serialized markdown, which may
// format untouched blocks differently from the file (`__x__` vs `**x**`, hard
// wraps, list markers). Keep the original bytes of every top-level block whose
// meaning did not change, so `git diff` shows only real edits. The editor
// writes links inline and keeps no link definitions: a reference link means
// the link its definition makes, and every definition is kept as written.

import { lineMatches } from '../core/diff.js';
import { parseMarkdown } from './project.js';

/** @returns {string} the doc to write */
export function splice(oldSource, newSource) {
  if (oldSource === newSource) return oldSource;
  const { blocks: oldBlocks, definitions } = blocksOf(oldSource);
  const { blocks: newBlocks } = blocksOf(newSource);
  if (oldBlocks.length === 0 || newBlocks.length === 0) return newSource;

  const match = align(oldBlocks.map((b) => b.key), newBlocks.map((b) => b.key));
  const last = newBlocks.length - 1;
  // The text between old blocks m and m + 1, taken once; definitions are in it.
  const used = new Set();
  const gap = (m) => oldSource.slice(oldBlocks[m].end, oldBlocks[m + 1].start);
  const between = (m) => used.add(m) && gap(m);
  const defines = (m) => m >= 0 && m + 1 < oldBlocks.length && !used.has(m) && /\S/.test(gap(m));
  let out = match[0] === 0
    ? oldSource.slice(0, oldBlocks[0].start)
    : newSource.slice(0, newBlocks[0].start);
  for (let i = 0; i <= last; i++) {
    const m = match[i];
    out += m === -1 ? newSource.slice(newBlocks[i].start, newBlocks[i].end) : oldSource.slice(oldBlocks[m].start, oldBlocks[m].end);
    if (i < last) {
      const next = match[i + 1];
      if (m !== -1 && next === m + 1) out += between(m);
      else if (defines(m)) out += between(m);
      else if (defines(next - 1)) out += between(next - 1);
      else out += newSource.slice(newBlocks[i].end, newBlocks[i + 1].start);
    }
  }
  out += match[last] === oldBlocks.length - 1
    ? oldSource.slice(oldBlocks.at(-1).end)
    : newSource.slice(newBlocks[last].end);
  // A definition whose place went to the editor's text stays, at the end.
  const kept = new Set(blocksOf(out).definitions.map((d) => d.id));
  const lost = definitions.filter((d) => !kept.has(d.id)).map((d) => oldSource.slice(d.start, d.end));
  if (lost.length > 0) out = `${out.replace(/\n*$/, '')}\n\n${lost.join('\n')}\n`;

  // Context can change how a kept block parses (a list absorbing a neighbour,
  // a lazy continuation). If the result does not mean what the editor sent,
  // write the editor's markdown instead.
  const { blocks: check } = blocksOf(out);
  const same = check.length === newBlocks.length && check.every((b, i) => b.key === newBlocks[i].key);
  return same ? out : newSource;
}

// The blocks of `source` but its top-level link definitions, and those
// definitions: { blocks: [{ start, end, key }], definitions: [{ start, end, id }] }.
function blocksOf(source) {
  const tree = parseMarkdown(source);
  const defined = new Map();
  const visit = (node) => {
    if (node.type === 'definition' && !defined.has(node.identifier)) defined.set(node.identifier, node);
    node.children?.forEach(visit);
  };
  visit(tree);
  const range = (node) => ({ start: node.position.start.offset, end: node.position.end.offset });
  const top = tree.children.filter((node) => node.position);
  return {
    blocks: top.filter((node) => node.type !== 'definition').map((node) => ({ ...range(node), key: keyOf(node, defined) })),
    definitions: top.filter((node) => node.type === 'definition').map((node) => ({ ...range(node), id: node.identifier })),
  };
}

// What a block means, ignoring positions and whitespace differences in text
// (but in code and front matter); a reference link or image is the one its
// definition makes.
function keyOf(node, defined) {
  return JSON.stringify(node, (name, value) => {
    if (name === 'position' || value === null || value === undefined) return undefined;
    if (name === 'value' && typeof value === 'string' && node.type !== 'code' && node.type !== 'yaml') return value.replace(/\s+/g, ' ').trim();
    const definition = (value?.type === 'linkReference' || value?.type === 'imageReference') && defined.get(value.identifier);
    if (definition) {
      const { url, title } = definition;
      return value.type === 'linkReference' ? { type: 'link', title, url, children: value.children } : { type: 'image', title, url, alt: value.alt };
    }
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
