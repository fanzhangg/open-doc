// Edits (SPEC.md §2.5): what changed between two versions of a doc's markdown
// source, compact enough to show on a comment card and precise enough to undo.
// Proposals (§2.6): changes suggested in a reply, applied later by a human.
// Also the line alignment the browser's three-way merge is built on.

import { locate } from './anchor.js';
import { OpError } from './ops.js';

export const EDIT_CONTEXT = 32;
const MAX_DIFF_CELLS = 4_000_000;
const WORD = /[\p{L}\p{N}_]/u;

/**
 * For each line of `a`, the index of the matching line of `b` in a longest
 * common subsequence, or -1. Null when the inputs are too large to diff.
 */
export function lineMatches(a, b) {
  const map = new Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    map[start] = start;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    map[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return map;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      table[x * width + y] = a[start + x] === b[start + y]
        ? table[(x + 1) * width + y + 1] + 1
        : Math.max(table[(x + 1) * width + y], table[x * width + y + 1]);
    }
  }
  let x = 0;
  let y = 0;
  while (x < n && y < m) {
    if (a[start + x] === b[start + y]) {
      map[start + x] = start + y;
      x++;
      y++;
    } else if (table[(x + 1) * width + y] >= table[x * width + y + 1]) {
      x++;
    } else {
      y++;
    }
  }
  return map;
}

/**
 * The changes from `before` to `after`: one per run of changed lines, trimmed
 * to the characters that differ, widened to whole words where they split one.
 *
 * @returns {{ from: number, to: number, edit: { before: string, after: string, prefix: string, suffix: string, start: number } }[]}
 *   `[from, to)` is the replaced range in `before`; `edit` is the record
 *   stored in the sidecar, positioned in `after`.
 */
export function diffEdits(before, after) {
  if (before === after) return [];
  const a = before.split('\n');
  const b = after.split('\n');
  const map = lineMatches(a, b);
  const regions = map ? changedRegions(map, a.length, b.length) : [[0, a.length, 0, b.length]];
  const startsA = lineStarts(a);
  const startsB = lineStarts(b);
  const changes = [];
  for (const [i, j, k, l] of regions) {
    let from = Math.min(startsA[i], before.length);
    let to = Math.min(startsA[j], before.length);
    let bFrom = Math.min(startsB[k], after.length);
    let bTo = Math.min(startsB[l], after.length);
    while (from < to && bFrom < bTo && before[from] === after[bFrom]) {
      from++;
      bFrom++;
    }
    while (to > from && bTo > bFrom && before[to - 1] === after[bTo - 1]) {
      to--;
      bTo--;
    }
    if (from === to && bFrom === bTo) continue;
    // A change that splits a word is widened to the whole word ("colour" →
    // "color", not "u" → ""); one that falls between words is left alone.
    const isWord = (ch) => ch !== undefined && WORD.test(ch);
    const splitsStart = isWord(before[from]) && from < to || isWord(after[bFrom]) && bFrom < bTo;
    const splitsEnd = isWord(before[to - 1]) && from < to || isWord(after[bTo - 1]) && bFrom < bTo;
    while (splitsStart && from > 0 && bFrom > 0 && before[from - 1] === after[bFrom - 1] && isWord(before[from - 1])) {
      from--;
      bFrom--;
    }
    while (splitsEnd && to < before.length && bTo < after.length && before[to] === after[bTo] && isWord(before[to])) {
      to++;
      bTo++;
    }
    changes.push({
      from,
      to,
      edit: {
        before: before.slice(from, to),
        after: after.slice(bFrom, bTo),
        prefix: after.slice(Math.max(0, bFrom - EDIT_CONTEXT), bFrom),
        suffix: after.slice(bTo, bTo + EDIT_CONTEXT),
        start: bFrom,
      },
    });
  }
  return changes;
}

/** Where an edit's `after` text sits in `markdown` now, or null when it has changed or gone. */
export function findEdit(markdown, edit) {
  if (edit.after) {
    const found = locate(markdown, { exact: edit.after, prefix: edit.prefix, suffix: edit.suffix, start: edit.start });
    if (found?.method !== 'exact') return null;
    // Still in place: at least one side of its context is untouched.
    const prefixKept = markdown.slice(Math.max(0, found.start - edit.prefix.length), found.start) === edit.prefix;
    const suffixKept = markdown.slice(found.end, found.end + edit.suffix.length) === edit.suffix;
    return prefixKept || suffixKept ? { start: found.start, end: found.end } : null;
  }
  // A deletion left nothing behind: find the spot between its context.
  const gap = edit.prefix + edit.suffix;
  if (gap === '') return markdown === '' ? { start: 0, end: 0 } : null;
  let best = null;
  for (let i = markdown.indexOf(gap); i !== -1; i = markdown.indexOf(gap, i + 1)) {
    const at = i + edit.prefix.length;
    if (best === null || Math.abs(at - edit.start) < Math.abs(best - edit.start)) best = at;
  }
  return best === null ? null : { start: best, end: best };
}

