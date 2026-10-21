// Edits: what changed between two versions of a doc's text,
// compact enough to show (web/history.js) and to count. Also the line
// alignment the three-way merge is built on.

import { locate } from './anchor.js';

const EDIT_CONTEXT = 32;
const CHUNK = 1024;

// The common start and end of two texts. A long doc changes in a few places,
// so these are compared a chunk at a time (a string compare is a memory
// compare), and only the chunk that differs a character at a time.

/** How many characters `a` and `b` start with in common, at most `max`. */
export function sameStart(a, b, max = Math.min(a.length, b.length)) {
  let n = 0;
  while (n + CHUNK <= max && a.slice(n, n + CHUNK) === b.slice(n, n + CHUNK)) n += CHUNK;
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n++;
  return n;
}

/** How many characters `a` and `b` end with in common, at most `max`. */
export function sameEnd(a, b, max = Math.min(a.length, b.length)) {
  let n = 0;
  while (n + CHUNK <= max && a.slice(a.length - n - CHUNK, a.length - n) === b.slice(b.length - n - CHUNK, b.length - n)) n += CHUNK;
  while (n < max && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n++;
  return n;
}
// The edit distance past which Myers' diff gives up on a stretch of two
// texts: its work grows with the square.
const MAX_EDITS = 2_000;
const WORD = /[\p{L}\p{N}_]/u;

/**
 * For each item of `a` (lines, or characters), the index of the matching item
 * of `b`, or -1: a longest common subsequence by Myers' O((N+M)·D) diff, in
 * linear space. Past what differs at the start and the end, a stretch longer
 * than MAX_EDITS items first matches the items found once in each, as
 * patience diff does, and diffs each stretch between them alone; one still
 * too changed to diff is taken as rewritten. Null when nothing past the
 * start and the end matches and it could not be diffed.
 */
export function lineMatches(a, b) {
  const map = new Array(a.length).fill(-1);
  let x0 = 0;
  let y0 = 0;
  let x1 = a.length;
  let y1 = b.length;
  while (x0 < x1 && y0 < y1 && a[x0] === b[y0]) map[x0++] = y0++;
  while (x1 > x0 && y1 > y0 && a[x1 - 1] === b[y1 - 1]) map[--x1] = --y1;
  const size = 2 * Math.ceil((x1 - x0 + y1 - y0) / 2) + 3;
  const forward = new Int32Array(size);
  const backward = new Int32Array(size);
  const anchors = x1 - x0 + y1 - y0 > MAX_EDITS ? uniqueMatches(a, x0, x1, b, y0, y1) : [];
  if (anchors.length === 0) return myers(a, x0, x1, b, y0, y1, map, forward, backward) ? map : null;
  for (const [i, j] of [...anchors, [x1, y1]]) {
    if (!myers(a, x0, i, b, y0, j, map, forward, backward)) map.fill(-1, x0, i);
    if (i < x1) map[i] = j;
    x0 = i + 1;
    y0 = j + 1;
  }
  return map;
}

// Match a[x0, x1) to b[y0, y1) into `map`, or false past MAX_EDITS.
function myers(a, x0, x1, b, y0, y1, map, forward, backward) {
  let edits = 0;
  const compare = (x0, x1, y0, y1) => {
    while (x0 < x1 && y0 < y1 && a[x0] === b[y0]) map[x0++] = y0++;
    while (x1 > x0 && y1 > y0 && a[x1 - 1] === b[y1 - 1]) map[--x1] = --y1;
    if (x0 === x1 || y0 === y1) {
      edits += x1 - x0 + y1 - y0;
      return edits <= MAX_EDITS;
    }
    const snake = middleSnake(a, x0, x1 - x0, b, y0, y1 - y0, forward, backward);
    if (!snake) return false;
    const [sx, sy, ex] = snake;
    for (let k = 0; k < ex - sx; k++) map[sx + k] = sy + k;
    return compare(x0, sx, y0, sy) && compare(ex, x1, sy + ex - sx, y1);
  };
  return compare(x0, x1, y0, y1);
}

// The pairs [i, j] where a[i] and b[j] are each found once in a[x0, x1) and
// b[y0, y1), the longest run of them in order in both.
function uniqueMatches(a, x0, x1, b, y0, y1) {
  const once = (items, from, to) => {
    const at = new Map(); // item → its index, or -1 when found again
    for (let k = from; k < to; k++) at.set(items[k], at.has(items[k]) ? -1 : k);
    return at;
  };
  const inA = once(a, x0, x1);
  const inB = once(b, y0, y1);
  const pairs = [];
  for (const [item, i] of inA) {
    const j = inB.get(item);
    if (i !== -1 && j !== undefined && j !== -1) pairs.push([i, j]);
  }
  // The longest increasing run of j, by patience sorting.
  const tops = [];
  const back = new Array(pairs.length);
  for (let p = 0; p < pairs.length; p++) {
    let lo = 0;
    let hi = tops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tops[mid]][1] < pairs[p][1]) lo = mid + 1;
      else hi = mid;
    }
    back[p] = lo > 0 ? tops[lo - 1] : -1;
    tops[lo] = p;
  }
  const run = [];
  for (let p = tops.at(-1) ?? -1; p !== -1; p = back[p]) run.push(pairs[p]);
  return run.reverse();
}

