// A revision as marks a view draws (see web/views/markdown/view.js): recorded edits
// found in the doc's text as it is now. An edit changed since is left out.

import { findEdit } from '../src/core/diff.js';
import { buddyColor, nameOf } from './faces.js';

/** Edit marks on `text` for `edits` (diffEdits records), shown as `by`'s, animated once by a new `replay` number. */
export function revisionMarks(text, edits, { by = null, replay = 0 } = {}) {
  return edits.flatMap((edit) => {
    const range = findEdit(text, edit);
    return range ? [{ kind: 'edit', from: range.start, to: range.end, removed: edit.before, by, replay }] : [];
  });
}

/** The node of a buddy's cursor mark (kind 'cursor'): a line in its colour, with its name while it works. */
export function cursorNode({ by, working }) {
  const node = document.createElement('span');
  node.className = working ? 'pj-cursor pj-cursor-working' : 'pj-cursor';
  node.style.cssText = `--buddy: ${buddyColor(by)}; --buddy-ink: #1f1d24`;
  node.contentEditable = 'false';
  const label = document.createElement('span');
  label.className = 'pj-cursor-name';
  label.textContent = nameOf(by);
  node.append(label);
  return node;
}
