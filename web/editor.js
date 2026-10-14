// The document pane: a Milkdown (ProseMirror) WYSIWYG editor with a minimal
// toolbar, comment highlights, and a floating "Comment" button on selections.

import { Editor, rootCtx, defaultValueCtx, editorViewCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import {
  commonmark, toggleStrongCommand, toggleEmphasisCommand, wrapInHeadingCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand, toggleLinkCommand, turnIntoTextCommand,
} from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { $prose, callCommand, getMarkdown, replaceAll } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { locate } from '../src/core/anchor.js';
import { docRange, projectDoc, textRange } from './pm-text.js';

const highlightKey = new PluginKey('opendoc-highlights');

const highlightPlugin = $prose(() => new Plugin({
  key: highlightKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, set) => tr.getMeta(highlightKey) ?? set.map(tr.mapping, tr.doc),
  },
  props: { decorations: (state) => highlightKey.getState(state) },
}));

/**
 * @param {HTMLElement} root
 * @param {{ markdown: string, onChange: (markdown: string) => void, onSelectThread: (id: string) => void,
 *           onCommentRequest: (selection: { quote: string, prefix: string, suffix: string, start: number }) => void }} options
 */
export async function createDocEditor(root, { markdown, onChange, onSelectThread, onCommentRequest }) {
  // Markdown as last loaded from disk; an update that serializes to the same
  // text is a reload echo, not a local edit (markdownUpdated is debounced).
  let baseline = null;
  let onDocUpdated = () => {};
  const host = root.querySelector('.od-editor');
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
          if (next !== baseline) onChange(next);
        })
        .updated(() => onDocUpdated());
    })
    .use(commonmark).use(gfm).use(history).use(clipboard).use(listener).use(highlightPlugin)
    .create();

  const view = () => editor.ctx.get(editorViewCtx);
  baseline = editor.action(getMarkdown());
  let threads = [];
  let activeId = null;

  function paintHighlights() {
    const v = view();
    const projection = projectDoc(v.state.doc);
    const decorations = [];
    for (const thread of threads) {
      if (!thread.anchor || thread.detached || thread.status !== 'open') continue;
      const found = locate(projection.text, thread.anchor);
      if (!found) continue;
      const { from, to } = docRange(projection, found.start, found.end);
      decorations.push(Decoration.inline(from, to, {
        class: thread.id === activeId ? 'od-hl od-hl-active' : 'od-hl',
        'data-thread': thread.id,
      }));
    }
    v.dispatch(v.state.tr.setMeta(highlightKey, DecorationSet.create(v.state.doc, decorations)));
  }

  // Re-place highlights shortly after typing stops; mapping keeps them close meanwhile.
  let repaintTimer;
  onDocUpdated = () => {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(paintHighlights, 300);
  };

  host.addEventListener('click', (event) => {
    const mark = event.target.closest?.('[data-thread]');
    if (mark) onSelectThread(mark.dataset.thread);
  });

  // Floating comment button for a non-empty selection.
  const button = root.querySelector('.od-comment-button');
  function placeButton() {
    const v = view();
    const { from, to, empty } = v.state.selection;
    if (empty || !v.hasFocus()) {
      button.hidden = true;
      return;
    }
    const coords = v.coordsAtPos(to);
    const box = root.getBoundingClientRect();
    button.style.top = `${coords.bottom - box.top + root.scrollTop + 6}px`;
    button.style.left = `${Math.min(coords.left - box.left, box.width - 120)}px`;
    button.hidden = textRange(projectDoc(v.state.doc), from, to) === null;
  }
  document.addEventListener('selectionchange', () => requestAnimationFrame(placeButton));
  host.addEventListener('blur', () => setTimeout(placeButton, 150), true);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    const v = view();
    const projection = projectDoc(v.state.doc);
    const range = textRange(projection, v.state.selection.from, v.state.selection.to);
    button.hidden = true;
    if (!range) return;
    const { text } = projection;
    onCommentRequest({
      quote: text.slice(range.start, range.end),
      prefix: text.slice(Math.max(0, range.start - 32), range.start),
      suffix: text.slice(range.end, range.end + 32),
      start: range.start,
    });
  });

  // Toolbar.
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
  root.querySelector('.od-toolbar').addEventListener('mousedown', (event) => {
    const name = event.target.closest('button')?.dataset.command;
    if (!name) return;
    event.preventDefault(); // keep the selection in the editor
    const command = commands[name]();
    if (command) editor.action(command);
    view().focus();
  });

  return {
    getMarkdown: () => editor.action(getMarkdown()),
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
      view().dom.querySelector(`[data-thread="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  };
}
