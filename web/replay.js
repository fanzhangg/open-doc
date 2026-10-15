// Replaying a change made on disk the way a collaborator would type it: the
// agent's caret moves to each change, text to be removed is selected for a
// moment and then removed, and new text appears a few characters at a time.
//
// planReplay turns "this doc becomes that doc" into small operations, in
// positions of the doc as it is now. The replayer runs them over a few
// seconds, one ProseMirror transaction per piece, and maps the ones still to
// come through every other transaction, so the human can keep typing
// anywhere; typing in the block being replayed completes that block at once.

import { Fragment, Mark } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, Selection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

export const replayKey = new PluginKey('opendoc-replay');

const SELECT_MS = 300; // how long text to be removed shows selected
const CHAR_MS = 1000 / 18; // typing speed: about 18 characters a second
const LINE_MS = 200; // extra pause at a line break
const BLOCK_MS = 500; // pause between changed blocks
const STEP_MS = 150; // a change of block type or of formatting only
const MAX_MS = 10_000; // a longer replay speeds up to fit
const FADE_MS = 30_000; // the caret fades this long after the agent stops
const FOLLOW_IDLE_MS = 3000; // the view follows the caret unless the human typed this recently
const FRAME_MS = 16;
const TEXT_TYPES = new Set(['paragraph', 'heading']);

// ---- planning ----

/**
 * Operations that turn `oldDoc` into `newDoc`, in positions of `oldDoc`:
 *   { kind: 'select', from, to }  show the range selected (removed next)
 *   { kind: 'delete', from, to }
 *   { kind: 'type', pos, units }  insert characters (and inline nodes)
 *   { kind: 'replace', from, to, units }  same text, new formatting
 *   { kind: 'retype', pos, type, attrs }  paragraph ↔ heading
 *   { kind: 'block', pos, node }  insert a block, empty, then type its text
 *   { kind: 'swap', from, to, node }  replace a block the same way
 *   { kind: 'pause', ms }
 * Each also carries `group`: the top-level block it belongs to.
 */
export function planReplay(oldDoc, newDoc) {
  const plan = { ops: [], group: 0 };
  planChildren(oldDoc, newDoc, 0, plan, true);
  return plan.ops;
}

function planChildren(a, b, start, plan, top) {
  const offsets = [start];
  a.forEach((child) => offsets.push(offsets.at(-1) + child.nodeSize));
  for (const h of diffBlocks(a, b)) {
    const paired = Math.min(h.a1 - h.a0, h.b1 - h.b0);
    for (let k = 0; k < paired; k++) {
      if (top) nextGroup(plan);
      planPair(a.child(h.a0 + k), b.child(h.b0 + k), offsets[h.a0 + k], plan);
    }
    if (h.a1 - h.a0 > paired) {
      if (top) nextGroup(plan);
      const range = { from: offsets[h.a0 + paired], to: offsets[h.a1] };
      push(plan, { kind: 'select', ...range }, { kind: 'delete', ...range });
    }
    for (let k = h.b0 + paired; k < h.b1; k++) {
      if (top) nextGroup(plan);
      push(plan, { kind: 'block', pos: offsets[h.a1], node: b.child(k) });
    }
  }
}

function nextGroup(plan) {
  if (plan.ops.length > 0) push(plan, { kind: 'pause', ms: BLOCK_MS });
  plan.group++;
}

function push(plan, ...ops) {
  for (const op of ops) plan.ops.push({ ...op, group: plan.group });
}

function planPair(x, y, pos, plan) {
  if (sameBlock(x, y)) return;
  const sameType = x.type === y.type && sameAttrs(x, y);
  if (x.isTextblock && y.isTextblock && (sameType || (TEXT_TYPES.has(x.type.name) && TEXT_TYPES.has(y.type.name)))) {
    if (!sameType) push(plan, { kind: 'retype', pos, type: y.type, attrs: y.attrs });
    planInline(x, y, pos + 1, plan);
    return;
  }
  if (sameType && !x.isTextblock && !x.isLeaf) {
    planChildren(x, y, pos + 1, plan, false);
    return;
  }
  const range = { from: pos, to: pos + x.nodeSize };
  push(plan, { kind: 'select', ...range }, { kind: 'swap', ...range, node: y });
}

