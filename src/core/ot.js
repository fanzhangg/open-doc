// Operations on a doc's text: what an edit is when the doc host orders the
// edits of many writers (docs/architecture.md, Interfaces). An edit is a
// list of operations `{ from, to, insert }` on the text it started from:
// replace [from, to) with `insert`, offsets in UTF-16 code units, sorted and
// not overlapping. The page and the host share these.

import { lineMatches, sameEnd, sameStart } from './diff.js';

/**
 * The edit that turns `base` into `text`, by character: what differs is
 * trimmed, then diffed by line, and inside each run of lines that changed
 * each run of characters that changed is its own operation. So when two
 * pages restyle a block the same way (`__x__` to `**x**`, a Markdown view's
 * first touch of it), they send the same operations, which land once.
 * `caret`, an offset in `text`, is where the writer's edit ended: what
 * differs is not trimmed past it, so of two places an edit could be (a
 * deleted sentence that ends as the next one starts), it is at the caret.
 */
export function diffOps(base, text, caret) {
  if (base === text) return [];
  const max = Math.min(base.length, text.length);
  let start = sameStart(base, text, Math.min(max, caret ?? max));
  let end = sameEnd(base, text, Math.min(max - start, caret === undefined ? max : text.length - caret));
  // Never split a surrogate pair.
  if (start > 0 && isHigh(base.charCodeAt(start - 1))) start--;
  if (end > 0 && isLow(base.charCodeAt(base.length - end))) end--;
  const a = base.slice(start, base.length - end);
  const b = text.slice(start, text.length - end);
  const byLine = edits(a, b, start, lines) ?? [{ from: start, to: start + a.length, insert: b }];
  return byLine.flatMap((op) => edits(base.slice(op.from, op.to), op.insert, op.from, Array.from) ?? [op]);
}

// The operations turning `a` into `b`, at `at` in the text, as `split` cuts
// them into pieces: between two pieces both have, what `a` had is replaced by
// what `b` has. Null when they have nothing in common to diff by.
function edits(a, b, at, split) {
  const x = split(a);
  const y = split(b);
  const matches = lineMatches(x, y);
  if (!matches) return null;
  const ops = [];
  let i = 0;
  let j = 0;
  for (let k = 0; k <= x.length; k++) {
    if (k < x.length && matches[k] === -1) continue;
    const next = k < x.length ? matches[k] : y.length;
    const gone = x.slice(i, k).join('');
    if (gone || next > j) ops.push({ from: at, to: at + gone.length, insert: y.slice(j, next).join('') });
    at += gone.length + (x[k]?.length ?? 0);
    i = k + 1;
    j = next + 1;
  }
  return ops;
}

const lines = (text) => (text ? text.split(/(?<=\n)/) : []);

/** `text` with edit `ops` applied. */
export function apply(text, ops) {
  let out = '';
  let at = 0;
  for (const op of ops) {
    out += text.slice(at, op.from) + op.insert;
    at = op.to;
  }
  return out + text.slice(at);
}

/**
 * Where offset `at` of a text is once edit `ops` lands on it: after text
 * inserted there, at the end of text that replaced it. A person's caret
 * follows the others' edits so.
 */
export function mapOffset(at, ops) {
  let shift = 0;
  for (const op of ops) {
    if (op.from > at || (op.from === at && op.to > at)) break;
    if (op.to > at) return op.from + shift + op.insert.length;
    shift += op.insert.length - (op.to - op.from);
  }
  return at + shift;
}

/**
 * Edit `ops` moved over edit `landed`, both on text `base`, so it applies
 * after `landed`: { ops, dropped }.
 *
 * A person's edit merges by character, and nothing typed is lost: what both
 * deleted is deleted once, an insert inside a range the other deleted stays,
 * and of two inserts at one place `landed`'s goes first, unless `first` says
 * it is `ops` that reached the host first. A replacement both made (the same
 * range, the same text) lands once. For any a, b on one text:
 * apply(apply(t, a), transform(b, a).ops) === apply(apply(t, b), transform(a, b, { first: true }).ops).
 *
 * An edit that `yields` (a buddy's, an outside change, an undo) is dropped
 * wherever `landed` changed a line it changes, and `dropped` says so; its
 * operations that touch one line go or stay together. Where both changed
 * one line, in places apart, it stays if every rule's `mergeLine` (rulesOf)
 * allows the merged line. Where both made the same change, it goes, and
 * nothing is dropped. When it is `landed` that yields (it reached the host
 * first, but this edit started before it), the same holds the other way
 * round: `ops` comes out as the edit from what `landed` made to `ops` with
 * what stays of `landed` on it, and `dropped` says whether `landed` lost
 * anything to it.
 */
export function transform(ops, landed, { first = false, yields = false, landedYields = false, base = '', rules = [] } = {}) {
  if (landedYields) {
    const kept = transform(landed, ops, { yields: true, base, rules });
    return { ops: diffOps(apply(base, landed), apply(apply(base, ops), kept.ops)), dropped: kept.dropped };
  }
  let dropped = false;
  if (yields && landed.length > 0) {
    const kept = [];
    for (const group of byLine(base, ops)) {
      const verdict = overlaps(base, group, landed, rules);
      if (verdict === 'kept') kept.push(...group.ops);
      else if (verdict === 'dropped') dropped = true;
    }
    ops = kept;
  }
  return { ops: moved(ops, landed, first), dropped };
}

