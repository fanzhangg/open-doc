// @mentions written in the doc's own text, not in a comment (SPEC.md §4.1).

import { MENTION_TOKEN, parseMentions } from './mentions.js';
import { lineMatches } from './diff.js';
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

/**
 * The mentions of `names` that the change from markdown `before` to `after`
 * added: those in `after` that are not a mention of `before` carried over
 * untouched. Typing, pasting, finishing (`@hel` → `@helper`) or uncovering
 * one adds it; text changing before or after an old one does not.
 *
 * @returns {{ name: string, start: number, end: number, quote: string }[]} as textMentions
 */
export function addedMentions(before, after, names) {
  const now = textMentions(after, names);
  if (now.length === 0) return [];
  const changes = changedRanges(project(before).text, project(after).text);
  const kept = textMentions(before, names).flatMap((m) => {
    const at = carry(changes, m.start, tokenEnd(m));
    return at === null ? [] : [`${m.name.toLowerCase()}@${at}`];
  });
  return now.filter((m) => !kept.includes(`${m.name.toLowerCase()}@${m.start}`));
}

/** Where a mention's `@name` ends: `@` plus the name. */
export const tokenEnd = (mention) => mention.start + 1 + mention.name.length;

/**
 * What changed from text `before` to `after`, as ranges in order: `[a0, a1)`
 * of `before` became `[b0, b1)` of `after`; the text between them is the
 * same in both. Lines are aligned first, then the characters of each line
 * changed in place, so changes in different places stay apart.
 * @returns {{ a0: number, a1: number, b0: number, b1: number }[]}
 */
export function changedRanges(before, after) {
  if (before === after) return [];
  const a = before.split('\n');
  const b = after.split('\n');
  const runs = unmatched(a, b);
  if (!runs) return [hunk(before, after, 0, 0)];
  const startsA = lineStarts(a);
  const startsB = lineStarts(b);
  // With a newline after the last line too, every line ends with one.
  const paddedA = `${before}\n`;
  const paddedB = `${after}\n`;
  const ranges = [];
  for (const [i, i2, j, j2] of runs) {
    if (i2 - i === j2 - j) {
      for (let k = 0; k < i2 - i; k++) ranges.push(...inLine(a[i + k], b[j + k], startsA[i + k], startsB[j + k]));
    } else {
      ranges.push(hunk(paddedA.slice(startsA[i], startsA[i2]), paddedB.slice(startsB[j], startsB[j2]), startsA[i], startsB[j]));
    }
  }
  return ranges.filter((r) => r.a0 !== r.a1 || r.b0 !== r.b1);
}

// The runs of `a` and `b` left out of their longest common subsequence, in
// order: `a[i, i2)` became `b[j, j2)`. Null when they are too long to align.
function unmatched(a, b) {
  const map = lineMatches(a, b);
  if (!map) return null;
  const runs = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && map[i] === j) {
      i++;
      j++;
      continue;
    }
    let i2 = i;
    while (i2 < a.length && map[i2] === -1) i2++;
    const j2 = i2 < a.length ? map[i2] : b.length;
    runs.push([i, i2, j, j2]);
    i = i2;
    j = j2;
  }
  return runs;
}

// A line changed in place, starting at `atA` / `atB`: what changed in it,
// character by character.
function inLine(lineA, lineB, atA, atB) {
  const runs = unmatched(lineA.split(''), lineB.split(''));
  if (!runs) return [hunk(lineA, lineB, atA, atB)];
  return runs.map(([i, i2, j, j2]) => ({ a0: atA + i, a1: atA + i2, b0: atB + j, b1: atB + j2 }));
}

/**
 * Where text `[start, end)` of `before` is in `after`, given their
 * changedRanges: moved along by the changes before it, null when a change
 * touches it.
 */
export function carry(changes, start, end) {
  let shift = 0;
  for (const { a0, a1, b1 } of changes) {
    if (end <= a0) break;
    if (start < a1) return null;
    shift = b1 - a1;
  }
  return start + shift;
}

// `before` became `after`, both starting at `atA` / `atB` of the whole texts:
// what is left once their common start and end are set aside.
function hunk(before, after, atA, atB) {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < max - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { a0: atA + start, a1: atA + before.length - tail, b0: atB + start, b1: atB + after.length - tail };
}

// Where each line starts, and one past the last (as if it ended with a newline).
function lineStarts(lines) {
  const starts = [0];
  for (const line of lines) starts.push(starts.at(-1) + line.length + 1);
  return starts;
}

/** The block (paragraph, heading, cell) of rendered `text` holding offset `at`: `[start, end)`. */
export function blockAt(text, at) {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const lineEnd = text.indexOf('\n', at);
  return { start, end: lineEnd === -1 ? text.length : lineEnd };
}
