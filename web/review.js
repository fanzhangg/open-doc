// Changes on the page: proposals (SPEC.md §2.6), whether one can still be
// applied, and how a proposal or a recorded edit (§2.5) shows in the text.
//
// A preview item is { anchor, mark, widget } in rendered-text terms:
// `anchor` is the span to mark ('del' strikes it, 'ins' highlights it as new,
// null leaves it alone), and `widget` ({ side, kind, text }) is text that is
// not in the doc, shown before or after the span: the new text of a
// proposal, or the old text an edit removed.

import { createAnchor } from '../src/core/anchor.js';
import { applyProposal, findEdit, findProposal } from '../src/core/diff.js';
import { project } from '../src/core/project.js';

/**
 * A proposal as a suggestion: its `before` struck through and its `after`
 * inserted next to it. Changes no longer found in `markdown` (the doc on
 * disk) are left out, and so is one whose `before` renders to nothing.
 */
export function previewItems(markdown, changes) {
  const projection = project(markdown);
  const items = [];
  for (const change of changes) {
    const range = findProposal(markdown, change);
    const span = range && renderedSpan(projection, range);
    if (!span || span.start === span.end) continue;
    const text = project(change.after).text;
    items.push({ anchor: createAnchor(projection.text, span.start, span.end), mark: 'del', widget: text ? { side: 'after', kind: 'ins', text } : null });
  }
  return items;
}

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
    const span = range && renderedSpan(projection, range);
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

// The rendered-text span drawn from source range [start, end): the
// characters whose source offset falls inside it; for an empty range, the
// position of the first character at or after it.
function renderedSpan({ text, offsets }, range) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    if (offsets[i] < range.start) continue;
    if (start === -1) start = i;
    if (offsets[i] >= range.end) break;
    end = i + 1;
  }
  if (start === -1) return { start: text.length, end: text.length };
  return { start, end: Math.max(start, end) };
}

/** The apply notice for `message`'s proposal that is still in effect (not undone), or null. */
export function appliedBy(thread, message) {
  return thread.messages.findLast((m) => m.applies === message.id && !thread.messages.some((u) => u.undoes === m.id)) ?? null;
}

/** The proposal in `thread` the human may still act on: the latest one not applied, or null. */
export function openProposal(thread) {
  return thread.messages.findLast((m) => m.proposal?.length && !appliedBy(thread, m)) ?? null;
}

/** Whether every change of `message`'s proposal can still be found in `markdown`. */
export const canApply = (markdown, message) => applyProposal(markdown, message.proposal) !== null;