// Changes inside one textblock, word by word (character by character in CJK
// text), so a rewritten phrase is removed and typed as a whole rather than as
// scattered letters.
function planInline(x, y, contentStart, plan) {
  const ux = unitsOf(x);
  const uy = unitsOf(y);
  const tx = tokensOf(ux);
  const ty = tokensOf(uy);
  const at = [contentStart];
  for (const u of ux) at.push(at.at(-1) + u.size);
  const unitAt = (tokens, i, units) => (i < tokens.length ? tokens[i].from : units.length);
  for (const run of joinRuns(diffSeq(tx.length, ty.length, (i, j) => tx[i].key === ty[j].key), tx)) {
    const from = at[unitAt(tx, run.a0, ux)];
    const to = at[unitAt(tx, run.a1, ux)];
    const units = uy.slice(unitAt(ty, run.b0, uy), unitAt(ty, run.b1, uy));
    if (from < to && units.length > 0 && plainText(ux.slice(unitAt(tx, run.a0, ux), unitAt(tx, run.a1, ux))) === plainText(units)) {
      push(plan, { kind: 'select', from, to }, { kind: 'replace', from, to, units });
      continue;
    }
    if (from < to) push(plan, { kind: 'select', from, to }, { kind: 'delete', from, to });
    if (units.length > 0) push(plan, { kind: 'type', pos: from, units });
  }
}

// Runs separated only by spaces read better as one change.
function joinRuns(runs, tokens) {
  const out = [];
  for (const run of runs) {
    const last = out.at(-1);
    let gapIsSpace = Boolean(last);
    for (let i = last?.a1 ?? 0; gapIsSpace && i < run.a0; i++) gapIsSpace = tokens[i].space;
    if (last && gapIsSpace) Object.assign(last, { a1: run.a1, b1: run.b1 });
    else out.push({ ...run });
  }
  return out;
}

// A textblock's inline content as units: one per character (a whole code
// point) or inline node, each with its marks and size in the doc.
function unitsOf(node) {
  const units = [];
  node.forEach((child) => {
    if (child.isText) for (const ch of child.text) units.push({ text: ch, marks: child.marks, size: ch.length });
    else units.push({ node: child, marks: child.marks, size: child.nodeSize });
  });
  return units;
}

const unitKey = (u) => `${u.text ?? `\u0001${u.node.type.name}${JSON.stringify(u.node.attrs)}`}\u0000${u.marks.map((m) => m.type.name + JSON.stringify(m.attrs)).join()}`;
const plainText = (units) => units.map((u) => u.text ?? '\u0001').join('');

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}_'’-]/u;
function classOf(u) {
  if (!u.text) return 'node';
  if (CJK.test(u.text)) return 'cjk';
  if (/\s/.test(u.text)) return 'space';
  return WORD.test(u.text) ? 'word' : 'punct';
}

function tokensOf(units) {
  const tokens = [];
  for (let i = 0; i < units.length;) {
    const kind = classOf(units[i]);
    let j = i + 1;
    if (kind === 'word' || kind === 'space') while (j < units.length && classOf(units[j]) === kind) j++;
    tokens.push({ from: i, to: j, key: units.slice(i, j).map(unitKey).join('\u0002'), space: kind === 'space' });
    i = j;
  }
  return tokens;
}

/**
 * Runs of children that differ between two nodes, aligned by a longest
 * common subsequence of equal children: [{ a0, a1, b0, b1 }], in order.
 */
export function diffBlocks(a, b) {
  return diffSeq(a.childCount, b.childCount, (x, y) => sameBlock(a.child(x), b.child(y)));
}

