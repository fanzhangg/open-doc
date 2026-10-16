// The page: a Milkdown (ProseMirror) WYSIWYG editor with comment highlights,
// a suggestion-style view of a proposal or a past edit, named
// formatting commands for the toolbar, selection bubble and "/" menu, and
// collaborator-style application of changes made on disk: the agent's
// changes are replayed as typing (web/replay.js); other changes replace only
// the blocks that differ (the caret stays put) and glow with the author's name.

import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, serializerCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import {
  commonmark, toggleStrongCommand, toggleEmphasisCommand, wrapInHeadingCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand, turnIntoTextCommand,
  toggleInlineCodeCommand, wrapInBlockquoteCommand, createCodeBlockCommand, insertHrCommand, liftListItemCommand,
} from '@milkdown/kit/preset/commonmark';
import { gfm, toggleStrikethroughCommand, insertTableCommand } from '@milkdown/kit/preset/gfm';
import { history, undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { undoDepth, redoDepth } from '@milkdown/kit/prose/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { $prose, $remark, callCommand, getMarkdown, replaceAll } from '@milkdown/kit/utils';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { lift } from '@milkdown/kit/prose/commands';
import { Fragment, Mark } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { locate } from '../src/core/anchor.js';
import { activeWorking } from '../src/core/ops.js';
import { MENTION_TOKEN } from '../src/core/mentions.js';
import { docRange, projectDoc, selectionSpan, textRange } from './pm-text.js';
import { createReplayer, diffBlocks } from './replay.js';

const FLASH_MS = 6000;
const highlightKey = new PluginKey('opendoc-highlights');
const flashKey = new PluginKey('opendoc-flash');
const linkKey = new PluginKey('opendoc-link');
const mentionKey = new PluginKey('opendoc-mentions');

// CommonMark does not close `**熟悉：**直接` (a run after full-width
// punctuation, before a CJK letter); this reads and writes it as bold, the
// same way the core projection (src/core/project.js) does.
const cjkFriendly = $remark('cjkFriendly', () => remarkCjkFriendly);

// Decorations replaced wholesale through a meta, mapped through other edits.
const decorationPlugin = (key) => $prose(() => new Plugin({
  key,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, set) => tr.getMeta(key) ?? set.map(tr.mapping, tr.doc),
  },
  props: { decorations: (state) => key.getState(state) },
}));

// The range a link is being written for while the link popover has focus:
// { from, to }, set and cleared through a meta, mapped through other edits,
// and shown as a selection would be.
const linkPlugin = $prose(() => new Plugin({
  key: linkKey,
  state: {
    init: () => null,
    apply(tr, range) {
      if (tr.getMeta(linkKey) !== undefined) return tr.getMeta(linkKey);
      if (!range) return null;
      const from = tr.mapping.map(range.from, 1);
      return { from, to: Math.max(from, tr.mapping.map(range.to, -1)) };
    },
  },
  props: {
    decorations(state) {
      const range = linkKey.getState(state);
      if (!range || range.from === range.to) return null;
      return DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: 'od-link-target' })]);
    },
  },
}));

// @name in the text, for someone who can be mentioned here: drawn as a chip
// that shows its name card on hover. The names come through a meta, as a Map
// of lower-cased name → { name, kind }; code is left alone.
const mentionPlugin = $prose(() => new Plugin({
  key: mentionKey,
  state: {
    init: () => ({ names: new Map(), set: DecorationSet.empty }),
    apply(tr, value, _old, state) {
      const names = tr.getMeta(mentionKey) ?? value.names;
      if (names === value.names && !tr.docChanged) return value;
      return { names, set: mentionDecorations(state.doc, names) };
    },
  },
  props: { decorations: (state) => mentionKey.getState(state).set },
}));

