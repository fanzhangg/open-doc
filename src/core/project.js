// Rendered-text projection (SPEC.md §3.1): the text a reader sees, with
// markdown syntax removed, plus a map from each text offset back to the
// markdown source. Anchors are measured against this text.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'tableCell', 'code', 'html']);
const CONTAINERS = new Set([
  'root', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'footnoteDefinition',
]);
const INLINE_PARENTS = new Set(['emphasis', 'strong', 'delete', 'link', 'linkReference']);
const WHITESPACE = /\s/;

/**
 * @param {string} markdown
 * @returns {{ text: string, offsets: Int32Array, source: string }}
 *   `offsets[i]` is the source offset of `text[i]`; `offsets[text.length]`
 *   is the source length.
 */
export function project(markdown) {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  const lines = [];
  collectBlocks(tree, markdown, lines);

  let text = '';
  const offsets = [];
  for (const line of lines) {
    if (text.length > 0) {
      // The separator maps to the start of the next block.
      text += '\n';
      offsets.push(line.offsets[0]);
    }
    text += line.text;
    for (const offset of line.offsets) offsets.push(offset);
  }
  offsets.push(markdown.length);

  return { text, offsets: Int32Array.from(offsets), source: markdown };
}

/** Source range `[start, end)` covering rendered range `[start, end)`. */
export function sourceRange(projection, start, end) {
  const { offsets } = projection;
  if (end <= start) return { start: offsets[start], end: offsets[start] };
  return { start: offsets[start], end: offsets[end - 1] + 1 };
}

/** 1-based line number of a source offset. */
export function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function collectBlocks(node, source, lines) {
  if (TEXT_BLOCKS.has(node.type)) {
    const chars = [];
    if (node.type === 'code' || node.type === 'html') {
      alignValue(node.value, node, source, chars);
    } else {
      for (const child of node.children) collectInline(child, source, chars);
    }
    const line = node.type === 'code' ? toLine(chars) : collapse(chars);
    if (line.text.length > 0) lines.push(line);
    return;
  }
  if (CONTAINERS.has(node.type)) {
    for (const child of node.children) collectBlocks(child, source, lines);
  }
  // thematicBreak, definition, footnote definitions' labels, etc.: no text.
}

function collectInline(node, source, chars) {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'html':
      alignValue(node.value, node, source, chars);
      return;
    case 'break':
      chars.push([' ', node.position.start.offset]);
      return;
    default:
      if (INLINE_PARENTS.has(node.type)) {
        for (const child of node.children) collectInline(child, source, chars);
      }
      // image, imageReference, footnoteReference: no text.
  }
}

// Map each character of a node's decoded value to a source offset by walking
// value and source together; source characters with no counterpart in the
// value (escapes, fences, indentation) are skipped.
function alignValue(value, node, source, chars) {
  const from = node.position.start.offset;
  const to = node.position.end.offset;
  let j = from;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    let k = j;
    while (k < to && source[k] !== ch) k++;
    if (k < to) {
      chars.push([ch, k]);
      j = k + 1;
    } else {
      chars.push([ch, Math.min(j, to - 1)]);
    }
  }
}

// Collapse whitespace runs to one space and trim (SPEC.md §3.1 rule 4).
function collapse(chars) {
  let text = '';
  const offsets = [];
  let pendingSpace = null;
  for (const [ch, offset] of chars) {
    if (WHITESPACE.test(ch)) {
      if (pendingSpace === null) pendingSpace = offset;
      continue;
    }
    if (pendingSpace !== null && text.length > 0) {
      text += ' ';
      offsets.push(pendingSpace);
    }
    pendingSpace = null;
    text += ch;
    offsets.push(offset);
  }
  return { text, offsets };
}

function toLine(chars) {
  return { text: chars.map(([ch]) => ch).join(''), offsets: chars.map(([, offset]) => offset) };
}
