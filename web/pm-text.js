// The editor-side rendered text (SPEC.md §3.1) built from the ProseMirror
// document, with a map from each character to a document position. Used to
// place highlights and to turn a selection into a quote; the canonical anchor
// is always computed from the markdown with the core projection.

const WHITESPACE = /\s/;

/** @returns {{ text: string, positions: number[] }} positions[i] is the doc position of text[i] */
export function projectDoc(doc) {
  const lines = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const chars = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        for (let i = 0; i < child.text.length; i++) chars.push([child.text[i], start + i]);
      } else if (child.type.name === 'hardbreak' || child.type.name === 'hard_break') {
        chars.push([' ', start]);
      }
    });
    const line = node.type.spec.code ? chars : collapse(chars);
    if (line.length > 0) lines.push(line);
    return false;
  });

  let text = '';
  const positions = [];
  for (const line of lines) {
    if (text.length > 0) {
      text += '\n';
      positions.push(line[0][1]);
    }
    for (const [ch, pos] of line) {
      text += ch;
      positions.push(pos);
    }
  }
  return { text, positions };
}

/**
 * The document range a selection covers: { from, to }. A selection of table
 * cells has a range per cell, and its own from/to are only the first cell's.
 */
export function selectionSpan(selection) {
  let { from, to } = selection;
  for (const r of selection.ranges) {
    from = Math.min(from, r.$from.pos);
    to = Math.max(to, r.$to.pos);
  }
  return { from, to };
}

/** Text range covering the document range [from, to), or null if empty. */
export function textRange(projection, from, to) {
  const { positions } = projection;
  let start = positions.findIndex((p) => p >= from);
  if (start === -1) return null;
  // A line break sits at the position of the next line's first character: a
  // range starting there starts with that character, not the break.
  if (positions[start + 1] === positions[start]) start++;
  let end = start;
  while (end < positions.length && positions[end] < to) end++;
  return end > start ? { start, end } : null;
}

/** Document range for text range [start, end). */
export function docRange(projection, start, end) {
  return { from: projection.positions[start], to: projection.positions[end - 1] + 1 };
}

function collapse(chars) {
  const out = [];
  let pending = null;
  for (const [ch, pos] of chars) {
    if (WHITESPACE.test(ch)) {
      if (pending === null) pending = pos;
      continue;
    }
    if (pending !== null && out.length > 0) out.push([' ', pending]);
    pending = null;
    out.push([ch, pos]);
  }
  return out;
}
