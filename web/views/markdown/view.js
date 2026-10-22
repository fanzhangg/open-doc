// The Markdown view: a Milkdown (ProseMirror) WYSIWYG editor that draws the
// page's marks (comments, a draft, a revision), with its own chrome (a
// toolbar, comment bubble, link popover and outline, see
// chrome.js), and collaborator-style application of changes made
// on disk: only the blocks that differ are replaced (the caret stays put).
// A buddy's change is flagged with its name; any other change glows with
// who made it.
//
// The page talks to a view in offsets on the doc's text, the file's
// markdown (the view interface is what createMarkdownView returns first;
// test/views.test.js is its contract). Inside, marks are drawn on the
// rendered text of the editor's document (web/pm-text.js), which the
// markdown projection of the text (src/markdown/project.js) matches
// character for character.

import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, serializerCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import {
  toggleStrongCommand, toggleEmphasisCommand, wrapInHeadingCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand, turnIntoTextCommand,
  toggleInlineCodeCommand, wrapInBlockquoteCommand, createCodeBlockCommand, insertHrCommand, liftListItemCommand,
  listItemKeymap,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand, insertTableCommand, remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import { history, undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { undoDepth, redoDepth } from '@milkdown/kit/prose/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { cursor } from '@milkdown/kit/plugin/cursor';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { $prose, $shortcut, callCommand } from '@milkdown/kit/utils';
import { lift } from '@milkdown/kit/prose/commands';
import { keymap } from '@milkdown/kit/prose/keymap';
import { addRowAfter, goToNextCell, isInTable } from '@milkdown/kit/prose/tables';
import { Fragment } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { createAnchor, locate } from '../../../src/core/anchor.js';
import { definesLinks, project, projectBlocks, renderedRange, sourceRange } from '../../../src/markdown/project.js';
import { splice } from '../../../src/markdown/splice.js';
import { docRange, projectDoc, selectionSpan, textRange } from '../../pm-text.js';
import { editItems } from '../../review.js';
import { markdownPlugins } from '../../markdown-schema.js';
import { diagrams } from '../../diagrams.js';
import { blocksOf, childPos, diffBlocks, pairRanges, parseRun, replaceBlocks, textOfDoc, textPos } from './blocks.js';
import { buddyColor } from '../../faces.js';
import { cursorNode } from '../../marks.js';
import { createChrome } from './chrome.js';
import { createFind, matches } from '../../find.js';

const FLASH_MS = 6000;
const highlightKey = new PluginKey('ponjo-highlights');
const flashKey = new PluginKey('ponjo-flash');
const linkKey = new PluginKey('ponjo-link');
const foundKey = new PluginKey('ponjo-found');
const bidiKey = new PluginKey('ponjo-bidi');
const FROM_DISK = 'ponjo-from-disk'; // meta of a change applied from disk, not typed

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
      return DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: 'pj-link-target' })]);
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

// Pasting a single URL over selected text links the text to it, as Docs and
// Notion do. Plain text goes in as the text it is, a paragraph a line, as
// typed text does (Markdown in it stays text); formatted text (HTML) is the
// clipboard plugin's, but for images held in the page itself (`data:`,
// `blob:`), whose bytes would land in the doc.
const paste = $prose(() => new Plugin({
  props: {
    handlePaste(view, event, slice) {
      const data = event.clipboardData;
      const url = data?.getData('text/plain').trim();
      const { selection: { empty, from, to, $from }, schema, tr } = view.state;
      const type = schema.marks.link;
      if (!empty && /^(https?:\/\/|mailto:)\S+$/i.test(url) && $from.parent.type.allowsMarkType(type)) {
        view.dispatch(tr.removeMark(from, to, type).addMark(from, to, type.create({ href: url })));
        return true;
      }
      // ProseMirror's own slice of plain text: its lines as paragraphs, or as they are in code.
      if (!data || data.types.includes('text/html') || data.types.includes('vscode-editor-data')) return false;
      view.dispatch(tr.replaceSelection(slice).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
      return true;
    },
    transformPastedHTML(html) {
      const template = document.createElement('template');
      template.innerHTML = html;
      for (const image of template.content.querySelectorAll('img')) {
        if (/^\s*(data|blob):/i.test(image.getAttribute('src') ?? '')) image.remove();
      }
      return template.innerHTML;
    },
  },
}));

// Clicking a task list item's box (app.css draws it in the item's gutter,
// left of the item) ticks or unticks it.
const taskBox = $prose(() => new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const item = event.target;
        if (!view.editable || item.dataset?.itemType !== 'task' || event.clientX >= item.getBoundingClientRect().left) return false;
        const pos = view.posAtDOM(item, 0) - 1;
        const node = view.state.doc.nodeAt(pos);
        event.preventDefault();
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
        return true;
      },
    },
  },
}));

