// Three-way merge of markdown by line, for an agent editing the file while the
// human types. The editor serializes each paragraph to one line, so a line is
// close to a block: edits to different paragraphs merge, and edits to
// different parts of the same paragraph merge by character. Edits that
// overlap conflict.

import { lineMatches as matches } from './diff.js';

/**
 * With `prefer: 'ours'`, a conflict keeps our side and reports theirs as
 * dropped instead of failing: each entry is the base lines and their lines
 * of one region where their change was not kept.
 * @param {string} base the text both sides started from
 * @param {string} ours
 * @param {string} theirs
 * @param {{ prefer?: 'ours' }} [options]
 * @returns {{ text: string, conflict: false, dropped: { base: string, theirs: string }[] } | { text: null, conflict: true }}
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
    return prefer === 'ours' ? { text: ours, conflict: false, dropped: [{ base, theirs }] } : { text: null, conflict: true };
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
    else {
      const line = baseChunk.length === 1 && ourChunk.length === 1 && theirChunk.length === 1
        ? mergeLine(baseChunk[0], ourChunk[0], theirChunk[0])
        : null;
      if (line !== null) out.push(line);
      else if (prefer === 'ours') {
        out.push(...ourChunk);
        dropped.push({ base: baseChunk.join('\n'), theirs: theirChunk.join('\n') });
      } else return { text: null, conflict: true };
    }
    i = j;
    oi = oEnd;
    ti = tEnd;
  }
  return { text: out.join('\n'), conflict: false, dropped };
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
