// Three-way merge of markdown by line, for an agent editing the file while the
// human types. The editor serializes each paragraph to one line, so a line is
// close to a block: edits to different paragraphs merge, edits to the same
// paragraph conflict.

const MAX_DIFF_CELLS = 4_000_000;

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

// For each line of `a`, the index of the matching line of `b` in a longest
// common subsequence, or -1. Null when the inputs are too large to diff.
function matches(a, b) {
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

function same(a, b) {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