// A block holding right-to-left letters (Hebrew, Arabic…) runs the way its
// text starts, as do the blocks in it: dir="auto". Each top-level block is
// looked at once.
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const directions = new WeakMap(); // a top-level node → the [from, to) of its blocks to mark, from its start
const bidiPlugin = $prose(() => new Plugin({
  key: bidiKey,
  state: {
    init: (_config, { doc }) => bidiOf(doc),
    apply: (tr, set) => (tr.docChanged ? bidiOf(tr.doc) : set),
  },
  props: { decorations: (state) => bidiKey.getState(state) },
}));

function bidiOf(doc) {
  const decorations = [];
  doc.forEach((node, offset) => {
    let own = directions.get(node);
    if (!own) {
      own = [];
      if (RTL.test(node.textContent)) {
        own.push([0, node.nodeSize]);
        node.descendants((child, pos) => {
          if (child.isBlock) own.push([pos + 1, pos + 1 + child.nodeSize]);
        });
      }
      directions.set(node, own);
    }
    for (const [from, to] of own) decorations.push(Decoration.node(offset + from, offset + to, { dir: 'auto' }));
  });
  return DecorationSet.create(doc, decorations);
}

// Reports every view update, and marks the top-level block holding the caret
// (for focus mode).
const uiPlugin = (hooks) => $prose(() => new Plugin({
  view: () => ({ update: (view) => hooks.onUpdate(view) }),
  props: {
    handleDOMEvents: {
      focus: (view) => hooks.onUpdate(view),
      blur: (view) => hooks.onUpdate(view),
    },
    decorations(state) {
      const { $from } = state.selection;
      if ($from.depth === 0) return null;
      const top = $from.before(1);
      return DecorationSet.create(state.doc, [Decoration.node(top, top + $from.node(1).nodeSize, { class: 'pj-current' })]);
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
 * - { kind: 'cursor', at, by, working }: buddy `by`'s cursor after the
 *   character before text offset `at`; `working` shows its name.
 *
 * @param {{ stage: HTMLElement, text: string, editable?: boolean, onChange?: () => void, onEdit?: () => void,
 *           onMarkClick?: (id: string) => void, onLayout?: () => void,
 *           toolbar?: HTMLElement, onComment?: () => void,
 *           settings?: object, saveSettings?: (patch: object) => void }} options
 */
// `onChange` fires once the person pauses after changing the doc, `onEdit`
// on each change they make.
// `editable: false` makes a read-only view, such as an earlier version of the doc;
// it shows diagrams as their source, so the changes in them can be seen, and
// its chrome has no formatting tools or Comment bubble.
// Given a `toolbar`, the view puts its tools there and the rest of its chrome
// around `stage`; its bubble's Comment button calls `onComment`. The chrome
// follows the view's `settings` (web/views/markdown/index.js) and changes
// them through `saveSettings` (the focus mode shortcut).
export async function createMarkdownView({
  stage, text, editable = true, onChange = () => {}, onEdit = () => {}, onMarkClick = () => {}, onLayout = () => {}, toolbar = null, onComment = () => {},
  settings = null, saveSettings = () => {},
}) {
  // The human changed the doc since `updated` last fired: any change not
  // applied from disk, even one that brings back the text as it was saved.
  // What Milkdown plugins append (the empty line kept after a last table or code
  // block, which saves as nothing) follows from another change.
  let edited = false;
  let editing = false; // the same, since onEdit last fired
  let chrome = null;
  let finder = null;
  let foundIn = null; // the doc the find bar's matches were found in, while it has a query
  let refind = 0;
  const hooks = {
    onUpdate: (v) => {
      chrome?.update();
      if (foundIn && v.state.doc !== foundIn) {
        clearTimeout(refind);
        refind = setTimeout(() => finder.changed(), 100); // not while the view updates, nor on every key
      }
    },
  };
  const host = stage.querySelector('.pj-editor');
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, text);
      if (!editable) ctx.update(editorViewOptionsCtx, (options) => ({ ...options, editable: () => false }));
      // Delete at the start of a list item deletes forward, as in any text.
      ctx.update(listItemKeymap.key, (keys) => ({ ...keys, LiftFirstListItem: { shortcuts: 'Backspace' } }));
      // Match common markdown style so edited blocks change as little as possible.
      ctx.update(remarkStringifyOptionsCtx, (options) => ({
        ...options, bullet: '-', emphasis: '*', strong: '*', rule: '-', fences: true, listItemIndent: 'one',
      }));
      // A table row is written as its own cells say, not padded to line up
      // with the others: an edit in one cell then changes only its row, and
      // two people typing in one table do not both re-pad it.
      ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
      // `updated` is debounced (200 ms) and fires only when the doc changed.
      ctx.get(listenerCtx).updated(() => {
        if (edited) {
          edited = false;
          onChange();
        }
      });
    })
    .use(markdownPlugins).use(editable ? diagrams : []).use(history).use(paste).use(clipboard).use(listener).use(cursor).use(trailing).use(tableTab).use(taskBox)
    .use(decorationPlugin(highlightKey)).use(decorationPlugin(flashKey)).use(decorationPlugin(foundKey)).use(linkPlugin).use(bidiPlugin).use(uiPlugin(hooks))
    // The standard keys format as the toolbar does; typed Markdown still stays text.
    .use($prose(() => keymap({
      'Mod-b': () => run('bold'),
      'Mod-i': () => run('italic'),
      'Mod-e': () => run('code'),
      'Mod-Shift-x': () => run('strike'),
      'Mod-k': () => Boolean(chrome?.link()),
    })))
    .use($prose(() => new Plugin({
      appendTransaction(trs) {
        if (trs.some((tr) => tr.docChanged && !tr.getMeta(FROM_DISK) && !tr.getMeta('appendedTransaction'))) edited = editing = true;
        return null;
      },
      // Once the change is in the editor's state, getText reads it.
      view: () => ({
        update(v) {
          if (!editing || v.composing) return; // typing in an IME composition is the person's once it ends
          editing = false;
          onEdit();
        },
      }),
      props: {
        handleDOMEvents: {
          compositionend: (v) => {
            setTimeout(() => {
              if (!editing || v.composing) return;
              editing = false;
              onEdit();
            });
          },
        },
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
  // The doc's text as this view was last given it, and the document it was
  // given to (`base`). A document's text is that, with each block the human
  // changed in this editor's style and every other block as it was; worked
  // out once per doc, and projected once when asked. While each top-level
  // block of `given` pairs with a child of `base` (`base.blocks`, their
  // ranges; worked out when first asked, null when they do not pair up), a
  // change in or out is worked out only where it is (blocks.js), so a
  // long doc others write in stays quick; otherwise it is worked out whole.
  let given = text;
  let base = { doc: view().state.doc, blocks: undefined };
  const baseBlocks = () => {
    if (base.blocks === undefined) base.blocks = blocksOf(base.doc, given);
    return base.blocks;
  };
  const serializeNodes = (nodes) => editor.ctx.get(serializerCtx)(base.doc.type.create(null, nodes));
  // { text, blocks }: the doc's text for `doc`, and its children's ranges in it, or null.
  const textOf = (doc) => {
    const blocks = baseBlocks();
    if (doc === base.doc) return { text: given, blocks };
    const found = blocks && textOfDoc(doc, base.doc, given, blocks, serializeNodes, parse);
    if (found) return found;
    const ours = serialize(doc);
    return { text: ours === serialize(parse(given)) ? given : splice(given, ours), blocks: null };
  };
  const texts = new WeakMap(); // doc → { given, text, blocks, projection }
  const sourceOf = (doc) => {
    let source = texts.get(doc);
    if (source?.given !== given) texts.set(doc, (source = { given, ...textOf(doc), projection: null }));
    return source;
  };
  const currentText = () => sourceOf(view().state.doc).text;
  const projectionCache = new Map(); // a block's text → its rendered lines
  // A doc that may define links is projected whole: a block's links read by definitions elsewhere.
  const projected = (doc) => {
    const source = sourceOf(doc);
    return (source.projection ??= source.blocks && !definesLinks(source.text) ? projectBlocks(source.text, source.blocks, projectionCache) : project(source.text));
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

  /**
   * The document position of a caret at text offset `at`: after the
   * character drawn before it or, when markup is before it (`# `, `**`),
   * before the one drawn after it; null for a doc with no text.
   */
  function caretAt(doc, at) {
    const projection = projected(doc);
    const last = projection.text.length - 1;
    if (last < 0) return null;
    // One pass over the text: the character drawn before `at`, else the one after it, else the last.
    const { start, end } = renderedRange(projection, at - 1, at);
    const i = Math.min(start, last);
    const editorProjection = projectionOf(doc);
    const found = across(projection, editorProjection, i, i + 1);
    if (!found) return null;
    const range = docRange(editorProjection, found.start, found.end);
    return start < end || start > last ? range.to : range.from;
  }

  /** Text offset of document position `pos`, or null when it is not in the text. */
  function offsetAt(doc, pos) {
    const editorProjection = projectionOf(doc);
    const { positions, text: rendered } = editorProjection;
    const projection = projected(doc);
    let i = positions.findIndex((p) => p >= pos);
    if (i === -1) i = rendered.length;
    const last = i - 1; // the character before `pos`, never the line break after it
    if (rendered[i] === '\n' && positions[i + 1] === positions[i]) i++;
    // Before the character at `pos`, else after the one before it.
    const before = i < rendered.length && positions[i] === pos;
    const at = before ? i : last;
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
        const classes = mark.active ? 'pj-hl pj-hl-active' : 'pj-hl';
        decorations.push(Decoration.inline(range.from, range.to, { class: classes, 'data-thread': mark.id }, { thread: mark.id, active: mark.active }));
        drawn.push(range.from, range.to, mark.id, classes);
      }
    }
    for (const mark of marks) {
      const pos = mark.kind === 'cursor' ? caretAt(doc, mark.at) : null;
      if (pos === null) continue;
      decorations.push(Decoration.widget(pos, () => cursorNode(mark), { side: 1, key: `cursor-${mark.by}-${mark.working}` }));
      drawn.push('cursor', mark.by, pos, mark.working);
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
      const kindClass = (kind) => (by ? (kind === 'ins' ? 'pj-buddy-edit' : 'pj-buddy-del') : `pj-mark-${kind}`);
      const classes = (kind) => `${kindClass(kind)}${replay ? ' pj-replay' : ''}`;
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

  // ---- formatting commands, run from the toolbar ----

  const listCommand = (type, wrap) => (state, dispatch) => {
    const list = ancestor(state, (node) => node.type.name === 'bullet_list' || node.type.name === 'ordered_list');
    if (!list) return editor.action(callCommand(wrap.key));
    if (list.node.type.name === type) return editor.action(callCommand(liftListItemCommand.key));
    // The items say which kind of list they are in, too: Milkdown turns a
    // bulleted list whose items still say ordered back into a numbered one.
    const tr = state.tr.setNodeMarkup(list.pos, state.schema.nodes[type], { spread: list.node.attrs.spread });
    const listType = type === 'bullet_list' ? 'bullet' : 'ordered';
    list.node.forEach((item, offset) => tr.setNodeMarkup(list.pos + 1 + offset, null, { ...item.attrs, listType }));
    dispatch(tr);
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

  /** Run a named formatting command against the current selection; true, as a key's command. */
  function run(name) {
    const v = view();
    // Front matter is source: nothing formats it.
    if (editable && (name === 'undo' || name === 'redo' || blockType(v.state) !== 'front_matter')) commands[name]?.(v.state, (tr) => v.dispatch(tr));
    v.focus();
    return true;
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

  // ---- outline ----

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
    const v = view();
    const current = v.state.doc;
    // Only the blocks that differ from the text now are parsed, when that is known.
    const source = sourceOf(current);
    const run = source.blocks && parseRun(current, source.text, source.blocks, next, parse);
    let target;
    let hunks;
    if (run) {
      const kept = current.content.content;
      target = current.copy(Fragment.from([...kept.slice(0, run.from), ...run.nodes, ...kept.slice(run.to)]));
      hunks = diffBlocks(Fragment.from(kept.slice(run.from, run.to)), Fragment.from(run.nodes))
        .map((h) => ({ a0: h.a0 + run.from, a1: h.a1 + run.from, b0: h.b0 + run.from, b1: h.b1 + run.from }));
    } else {
      target = parse(next);
      hunks = diffBlocks(current, target);
    }
    const blocks = run ? run.blocks : undefined;
    given = next;
    if (hunks.length === 0) {
      base = { doc: current, blocks };
      return;
    }
    const tr = replaceBlocks(v.state.tr, current, target, hunks).setMeta('addToHistory', false).setMeta(FROM_DISK, true);
    base = { doc: tr.doc, blocks };
    if (by) flash(tr, hunks.map((h) => changedRange(current, target, h)).filter(Boolean), by, buddy);
    v.dispatch(tr);
    // What the editor makes of it on its own (a table's half-typed row
    // filled out, an empty line kept after a last table) is still `next`:
    // it is no one's edit.
    if (v.state.doc !== tr.doc) {
      const paired = blocks && pairRanges(v.state.doc.content.content, blocks, true);
      if (paired || !blocks) base = { doc: v.state.doc, blocks: paired ?? undefined };
    }
  }

  // Glow `ranges` of the doc `tr` makes, in the same transaction, so the page is drawn once.
  function flash(tr, ranges, by, buddy) {
    if (ranges.length === 0) return;
    const flashId = Symbol('flash');
    const decorations = buddy ? [] : ranges.map((r) => (r.node
      ? Decoration.node(r.from, r.to, { class: 'pj-flash-block' }, { flashId })
      : Decoration.inline(r.from, r.to, { class: 'pj-flash' }, { flashId })));
    // The flag at the start of the word the change begins in.
    const first = ranges[0];
    const $at = tr.doc.resolve(first.from);
    const at = first.node ? first.from + 1 : first.from - ($at.parent.textBetween(0, $at.parentOffset).match(/[\p{L}\p{N}_]*$/u)?.[0].length ?? 0);
    decorations.push(Decoration.widget(at, () => flag(by, buddy ? buddyColor(by) : null), { side: -1, flashId }));
    tr.setMeta(flashKey, flashKey.getState(view().state).map(tr.mapping, tr.doc).add(tr.doc, decorations));
    setTimeout(() => updateFlashes((set) => set.remove(set.find(undefined, undefined, (spec) => spec.flashId === flashId))), FLASH_MS);
  }

  function updateFlashes(change) {
    const v = view();
    v.dispatch(v.state.tr.setMeta(flashKey, change(flashKey.getState(v.state))).setMeta('addToHistory', false));
  }

  // The selection: { from, to }, or null when it is not in the text.
  function selection() {
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
  }

  // ---- find (web/find.js): in what a reader sees ----

  let found = []; // the document ranges of the matches, in `foundIn`
  let query = '';

  // { count, current }: how many matches, and which is selected (from 1; 0: none).
  function foundState() {
    const { from, to } = view().state.selection;
    return { count: found.length, current: found.findIndex((r) => r.from === from && r.to === to) + 1 };
  }

  function paintFound() {
    const v = view();
    const { current } = foundState();
    const decorations = found.map((r, i) => Decoration.inline(r.from, r.to, { class: i + 1 === current ? 'pj-found pj-found-current' : 'pj-found' }));
    v.dispatch(v.state.tr.setMeta(foundKey, DecorationSet.create(v.state.doc, decorations)).setMeta('addToHistory', false));
  }

  const search = {
    find(next) {
      query = next;
      const { doc } = view().state;
      const projection = projectionOf(doc);
      // Not in raw HTML, whose characters share the one position of its atom,
      // nor in a diagram's hidden source.
      found = matches(projection.text, query)
        .filter(([start, end]) => projection.positions.subarray(start, end).every((p, i, all) => i === 0 || p > all[i - 1]))
        .map(([start, end]) => docRange(projection, start, end))
        .filter(({ from }) => !(editable && doc.resolve(from).parent.attrs.language === 'mermaid'));
      foundIn = query ? doc : null;
      paintFound();
      return foundState();
    },
    step(back) {
      if (found.length === 0) return foundState();
      const v = view();
      const { from, to } = v.state.selection;
      const same = (r) => r.from === from && r.to === to;
      const i = back ? found.findLastIndex((r) => r.to <= from && !same(r)) : found.findIndex((r) => r.from >= to && !same(r));
      const next = found.at(i === -1 ? (back ? -1 : 0) : i);
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, next.from, next.to)));
      // Into view when it is not, below the find bar.
      const canvas = stage.parentElement;
      const box = canvas.getBoundingClientRect();
      const { top, bottom } = v.coordsAtPos(next.from);
      if (top < box.top + 80 || bottom > box.bottom - 16) canvas.scrollTop += top - (box.top + box.height / 2);
      paintFound();
      return foundState();
    },
    replace(text, all) {
      const v = view();
      const { from, to } = v.state.selection;
      const targets = all ? found : found.filter((r) => r.from === from && r.to === to);
      if (!editable || targets.length === 0) return search.step(false);
      const tr = v.state.tr;
      for (const r of [...targets].reverse()) tr.insertText(text, r.from, r.to);
      v.dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(targets.at(-1).to))));
      search.find(query);
      return all ? foundState() : search.step(false);
    },
    selected: () => {
      const { state } = view();
      return state.doc.textBetween(state.selection.from, state.selection.to, '\n');
    },
    focus: () => view().focus(),
  };
  finder = createFind(search, { host, editable });

  if (toolbar) {
    chrome = createChrome({
      run, formatState, getText: currentText, selection, headings, scrollToHeading, scrollToAnchor,
      selectionRect, beginLink, endLink, linkRect, caretLink,
    }, { toolbar, stage, host, onComment, settings, saveSettings, editable });
  }

  return {
    // ---- the view interface: every view has these, in offsets on the doc's text ----

    /** The doc's text as saving would write it. */
    getText: currentText,
    applyText,
    /** Whether an IME composition is on: its text is not the person's yet. */
    composing: () => view().composing,
    /** Draw `marks` (see above) in place of the ones drawn. */
    setMarks(next) {
      marks = next;
      paintMarks();
    },
    /** The selection: { from, to }, or null when it is not in the text. */
    selection,
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
    /** Undo or redo the human's last edit, in this view's own history. */
    undo: () => run('undo'),
    redo: () => run('redo'),
    destroy() {
      chrome?.destroy();
      finder.destroy();
      clearTimeout(refind);
      host.removeEventListener('click', clickMark);
      return editor.destroy();
    },

    // ---- the view interface ----

    /** The view's settings changed. */
    applySettings: (next) => chrome?.applySettings(next),
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
  wrap.className = 'pj-flag';
  if (color) wrap.style.cssText = `--buddy: ${color}; --buddy-ink: #1f1d24`;
  const label = document.createElement('span');
  label.className = 'pj-flag-label';
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
