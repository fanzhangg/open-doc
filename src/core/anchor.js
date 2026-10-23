// Anchors (SPEC.md §3): create them from a selection, and find them in
// the doc's text as it is now. The format leaves finding to each reader;
// this is Ponjo's way, not the format's. In order:
//
// 1. Exact: every occurrence of `exact`; among the acceptable ones
//    (`acceptable`), the best score (`evaluate`).
// 2. Context bracket: what now sits between the full prefix and suffix
//    (`bracket`).
// 3. Fuzzy: approximate matches of `exact` with up to half its length in
//    edits (insertions, deletions, substitutions), first in a window
//    around `start`, then in the whole text; among the acceptable ones,
//    the best score. A quote shorter than 4 characters is never
//    fuzzy-matched.
// 4. Otherwise it is not found, and its comment shows as detached.
//
// The same doc and anchor always give the same result.

import search from 'approx-string-match';

export const CONTEXT_LENGTH = 32;
const MIN_FUZZY_LENGTH = 4;
const SHORT_QUOTE_LENGTH = 8;
const MIN_BRACKET_CONTEXT = 8;
const TAIL_LENGTH = 16;
const WINDOW_SLACK = 2048;
const WEIGHTS = { quote: 50, prefix: 20, suffix: 20, position: 2 };

/** Anchor for the range `[start, end)` of a doc's text (SPEC.md §3.1). */
export function createAnchor(text, start, end) {
  if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= text.length)) {
    throw new RangeError(`invalid range [${start}, ${end}) for text of length ${text.length}`);
  }
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH),
    start,
  };
}

/**
 * Find an anchor in a doc's text as it is now (steps 1–4 above).
 * @returns {{ start: number, end: number, method: 'exact' | 'bracket' | 'fuzzy', score: number } | null}
 */
export function locate(text, anchor) {
  const { exact } = anchor;

  const exactAccepted = occurrences(text, exact)
    .map((start) => evaluate(text, anchor, start, start + exact.length, 0))
    .filter((c) => acceptable(c, anchor));
  if (exactAccepted.length > 0) return pick(exactAccepted, 'exact');

  const bracketed = bracket(text, anchor);
  if (bracketed) return bracketed;

  if (exact.length < MIN_FUZZY_LENGTH) return null;

  const maxErrors = Math.floor(exact.length / 2);
  const windowStart = Math.max(0, anchor.start - exact.length - WINDOW_SLACK);
  const windowEnd = Math.min(text.length, anchor.start + 2 * exact.length + WINDOW_SLACK);
  const ranges = [[windowStart, windowEnd]];
  if (windowStart > 0 || windowEnd < text.length) ranges.push([0, text.length]);

  for (const [from, to] of ranges) {
    const accepted = search(text.slice(from, to), exact, maxErrors)
      .map((m) => evaluate(text, anchor, from + m.start, from + m.end, m.errors))
      .filter((c) => acceptable(c, anchor));
    if (accepted.length > 0) return pick(accepted, 'fuzzy');
  }
  return null;
}

// Context bracket (step 2): when the full prefix and suffix, each at least
// 8 characters, both survive unchanged, the anchor is whatever now sits
// between them: a gap of `ceil(len(exact) / 2)` to `2 * len(exact) + 16`
// characters after an exact prefix and before an exact suffix. Of several,
// the one whose start is closest to `start` (ties: earliest). This follows
// edits that grow or shrink the quote itself, such as "extra load" becoming
// "extra peak load". Having the whole context, it needs no `acceptable`.
function bracket(text, anchor) {
  const { exact, prefix, suffix } = anchor;
  if (prefix.length < MIN_BRACKET_CONTEXT || suffix.length < MIN_BRACKET_CONTEXT) return null;
  const minGap = Math.max(1, Math.ceil(exact.length / 2));
  const maxGap = 2 * exact.length + 16;
  let best = null;
  for (const prefixStart of occurrences(text, prefix)) {
    const start = prefixStart + prefix.length;
    const end = text.indexOf(suffix, start + minGap);
    if (end === -1 || end - start > maxGap) continue;
    const distance = Math.abs(start - anchor.start);
    if (!best || distance < best.distance) best = { start, end, distance };
  }
  return best && { start: best.start, end: trimTail(text, anchor, best), method: 'bracket', score: 0 };
}

// Text typed after the quote lands between it and the suffix, so the gap
// swallows it: when the quote's own tail (its last 16 characters) survives
// in the gap, end after its last occurrence.
function trimTail(text, { exact }, { start, end }) {
  const tail = exact.slice(-TAIL_LENGTH);
  const at = text.slice(start, end).lastIndexOf(tail);
  return at === -1 ? end : start + at + tail.length;
}

// The one acceptance rule for exact and fuzzy candidates: quote
// similarity at least 0.5; below 0.8, context similarity (the mean of
// prefix and suffix similarity) at least 0.5 too. A quote shorter than 8
// characters always needs its context, so a short quote that was deleted
// does not jump to an unrelated copy elsewhere: an exact copy is also a
// perfect fuzzy match, so checking it only in the exact step lets it through.
function acceptable(candidate, anchor) {
  const { quoteSim, contextSim } = candidate;
  if (quoteSim < 0.5) return false;
  if (quoteSim < 0.8 && contextSim < 0.5) return false;
  if (anchor.exact.length < SHORT_QUOTE_LENGTH && contextSim < 0.5) return false;
  return true;
}

// A candidate's score, with `sim(a, b) = 1 - edits / len(a)` (1 when `a` is
// empty) by approximate search of `a` within `b`:
//   50 * quote sim + 20 * prefix sim (32 characters before)
//   + 20 * suffix sim (32 after) + 2 * (1 - |start - anchor's start| / len(text))
function evaluate(text, anchor, start, end, errors) {
  const quoteSim = 1 - errors / anchor.exact.length;
  const prefixSim = similarity(anchor.prefix, text.slice(Math.max(0, start - anchor.prefix.length), start));
  const suffixSim = similarity(anchor.suffix, text.slice(end, end + anchor.suffix.length));
  const positionSim = text.length === 0
    ? 1
    : Math.max(0, 1 - Math.abs(start - anchor.start) / text.length);
  const score = WEIGHTS.quote * quoteSim
    + WEIGHTS.prefix * prefixSim
    + WEIGHTS.suffix * suffixSim
    + WEIGHTS.position * positionSim;
  return { start, end, score, quoteSim, contextSim: (prefixSim + suffixSim) / 2 };
}

// Highest score wins; ties go to the earliest start, so results are deterministic.
function pick(candidates, method) {
  let best = candidates[0];
  for (const c of candidates) {
    if (c.score > best.score || (c.score === best.score && c.start < best.start)) best = c;
  }
  return { start: best.start, end: best.end, method, score: best.score };
}

// 1 - edits/len(needle) for the best approximate match of needle in haystack.
function similarity(needle, haystack) {
  if (needle.length === 0) return 1;
  if (haystack.length === 0) return 0;
  const matches = search(haystack, needle, needle.length);
  if (matches.length === 0) return 0;
  const errors = Math.min(...matches.map((m) => m.errors));
  return 1 - errors / needle.length;
}

function occurrences(text, needle) {
  const starts = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) starts.push(i);
  return starts;
}