function mentionDecorations(doc, names) {
  if (names.size === 0) return DecorationSet.empty;
  const decorations = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code || !node.textContent.includes('@')) return false;
    // One character per position: code and inline nodes become blanks.
    let text = '';
    node.forEach((child) => {
      const code = child.isText && child.marks.some((m) => m.type.spec.code);
      text += child.isText && !code ? child.text : '\uFFFC'.repeat(child.nodeSize);
    });
    for (const match of text.matchAll(MENTION_TOKEN)) {
      let token = match[2];
      // Sentence punctuation after a name ("@claude.") is not part of it.
      while (!names.has(token.toLowerCase()) && token.endsWith('.')) token = token.slice(0, -1);
      const who = names.get(token.toLowerCase());
      if (!who) continue;
      const from = pos + 1 + match.index + match[1].length;
      decorations.push(Decoration.inline(from, from + 1 + token.length, {
        class: `od-at od-at-${who.kind}`, 'data-mention': who.name, 'data-mention-kind': who.kind,
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

// Reports every view update and lets the page take keys first (for the "/"
// menu), and marks the top-level block holding the caret (for focus mode).
const uiPlugin = (hooks) => $prose(() => new Plugin({
  view: () => ({ update: (view) => hooks.onUpdate(view) }),
  props: {
    handleKeyDown: (_view, event) => hooks.onKeyDown(event),
    handleDOMEvents: {
      focus: (view) => hooks.onUpdate(view),
      blur: (view) => hooks.onUpdate(view),
    },
    decorations(state) {
      const { $from } = state.selection;
      if ($from.depth === 0) return null;
      const top = $from.before(1);
      return DecorationSet.create(state.doc, [Decoration.node(top, top + $from.node(1).nodeSize, { class: 'od-current' })]);
    },
  },
}));

/**
 * @param {{ stage: HTMLElement, markdown: string,
 *           onChange: () => void, onSelectThread: (id: string) => void,
 *           onCommentRequest: (selection: { quote: string, prefix: string, suffix: string, start: number } | null) => void }} options
 */
// `editable: false` makes a read-only view, such as an earlier version of the doc.
export async function createDocEditor({ stage, markdown, onChange, onSelectThread, onCommentRequest, editable = true }) {
  // Markdown as last loaded or applied; an update that serializes to the same
  // text is an echo of that, not a local edit (markdownUpdated is debounced).
  let baseline = null;
  let onDocUpdated = () => {};
  const uiListeners = new Set();
  let keyHandler = () => false;
  const hooks = {
    onUpdate: () => { for (const fn of uiListeners) fn(); },
    onKeyDown: (event) => keyHandler(event),
  };
  const host = stage.querySelector('.od-editor');
  // While a replay runs, the doc passes through states that are neither the
  // human's nor on disk; edits are reported once it ends (onReplayEnd).
  let replayTarget = null;
  const replayer = createReplayer({ getView: () => view(), stage, onEnd: (done) => onReplayEnd(done) });
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
      if (!editable) ctx.update(editorViewOptionsCtx, (options) => ({ ...options, editable: () => false }));
      // Match common markdown style so edited blocks change as little as possible.
      ctx.update(remarkStringifyOptionsCtx, (options) => ({
        ...options, bullet: '-', emphasis: '*', strong: '*', rule: '-', fences: true, listItemIndent: 'one',
      }));
      ctx.get(listenerCtx)
        .markdownUpdated((_ctx, next) => {
          if (next !== baseline && !replayer.active()) onChange();
        })
        .updated(() => onDocUpdated());
    })
    .use(commonmark).use(gfm).use(cjkFriendly).use(history).use(clipboard).use(listener)
    .use(decorationPlugin(highlightKey)).use(decorationPlugin(flashKey)).use(linkPlugin).use(mentionPlugin).use(uiPlugin(hooks))
    .use($prose(() => replayer.plugin))
    .create();

  const view = () => editor.ctx.get(editorViewCtx);
  const parse = (md) => editor.ctx.get(parserCtx)(md);
  const serialize = (doc) => editor.ctx.get(serializerCtx)(doc);
  baseline = editor.action(getMarkdown());
  let threads = [];
  let activeId = null;
  let preview = { items: [], replay: 0 }; // see web/review.js; replay > 0 animates it once
  let replays = 0;
  let draft = null; // anchor-like hint of the selection being commented on
  const layoutListeners = new Set();

  function paintHighlights() {
    const v = view();
    const projection = projectDoc(v.state.doc);
    const decorations = [];
    const find = (anchor) => {
      const found = locate(projection.text, anchor);
      return found && docRange(projection, found.start, found.end);
    };
    const add = (anchor, id, classes) => {
      const range = find(anchor);
      if (range) decorations.push(Decoration.inline(range.from, range.to, { class: classes, 'data-thread': id }));
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
    // A proposal or a past edit shows as a suggestion: removed text struck
    // through, new text marked. Decorations only; the doc does not change. A
    // new `replay` number gives the marks new attributes, so ProseMirror
    // redraws them and their animation runs again.
    const { replay } = preview;
    const classes = (kind) => `od-mark-${kind}${replay ? ' od-replay' : ''}`;
    preview.items.forEach(({ anchor, mark, widget }, i) => {
      const range = find(anchor);
      if (!range) return;
      if (mark) decorations.push(Decoration.inline(range.from, range.to, { class: classes(mark), 'data-replay': String(replay) }));
      if (!widget) return;
      const before = widget.side === 'before';
      decorations.push(Decoration.widget(before ? range.from : range.to, () => el(widget.kind, classes(widget.kind), widget.text), {
        side: before ? -1 : 1, key: `change-${replay}-${i}-${widget.kind}-${widget.text}`,
      }));
    });
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
    const { from, to } = selectionSpan(v.state.selection);
    const range = textRange(projection, from, to);
    if (!range) return null;
    const { text } = projection;
    return {
      quote: text.slice(range.start, range.end),
      prefix: text.slice(Math.max(0, range.start - 32), range.start),
      suffix: text.slice(range.end, range.end + 32),
      start: range.start,
    };
  }

  // The top-level block holding the caret, as an anchor on the rendered text
  // ({ exact, prefix, suffix, start }); null when it has no text.
  function caretBlock() {
    const v = view();
    const { $from } = v.state.selection;
    if ($from.depth === 0) return null;
    const projection = projectDoc(v.state.doc);
    const range = textRange(projection, $from.before(1), $from.after(1));
    if (!range || range.start === range.end) return null;
    const { text } = projection;
    return {
      exact: text.slice(range.start, range.end),
      prefix: text.slice(Math.max(0, range.start - 32), range.start),
      suffix: text.slice(range.end, range.end + 32),
      start: range.start,
    };
  }

  // Comments are on selected text only.
  function requestComment() {
    const hint = view().state.selection.empty ? null : selectionHint();
    if (hint) onCommentRequest(hint);
  }

  // ---- formatting commands, shared by the toolbar, the selection bubble and "/" ----

  const listCommand = (type, wrap) => (state, dispatch) => {
    const list = ancestor(state, (node) => node.type.name === 'bullet_list' || node.type.name === 'ordered_list');
    if (!list) return editor.action(callCommand(wrap.key));
    if (list.node.type.name === type) return editor.action(callCommand(liftListItemCommand.key));
    dispatch(state.tr.setNodeMarkup(list.pos, state.schema.nodes[type]));
    return true;
  };
  const headingCommand = (level) => (state) => editor.action(blockType(state) === `h${level}`
    ? callCommand(turnIntoTextCommand.key)
    : callCommand(wrapInHeadingCommand.key, level));
  const commands = {
    undo: () => editor.action(callCommand(undoCommand.key)),
    redo: () => editor.action(callCommand(redoCommand.key)),
    paragraph: () => editor.action(callCommand(turnIntoTextCommand.key)),
    h1: headingCommand(1),
    h2: headingCommand(2),
    h3: headingCommand(3),
    bold: () => editor.action(callCommand(toggleStrongCommand.key)),
    italic: () => editor.action(callCommand(toggleEmphasisCommand.key)),
    strike: () => editor.action(callCommand(toggleStrikethroughCommand.key)),
    code: () => editor.action(callCommand(toggleInlineCodeCommand.key)),
    bullets: listCommand('bullet_list', wrapInBulletListCommand),
    numbers: listCommand('ordered_list', wrapInOrderedListCommand),
    quote: (state, dispatch) => (ancestor(state, (node) => node.type.name === 'blockquote')
      ? lift(state, dispatch)
      : editor.action(callCommand(wrapInBlockquoteCommand.key))),
    codeBlock: () => editor.action(callCommand(createCodeBlockCommand.key)),
    divider: () => editor.action(callCommand(insertHrCommand.key)),
    table: () => editor.action(callCommand(insertTableCommand.key, { row: 3, col: 3 })),
  };

  /** Run a named formatting command against the current selection. */
  function run(name) {
    const v = view();
    commands[name]?.(v.state, (tr) => v.dispatch(tr));
    v.focus();
  }

  /**
   * What the toolbar reflects: active marks, the block type and lists at the
   * caret, and whether there is anything to undo or redo.
   */
  function formatState() {
    const { state } = view();
    const active = new Set();
    for (const [name, mark] of [['bold', 'strong'], ['italic', 'emphasis'], ['strike', 'strike_through'], ['code', 'inlineCode'], ['link', 'link']]) {
      if (markActive(state, mark)) active.add(name);
    }
    const list = ancestor(state, (node) => node.type.name === 'bullet_list' || node.type.name === 'ordered_list');
    if (list) active.add(list.node.type.name === 'bullet_list' ? 'bullets' : 'numbers');
    if (ancestor(state, (node) => node.type.name === 'blockquote')) active.add('quote');
    const block = blockType(state);
    active.add(block);
    return { active, block, canUndo: undoDepth(state) > 0, canRedo: redoDepth(state) > 0 };
  }

  // ---- links, written in the link popover ----

  /**
   * Hold the link at the selection for the popover: the selection widened to
   * whole links at its ends, or the link around the caret. Returns its href,
   * or null for a new link.
   */
  function beginLink() {
    const v = view();
    const target = linkTarget(v.state);
    v.dispatch(v.state.tr.setMeta(linkKey, { from: target.from, to: target.to }).setMeta('addToHistory', false));
    return target.href;
  }

  /**
   * Finish the held link: `href` sets it, '' removes it, null cancels. A new
   * link at a bare caret inserts the URL as its text.
   */
  function endLink(href) {
    const v = view();
    const range = linkKey.getState(v.state);
    if (!range) return;
    const { state } = v;
    const type = state.schema.marks.link;
    const { from, to } = range;
    const tr = state.tr.setMeta(linkKey, null);
    const $from = state.doc.resolve(from);
    if (href === null || (href && from === to && !$from.parent.type.allowsMarkType(type))) {
      tr.setMeta('addToHistory', false); // cancelled, or a caret in a code block
    } else if (!href) {
      tr.removeMark(from, to, type);
    } else if (from === to) {
      const marks = type.create({ href }).addToSet(state.storedMarks ?? $from.marks());
      tr.insert(from, state.schema.text(href, marks));
      tr.setSelection(TextSelection.create(tr.doc, from + href.length));
    } else {
      tr.removeMark(from, to, type).addMark(from, to, type.create({ href }));
      tr.setSelection(TextSelection.create(tr.doc, to));
    }
    v.dispatch(tr.scrollIntoView());
    v.focus();
  }

  /** Viewport rectangle of the held link, or null when none is held. */
  function linkRect() {
    const v = view();
    const range = linkKey.getState(v.state);
    if (!range) return null;
    const start = v.coordsAtPos(range.from);
    const end = v.coordsAtPos(range.to);
    return { top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom), left: Math.min(start.left, end.left), right: Math.max(start.right, end.right) };
  }

  // ---- "/" menu: the query typed after a slash at the caret ----

  function slashQuery() {
    const v = view();
    const { selection } = v.state;
    if (!selection.empty || !v.hasFocus()) return null;
    const { $from } = selection;
    if ($from.parent.type.name === 'code_block' || !$from.parent.isTextblock) return null;
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
    const match = before.match(/(?:^|\s)\/([A-Za-z0-9]{0,20})$/);
    if (!match) return null;
    return { query: match[1], from: selection.from - match[1].length - 1, to: selection.from };
  }

  /** Remove the typed "/query", then run `name`. */
  function runSlash(range, name) {
    const v = view();
    v.dispatch(v.state.tr.delete(range.from, range.to));
    run(name);
  }

  // ---- outline and counts ----

  function headings() {
    const result = [];
    view().state.doc.forEach((node, pos) => {
      if (node.type.name === 'heading' && node.textContent.trim()) result.push({ level: node.attrs.level, text: node.textContent, pos });
    });
    return result;
  }

  function scrollToHeading(pos) {
    const v = view();
    const dom = v.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + 1)));
    v.focus();
  }

  function counts() {
    const { state } = view();
    const words = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
    const { empty } = state.selection;
    const { from, to } = selectionSpan(state.selection);
    return {
      words: words(state.doc.textBetween(0, state.doc.content.size, ' ', ' ')),
      selected: empty ? 0 : words(state.doc.textBetween(from, to, ' ', ' ')),
    };
  }

  /** Viewport rectangle of the selection, or null when there is none to point at. */
  function selectionRect() {
    const v = view();
    const { empty } = v.state.selection;
    const { from, to } = selectionSpan(v.state.selection);
    if (empty || !v.hasFocus()) return null;
    const start = v.coordsAtPos(from);
    const end = v.coordsAtPos(to);
    return { top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom), left: Math.min(start.left, end.left), right: Math.max(start.right, end.right), commentable: textRange(projectDoc(v.state.doc), from, to) !== null };
  }

  // ---- changes from disk ----

  /**
   * Show `next`, a change made by `by`. With `animate`, `by`'s caret types
   * the change in; otherwise only the top-level blocks that differ are
   * replaced and the new text glows, labelled `by`. A replay still running
   * from an earlier change is completed first.
   */
  function applyMarkdown(next, by, { animate = false } = {}) {
    replayer.finish();
    const v = view();
    const current = v.state.doc;
    const target = parse(next);
    if (animate) {
      replayTarget = next;
      if (replayer.start(target, by)) return;
      replayTarget = null;
    }
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

  // The replay is over: what it typed stays marked until the human looks at
  // the comments (clearReview), and typing that happened meanwhile is now
  // reported as the human's edit.
  function onReplayEnd({ ranges }) {
    baseline = serialize(parse(replayTarget));
    replayTarget = null;
    const decorations = ranges.map((r) => Decoration.inline(r.from, r.to, { class: 'od-review' }, { review: true }));
    if (decorations.length > 0) updateFlashes((set, doc) => set.add(doc, decorations));
    paintHighlights();
    if (editor.action(getMarkdown()) !== baseline) onChange();
  }

  function clearReview() {
    const set = flashKey.getState(view().state);
    const marked = set.find(undefined, undefined, (spec) => spec.review);
    if (marked.length > 0) updateFlashes((current) => current.remove(marked));
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
    /** Whether a change is being replayed; the doc is then between versions. */
    replaying: () => replayer.active(),
    /** Show the rest of a replay at once. */
    finishReplay: () => replayer.finish(),
    /** Resolves once no replay is running. */
    replayDone: () => replayer.done(),
    /** Remove the marks on text the agent typed. */
    clearReview,
    /**
     * The agent `name` started on comments: put its caret at the first
     * anchor of `anchors` that is found. Null takes the caret away.
     */
    agentLooking(name, anchors) {
      if (!name) {
        replayer.hide();
        return;
      }
      const projection = projectDoc(view().state.doc);
      for (const anchor of anchors) {
        const found = anchor && locate(projection.text, anchor);
        if (found) {
          replayer.look(docRange(projection, found.start, found.end).from, name);
          return;
        }
      }
    },
    /** The agent stopped working: its caret stays and fades. */
    agentResting: () => replayer.rest(),
    /** Replace the content without reporting it as a local edit. */
    setMarkdown(next) {
      replayer.finish();
      editor.action(replaceAll(next, true));
      baseline = editor.action(getMarkdown());
      paintHighlights();
    },
    setThreads(next) {
      threads = next;
      paintHighlights();
    },
    /** Who can be @mentioned: [{ name, kind }]. Their @names in the text show as chips. */
    setMentionNames(list) {
      const names = new Map(list.map((p) => [p.name.toLowerCase(), p]));
      const current = mentionKey.getState(view().state).names;
      if (names.size === current.size && [...names].every(([k, p]) => current.get(k)?.name === p.name && current.get(k)?.kind === p.kind)) return;
      view().dispatch(view().state.tr.setMeta(mentionKey, names).setMeta('addToHistory', false));
    },
    setActive(id) {
      activeId = id;
      paintHighlights();
    },
    /**
     * Show changes in the text (items from web/review.js); [] clears.
     * `replay` animates them once and scrolls the first into view.
     */
    setPreview(items, { replay = false } = {}) {
      preview = { items, replay: replay ? ++replays : 0 };
      paintHighlights();
      if (!replay || items.length === 0) return;
      const v = view();
      const found = locate(projectDoc(v.state.doc).text, items[0].anchor);
      if (!found) return;
      const { from } = docRange(projectDoc(v.state.doc), found.start, found.end);
      const { node } = v.domAtPos(from);
      (node.nodeType === 1 ? node : node.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    setDraft(hint) {
      draft = hint && { exact: hint.quote, prefix: hint.prefix, suffix: hint.suffix, start: hint.start };
      paintHighlights();
    },
    requestComment,
    caretBlock,
    run,
    formatState,
    slashQuery,
    runSlash,
    headings,
    scrollToHeading,
    counts,
    selectionRect,
    beginLink,
    endLink,
    linkRect,
    coordsAt: (pos) => view().coordsAtPos(pos),
    /** Called after every editor update: typing, selection, focus. */
    onUi(listener) {
      uiListeners.add(listener);
    },
    /** Sees editor keydowns first; return true to consume one. */
    setKeyHandler(handler) {
      keyHandler = handler;
    },
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

// The nearest ancestor of the selection start matching `test`: { node, pos }.
function ancestor(state, test) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (test(node)) return { node, pos: $from.before(depth) };
  }
  return null;
}

// The mark of type `name` at the caret or across the selection, or null.
function markActive(state, name) {
  const type = state.schema.marks[name];
  if (!type) return null;
  const { empty, $from } = state.selection;
  const { from, to } = selectionSpan(state.selection);
  if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) ?? null;
  let found = null;
  state.doc.nodesBetween(from, to, (node) => {
    found ??= type.isInSet(node.marks) ?? null;
  });
  return found;
}

// What the link popover edits: { from, to, href }. A selection grows to take
// in whole links at its ends; a caret takes the link around it, if any.
function linkTarget(state) {
  const type = state.schema.marks.link;
  const { from, to, empty } = state.selection;
  const head = linkAround(state.doc, from, type, empty ? 'both' : 'after');
  const tail = empty ? head : linkAround(state.doc, to, type, 'before');
  let mark = head?.mark ?? tail?.mark ?? null;
  if (!empty) {
    state.doc.nodesBetween(from, to, (node) => {
      mark ??= type.isInSet(node.marks) ?? null;
    });
  }
  return { from: Math.min(from, head?.from ?? from), to: Math.max(to, tail?.to ?? to), href: mark?.attrs.href ?? null };
}

// The run of text carrying one link that touches `pos` on `side`
// ('before', 'after' or 'both'): { from, to, mark }, or null.
function linkAround(doc, pos, type, side) {
  const $pos = doc.resolve(pos);
  const after = side !== 'before' && type.isInSet($pos.nodeAfter?.marks ?? []);
  const before = side !== 'after' && type.isInSet($pos.nodeBefore?.marks ?? []);
  const mark = after || before;
  if (!mark) return null;
  const { parent } = $pos;
  let at = $pos.start();
  let run = null;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (mark.isInSet(child.marks)) {
      run = run ? { ...run, to: at + child.nodeSize } : { from: at, to: at + child.nodeSize, mark };
    } else if (run && run.to >= pos) {
      break;
    } else {
      run = null;
    }
    at += child.nodeSize;
  }
  return run && run.from <= pos && pos <= run.to ? run : null;
}

// 'paragraph', 'h1'…'h6', 'code_block' or another node name, for the block at the caret.
function blockType(state) {
  const parent = state.selection.$from.parent;
  return parent.type.name === 'heading' ? `h${parent.attrs.level}` : parent.type.name;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
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
