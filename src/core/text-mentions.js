// @mentions written in the doc's own text, not in a comment (SPEC.md §4.1).

import { MENTION_TOKEN, parseMentions } from './mentions.js';
import { parseMarkdown, project } from './project.js';

const NOT_TEXT = new Set(['code', 'inlineCode', 'html']);

/**
 * The @mentions of `names` in the rendered text of `markdown`, outside code
 * and raw HTML, in order. Each runs from the `@` to the end of its block
 * (paragraph, heading, cell): that is the ask, as the quote of a comment.
 *
 * @param {string} markdown
 * @param {string[]} names participant names that count
 * @returns {{ name: string, start: number, end: number, quote: string }[]}
 *   `start` and `end` are rendered-text offsets.
 */
export function textMentions(markdown, names) {
  if (names.length === 0 || !markdown.includes('@')) return [];
  const { text, offsets } = project(markdown);
  const skip = [];
  (function walk(node) {
    if (NOT_TEXT.has(node.type)) skip.push([node.position.start.offset, node.position.end.offset]);
    else for (const child of node.children ?? []) walk(child);
  })(parseMarkdown(markdown));
  const participants = names.map((name) => ({ name }));
  const found = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const start = match.index + match[1].length;
    const source = offsets[start];
    if (skip.some(([from, to]) => source >= from && source < to)) continue;
    const [name] = parseMentions(match[0], participants);
    if (!name) continue;
    const lineEnd = text.indexOf('\n', start);
    const end = start + text.slice(start, lineEnd === -1 ? text.length : lineEnd).trimEnd().length;
    found.push({ name, start, end, quote: text.slice(start, end) });
  }
  return found;
}
