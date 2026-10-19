// The page's chrome around the doc's view: the word count and the desktop
// app's menu commands. A plugin's view brings its own tools and shortcuts
// (web/plugins/). Tooltips and the Settings dialog are in settings-dialog.js,
// shared with the desktop start window.

import { hydrateIcons } from './icons.js';
import { keyLabel, setupSettings, setupTooltips } from './settings-dialog.js';
import { api } from './api.js';
import { PLUGINS } from './plugins/index.js';

/**
 * @param {{ getView: () => object, settings: ReturnType<typeof import('./settings.js').createSettings>,
 *           getName: () => string, setName: (name: string) => boolean }} options
 */
export function createChrome({ getView, settings: store, getName, setName }) {
  hydrateIcons();
  for (const kbd of document.querySelectorAll('kbd[data-keys]')) kbd.textContent = keyLabel(kbd.dataset.keys);
  setupTooltips();
  const count = document.querySelector('.od-count');
  const page = document.querySelector('.od-page');

  const settings = setupSettings({
    store,
    plugins: PLUGINS,
    getName,
    setName,
    onApply(next) {
      count.hidden = !next.wordCount;
      window.dispatchEvent(new Event('resize')); // the comment margin re-lays out
    },
    scripts: {
      list: api.scripts,
      reset: api.resetScript,
      showFolder: window.opendocDesktop && (() => window.opendocDesktop.showAgents()),
    },
  });

  // Toolbar buttons act without taking the doc's selection.
  document.querySelector('.od-toolbar').addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });

  // ---- word count ----

  // Counting words reads the whole doc, so it runs a few times a second at
  // most, not on every keystroke or every frame of an agent's replay.
  const COUNT_MS = 300;
  let countTimer = 0;
  let countedAt = -Infinity;
  function recount() {
    if (!countTimer) countTimer = setTimeout(refreshCount, Math.max(0, COUNT_MS - (performance.now() - countedAt)));
  }
  function refreshCount() {
    countTimer = 0;
    countedAt = performance.now();
    const view = getView();
    const text = view.getText();
    const selection = view.selection();
    const selected = selection ? words(text.slice(selection.from, selection.to)) : 0;
    count.textContent = selected ? `${selected.toLocaleString()} of ${plural(words(text), 'word')}` : plural(words(text), 'word');
  }
  document.addEventListener('selectionchange', recount);

  refreshCount();
  return {
    /** The doc's text changed: count its words again. */
    recount,
    /** A command from the desktop app's menu: 'settings', 'shortcuts', 'undo' or 'redo'. */
    command(name) {
      // Undo in the doc is the view's own history (your edits only); in a field, the field's.
      if (name === 'undo' || name === 'redo') {
        if (page.contains(document.activeElement)) getView()[name]();
        else document.execCommand(name);
      } else if (name === 'settings') settings.toggle('general');
      else if (name === 'shortcuts') settings.toggle('shortcuts');
    },
  };
}

function words(text) {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}
