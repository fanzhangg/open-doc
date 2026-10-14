// The page: a Milkdown (ProseMirror) WYSIWYG editor with comment highlights,
// a margin "add comment" button for selections, and collaborator-style
// application of changes made on disk: only the blocks that changed are
// replaced (the caret stays put) and the new text glows with the author's name.

import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, serializerCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import {
  commonmark, toggleStrongCommand, toggleEmphasisCommand, wrapInHeadingCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand, toggleLinkCommand, turnIntoTextCommand,
} from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { $prose, callCommand, getMarkdown, replaceAll } from '@milkdown/kit/utils';
import { Fragment, Mark } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { locate } from '../src/core/anchor.js';
import { activeWorking } from '../src/core/ops.js';
import { docRange, projectDoc, textRange } from './pm-text.js';

const FLASH_MS = 6000;
const highlightKey = new PluginKey('opendoc-highlights');
const flashKey = new PluginKey('opendoc-flash');

// Decorations replaced wholesale through a meta, mapped through other edits.
const decorationPlugin = (key) => $prose(() => new Plugin({
  key,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, set) => tr.getMeta(key) ?? set.map(tr.mapping, tr.doc),
  },
  props: { decorations: (state) => key.getState(state) },
}));

/**
 * @param {{ stage: HTMLElement, toolbar: HTMLElement, markdown: string,
 *           onChange: () => void, onSelectThread: (id: string) => void,
 *           onCommentRequest: (selection: { quote: string, prefix: string, suffix: string, start: number } | null) => void }} options
 */