// Runs where two sequences of length n and m differ, given equality by index.
function diffSeq(n, m, eq) {
  let start = 0;
  while (start < n && start < m && eq(start, start)) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && eq(endA - 1, endB - 1)) {
    endA--;
    endB--;
  }
  const rows = endA - start;
  const cols = endB - start;
  if (rows === 0 && cols === 0) return [];
  if (rows === 0 || cols === 0 || rows * cols > 1_000_000) return [{ a0: start, a1: endA, b0: start, b1: endB }];

  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  const same = (x, y) => eq(start + x, start + y);
  for (let x = rows - 1; x >= 0; x--) {
    for (let y = cols - 1; y >= 0; y--) {
      table[x * width + y] = same(x, y) ? table[(x + 1) * width + y + 1] + 1 : Math.max(table[(x + 1) * width + y], table[x * width + y + 1]);
    }
  }
  const runs = [];
  let x = 0;
  let y = 0;
  let open = null;
  const close = () => {
    if (open) runs.push({ a0: start + open.x, a1: start + x, b0: start + open.y, b1: start + y });
    open = null;
  };
  while (x < rows || y < cols) {
    if (x < rows && y < cols && same(x, y)) {
      close();
      x++;
      y++;
    } else {
      open ??= { x, y };
      if (y >= cols || (x < rows && table[(x + 1) * width + y] >= table[x * width + y + 1])) x++;
      else y++;
    }
  }
  close();
  return runs;
}

// Equal blocks, ignoring heading ids: the live editor derives them from the
// text after parsing, so a freshly parsed copy of the same heading lacks one.
export function sameBlock(a, b) {
  if (a.eq(b)) return true;
  return a.type === b.type && a.content.eq(b.content) && Mark.sameSet(a.marks, b.marks) && sameAttrs(a, b);
}

