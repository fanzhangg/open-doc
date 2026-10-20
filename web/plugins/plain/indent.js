// How the plain view indents: worked out from the text or the settings, and
// typed by Tab, Shift-Tab and Enter.

import { EditorSelection } from '@codemirror/state';
import { insertNewline } from '@codemirror/commands';

const SAMPLE_LINES = 2000;

/**
 * The indent `text` uses: `{ tabs: true }`, or `{ tabs: false, size }` for the
 * most common step in the width of spaces between one indented line and the
 * next (2 to 8); null when nothing is indented. Looks at the first lines only.
 */
export function detectIndent(text) {
  let tabLed = 0;
  let spaceLed = 0;
  let previous = 0;
  const steps = new Map();
  for (const line of text.split('\n', SAMPLE_LINES)) {
    if (line.trim() === '') continue;
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.startsWith('\t')) tabLed++;
    else if (lead !== '') spaceLed++;
    const step = Math.abs(lead.length - previous);
    if (step >= 2 && step <= 8 && !lead.includes('\t')) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = lead.includes('\t') ? 0 : lead.length;
  }
  if (tabLed > spaceLed) return { tabs: true };
  const [size] = [...steps].sort(([a, countA], [b, countB]) => countB - countA || a - b)[0] ?? [];
  return size ? { tabs: false, size } : null;
}

/** The indent to type under the plugin's `indent` ('auto', 'tabs' or 'spaces') and `tabWidth` settings, for `text`. */
export function resolveIndent({ indent, tabWidth }, text) {
  if (indent === 'tabs') return { tabs: true };
  return (indent === 'auto' && detectIndent(text)) || { tabs: false, size: tabWidth };
}

const unitText = (indent) => (indent.tabs ? '\t' : ' '.repeat(indent.size));

// The lines a selection touches, as CodeMirror lines; a selection that ends at the start of a line leaves it out.
function touchedLines(state) {
  const { from, to } = state.selection.main;
  const last = state.doc.lineAt(to);
  const end = to > from && to === last.from ? last.number - 1 : last.number;
  return Array.from({ length: end - state.doc.lineAt(from).number + 1 }, (_, i) => state.doc.line(state.doc.lineAt(from).number + i));
}

/**
 * Tab, Shift-Tab and Enter for an editable view. `indent()` is the indent to
 * type, `keep()` whether Enter starts the new line with the indent of the
 * one it leaves. Tab types the indent, or indents every line of a selection
 * over several lines; Shift-Tab takes one indent off those lines.
 */
export function indentKeys({ indent, keep }) {
  return [
    {
      key: 'Tab',
      run(view) {
        const { state } = view;
        if (state.readOnly) return false;
        const lines = touchedLines(state);
        if (lines.length < 2) view.dispatch({ ...state.replaceSelection(unitText(indent())), scrollIntoView: true, userEvent: 'input.type' });
        else view.dispatch({ changes: lines.filter((line) => line.length > 0).map((line) => ({ from: line.from, insert: unitText(indent()) })), userEvent: 'input.indent' });
        return true;
      },
    },
    {
      key: 'Shift-Tab',
      run(view) {
        const { state } = view;
        if (state.readOnly) return false;
        const { tabs, size } = indent();
        const lead = new RegExp(`^(\\t| {1,${tabs ? 4 : size}})`);
        const changes = touchedLines(state).flatMap((line) => {
          const found = lead.exec(line.text);
          return found ? [{ from: line.from, to: line.from + found[0].length }] : [];
        });
        if (changes.length > 0) view.dispatch({ changes, userEvent: 'delete.dedent' });
        return true;
      },
    },
    {
      key: 'Enter',
      run(view) {
        if (!keep()) return insertNewline(view);
        const { state } = view;
        if (state.readOnly) return false;
        view.dispatch(state.update(state.changeByRange((range) => {
          const line = state.doc.lineAt(range.from);
          const insert = `\n${/^[ \t]*/.exec(line.text)[0].slice(0, range.from - line.from)}`;
          return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
        }), { scrollIntoView: true, userEvent: 'input' }));
        return true;
      },
    },
  ];
}