/** `markdown` with `edits` reversed, or null when any of them can no longer be found. */
export function revertEdits(markdown, edits) {
  return replaceAll(markdown, edits.map((edit) => ({ range: findEdit(markdown, edit), text: edit.before })));
}

/**
 * A proposal (SPEC.md §2.6) from `{ before, after }` pairs of markdown source:
 * each `before` must occur exactly once in `markdown`, and no two may overlap.
 * Each change gets the context around its `before`, so it can be found again
 * after the doc changes elsewhere. Throws OpError('bad_input') otherwise.
 */
export function proposeChanges(markdown, changes) {
  if (!Array.isArray(changes) || changes.length === 0) throw new OpError('bad_input', 'a proposal needs at least one change');
  const crlf = markdown.includes('\r\n');
  const eol = (text) => (crlf ? text.replace(/\r?\n/g, '\r\n') : text);
  const out = changes.map((change, i) => {
    const n = changes.length > 1 ? ` ${i + 1}` : '';
    if (!change || typeof change.before !== 'string' || typeof change.after !== 'string') {
      throw new OpError('bad_input', `change${n} needs "before" and "after" strings`);
    }
    const before = eol(change.before);
    const after = eol(change.after);
    if (before === '') throw new OpError('bad_input', `change${n}: "before" is empty; quote the text next to the insertion and repeat it in "after"`);
    if (before === after) throw new OpError('bad_input', `change${n}: "before" and "after" are the same`);
    const start = markdown.indexOf(before);
    if (start === -1) throw new OpError('bad_input', `change${n}: "before" does not appear in the doc; copy it exactly from the markdown source`);
    if (markdown.indexOf(before, start + 1) !== -1) throw new OpError('bad_input', `change${n}: "before" appears more than once in the doc; quote more of the surrounding text`);
    const end = start + before.length;
    return {
      before,
      after,
      prefix: markdown.slice(Math.max(0, start - EDIT_CONTEXT), start),
      suffix: markdown.slice(end, end + EDIT_CONTEXT),
      start,
    };
  });
  const sorted = [...out].sort((x, y) => x.start - y.start);
  for (let n = 1; n < sorted.length; n++) {
    if (sorted[n].start < sorted[n - 1].start + sorted[n - 1].before.length) throw new OpError('bad_input', 'two changes overlap; merge them into one');
  }
  return out;
}

/**
 * Where a proposed change's `before` sits in `markdown` now, or null when that
 * text has changed or gone: the undo rule of §2.5, run the other way.
 */
export function findProposal(markdown, change) {
  return findEdit(markdown, { after: change.before, prefix: change.prefix, suffix: change.suffix, start: change.start });
}

/** `markdown` with a proposal applied, or null when any change can no longer be found. */
export function applyProposal(markdown, changes) {
  return replaceAll(markdown, changes.map((change) => ({ range: findProposal(markdown, change), text: change.after })));
}

// Replace each found range with its text; null when one is missing or two overlap.
function replaceAll(markdown, items) {
  if (items.some((item) => !item.range)) return null;
  const ranges = items.map(({ range, text }) => ({ ...range, text })).sort((x, y) => y.start - x.start);
  for (let n = 1; n < ranges.length; n++) {
    if (ranges[n].end > ranges[n - 1].start) return null;
  }
  let out = markdown;
  for (const r of ranges) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  return out;
}

// Runs of lines that differ: [aStart, aEnd, bStart, bEnd].
function changedRegions(map, n, m) {
  const regions = [];
  let i = 0;
  let k = 0;
  for (;;) {
    while (i < n && map[i] === k) {
      i++;
      k++;
    }
    if (i >= n && k >= m) break;
    let j = i;
    while (j < n && map[j] === -1) j++;
    const l = j < n ? map[j] : m;
    regions.push([i, j, k, l]);
    i = j;
    k = l;
  }
  return regions;
}

// Offset of each line, plus one past the end (as if the text ended in a newline).
function lineStarts(lines) {
  const starts = [0];
  for (const line of lines) starts.push(starts.at(-1) + line.length + 1);
  return starts;
}
