// Rendered text: what a reader of a markdown doc sees, with its syntax
// removed, plus a map from each character back to the source. The WYSIWYG
// editor reaches its document through it (web/views/markdown/view.js builds the same text
// from its own document), and the Markdown rule compares it (src/rules/markdown.js).
//
// Built from the CommonMark + GFM tree, with emphasis read the CJK-friendly
// way (`**熟悉：**直接` is bold): each text block (paragraph, heading, table
// cell, code block, raw HTML block) is a line, lines joined by `\n`, empty
// ones skipped; inside one, text, inline code and inline HTML count as
// written, and the children of emphasis, strong, strikethrough and links;
// images, footnote references and definitions count for nothing; a hard
// break is a space; outside code blocks whitespace runs become one space and
// the line is trimmed.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { createAnchor, locate } from '../core/anchor.js';
import { gfm } from 'micromark-extension-gfm';
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly';
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
  const lines = [];
  collectBlocks(parseMarkdown(markdown), markdown, lines);
  return joined(lines.map((line) => [line, 0]), markdown);
}

/**
 * project(markdown) worked out block by block, for a long doc that changes a
 * few blocks at a time: `blocks` are its top-level blocks (blockRanges), and
 * `cache` (a Map) keeps the lines of each block's text from one call to the
 * next. Only for a doc whose blocks read alone as they do in it (not
 * definesLinks).
 */
export function projectBlocks(markdown, blocks, cache) {
  const lines = [];
  const used = new Map();
  for (const { start, end } of blocks) {
    const text = markdown.slice(start, end);
    let own = used.get(text) ?? cache.get(text);
    if (!own) collectBlocks(parseMarkdown(text), text, (own = []));
    used.set(text, own);
    for (const line of own) lines.push([line, start]);
  }
  cache.clear();
  for (const [text, own] of used) cache.set(text, own);
  return joined(lines, markdown);
}

/**
 * Whether `markdown` may define a link or footnote, at any depth (in a quote
 * or a list too): a definition ties the blocks that use it to the one it is
 * in, so such a doc is read whole, not block by block. A line that only
 * looks like one counts too; it is read whole, as it would be.
 */
export const definesLinks = (markdown) => /^[ \t>*+\-\d.)]*\[[^\]\n]+\]:/m.test(markdown);

/** The range { start, end } of each top-level block of `markdown`. */
export function blockRanges(markdown) {
  return parseMarkdown(markdown).children
    .filter((node) => node.position)
    .map((node) => ({ start: node.position.start.offset, end: node.position.end.offset }));
}

// Lines [line, shift] joined by `\n`, each offset moved by its line's shift.
function joined(lines, markdown) {
  const text = lines.map(([line]) => line.text).join('\n');
  const offsets = new Int32Array(text.length + 1);
  let i = 0;
  lines.forEach(([line, shift], k) => {
    // The separator maps to the start of the next block.
    if (k > 0) offsets[i++] = line.offsets[0] + shift;
    for (const offset of line.offsets) offsets[i++] = offset + shift;
  });
  offsets[i] = markdown.length;
  return { text, offsets, source: markdown };
}

/** The markdown syntax tree (mdast) that the projection is built from. */
export function parseMarkdown(markdown) {
  return fromMarkdown(markdown, {
    extensions: [gfm(), cjkFriendlyExtension()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/** Source range `[start, end)` covering rendered range `[start, end)`. */
export function sourceRange(projection, start, end) {
  const { offsets } = projection;
  if (end <= start) return { start: offsets[start], end: offsets[start] };
  return { start: offsets[start], end: offsets[end - 1] + 1 };
}

/**
 * Anchor on `source` as one on its rendered text, or null when it is not
 * found or covers only markup.
 */
export function renderedAnchor(source, anchor, projection = project(source)) {
  const found = locate(source, anchor);
  if (!found) return null;
  const range = renderedRange(projection, found.start, found.end);
  return range.start < range.end ? createAnchor(projection.text, range.start, range.end) : null;
}

/** Anchor on the rendered text of `source` as one on `source`, or null when it is not found. */
export function sourceAnchor(source, anchor, projection = project(source)) {
  const found = locate(projection.text, anchor);
  if (!found) return null;
  const range = sourceRange(projection, found.start, found.end);
  return createAnchor(source, range.start, range.end);
}

/**
 * Rendered range drawn from source range `[start, end)`: the characters
 * whose source offset falls inside it; for a range with none, the empty
 * range at the first character after it.
 */
export function renderedRange({ text, offsets }, start, end) {
  let from = -1;
  let to = -1;
  for (let i = 0; i < text.length; i++) {
    if (offsets[i] < start) continue;
    if (from === -1) from = i;
    if (offsets[i] >= end) break;
    to = i + 1;
  }
  if (from === -1) return { start: text.length, end: text.length };
  // A line break has the offset of the next line's first character: a range
  // starting there starts with that character.
  if (text[from] === '\n' && offsets[from + 1] === offsets[from]) from++;
  return { start: from, end: Math.max(from, to) };
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

// Collapse whitespace runs to one space and trim.
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
