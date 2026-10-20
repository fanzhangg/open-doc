// The plain view's status bar, under the page: where the caret is, and the
// selection's size. Only an editable view has one.

/** Put a status bar after `canvas` for `view` (a CodeMirror EditorView); `update()` repaints it, `destroy()` takes it away. */
export function createStatusBar(view, canvas) {
  const bar = document.createElement('div');
  bar.className = 'od-statusbar';
  bar.setAttribute('aria-label', 'Editor status');
  const position = document.createElement('span');
  bar.append(position);
  canvas.after(bar);

  function update() {
    const { state } = view;
    const { from, to, head } = state.selection.main;
    const line = state.doc.lineAt(head);
    const selected = from === to ? '' : ` · ${[...state.sliceDoc(from, to)].length.toLocaleString()} selected`;
    position.textContent = `Ln ${line.number.toLocaleString()}, Col ${(head - line.from + 1).toLocaleString()}${selected}`;
  }
  update();
  return { update, destroy: () => bar.remove() };
}
