// A ```mermaid code block shows as its diagram, which only a buddy changes:
// ask one in a comment. The block keeps its source as text, so comments
// anchor to it, but the source is hidden and cannot be typed into; a click
// selects the whole block, to comment on or delete. Mermaid loads with the
// first diagram.

import { $prose, $view } from '@milkdown/kit/utils';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { NodeSelection, Plugin } from '@milkdown/kit/prose/state';

const isDiagram = (node) => node?.type.name === 'code_block' && node.attrs.language === 'mermaid';

let mermaid = null;
let renders = 0;
const shown = new Set(); // each diagram's redraw, run again when the theme changes

function dark() {
  const { theme } = document.documentElement.dataset;
  return theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

async function render(source) {
  mermaid ??= import('mermaid').then((module) => module.default);
  const m = await mermaid;
  m.initialize({ startOnLoad: false, theme: dark() ? 'dark' : 'default', suppressErrorRendering: true });
  return (await m.render(`pj-diagram-${++renders}`, source)).svg;
}

const redrawAll = () => { for (const draw of shown) draw(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawAll);
new MutationObserver(redrawAll).observe(document.documentElement, { attributeFilter: ['data-theme'] });

const diagramView = $view(codeBlockSchema.node, () => (node, _view, _getPos, _outer, inner) => {
  if (!isDiagram(node)) return null;
  const dom = document.createElement('div');
  dom.className = 'pj-diagram';
  let source = null;
  const draw = async () => {
    const text = source;
    try {
      const svg = await render(text);
      if (text === source) dom.innerHTML = svg;
    } catch (error) {
      if (text !== source) return;
      const code = document.createElement('pre');
      code.textContent = text;
      const message = document.createElement('p');
      message.className = 'pj-diagram-error';
      message.textContent = error.message;
      dom.replaceChildren(code, message);
    }
  };
  // Comment highlights on the hidden source mark the whole diagram.
  const highlight = (decorations) => {
    const comments = [];
    decorations.forEachSet((set) => comments.push(...set.find().filter((d) => d.spec.thread)));
    dom.classList.toggle('pj-hl', comments.length > 0);
    dom.classList.toggle('pj-hl-active', comments.some((d) => d.spec.active));
    if (comments.length > 0) dom.dataset.thread = comments[0].spec.thread;
    else delete dom.dataset.thread;
  };
  const update = (next, _outerNext, innerNext) => {
    if (!isDiagram(next)) return false;
    highlight(innerNext);
    if (next.textContent !== source) {
      source = next.textContent;
      draw();
    }
    return true;
  };
  update(node, null, inner);
  shown.add(draw);
  return { dom, update, destroy: () => shown.delete(draw), ignoreMutation: () => true };
});

// The caret never goes into a diagram: a click, or a selection that lands
// inside one, selects the whole block, and so does Backspace or Delete next
// to one, which would otherwise join text into its source.
const diagramSelection = $prose(() => new Plugin({
  props: {
    handleClickOn(view, _pos, node, nodePos) {
      if (!isDiagram(node)) return false;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
      return true;
    },
    handleKeyDown(view, event) {
      const { state } = view;
      const { $from, empty } = state.selection;
      if (!empty || $from.depth === 0) return false;
      let at = null;
      if (event.key === 'Backspace' && $from.parentOffset === 0) {
        const $cut = state.doc.resolve($from.before());
        if (isDiagram($cut.nodeBefore)) at = $cut.pos - $cut.nodeBefore.nodeSize;
      } else if (event.key === 'Delete' && $from.parentOffset === $from.parent.content.size) {
        const $cut = state.doc.resolve($from.after());
        if (isDiagram($cut.nodeAfter)) at = $cut.pos;
      }
      if (at === null) return false;
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)));
      return true;
    },
  },
  appendTransaction(_transactions, _old, state) {
    const { $from, $to } = state.selection;
    if ($from.parent !== $to.parent || !isDiagram($from.parent)) return null;
    return state.tr.setSelection(NodeSelection.create(state.doc, $from.before()));
  },
}));

export const diagrams = [diagramView, diagramSelection];