function sameAttrs(a, b) {
  const { id: _a, ...restA } = a.attrs;
  const { id: _b, ...restB } = b.attrs;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

// ---- running ----

/**
 * Run `op` on `state`, or its first `count` characters for a type op.
 * Returns the transaction (null when the op changes nothing), whether the op
 * is finished, the ops it expands into (in positions after the transaction),
 * the range of text it added and where the agent's caret ends up.
 */
export function runOp(state, op, count = Infinity) {
  const { tr } = state;
  switch (op.kind) {
    case 'delete':
      tr.delete(op.from, op.to);
      return { tr, done: true, more: [], range: null, caret: op.from };
    case 'type': {
      const take = op.units.splice(0, Math.max(1, count));
      const fragment = fragmentOf(take, state.schema);
      tr.insert(op.pos, fragment);
      return { tr, done: op.units.length === 0, more: [], range: { from: op.pos, to: op.pos + fragment.size }, caret: op.pos + fragment.size };
    }
    case 'replace': {
      const fragment = fragmentOf(op.units, state.schema);
      tr.replaceWith(op.from, op.to, fragment);
      return { tr, done: true, more: [], range: { from: op.from, to: op.from + fragment.size }, caret: op.from + fragment.size };
    }
    case 'retype':
      tr.setNodeMarkup(op.pos, op.type, op.attrs);
      return { tr, done: true, more: [], range: null, caret: op.pos + 1 };
    case 'block':
    case 'swap': {
      const at = op.kind === 'block' ? op.pos : op.from;
      const empty = skeleton(op.node);
      if (op.kind === 'block') tr.insert(at, empty);
      else tr.replaceWith(op.from, op.to, empty);
      return { tr, done: true, more: fillOps(empty, op.node, at, op.group), range: null, caret: at + 1 };
    }
    default: // select, pause: nothing to change
      return { tr: null, done: true, more: [], range: null, caret: op.to ?? null };
  }
}

/** Map an op's positions through a transaction's mapping. */
export function mapOp(op, mapping) {
  if (op.pos !== undefined) op.pos = mapping.map(op.pos, 1);
  if (op.from !== undefined) {
    op.from = mapping.map(op.from, 1);
    op.to = Math.max(op.from, mapping.map(op.to, -1));
  }
}

/** Run every op at once, for a state without a view (tests). */
export function replayAll(state, ops) {
  const queue = [...ops];
  while (queue.length > 0) {
    const op = queue.shift();
    const result = runOp(state, op);
    if (!result.done) queue.unshift(op);
    if (!result.tr) continue;
    state = state.apply(result.tr);
    for (const rest of queue) mapOp(rest, result.tr.mapping);
    queue.unshift(...result.more);
  }
  return state;
}

// A block with its structure but no text, to type the text into.
function skeleton(node) {
  if (node.isTextblock) return node.type.create(node.attrs, null, node.marks);
  if (node.isLeaf) return node;
  const children = [];
  node.forEach((child) => children.push(skeleton(child)));
  return node.type.create(node.attrs, children, node.marks);
}

// Type ops filling the empty textblocks of `empty` (inserted at `at`) with
// the text of the matching textblocks of `full`.
function fillOps(empty, full, at, group) {
  const ops = [];
  const visit = (e, f, pos) => {
    if (e.isTextblock) {
      if (f.content.size === 0) return;
      if (ops.length > 0) ops.push({ kind: 'pause', ms: LINE_MS, group });
      ops.push({ kind: 'type', pos: pos + 1, units: unitsOf(f), group });
      return;
    }
    if (e.isLeaf) return;
    let p = pos + 1;
    e.forEach((child, _offset, i) => {
      visit(child, f.child(i), p);
      p += child.nodeSize;
    });
  };
  visit(empty, full, at);
  return ops;
}

function fragmentOf(units, schema) {
  const nodes = [];
  let text = '';
  let marks = null;
  const flush = () => {
    if (text) nodes.push(schema.text(text, marks));
    text = '';
  };
  for (const u of units) {
    if (u.node) {
      flush();
      nodes.push(u.node);
    } else {
      if (text && !Mark.sameSet(marks, u.marks)) flush();
      marks = u.marks;
      text += u.text;
    }
  }
  flush();
  return Fragment.fromArray(nodes);
}

// How long an op takes at normal speed, including text it will type later.
function costOf(op) {
  switch (op.kind) {
    case 'select': return SELECT_MS;
    case 'pause': return op.ms;
    case 'type': return op.units.reduce((sum, u) => sum + unitCost(u), 0);
    case 'block':
    case 'swap': return [...op.node.textContent].length * CHAR_MS;
    case 'delete': return 0;
    default: return STEP_MS;
  }
}

const unitCost = (u) => CHAR_MS + (u.text === '\n' || u.node?.type.name === 'hardbreak' ? LINE_MS : 0);

/**
 * The replayer for one editor. `getView` returns the ProseMirror view;
 * `stage` holds the "editing below" pill; `onEnd({ ranges, humanEdited })`
 * is called when a replay finishes, with the ranges of text it added.
 */
export function createReplayer({ getView, stage, onEnd }) {
  let queue = [];
  let active = false;
  let target = null;
  let speed = 1;
  let budget = 0;
  let last = 0;
  let frame = 0;
  let holding = null; // the select op being shown
  let caret = null; // { pos, name, mode: 'looking' | 'active' | 'idle' | 'faded' }
  let ranges = [];
  let humanEdited = false;
  let flushBlock = false;
  let lastHuman = 0;
  let lastFollow = 0;
  let fadeTimer;
  let waiters = [];

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'od-agent-offscreen';
  pill.hidden = true;
  pill.addEventListener('click', () => scrollToCaret());
  stage.append(pill);
  // Nobody is watching a hidden page: show the change at once.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) finish();
  });

  const plugin = new Plugin({
    key: replayKey,
    appendTransaction(trs, _old, next) {
      for (const tr of trs) {
        if (!tr.docChanged) continue;
        for (const op of queue) mapOp(op, tr.mapping);
        if (caret) caret.pos = tr.mapping.map(caret.pos, 1);
        ranges = ranges.map((r) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) })).filter((r) => r.from < r.to);
        if (tr.getMeta(replayKey) || tr.getMeta('addToHistory') === false) continue;
        lastHuman = Date.now();
        if (!active) continue;
        humanEdited = true;
        if (touchesCaretBlock(tr, next.doc)) flushBlock = true;
      }
      return null;
    },
    props: {
      decorations(state) {
        const decorations = [];
        if (holding && holding.from < holding.to) decorations.push(Decoration.inline(holding.from, holding.to, { class: 'od-replay-select' }));
        if (caret && caret.pos <= state.doc.content.size) {
          const pos = Selection.near(state.doc.resolve(caret.pos), -1).head;
          const { name, mode } = caret;
          decorations.push(Decoration.widget(pos, () => caretElement(name, mode), {
            side: 1, key: `agent-caret-${name}-${mode}`, ignoreSelection: true, stopEvent: () => true,
          }));
        }
        return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null;
      },
    },
  });

  function caretElement(name, mode) {
    const wrap = document.createElement('span');
    wrap.className = 'od-agent-caret';
    wrap.dataset.mode = mode;
    wrap.contentEditable = 'false';
    const label = document.createElement('span');
    label.className = 'od-agent-caret-label';
    label.textContent = name;
    if (mode === 'active') {
      label.title = 'Show the rest now';
      label.addEventListener('mousedown', (event) => {
        event.preventDefault();
        finish();
      });
    }
    wrap.append(label);
    return wrap;
  }

  // Whether the human's transaction changed the top-level block the agent is in.
  function touchesCaretBlock(tr, doc) {
    if (!caret) return false;
    const $pos = doc.resolve(Math.min(caret.pos, doc.content.size));
    if ($pos.depth === 0) return false;
    const from = $pos.before(1);
    const to = $pos.after(1);
    let hit = false;
    tr.mapping.maps.forEach((map, i) => {
      const rest = tr.mapping.slice(i + 1);
      map.forEach((_os, _oe, start, end) => {
        if (rest.map(start, -1) <= to && rest.map(end, 1) >= from) hit = true;
      });
    });
    return hit;
  }

  function redraw() {
    const view = getView();
    view.dispatch(view.state.tr.setMeta(replayKey, 'redraw').setMeta('addToHistory', false));
  }

  // A timer rather than requestAnimationFrame: a window that is covered (or
  // never drawn) gets no animation frames, and a replay must not stall there
  // with the doc between versions.
  function schedule() {
    if (!frame) frame = setTimeout(() => tick(performance.now()), FRAME_MS);
  }

  // Run one op (or `count` characters of it) now.
  function perform(op, count) {
    const view = getView();
    let result;
    try {
      result = runOp(view.state, op, count);
    } catch (error) {
      console.debug('opendoc: a replay step no longer fits; skipped', op.kind, error);
      if (queue[0] === op) queue.shift();
      return;
    }
    if (result.done && queue[0] === op) queue.shift();
    if (result.tr) view.dispatch(result.tr.setMeta(replayKey, true).setMeta('addToHistory', false));
    queue.unshift(...result.more);
    if (result.range) {
      const lastRange = ranges.at(-1);
      if (lastRange && lastRange.to === result.range.from) lastRange.to = result.range.to;
      else ranges.push(result.range);
    }
    if (result.caret !== null && caret) caret.pos = result.caret;
  }

  function tick(now) {
    frame = 0;
    if (!active) return;
    const view = getView();
    if (view.composing) {
      last = now; // an IME is composing: wait, and do not catch up afterwards
      schedule();
      return;
    }
    budget += (now - last) * speed;
    last = now;
    if (flushBlock) {
      flushBlock = false;
      completeBlock();
    }
    while (queue.length > 0) {
      const op = queue[0];
      if (op.kind === 'select') {
        if (holding !== op) {
          holding = op;
          caret.pos = op.to;
          redraw();
        }
        if (budget < SELECT_MS) break;
        budget -= SELECT_MS;
        holding = null;
        queue.shift();
        continue;
      }
      if (op.kind === 'pause') {
        if (budget < op.ms) break;
        budget -= op.ms;
        queue.shift();
        continue;
      }
      if (op.kind === 'type') {
        let count = 0;
        let cost = 0;
        while (count < op.units.length && cost + unitCost(op.units[count]) <= budget) cost += unitCost(op.units[count++]);
        if (count === 0) break;
        budget -= cost;
        perform(op, count);
        continue;
      }
      const cost = costOf(op);
      if (op.kind !== 'block' && op.kind !== 'swap' && budget < cost) break;
      if (op.kind !== 'block' && op.kind !== 'swap') budget -= cost;
      perform(op);
    }
    follow();
    if (queue.length === 0 && !holding) end();
    else schedule();
  }

  // The human typed in the block being replayed: show the rest of it now.
  function completeBlock() {
    const group = queue.find((op) => op.kind !== 'select' && op.kind !== 'pause')?.group;
    holding = null;
    while (queue.length > 0 && queue[0].group === group) {
      const op = queue[0];
      if (op.kind === 'select' || op.kind === 'pause') queue.shift();
      else perform(op);
    }
  }

  function finish() {
    if (!active) return;
    holding = null;
    while (queue.length > 0) {
      const op = queue[0];
      if (op.kind === 'select' || op.kind === 'pause') queue.shift();
      else perform(op);
    }
    end();
  }

  function end() {
    active = false;
    holding = null;
    clearTimeout(frame);
    frame = 0;
    const view = getView();
    // The replay should land exactly on the target; if a kind of node was
    // missed, put the target's blocks in place (only when the human did not
    // type meanwhile, which also changes the result).
    if (!humanEdited && target) {
      const hunks = diffBlocks(view.state.doc, target);
      if (hunks.length > 0) {
        console.debug('opendoc: replay did not reach the target; replacing', hunks);
        const tr = view.state.tr;
        const current = view.state.doc;
        for (const h of [...hunks].reverse()) {
          const nodes = [];
          for (let k = h.b0; k < h.b1; k++) nodes.push(target.child(k));
          tr.replaceWith(childPos(current, h.a0), childPos(current, h.a1), Fragment.from(nodes));
        }
        view.dispatch(tr.setMeta(replayKey, true).setMeta('addToHistory', false));
      }
    }
    target = null;
    idle();
    pill.hidden = true;
    const done = { ranges, humanEdited };
    ranges = [];
    onEnd(done);
    for (const resolve of waiters) resolve();
    waiters = [];
  }

  function idle() {
    if (!caret) return;
    caret.mode = 'idle';
    redraw();
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (caret?.mode !== 'idle') return;
      caret.mode = 'faded';
      redraw();
    }, FADE_MS);
  }

  // Keep the caret in view, unless the human is typing: then point at it.
  function follow() {
    if (!caret) return;
    const view = getView();
    let rect;
    try {
      rect = view.coordsAtPos(Math.min(caret.pos, view.state.doc.content.size));
    } catch {
      return;
    }
    const above = rect.bottom < 0;
    const below = rect.top > window.innerHeight;
    if (!above && !below) {
      pill.hidden = true;
      return;
    }
    if (Date.now() - lastHuman > FOLLOW_IDLE_MS) {
      pill.hidden = true;
      if (Date.now() - lastFollow > 600) {
        lastFollow = Date.now();
        scrollToCaret();
      }
      return;
    }
    pill.textContent = `${caret.name} is editing ${below ? 'below ↓' : 'above ↑'}`;
    pill.dataset.side = below ? 'below' : 'above';
    pill.hidden = false;
  }

  function scrollToCaret() {
    if (!caret) return;
    const view = getView();
    const { node } = view.domAtPos(Math.min(caret.pos, view.state.doc.content.size));
    (node.nodeType === 1 ? node : node.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    pill.hidden = true;
  }

  return {
    plugin,
    active: () => active,
    /**
     * Start replaying the change from the view's doc to `next` (a doc),
     * typed by `name`. False when there is nothing to replay.
     */
    start(next, name) {
      finish();
      if (document.hidden) return false;
      const view = getView();
      const ops = planReplay(view.state.doc, next);
      if (ops.length === 0) return false;
      const total = ops.reduce((sum, op) => sum + costOf(op), 0);
      speed = Math.max(1, total / MAX_MS);
      queue = ops;
      target = next;
      active = true;
      humanEdited = false;
      flushBlock = false;
      ranges = [];
      budget = 0;
      clearTimeout(fadeTimer);
      const first = ops.find((op) => op.pos !== undefined || op.from !== undefined);
      caret = { pos: first.pos ?? first.from, name, mode: 'active' };
      last = performance.now();
      redraw();
      schedule();
      return true;
    },
    finish,
    /** Resolves once no replay is running. */
    done: () => (active ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()),
    /** The agent started on a comment at `pos`: show its caret there. */
    look(pos, name) {
      if (active) return;
      clearTimeout(fadeTimer);
      caret = { pos, name, mode: 'looking' };
      redraw();
    },
    /** The agent stopped: its caret stays where it was and fades. */
    rest() {
      if (!active && caret?.mode === 'looking') idle();
    },
    /** Take the agent's caret away (the agent is gone). */
    hide() {
      finish();
      caret = null;
      pill.hidden = true;
      redraw();
    },
  };
}

function childPos(doc, index) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}
