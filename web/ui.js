// The page's chrome around the doc's view: the Settings dialog and the desktop
// app's menu commands. A view brings its own tools and shortcuts
// (web/views/). Tooltips and the Settings dialog are in settings-dialog.js,
// shared with the desktop start window.

import { hydrateIcons } from './icons.js';
import { keyLabel, setupSettings, setupTooltips } from './settings-dialog.js';
import { api } from './api.js';
import { VIEWS } from './views/index.js';
import { RULES } from '../src/rules/index.js';

/**
 * @param {{ getView: () => object, settings: ReturnType<typeof import('./settings.js').createSettings>,
 *           getName: () => string, setName: (name: string) => boolean }} options
 */
export function createChrome({ getView, settings: store, getName, setName }) {
  hydrateIcons();
  for (const kbd of document.querySelectorAll('kbd[data-keys]')) kbd.textContent = keyLabel(kbd.dataset.keys);
  setupTooltips();
  const page = document.querySelector('.od-page');

  const settings = setupSettings({
    store,
    views: VIEWS,
    rules: RULES,
    getName,
    setName,
    onApply() {
      window.dispatchEvent(new Event('resize')); // the comment margin re-lays out
    },
    scripts: {
      list: api.scripts,
      reset: api.resetScript,
      // Only the app can encrypt a secret: it hands it to the doc host before this resolves.
      saveSecret: (id, key, value) => window.opendocDesktop.saveSecret(id, key, value),
      showFolder: window.opendocDesktop && (() => window.opendocDesktop.showAgents()),
    },
  });

  // Toolbar buttons act without taking the doc's selection.
  document.querySelector('.od-toolbar').addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });

  return {
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
