// Three-way merge of markdown by line, for an agent editing the file while the
// human types. The editor serializes each paragraph to one line, so a line is
// close to a block: edits to different paragraphs merge, and edits to
// different parts of the same paragraph merge by character (unless that would
// change how the line renders, such as splitting a `**` pair). Edits that
// overlap conflict.

import { lineMatches as matches } from './diff.js';
import { project } from './project.js';

/**
 * With `prefer: 'ours'`, a conflict keeps our side and reports theirs as
 * dropped instead of failing: each entry is one region where their change
 * was not kept, with its base, our and their lines, and where our lines are
 * in the result (`at`, a line index, and `count` lines). `prefer: 'theirs'`
 * is the same the other way round: `at` and `count` are where their lines are.
 * @param {string} base the text both sides started from
 * @param {string} ours
 * @param {string} theirs
 * @param {{ prefer?: 'ours' | 'theirs' }} [options]
 * @returns {{ text: string, conflict: false, dropped: { at: number, count: number, base: string, ours: string, theirs: string }[] } | { text: null, conflict: true }}
 */
export function merge3(base, ours, theirs, { prefer } = {}) {
  if (ours === theirs || theirs === base) return { text: ours, conflict: false, dropped: [] };
  if (ours === base) return { text: theirs, conflict: false, dropped: [] };
  const b = base.split('\n');
  const o = ours.split('\n');
  const t = theirs.split('\n');
  const mo = matches(b, o);
  const mt = matches(b, t);
  if (!mo || !mt) {
    if (prefer === 'ours') return { text: ours, conflict: false, dropped: [{ at: 0, count: o.length, base, ours, theirs }] };
    if (prefer === 'theirs') return { text: theirs, conflict: false, dropped: [{ at: 0, count: t.length, base, ours, theirs }] };
    return { text: null, conflict: true };
  }

  const out = [];
  const dropped = [];
  let i = 0;
  let oi = 0;
  let ti = 0;
  for (;;) {
    while (i < b.length && mo[i] === oi && mt[i] === ti) {
      out.push(b[i]);
      i++;
      oi++;
      ti++;
    }
    if (i >= b.length && oi >= o.length && ti >= t.length) break;
    // The next base line both sides kept ends this changed region.
    let j = i;
    while (j < b.length && (mo[j] === -1 || mt[j] === -1)) j++;
    const oEnd = j < b.length ? mo[j] : o.length;
    const tEnd = j < b.length ? mt[j] : t.length;
    const baseChunk = b.slice(i, j);
    const ourChunk = o.slice(oi, oEnd);
    const theirChunk = t.slice(ti, tEnd);
    if (same(ourChunk, baseChunk)) out.push(...theirChunk);
    else if (same(theirChunk, baseChunk) || same(ourChunk, theirChunk)) out.push(...ourChunk);
    else if (baseChunk.length === ourChunk.length && baseChunk.length === theirChunk.length) {
      // As many lines on each side (rows of a table, items of a list, a
      // paragraph): line by line, so an edit next to the other side's stays.
      for (let k = 0; k < baseChunk.length; k++) {
        const [bl, ol, tl] = [baseChunk[k], ourChunk[k], theirChunk[k]];
        const line = ol === bl ? tl : tl === bl || ol === tl ? ol : mergeMarkdownLine(bl, ol, tl);
        if (line !== null) out.push(line);
        else if (prefer) {
          dropped.push({ at: out.length, count: 1, base: bl, ours: ol, theirs: tl });
          out.push(prefer === 'ours' ? ol : tl);
        } else return { text: null, conflict: true };
      }
    } else if (prefer) {
      const kept = prefer === 'ours' ? ourChunk : theirChunk;
      dropped.push({ at: out.length, count: kept.length, base: baseChunk.join('\n'), ours: ourChunk.join('\n'), theirs: theirChunk.join('\n') });
      out.push(...kept);
    } else {
      return { text: null, conflict: true };
    }
    i = j;
    oi = oEnd;
    ti = tEnd;
  }
  return { text: out.join('\n'), conflict: false, dropped };
}

// A character merge of one line of markdown, kept only when it renders as
// the same merge of the rendered lines: merging next to markup can otherwise
// pair a `*` from one side with a `*` from the other.
function mergeMarkdownLine(base, ours, theirs) {
  const line = mergeLine(base, ours, theirs);
  if (line === null) return null;
  const text = (md) => project(md).text;
  return text(line) === mergeLine(text(base), text(ours), text(theirs)) ? line : null;
}

/**
 * Where lines `at` to `at + count` of `from` ended up in `to`, a later
 * version of it: { start, end } line indexes in `to`, taking in whatever
 * changed between the nearest lines on either side that are still there.
 */
export function followLines(from, to, at, count) {
  const a = from.split('\n');
  const b = to.split('\n');
  const map = matches(a, b);
  if (!map) return null;
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (map[i] !== -1) {
      start = map[i] + 1;
      break;
    }
  }
  let end = b.length;
  for (let i = at + count; i < a.length; i++) {
    if (map[i] !== -1) {
      end = map[i];
      break;
    }
  }
  return { start, end: Math.max(start, end) };
}

/**
 * Merge two edits of one line when they change separate parts of it, or
 * null when they overlap (or both insert at the same place).
 */
export function mergeLine(base, ours, theirs) {
  const a = changedSpan(base, ours);
  const c = changedSpan(base, theirs);
  const [first, second] = a.from <= c.from ? [a, c] : [c, a];
  const bothInsertHere = first.from === first.to && second.from === second.to && first.from === second.from;
  if (first.to > second.from || bothInsertHere) return null;
  return base.slice(0, first.from) + first.text + base.slice(first.to, second.from) + second.text + base.slice(second.to);
}

// The one span of `base` that `next` replaced, by common prefix and suffix,
// never splitting a surrogate pair: { from, to, text }.
function changedSpan(base, next) {
  let p = 0;
  while (p < base.length && p < next.length && base[p] === next[p]) p++;
  if (p > 0 && isHighSurrogate(base.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < base.length - p && s < next.length - p && base[base.length - 1 - s] === next[next.length - 1 - s]) s++;
  if (s > 0 && isLowSurrogate(base.charCodeAt(base.length - s))) s--;
  return { from: p, to: base.length - s, text: next.slice(p, next.length - s) };
}

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

function same(a, b) {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
