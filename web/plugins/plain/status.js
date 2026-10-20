// The plain view's status bar, under the page: where the caret is and the
// selection's size on the left; on the right the indent Tab types, which
// opens a menu of others (they change the plugin's settings, so only what is
// typed later, never the file), and toggles for wrapping and whitespace.
// Only an editable view has one.

const INDENTS = [['tabs', 'Tab'], [2, '2 spaces'], [4, '4 spaces'], [8, '8 spaces']];
const indentName = ({ tabs, size }) => (tabs ? 'Tab' : `${size} spaces`);

const BAR = `
<div class="od-statusbar" aria-label="Editor status">
  <span class="od-status-position"></span>
  <span class="od-status-actions">
    <button type="button" class="od-status-indent" aria-haspopup="listbox" aria-expanded="false"></button>
    <button type="button" data-setting="wrap" aria-pressed="false" data-tip="Wrap long lines">Wrap</button>
    <button type="button" data-setting="whitespace" aria-pressed="false" data-tip="Show all whitespace">Whitespace</button>
    <ul class="od-block-menu" role="listbox" aria-label="Indent with" hidden></ul>
  </span>
</div>`;

/**
 * Put a status bar after `canvas` for `view` (a CodeMirror EditorView).
 * `save(patch)` saves a change to the plugin's settings. `update()` repaints
 * the caret's place; `paint(settings, indent)` what depends on the settings;
 * `destroy()` takes the bar away.
 */
export function createStatusBar(view, canvas, save) {
  const template = document.createElement('template');
  template.innerHTML = BAR;
  const bar = template.content.firstElementChild;
  canvas.after(bar);
  const position = bar.querySelector('.od-status-position');
  const indentButton = bar.querySelector('.od-status-indent');
  const menu = bar.querySelector('.od-block-menu');
  const toggles = [...bar.querySelectorAll('[data-setting]')];
  let own;

  menu.replaceChildren(...INDENTS.map(([value, label]) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'option');
    item.tabIndex = 0;
    item.dataset.indent = value;
    item.textContent = label;
    return item;
  }));

  const close = () => {
    menu.hidden = true;
    indentButton.setAttribute('aria-expanded', 'false');
  };
  indentButton.addEventListener('click', () => {
    if (!menu.hidden) return close();
    const box = indentButton.getBoundingClientRect();
    menu.hidden = false;
    Object.assign(menu.style, { right: `${innerWidth - box.right}px`, bottom: `${innerHeight - box.top + 4}px`, margin: 0 });
    indentButton.setAttribute('aria-expanded', 'true');
    menu.querySelector('[aria-selected="true"]')?.focus();
  });
  const choose = (item) => {
    close();
    indentButton.focus();
    save(item.dataset.indent === 'tabs' ? { indent: 'tabs' } : { indent: 'spaces', tabWidth: Number(item.dataset.indent) });
  };
  menu.addEventListener('click', (event) => event.target.closest('li') && choose(event.target.closest('li')));
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      indentButton.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(event.target);
    }
  });
  const done = new AbortController();
  document.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== indentButton) close();
  }, { signal: done.signal });

  bar.addEventListener('click', (event) => {
    const { setting } = event.target.closest('[data-setting]')?.dataset ?? {};
    if (setting === 'wrap') save({ wrap: !own.wrap });
    else if (setting === 'whitespace') save({ whitespace: own.whitespace === 'all' ? 'selection' : 'all' });
  });

  function update() {
    const { state } = view;
    const { from, to, head } = state.selection.main;
    const line = state.doc.lineAt(head);
    const selected = from === to ? '' : ` · ${[...state.sliceDoc(from, to)].length.toLocaleString()} selected`;
    position.textContent = `Ln ${line.number.toLocaleString()}, Col ${(head - line.from + 1).toLocaleString()}${selected}`;
  }

  function paint(settings, indent) {
    own = settings;
    indentButton.textContent = `Indent: ${indentName(indent)}`;
    for (const item of menu.children) item.setAttribute('aria-selected', String(item.textContent === indentName(indent)));
    for (const toggle of toggles) toggle.setAttribute('aria-pressed', String(toggle.dataset.setting === 'wrap' ? settings.wrap : settings.whitespace === 'all'));
  }

  update();
  return {
    update,
    paint,
    destroy() {
      done.abort();
      bar.remove();
    },
  };
}