export async function createDocEditor({ stage, toolbar, markdown, onChange, onSelectThread, onCommentRequest }) {
  // Markdown as last loaded or applied; an update that serializes to the same
  // text is an echo of that, not a local edit (markdownUpdated is debounced).
  let baseline = null;
  let onDocUpdated = () => {};
  const host = stage.querySelector('.od-editor');
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
      // Match common markdown style so edited blocks change as little as possible.
      ctx.update(remarkStringifyOptionsCtx, (options) => ({
        ...options, bullet: '-', emphasis: '*', strong: '*', rule: '-', fences: true, listItemIndent: 'one',
      }));
      ctx.get(listenerCtx)
        .markdownUpdated((_ctx, next) => {
          if (next !== baseline) onChange();
        })
        .updated(() => onDocUpdated());
    })
    .use(commonmark).use(gfm).use(history).use(clipboard).use(listener)
    .use(decorationPlugin(highlightKey)).use(decorationPlugin(flashKey))
    .create();

  const view = () => editor.ctx.get(editorViewCtx);
  const parse = (md) => editor.ctx.get(parserCtx)(md);
  const serialize = (doc) => editor.ctx.get(serializerCtx)(doc);
  baseline = editor.action(getMarkdown());
  let threads = [];
  let activeId = null;
  let draft = null; // anchor-like hint of the selection being commented on
  const layoutListeners = new Set();

  function paintHighlights() {
    const v = view();
    const projection = projectDoc(v.state.doc);
    const decorations = [];
    const add = (anchor, id, classes) => {
      const found = locate(projection.text, anchor);
      if (!found) return;
      const { from, to } = docRange(projection, found.start, found.end);
      decorations.push(Decoration.inline(from, to, { class: classes, 'data-thread': id }));
    };
    const now = Date.now();
    for (const thread of threads) {
      if (!thread.anchor || thread.detached || thread.status !== 'open') continue;
      let classes = 'od-hl';
      if (thread.id === activeId) classes += ' od-hl-active';
      if (activeWorking(thread, now)) classes += ' od-hl-working';
      add(thread.anchor, thread.id, classes);
    }
    if (draft) add(draft, 'draft', 'od-hl od-hl-active');
    v.dispatch(v.state.tr.setMeta(highlightKey, DecorationSet.create(v.state.doc, decorations)).setMeta('addToHistory', false));
    for (const listener of layoutListeners) listener();
  }

  // Re-place highlights shortly after typing stops; mapping keeps them close meanwhile.
  let repaintTimer;
  onDocUpdated = () => {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(paintHighlights, 250);
  };

  host.addEventListener('click', (event) => {
    const mark = event.target.closest?.('[data-thread]');
    if (mark && mark.dataset.thread !== 'draft') onSelectThread(mark.dataset.thread);
  });

  // ---- selection → comment ----

  function selectionHint() {
    const v = view();
    const projection = projectDoc(v.state.doc);
    const range = textRange(projection, v.state.selection.from, v.state.selection.to);
    if (!range) return null;
    const { text } = projection;
    return {
      quote: text.slice(range.start, range.end),
      prefix: text.slice(Math.max(0, range.start - 32), range.start),
      suffix: text.slice(range.end, range.end + 32),
      start: range.start,
    };
  }

  const button = stage.querySelector('.od-add-comment');
  function placeButton() {
    const v = view();
    const { from, to, empty } = v.state.selection;
    if (empty || !v.hasFocus() || textRange(projectDoc(v.state.doc), from, to) === null) {
      button.hidden = true;
      return;
    }
    const box = stage.getBoundingClientRect();
    const page = stage.querySelector('.od-page').getBoundingClientRect();
    button.style.top = `${v.coordsAtPos(from).top - box.top - 6}px`;
    button.style.left = `${Math.min(page.right - box.left - 18, box.width - 44)}px`; // straddles the page edge
    button.hidden = false;
  }
  document.addEventListener('selectionchange', () => requestAnimationFrame(placeButton));
  host.addEventListener('blur', () => setTimeout(placeButton, 150), true);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => requestComment());

  function requestComment() {
    const hint = view().state.selection.empty ? null : selectionHint();
    button.hidden = true;
    onCommentRequest(hint);
  }

  // ---- toolbar ----

  const commands = {
    paragraph: () => callCommand(turnIntoTextCommand.key),
    h1: () => callCommand(wrapInHeadingCommand.key, 1),
    h2: () => callCommand(wrapInHeadingCommand.key, 2),
    h3: () => callCommand(wrapInHeadingCommand.key, 3),
    bold: () => callCommand(toggleStrongCommand.key),
    italic: () => callCommand(toggleEmphasisCommand.key),
    bullets: () => callCommand(wrapInBulletListCommand.key),
    numbers: () => callCommand(wrapInOrderedListCommand.key),
    link: () => {
      const href = window.prompt('Link URL');
      return href ? callCommand(toggleLinkCommand.key, { href }) : null;
    },
  };
  toolbar.addEventListener('mousedown', (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    event.preventDefault(); // keep the selection in the editor
    if (target.dataset.action === 'comment') {
      requestComment();
      return;
    }
    const name = target.dataset.command;
    if (!name) return;
    const command = commands[name]();
    if (command) editor.action(command);
    view().focus();
  });

  // ---- changes from disk ----

  /** Replace only the top-level blocks that differ; glow the new text, labelled `by`. */
  function applyMarkdown(next, by) {
    const v = view();
    const current = v.state.doc;
    const target = parse(next);
    const hunks = diffBlocks(current, target);
    if (hunks.length === 0) {
      baseline = editor.action(getMarkdown());
      return;
    }
    const tr = v.state.tr;
    for (const h of [...hunks].reverse()) {
      const nodes = [];
      for (let k = h.b0; k < h.b1; k++) nodes.push(target.child(k));
      tr.replaceWith(childPos(current, h.a0), childPos(current, h.a1), Fragment.from(nodes));
    }
    tr.setMeta('addToHistory', false);
    v.dispatch(tr);
    baseline = editor.action(getMarkdown());
    flash(hunks.map((h) => changedRange(current, target, h)).filter(Boolean), by);
    paintHighlights();
  }

  function flash(ranges, by) {
    if (ranges.length === 0) return;
    const flashId = Symbol('flash');
    const decorations = [];
    ranges.forEach((r, i) => {
      decorations.push(r.node
        ? Decoration.node(r.from, r.to, { class: 'od-flash-block' }, { flashId })
        : Decoration.inline(r.from, r.to, { class: 'od-flash' }, { flashId }));
      if (i === 0) decorations.push(Decoration.widget(r.node ? r.from + 1 : r.from, () => flag(by), { side: -1, flashId }));
    });
    updateFlashes((set, doc) => set.add(doc, decorations));
    setTimeout(() => updateFlashes((set) => set.remove(set.find(undefined, undefined, (spec) => spec.flashId === flashId))), FLASH_MS);
  }

  function updateFlashes(change) {
    const v = view();
    const next = change(flashKey.getState(v.state), v.state.doc);
    v.dispatch(v.state.tr.setMeta(flashKey, next).setMeta('addToHistory', false));
  }

  return {
    getMarkdown: () => editor.action(getMarkdown()),
    /** Markdown as this editor would write it, for comparing with its own output. */
    normalize: (md) => serialize(parse(md)),
    applyMarkdown,
    /** Replace the content without reporting it as a local edit. */
    setMarkdown(next) {
      editor.action(replaceAll(next, true));
      baseline = editor.action(getMarkdown());
      paintHighlights();
    },
    setThreads(next) {
      threads = next;
      paintHighlights();
    },
    setActive(id) {
      activeId = id;
      paintHighlights();
    },
    setDraft(hint) {
      draft = hint && { exact: hint.quote, prefix: hint.prefix, suffix: hint.suffix, start: hint.start };
      paintHighlights();
    },
    requestComment,
    focus: () => view().focus(),
    /** Viewport top of each anchor (or of the draft), by thread id. */
    anchorTops(items) {
      const v = view();
      const projection = projectDoc(v.state.doc);
      const tops = new Map();
      for (const { id, anchor } of items) {
        const found = anchor && locate(projection.text, anchor);
        if (!found) continue;
        tops.set(id, v.coordsAtPos(docRange(projection, found.start, found.end).from).top);
      }
      return tops;
    },
    onLayout(listener) {
      layoutListeners.add(listener);
    },
  };
}

