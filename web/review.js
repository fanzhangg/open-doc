// How a revision (edit marks, see web/editor.js) shows in the Markdown
// view's rendered text.
//
// An item is { anchor, mark, widget, by, replay } in rendered-text terms:
// `anchor` is the span to mark ('ins' highlights it as new, null leaves it
// alone), and `widget` ({ side, kind, text }) is text that is not in the
// doc, shown before or after the span: the old text an edit removed.

import { createAnchor } from '../src/core/anchor.js';
import { project, renderedRange } from '../src/formats/markdown/project.js';

/**
 * Edit marks on `markdown` as a revision: the text they added highlighted
 * as new, the text they removed shown struck through where it was.
 */
export function editItems(markdown, marks, projection = project(markdown)) {
  const items = [];
  if (projection.text.length === 0) return items;
  for (const { from, to, removed: before, by, replay } of marks) {
    const span = renderedRange(projection, from, to);
    const removed = project(before).text;
    const widget = removed ? { side: 'before', kind: 'del', text: removed } : null;
    if (span.start < span.end) {
      items.push({ anchor: createAnchor(projection.text, span.start, span.end), mark: 'ins', widget, by, replay });
    } else if (widget) {
      // A deletion: hang the removed text on the character after the spot (or before it, at the end).
      const at = Math.min(span.start, projection.text.length - 1);
      items.push({ anchor: createAnchor(projection.text, at, at + 1), mark: null, widget: { ...widget, side: at < span.start ? 'after' : 'before' }, by, replay });
    }
  }
  return items;
}
