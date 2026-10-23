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
 * Edit `ops` moved over edit `landed`, both on one text, so it applies after
 * `landed`: what both deleted is deleted once, an insert inside a range the
 * other deleted stays, and of two inserts at one place `landed`'s goes
 * first, unless `first` says it is `ops` that reached the host first. A
 * replacement both made (the same range, the same text) lands once. Nothing
 * typed is lost. For any a, b on one text:
 * apply(apply(t, a), transform(b, a)) === apply(apply(t, b), transform(a, b, { first: true })).
 */
export function transform(ops, landed, { first = false } = {}) {
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
