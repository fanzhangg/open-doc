// Anchors (SPEC.md §3): create them from a selection or a quote, and re-find
// them after the doc changes — exact match, then context bracket, then fuzzy,
// else detach.

import search from 'approx-string-match';
import { project } from './project.js';

export const CONTEXT_LENGTH = 32;
export const MIN_FUZZY_LENGTH = 4;
export const SHORT_QUOTE_LENGTH = 8;
export const MIN_BRACKET_CONTEXT = 8;
const WINDOW_SLACK = 2048;
const WEIGHTS = { quote: 50, prefix: 20, suffix: 20, position: 2 };

export class AnchorError extends Error {
  /** @param {'not_found' | 'ambiguous'} code */
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

/** Anchor for the rendered-text range `[start, end)` (SPEC.md §3.2). */
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
 * Find an agent-supplied quote in the rendered text. A quote containing
 * markdown syntax is rendered first, so `**ship** it` finds `ship it`.
 *
 * @param {string} text rendered text
 * @param {string} quote
 * @param {{ occurrence?: number }} [options] 0-based pick when the quote repeats
 * @returns {{ start: number, end: number }}
 */
export function findQuote(text, quote, { occurrence } = {}) {
  const candidates = [quote, project(quote).text, quote.replace(/\s+/g, ' ').trim()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const starts = occurrences(text, candidate);
    if (starts.length === 0) continue;
    if (occurrence !== undefined) {
      if (occurrence < 0 || occurrence >= starts.length) {
        throw new AnchorError('not_found', `occurrence ${occurrence} out of range: the quote appears ${starts.length} time(s)`, { count: starts.length });
      }
      return { start: starts[occurrence], end: starts[occurrence] + candidate.length };
    }
    if (starts.length > 1) {
      throw new AnchorError('ambiguous', `the quote appears ${starts.length} times; pick an occurrence`, { count: starts.length });
    }
    return { start: starts[0], end: starts[0] + candidate.length };
  }
  throw new AnchorError('not_found', 'the quote does not appear in the doc');
}

/**
 * Re-find an anchor in new rendered text (SPEC.md §3.3).
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

/**
 * Re-find every anchored thread in new rendered text. Threads are returned as
 * new objects; unknown fields are preserved. Deterministic.
 *
 * @returns {{ threads: object[], changed: boolean }}
 */
export function reanchorThreads(text, threads) {
  let changed = false;
  const next = threads.map((thread) => {
    if (!thread.anchor) return thread;
    const found = locate(text, thread.anchor);
    if (!found) {
      if (thread.detached === true) return thread;
      changed = true;
      return { ...thread, detached: true };
    }
    const anchor = createAnchor(text, found.start, found.end);
    if (thread.detached === false && sameAnchor(anchor, thread.anchor)) return thread;
    changed = true;
    return { ...thread, anchor, detached: false };
  });
  return { threads: next, changed };
}

/**
 * Bring a sidecar's anchors up to date with a doc (SPEC.md §3.5). The caller
 * computes `docHash` (it needs a hash function, which differs between Node
 * and the browser). Returns the same object when nothing changed.
 */
export function refreshSidecar(sidecar, markdown, docHash) {
  if (sidecar.docHash === docHash) return sidecar;
  const { threads } = reanchorThreads(project(markdown).text, sidecar.threads);
  return { ...sidecar, docHash, threads };
}

// Context bracket (SPEC.md §3.3 step 2): when the full prefix and suffix both
// survive unchanged, the anchor is whatever now sits between them.
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
  return best && { start: best.start, end: best.end, method: 'bracket', score: 0 };
}

// The one acceptance rule for exact and fuzzy candidates (SPEC.md §3.3). A
// short quote always needs its context: an exact copy elsewhere is also a
// perfect fuzzy match, so checking it only in the exact step lets it through.
function acceptable(candidate, anchor) {
  const { quoteSim, contextSim } = candidate;
  if (quoteSim < 0.5) return false;
  if (quoteSim < 0.8 && contextSim < 0.5) return false;
  if (anchor.exact.length < SHORT_QUOTE_LENGTH && contextSim < 0.5) return false;
  return true;
}

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

function sameAnchor(a, b) {
  return a.exact === b.exact && a.prefix === b.prefix && a.suffix === b.suffix && a.start === b.start;
}