// The operations of `ops` grouped by the lines of `base` they touch: each
// group { ops, from, to }, [from, to] the lines' span from the first's start
// to the last's end (its newline, or the end of the text).
function byLine(base, ops) {
  const groups = [];
  for (const op of ops) {
    const [from, to] = lineSpan(base, op);
    const last = groups.at(-1);
    if (last && from <= last.to) {
      last.ops.push(op);
      last.to = Math.max(last.to, to);
    } else groups.push({ ops: [op], from, to });
  }
  return groups;
}

// The span of the lines of `base` that `op` touches: an insert the line it
// is in, a delete each line it deletes from.
function lineSpan(base, op) {
  const end = op.to > op.from ? op.to - 1 : op.from;
  const next = base.indexOf('\n', end);
  return [base.lastIndexOf('\n', op.from - 1) + 1, next === -1 ? base.length : next];
}

// Whether `group` of a yielding edit is 'kept', 'dropped' or 'same' (what
// `landed` made of its lines already) over `landed`.
function overlaps(base, group, landed, rules) {
  const theirs = landed.filter((op) => {
    const [from, to] = lineSpan(base, op);
    return from <= group.to && group.from <= to;
  });
  if (theirs.length === 0) return 'kept';
  if (theirs.some((op) => lineSpan(base, op)[0] < group.from || lineSpan(base, op)[1] > group.to)) return 'dropped';
  // The group's lines, with the newline after them, as each side left them.
  const end = Math.min(group.to + 1, base.length);
  const shift = (op) => ({ from: op.from - group.from, to: op.to - group.from, insert: op.insert });
  const was = base.slice(group.from, end);
  const ours = apply(was, group.ops.map(shift));
  const other = apply(was, theirs.map(shift));
  if (ours === other) return 'same';
  // One line both changed and kept as one line: merged by character, if apart.
  const one = (text) => text.indexOf('\n') === (was.endsWith('\n') ? text.length - 1 : -1);
  if (!one(was) || !one(ours) || !one(other)) return 'dropped';
  const line = (text) => (was.endsWith('\n') ? text.slice(0, -1) : text);
  const merged = mergeLine(line(was), line(ours), line(other));
  if (merged === null || rules.some((rule) => rule.mergeLine?.(line(was), line(ours), line(other), merged) === false)) return 'dropped';
  return 'kept';
}

/**
 * Merge two edits of one line when they change separate parts of it, or
 * null when they overlap (or one inserts where the other changes, from its
 * start): either way round.
 */
export function mergeLine(base, ours, theirs) {
  const a = changedSpan(base, ours);
  const c = changedSpan(base, theirs);
  const [first, second] = a.from < c.from || (a.from === c.from && a.to >= c.to) ? [a, c] : [c, a];
  const bothInsertHere = first.from === first.to && second.from === second.to && first.from === second.from;
  if (first.to > second.from || bothInsertHere) return null;
  return base.slice(0, first.from) + first.text + base.slice(first.to, second.from) + second.text + base.slice(second.to);
}

// The one span of `base` that `next` replaced, by common prefix and suffix,
// never splitting a surrogate pair: { from, to, text }.
function changedSpan(base, next) {
  let p = sameStart(base, next);
  if (p > 0 && isHigh(base.charCodeAt(p - 1))) p--;
  let s = sameEnd(base, next, Math.min(base.length, next.length) - p);
  if (s > 0 && isLow(base.charCodeAt(base.length - s))) s--;
  return { from: p, to: base.length - s, text: next.slice(p, next.length - s) };
}

// Edit `ops` moved over edit `landed` by character (see transform).
function moved(ops, landed, first) {
  const a = parts(ops);
  const b = parts(landed);
  const out = [];
  let i = 0;
  let j = 0;
  let at = 0; // offset in the text after `landed`
  const emit = (from, to, insert) => {
    const last = out.at(-1);
    if (last?.to === from) {
      last.to = to;
      last.insert += insert;
    } else out.push({ from, to, insert });
  };
  while (i < a.length) {
    const x = a[i];
    const y = b[j];
    if (x.insert !== undefined && y?.insert !== undefined && same(x.op, y.op)) {
      at += y.insert.length; // made by both: done
      i++;
      j++;
    } else if (x.insert !== undefined && (y?.insert === undefined || first)) {
      emit(at, at, x.insert);
      i++;
    } else if (y?.insert !== undefined) {
      at += y.insert.length;
      j++;
    } else {
      // Both keep or delete characters of the text: take the shorter run.
      const n = Math.min(x.n, y?.n ?? Infinity);
      if (x.delete && !y?.delete) emit(at, at + n, '');
      if (!y?.delete) at += n;
      if ((x.n -= n) === 0) i++;
      if (y && (y.n -= n) === 0) j++;
    }
  }
  return out;
}

// An edit as runs over its text: { n } keeps n characters, { n, delete } deletes
// them, { insert } inserts. An insert comes before what its operation deletes.
function parts(ops) {
  const out = [];
  let at = 0;
  for (const op of ops) {
    if (op.from > at) out.push({ n: op.from - at });
    if (op.insert) out.push({ insert: op.insert, op });
    if (op.to > op.from) out.push({ n: op.to - op.from, delete: true });
    at = op.to;
  }
  return out;
}

const same = (a, b) => a.to > a.from && a.from === b.from && a.to === b.to && a.insert === b.insert;
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
