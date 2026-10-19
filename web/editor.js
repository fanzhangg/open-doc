// The Markdown view: a Milkdown (ProseMirror) WYSIWYG editor that draws the
// page's marks (comments, a draft, a revision), with named formatting
// commands for the toolbar, selection bubble and "/" menu, and
// collaborator-style application of changes made on disk: only the blocks
// that differ are replaced (the caret stays put). A buddy's change is
// flagged with its name; any other change glows with who made it.
//
// The page talks to a view in offsets on the doc's text, the file's
// markdown (the view interface is what createMarkdownView returns first;
// test/views.test.js is its contract). Inside, marks are drawn on the
// rendered text of the editor's document (web/pm-text.js), which the
// markdown projection of the text (src/formats/markdown/project.js) matches
// character for character.

import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, serializerCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import {
  toggleStrongCommand, toggleEmphasisCommand, wrapInHeadingCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand, turnIntoTextCommand,
  toggleInlineCodeCommand, wrapInBlockquoteCommand, createCodeBlockCommand, insertHrCommand, liftListItemCommand,
  headingKeymap, listItemKeymap,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand, insertTableCommand } from '@milkdown/kit/preset/gfm';
import { history, undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { undoDepth, redoDepth } from '@milkdown/kit/prose/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { cursor } from '@milkdown/kit/plugin/cursor';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { $prose, $shortcut, callCommand } from '@milkdown/kit/utils';
import { lift } from '@milkdown/kit/prose/commands';
import { addRowAfter, goToNextCell, isInTable } from '@milkdown/kit/prose/tables';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { createAnchor, locate } from '../src/core/anchor.js';
import { project, renderedRange, sourceRange } from '../src/formats/markdown/project.js';
import { splice } from '../src/formats/markdown/splice.js';
import { docRange, projectDoc, selectionSpan, textRange } from './pm-text.js';
import { editItems } from './review.js';
import { markdownPlugins } from './markdown-schema.js';
import { diagrams } from './diagrams.js';
import { childPos, diffBlocks, replaceBlocks } from './blocks.js';
import { buddyColor } from './faces.js';

const FLASH_MS = 6000;
const highlightKey = new PluginKey('opendoc-highlights');
const flashKey = new PluginKey('opendoc-flash');
const linkKey = new PluginKey('opendoc-link');
const FROM_DISK = 'opendoc-from-disk'; // meta of a change applied from disk, not typed

// A ProseMirror doc never changes, so its projection is worked out once per
// doc, however often the marks, the margin ask.
const projections = new WeakMap();

function projectionOf(doc) {
  let projection = projections.get(doc);
  if (!projection) projections.set(doc, (projection = projectDoc(doc)));
  return projection;
}

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

// Tab in a table's last cell adds a row. Milkdown's Tab (priority 100) only
// moves to the next cell, and the key then left the table and broke it.
const tableTab = $shortcut(() => ({
  Tab: {
    key: 'Tab',
    priority: 90,
    onRun: () => (state, dispatch, view) => {
      if (!isInTable(state)) return false;
      if (dispatch) {
        addRowAfter(state, dispatch);
        goToNextCell(1)(view.state, dispatch);
      }
      return true;
    },
  },
}));

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
 * A mark is drawn over a range of the doc's text:
 * - { kind: 'comment', id, from, to, active }: commented text, `id` its
 *   thread's (or 'draft'); clicking it calls onMarkClick(id).
 * - { kind: 'edit', from, to, removed, by, replay }: part of a revision,
 *   [from, to) new text and `removed` the text it replaced, shown struck
 *   through before it; `by` shows it as that buddy's, and a new `replay`
 *   number (0: none) animates it once.
 *
 * @param {{ stage: HTMLElement, text: string, editable?: boolean, onChange?: () => void,
 *           onMarkClick?: (id: string) => void, onLayout?: () => void }} options
 */
// `editable: false` makes a read-only view, such as an earlier version of the doc;
// it shows diagrams as their source, so the changes in them can be seen.
export async function createMarkdownView({ stage, text, editable = true, onChange = () => {}, onMarkClick = () => {}, onLayout = () => {} }) {
  // The human changed the doc since `updated` last fired: any change not
  // applied from disk, even one that brings back the text as it was saved.
  // What plugins append (the empty line kept after a last table or code
  // block, which saves as nothing) follows from another change.
  let edited = false;
  const uiListeners = new Set();
  let keyHandler = () => false;
  const hooks = {
    onUpdate: () => { for (const fn of uiListeners) fn(); },
    onKeyDown: (event) => keyHandler(event),
  };
  const host = stage.querySelector('.od-editor');
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, text);
      if (!editable) ctx.update(editorViewOptionsCtx, (options) => ({ ...options, editable: () => false }));
      // Milkdown edits headings as if they were source: Backspace or Delete at
      // the start of one takes off a `#` (h3, h2, h1, text). Here Backspace
      // joins the line above and Delete deletes, as in any text; Delete at the
      // start of a list item deletes forward too.
      ctx.update(headingKeymap.key, (keys) => ({ ...keys, DowngradeHeading: { shortcuts: [] } }));
      ctx.update(listItemKeymap.key, (keys) => ({ ...keys, LiftFirstListItem: { shortcuts: 'Backspace' } }));
      // Match common markdown style so edited blocks change as little as possible.
      ctx.update(remarkStringifyOptionsCtx, (options) => ({
        ...options, bullet: '-', emphasis: '*', strong: '*', rule: '-', fences: true, listItemIndent: 'one',
      }));
      // `updated` is debounced (200 ms) and fires only when the doc changed.
      ctx.get(listenerCtx).updated(() => {
        if (edited) {
          edited = false;
          onChange();
        }
      });
    })
    .use(markdownPlugins).use(editable ? diagrams : []).use(history).use(clipboard).use(listener).use(cursor).use(trailing).use(tableTab)
    .use(decorationPlugin(highlightKey)).use(decorationPlugin(flashKey)).use(linkPlugin).use(uiPlugin(hooks))
    .use($prose(() => new Plugin({
      appendTransaction(trs) {
        if (trs.some((tr) => tr.docChanged && !tr.getMeta(FROM_DISK) && !tr.getMeta('appendedTransaction'))) edited = true;
        return null;
      },
    })))
    .create();

  const view = () => editor.ctx.get(editorViewCtx);
  // Parsing or serializing a long doc takes tens of milliseconds, and a sync
  // from disk or a save asks for the same ones more than once: each doc is
  // serialized once, and the last few parses are kept.
  const serialized = new WeakMap();
  let parsed = []; // [markdown, doc], newest first
  const parse = (md) => {
    const hit = parsed.find(([text]) => text === md);
    if (hit) return hit[1];
    const doc = editor.ctx.get(parserCtx)(md);
    parsed = [[md, doc], ...parsed].slice(0, 4);
    return doc;
  };
  const serialize = (doc) => {
    let md = serialized.get(doc);
    if (md === undefined) serialized.set(doc, (md = editor.ctx.get(serializerCtx)(doc)));
    return md;
  };
  // The doc's text as this view was last given it. Its text is that, with
  // each block the human changed in this editor's style and every other
  // block as it was; worked out once per doc, and projected once when asked.
  let given = text;
  const texts = new WeakMap(); // doc → { given, text, projection }
  const sourceOf = (doc) => {
    let source = texts.get(doc);
    if (source?.given !== given) {
      const ours = serialize(doc);
      texts.set(doc, (source = { given, text: ours === serialize(parse(given)) ? given : splice(given, ours), projection: null }));
    }
    return source;
  };
  const currentText = () => sourceOf(view().state.doc).text;
  const projected = (doc) => {
    const source = sourceOf(doc);
    return (source.projection ??= project(source.text));
  };

  // Rendered ranges of the doc's text and of the editor's document are the
  // same when the two rendered texts agree, as they should
  // (test/rendered-text.test.js); otherwise one is found in the other by its
  // words, or not at all.
  const across = (from, to, start, end) => (from.text === to.text
    ? { start, end }
    : locate(to.text, createAnchor(from.text, start, end)));

  /** The document range drawn from text range [from, to), or null when it draws nothing. */
  function docRangeOf(doc, from, to) {
    const projection = projected(doc);
    const rendered = renderedRange(projection, from, to);
    if (rendered.start === rendered.end) return null;
    const editorProjection = projectionOf(doc);
    const found = across(projection, editorProjection, rendered.start, rendered.end);
    return found && docRange(editorProjection, found.start, found.end);
  }

  /**
   * The document range of the character drawn at text offset `at`, or of the
   * last one when none is at or after it; null for a doc with no text.
   */
  function charAt(doc, at) {
    const projection = projected(doc);
    if (projection.text.length === 0) return null;
    const i = Math.min(renderedRange(projection, at, at).start, projection.text.length - 1);
    const editorProjection = projectionOf(doc);
    const found = across(projection, editorProjection, i, i + 1);
    return found && docRange(editorProjection, found.start, found.end);
  }

  /** Text offset of document position `pos`, or null when it is not in the text. */
  function offsetAt(doc, pos) {
    const editorProjection = projectionOf(doc);
    const { positions, text: rendered } = editorProjection;
    const projection = projected(doc);
    let i = positions.findIndex((p) => p >= pos);
    if (i === -1) i = rendered.length;
    if (rendered[i] === '\n' && positions[i + 1] === positions[i]) i++;
    // Before the character at `pos`, else after the one before it.
    const before = i < rendered.length && positions[i] === pos;
    const at = before ? i : i - 1;
    if (at < 0) return 0;
    const found = across(editorProjection, projection, at, at + 1);
    return found && projection.offsets[found.start] + (before ? 0 : 1);
  }

  let marks = [];
  // What was last painted, so a repaint that would draw the same is skipped.
  let paintedDoc = null;
  let painted = '';

  function paintMarks() {
    const v = view();
    const { doc } = v.state;
    const decorations = [];
    const drawn = [];
    for (const mark of marks) {
      if (mark.kind === 'comment') {
        const range = docRangeOf(doc, mark.from, mark.to);
        if (!range) continue;
        const classes = mark.active ? 'od-hl od-hl-active' : 'od-hl';
        decorations.push(Decoration.inline(range.from, range.to, { class: classes, 'data-thread': mark.id }, { thread: mark.id, active: mark.active }));
        drawn.push(range.from, range.to, mark.id, classes);
      }
    }
    // A revision shows as a suggestion: removed text struck through, new
    // text marked. Decorations only; the doc does not change. A new `replay`
    // number gives the marks new attributes, so ProseMirror redraws them and
    // their animation runs again. A buddy's (`by`) is in its colour, its
    // removed text grey.
    const edits = marks.filter((m) => m.kind === 'edit');
    const projection = edits.length > 0 ? projected(doc) : null;
    const editorProjection = projectionOf(doc);
    (projection ? editItems(projection.source, edits, projection) : []).forEach(({ anchor, mark, widget, by, replay }, i) => {
      const kindClass = (kind) => (by ? (kind === 'ins' ? 'od-buddy-edit' : 'od-buddy-del') : `od-mark-${kind}`);
      const classes = (kind) => `${kindClass(kind)}${replay ? ' od-replay' : ''}`;
      const style = by ? `--buddy: ${buddyColor(by)}` : '';
      const found = across(projection, editorProjection, anchor.start, anchor.start + anchor.exact.length);
      if (!found) return;
      const range = docRange(editorProjection, found.start, found.end);
      drawn.push(by, range.from, range.to, mark, replay);
      if (mark) decorations.push(Decoration.inline(range.from, range.to, { class: classes(mark), style, 'data-replay': String(replay) }));
      if (!widget) return;
      const before = widget.side === 'before';
      const key = `change-${replay}-${i}-${widget.kind}-${widget.text}`;
      decorations.push(Decoration.widget(before ? range.from : range.to, () => el(widget.kind, classes(widget.kind), widget.text), {
        side: before ? -1 : 1, key,
      }));
      drawn.push(key, widget.side);
    });
    const signature = JSON.stringify(drawn);
    if (doc === paintedDoc && signature === painted) return;
    paintedDoc = doc;
    painted = signature;
    v.dispatch(v.state.tr.setMeta(highlightKey, DecorationSet.create(doc, decorations)).setMeta('addToHistory', false));
    onLayout();
  }

  const clickMark = (event) => {
    const mark = event.target.closest?.('[data-thread]');
    if (mark) onMarkClick(mark.dataset.thread);
  };
  host.addEventListener('click', clickMark);

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
    for (const [name, mark] of [['bold', 'strong'], ['italic', 'emphasis'], ['strike', 'strike_through'], ['code', 'inlineCode']]) {
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
    return range ? rangeRect(v, range.from, range.to) : null;
  }

  /** The link at the caret while the editor has focus and nothing is selected: { href, rect }, or null. */
  function caretLink() {
    const v = view();
    const { state } = v;
    if (!v.hasFocus() || !state.selection.empty) return null;
    const run = linkAround(state.doc, state.selection.from, state.schema.marks.link, 'both');
    return run ? { href: run.mark.attrs.href, rect: rangeRect(v, run.from, run.to) } : null;
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

  /** Scroll to the heading a `#fragment` link names, as GitHub names it; false when there is none. */
  function scrollToAnchor(fragment) {
    const slug = (text) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const heading = headings().find((h) => slug(h.text) === decodeURIComponent(fragment).toLowerCase());
    if (heading) scrollToHeading(heading.pos);
    return Boolean(heading);
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
    return { top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom), left: Math.min(start.left, end.left), right: Math.max(start.right, end.right), commentable: textRange(projectionOf(v.state.doc), from, to) !== null };
  }

  // ---- changes from disk ----

  /**
   * Show `next`, outside the human's undo history: only the top-level blocks
   * that differ are replaced, flagged `by` for a while, if given; anything
   * but a buddy's change (`buddy`) also glows.
   */
  function applyText(next, { by = null, buddy = false } = {}) {
    given = next;
    const v = view();
    const current = v.state.doc;
    const target = parse(next);
    const hunks = diffBlocks(current, target);
    if (hunks.length === 0) return;
    v.dispatch(replaceBlocks(v.state.tr, current, target, hunks).setMeta('addToHistory', false).setMeta(FROM_DISK, true));
    if (by) flash(hunks.map((h) => changedRange(current, target, h)).filter(Boolean), by, buddy);
  }

  function flash(ranges, by, buddy) {
    if (ranges.length === 0) return;
    const flashId = Symbol('flash');
    const decorations = buddy ? [] : ranges.map((r) => (r.node
      ? Decoration.node(r.from, r.to, { class: 'od-flash-block' }, { flashId })
      : Decoration.inline(r.from, r.to, { class: 'od-flash' }, { flashId })));
    const first = ranges[0];
    decorations.push(Decoration.widget(first.node ? first.from + 1 : first.from, () => flag(by, buddy ? buddyColor(by) : null), { side: -1, flashId }));
    updateFlashes((set, doc) => set.add(doc, decorations));
    setTimeout(() => updateFlashes((set) => set.remove(set.find(undefined, undefined, (spec) => spec.flashId === flashId))), FLASH_MS);
  }

  function updateFlashes(change) {
    const v = view();
    const next = change(flashKey.getState(v.state), v.state.doc);
    v.dispatch(v.state.tr.setMeta(flashKey, next).setMeta('addToHistory', false));
  }

  return {
    // ---- the view interface: every view has these, in offsets on the doc's text ----

    /** The doc's text as saving would write it. */
    getText: currentText,
    applyText,
    /** Draw `marks` (see above) in place of the ones drawn. */
    setMarks(next) {
      marks = next;
      paintMarks();
    },
    /** The selection: { from, to }, or null when it is not in the text. */
    selection() {
      const { doc, selection } = view().state;
      const { from, to } = selectionSpan(selection);
      const rendered = textRange(projectionOf(doc), from, to);
      if (!rendered) {
        const at = offsetAt(doc, from);
        return at === null ? null : { from: at, to: at };
      }
      const projection = projected(doc);
      const found = across(projectionOf(doc), projection, rendered.start, rendered.end);
      if (!found) return null;
      const range = sourceRange(projection, found.start, found.end);
      return { from: range.start, to: range.end };
    },
    /** The viewport top of each text offset in `offsets`, or null where it is not drawn. */
    tops(offsets) {
      const v = view();
      return offsets.map((at) => {
        const range = charAt(v.state.doc, at);
        return range && v.coordsAtPos(range.from).top;
      });
    },
    /** Scroll text offset `at` into the middle of the view. */
    scrollTo(at) {
      const v = view();
      const range = charAt(v.state.doc, at);
      if (!range) return;
      const { node } = v.domAtPos(range.from);
      (node.nodeType === 1 ? node : node.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    focus: () => view().focus(),
    destroy() {
      host.removeEventListener('click', clickMark);
      return editor.destroy();
    },

    // ---- the Markdown view's own, for the toolbar, the "/" menu and the outline ----

    /** Which top-level block holds the caret (its index), or null when the editor has no focus. */
    caretIndex() {
      const v = view();
      if (!v.hasFocus()) return null;
      const { $from } = v.state.selection;
      return $from.depth === 0 ? -1 : $from.index(0);
    },
    run,
    formatState,
    slashQuery,
    runSlash,
    headings,
    scrollToHeading,
    scrollToAnchor,
    counts,
    selectionRect,
    beginLink,
    endLink,
    linkRect,
    caretLink,
    coordsAt: (pos) => view().coordsAtPos(pos),
    /** Called after every editor update: typing, selection, focus. */
    onUi(listener) {
      uiListeners.add(listener);
    },
    /** Sees editor keydowns first; return true to consume one. */
    setKeyHandler(handler) {
      keyHandler = handler;
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

function rangeRect(view, from, to) {
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);
  return { top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom), left: Math.min(start.left, end.left), right: Math.max(start.right, end.right) };
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

// Who made a change, over its start; in a buddy's colour (`color`) for a buddy.
function flag(name, color = null) {
  const wrap = document.createElement('span');
  wrap.className = 'od-flag';
  if (color) wrap.style.cssText = `--buddy: ${color}; --buddy-ink: #1f1d24`;
  const label = document.createElement('span');
  label.className = 'od-flag-label';
  label.textContent = name;
  wrap.append(label);
  return wrap;
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
