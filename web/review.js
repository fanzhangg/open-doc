// How a change between two versions of the doc (web/history.js) shows in
// the text.
//
// An item is { anchor, mark, widget } in rendered-text terms: `anchor` is
// the span to mark ('ins' highlights it as new, null leaves it alone), and
// `widget` ({ side, kind, text }) is text that is not in the doc, shown
// before or after the span: the old text an edit removed.

import { createAnchor } from '../src/core/anchor.js';
import { findEdit } from '../src/core/diff.js';
import { project, renderedRange } from '../src/formats/markdown/project.js';

/**
 * Recorded edits as a revision: the text they added highlighted as new, the
 * text they removed shown struck through where it was. Edits that have
 * changed since are left out.
 */
export function editItems(markdown, edits) {
  const projection = project(markdown);
  const items = [];
  for (const edit of edits) {
    const range = findEdit(markdown, edit);
    const span = range && renderedRange(projection, range.start, range.end);
    if (!span || projection.text.length === 0) continue;
    const removed = project(edit.before).text;
    const widget = removed ? { side: 'before', kind: 'del', text: removed } : null;
    if (span.start < span.end) {
      items.push({ anchor: createAnchor(projection.text, span.start, span.end), mark: 'ins', widget });
    } else if (widget) {
      // A deletion: hang the removed text on the character after the spot (or before it, at the end).
      const at = Math.min(span.start, projection.text.length - 1);
      items.push({ anchor: createAnchor(projection.text, at, at + 1), mark: null, widget: { ...widget, side: at < span.start ? 'after' : 'before' } });
    }
  }
  return items;
}
