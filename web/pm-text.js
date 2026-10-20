// The editor-side rendered text (src/markdown/project.js) built from
// the ProseMirror document, with a map from each character to a document
// position. Used to place highlights and to turn a selection into a quote,
// which the markdown projection turns into an anchor on the doc's text.

const WHITESPACE = /\s/;

// A top-level node never changes, so its lines are worked out once, with
// positions from the node's start, however often the doc around it changes.
const nodeLines = new WeakMap();

/** @returns {{ text: string, positions: Int32Array }} positions[i] is the doc position of text[i] */
export function projectDoc(doc) {
  const lines = [];
  const at = [];
  doc.forEach((node, offset) => {
    let own = nodeLines.get(node);
    if (!own) nodeLines.set(node, (own = linesOf(node)));
    for (const line of own) {
      lines.push(line);
      at.push(offset);
    }
  });
  const text = lines.map((line) => line.text).join('\n');
  const positions = new Int32Array(text.length);
  let i = 0;
  lines.forEach((line, k) => {
    if (k > 0) positions[i++] = line.positions[0] + at[k]; // the break sits at the next line's start
    for (const pos of line.positions) positions[i++] = pos + at[k];
  });
  return { text, positions };
}

// The lines of top-level node `top`: { text, positions }, positions from its start.
function linesOf(top) {
  const lines = [];
  const add = (node, pos) => {
    if (!node.isTextblock) return true;
    const chars = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        for (let i = 0; i < child.text.length; i++) chars.push([child.text[i], start + i]);
      } else if (child.type.name === 'hardbreak' || child.type.name === 'hard_break') {
        chars.push([' ', start]);
      } else if (child.type.name === 'html') {
        // Raw HTML counts as written; the editor keeps it as one
        // atom, so all of its characters sit at the atom's position.
        for (const ch of child.attrs.value ?? '') chars.push([ch, start]);
      }
    });
    const line = node.type.spec.code ? chars : collapse(chars);
    if (line.length > 0) lines.push({ text: line.map(([ch]) => ch).join(''), positions: line.map(([, p]) => p) });
    return false;
  };
  if (add(top, 0)) top.descendants((node, pos) => add(node, pos + 1));
  return lines;
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
  // range starting there starts with that character, not the break. (The
  // characters of a raw HTML atom share one position too, but are not breaks.)
  if (projection.text[start] === '\n' && positions[start + 1] === positions[start]) start++;
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
