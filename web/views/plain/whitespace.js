// What the plain view draws over a text's whitespace, faintly (app.css):
// dots for spaces and arrows for tabs, and a line at each indent level.

import { Decoration, ViewPlugin } from '@codemirror/view';

const space = Decoration.mark({ class: 'pj-ws-space' });
const tab = Decoration.mark({ class: 'pj-ws-tab' });
const guides = Decoration.mark({ class: 'pj-guides' });

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

// The width in characters of a line's leading whitespace, a tab being 4 (as in app.css), or null for a blank line.
const indentWidth = (text) => (text.trim() === '' ? null : [...(/^[ \t]*/.exec(text)[0])].reduce((width, char) => width + (char === '\t' ? 4 : 1), 0));

/**
 * A guide at each indent step (CSS `--indent`, in characters) over the leading
 * whitespace of every visible line, and over a blank line as far as the
 * shallower of the lines around it is indented, so the guides run on.
 */
export const indentGuides = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.build(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
  }

  build(view) {
    const { doc } = view.state;
    const ranges = [];
    // The width of the nearest line with text before `line` (0 at the start) and after it (0 at the end).
    const nearest = (line, step) => {
      for (let n = line.number + step; n >= 1 && n <= doc.lines; n += step) {
        const width = indentWidth(doc.line(n).text);
        if (width !== null) return width;
      }
      return 0;
    };
    for (const [from, to] of visible(view, false)) {
      for (let at = from; at <= to;) {
        const line = doc.lineAt(at);
        const lead = /^[ \t]+/.exec(line.text);
        const width = line.text === '' ? Math.min(nearest(line, -1), nearest(line, 1)) : 0;
        if (width > 0) ranges.push(Decoration.line({ class: 'pj-guides-blank', attributes: { style: `--width: ${width}` } }).range(line.from));
        else if (lead) ranges.push(guides.range(line.from, line.from + lead[0].length));
        at = line.to + 1;
      }
    }
    return Decoration.set(ranges);
  }
}, { decorations: (plugin) => plugin.decorations });
