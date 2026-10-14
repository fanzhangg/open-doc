// Three-way merge of markdown by line, for an agent editing the file while the
// human types. The editor serializes each paragraph to one line, so a line is
// close to a block: edits to different paragraphs merge, edits to the same
// paragraph conflict.

import { lineMatches as matches } from '../src/core/diff.js';

/**
 * @param {string} base the text both sides started from
 * @param {string} ours
 * @param {string} theirs
 * @returns {{ text: string, conflict: false } | { text: null, conflict: true }}
 */
export function merge3(base, ours, theirs) {
  if (ours === theirs || theirs === base) return { text: ours, conflict: false };
  if (ours === base) return { text: theirs, conflict: false };
  const b = base.split('\n');
  const o = ours.split('\n');
  const t = theirs.split('\n');
  const mo = matches(b, o);
  const mt = matches(b, t);
  if (!mo || !mt) return { text: null, conflict: true };

  const out = [];
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
    else return { text: null, conflict: true };
    i = j;
    oi = oEnd;
    ti = tEnd;
  }
  return { text: out.join('\n'), conflict: false };
}

function same(a, b) {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