function flag(name) {
  const wrap = document.createElement('span');
  wrap.className = 'od-flag';
  const label = document.createElement('span');
  label.className = 'od-flag-label';
  label.textContent = name;
  wrap.append(label);
  return wrap;
}

// Document position where top-level child `index` starts.
function childPos(doc, index) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/**
 * Runs of top-level blocks that differ between two docs, aligned by a longest
 * common subsequence of equal blocks: [{ a0, a1, b0, b1 }], in order.
 */
export function diffBlocks(a, b) {
  const n = a.childCount;
  const m = b.childCount;
  let start = 0;
  while (start < n && start < m && sameBlock(a.child(start), b.child(start))) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && sameBlock(a.child(endA - 1), b.child(endB - 1))) {
    endA--;
    endB--;
  }
  const rows = endA - start;
  const cols = endB - start;
  if (rows === 0 && cols === 0) return [];
  if (rows === 0 || cols === 0 || rows * cols > 250_000) return [{ a0: start, a1: endA, b0: start, b1: endB }];

  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  const eq = (x, y) => sameBlock(a.child(start + x), b.child(start + y));
  for (let x = rows - 1; x >= 0; x--) {
    for (let y = cols - 1; y >= 0; y--) {
      table[x * width + y] = eq(x, y) ? table[(x + 1) * width + y + 1] + 1 : Math.max(table[(x + 1) * width + y], table[x * width + y + 1]);
    }
  }
  const hunks = [];
  let x = 0;
  let y = 0;
  let open = null;
  const close = () => {
    if (open) hunks.push({ a0: start + open.x, a1: start + x, b0: start + open.y, b1: start + y });
    open = null;
  };
  while (x < rows || y < cols) {
    if (x < rows && y < cols && eq(x, y)) {
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
  return hunks;
}

// Equal blocks, ignoring heading ids: the live editor derives them from the
// text after parsing, so a freshly parsed copy of the same heading lacks one.
function sameBlock(a, b) {
  if (a.eq(b)) return true;
  if (a.type !== b.type || !a.content.eq(b.content) || !Mark.sameSet(a.marks, b.marks)) return false;
  const { id: _a, ...restA } = a.attrs;
  const { id: _b, ...restB } = b.attrs;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

// The part of the new doc a hunk introduced: the changed characters when one
// block replaced one block, otherwise the new blocks. Null for a deletion.
function changedRange(oldDoc, newDoc, h) {
  if (h.b1 === h.b0) return null;
  const from = childPos(newDoc, h.b0);
  const to = childPos(newDoc, h.b1);
  if (h.a1 - h.a0 === 1 && h.b1 - h.b0 === 1) {
    const before = oldDoc.child(h.a0).textContent;
    const node = newDoc.child(h.b0);
    const after = node.textContent;
    let p = 0;
    while (p < before.length && p < after.length && before[p] === after[p]) p++;
    let s = 0;
    while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
    if (after.length - s > p) {
      return { from: textPos(node, from, p), to: textPos(node, from, after.length - s) };
    }
  }
  if (h.b1 - h.b0 === 1) return { from, to, node: true };
  return { from: from + 1, to: to - 1 }; // several blocks: glow their text
}

// Document position of text offset `offset` inside top-level `node` at `nodePos`.
function textPos(node, nodePos, offset) {
  let seen = 0;
  let result = null;
  node.descendants((child, pos) => {
    if (result !== null) return false;
    if (!child.isText) return true;
    if (offset <= seen + child.text.length) {
      result = nodePos + 1 + pos + (offset - seen);
      return false;
    }
    seen += child.text.length;
    return true;
  });
  return result ?? nodePos + node.nodeSize - 1;
}
