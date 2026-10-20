// What the plain view draws over a text's whitespace, faintly (app.css):
// dots for spaces and arrows for tabs, and a line at each indent level.

import { Decoration, ViewPlugin } from '@codemirror/view';

const space = Decoration.mark({ class: 'od-ws-space' });
const tab = Decoration.mark({ class: 'od-ws-tab' });
const guides = Decoration.mark({ class: 'od-guides' });

// The ranges of the visible text a plugin looks at, as [from, to] pairs.
const visible = (view, onlySelection) => {
  const ranges = onlySelection ? view.state.selection.ranges.filter((range) => !range.empty) : [{ from: 0, to: view.state.doc.length }];
  return view.visibleRanges.flatMap((shown) => ranges
    .map((range) => [Math.max(range.from, shown.from), Math.min(range.to, shown.to)])
    .filter(([from, to]) => from < to));
};

/** Whitespace marks over `mode`: 'all' the visible text, or 'selection' the selected part of it. */
export const whitespaceMarks = (mode) => ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.build(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) this.decorations = this.build(update.view);
  }

  build(view) {
    const ranges = [];
    for (const [from, to] of visible(view, mode === 'selection')) {
      for (const run of view.state.sliceDoc(from, to).matchAll(/ +|\t/g)) {
        const start = from + run.index;
        ranges.push((run[0] === '\t' ? tab : space).range(start, start + run[0].length));
      }
    }
    return Decoration.set(ranges);
  }
}, { decorations: (plugin) => plugin.decorations });

/** A guide at each indent step (CSS `--indent`, in characters) over the leading whitespace of every visible line. */
export const indentGuides = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.build(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
  }

  build(view) {
    const ranges = [];
    for (const [from, to] of visible(view, false)) {
      for (let at = from; at <= to;) {
        const line = view.state.doc.lineAt(at);
        const lead = /^[ \t]+/.exec(line.text);
        if (lead) ranges.push(guides.range(line.from, line.from + lead[0].length));
        at = line.to + 1;
      }
    }
    return Decoration.set(ranges);
  }
}, { decorations: (plugin) => plugin.decorations });
