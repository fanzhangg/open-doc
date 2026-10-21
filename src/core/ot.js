// Operations on a doc's text: what an edit is when the doc host orders the
// edits of many writers (docs/architecture.md, Interfaces). An edit is a
// list of operations `{ from, to, insert }` on the text it started from:
// replace [from, to) with `insert`, offsets in UTF-16 code units, sorted and
// not overlapping. The page and the host share these.

import { lineMatches } from './diff.js';

/**
 * The edit that turns `base` into `text`, by character: what differs is
 * trimmed, and inside it each run that changed is its own operation. So when
 * two pages restyle a block the same way (`__x__` to `**x**`, a Markdown
 * view's first touch of it), they send the same operations, which land once.
 * `caret`, an offset in `text`, is where the writer's edit ended: what
 * differs is not trimmed past it, so of two places an edit could be (a
 * deleted sentence that ends as the next one starts), it is at the caret.
 */
export function diffOps(base, text, caret = text.length) {
  if (base === text) return [];
  const max = Math.min(base.length, text.length);
  let start = 0;
  while (start < max && start < caret && base.charCodeAt(start) === text.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && end < text.length - caret && base.charCodeAt(base.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
  // Never split a surrogate pair.
  if (start > 0 && isHigh(base.charCodeAt(start - 1))) start--;
  if (end > 0 && isLow(base.charCodeAt(base.length - end))) end--;
  const a = Array.from(base.slice(start, base.length - end));
  const b = Array.from(text.slice(start, text.length - end));
  const matches = lineMatches(a, b);
  if (!matches) return [{ from: start, to: base.length - end, insert: b.join('') }];
  // Between two matched characters, what `base` had is replaced by what `text` has.
  const ops = [];
  let at = start;
  let x = 0;
  let y = 0;
  for (let k = 0; k <= a.length; k++) {
    if (k < a.length && matches[k] === -1) continue;
    const next = k < a.length ? matches[k] : b.length;
    const gone = a.slice(x, k).join('');
    if (gone || next > y) ops.push({ from: at, to: at + gone.length, insert: b.slice(y, next).join('') });
    at += gone.length + (a[k]?.length ?? 0);
    x = k + 1;
    y = next + 1;
  }
  return ops;
}

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
 * Edit `ops` moved over edit `landed`, both on one text, so it applies after
 * `landed`. Merged by character, and nothing typed is lost: what both
 * deleted is deleted once, an insert inside a range the other deleted stays,
 * and of two inserts at one place `landed`'s goes first, unless `first`
 * says it is `ops` that reached the host first. A replacement both made
 * (the same range, the same text) lands once. For any a, b on one text:
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