// The middle snake of a[x0, x0+n) and b[y0, y0+m), which differ at both ends:
// [x, y, end x] of the diagonal run halfway along a shortest edit, or null
// past MAX_EDITS. Forward from the start and backward from the end, each
// on diagonals k = x - y (backward: of the reversed texts).
function middleSnake(a, x0, n, b, y0, m, forward, backward) {
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const max = Math.min(Math.ceil((n + m) / 2), MAX_EDITS);
  const off = Math.ceil((n + m) / 2) + 1;
  forward[off + 1] = 0;
  backward[off + 1] = 0;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && forward[off + k - 1] < forward[off + k + 1]) ? forward[off + k + 1] : forward[off + k - 1] + 1;
      let y = x - k;
      const sx = x;
      const sy = y;
      while (x < n && y < m && a[x0 + x] === b[y0 + y]) {
        x++;
        y++;
      }
      forward[off + k] = x;
      if (odd && delta - k >= -(d - 1) && delta - k <= d - 1 && x + backward[off + delta - k] >= n) return [x0 + sx, y0 + sy, x0 + x];
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && backward[off + k - 1] < backward[off + k + 1]) ? backward[off + k + 1] : backward[off + k - 1] + 1;
      let y = x - k;
      const sx = x;
      while (x < n && y < m && a[x0 + n - x - 1] === b[y0 + m - y - 1]) {
        x++;
        y++;
      }
      backward[off + k] = x;
      if (!odd && delta - k >= -d && delta - k <= d && x + forward[off + delta - k] >= n) return [x0 + n - x, y0 + m - y, x0 + n - sx];
    }
  }
  return null;
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

/** Where an edit's `after` text sits in `doc` now, or null when it has changed or gone. */
export function findEdit(doc, edit) {
  if (edit.after) {
    const found = locate(doc, { exact: edit.after, prefix: edit.prefix, suffix: edit.suffix, start: edit.start });
    if (found?.method !== 'exact') return null;
    // Still in place: at least one side of its context is untouched.
    const prefixKept = doc.slice(Math.max(0, found.start - edit.prefix.length), found.start) === edit.prefix;
    const suffixKept = doc.slice(found.end, found.end + edit.suffix.length) === edit.suffix;
    return prefixKept || suffixKept ? { start: found.start, end: found.end } : null;
  }
  // A deletion left nothing behind: find the spot between its context.
  const gap = edit.prefix + edit.suffix;
  if (gap === '') return doc === '' ? { start: 0, end: 0 } : null;
  let best = null;
  for (let i = doc.indexOf(gap); i !== -1; i = doc.indexOf(gap, i + 1)) {
    const at = i + edit.prefix.length;
    if (best === null || Math.abs(at - edit.start) < Math.abs(best - edit.start)) best = at;
  }
  return best === null ? null : { start: best, end: best };
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
