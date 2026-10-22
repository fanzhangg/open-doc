// The home page: Open Project, the recent projects, and Settings (from the menu). Bundled
// into dist/web/start.js (scripts/build.js) so it shares the editor's look
// and parts: its stylesheet and theme, tooltips and the Settings dialog.

import { hydrateIcons, icon } from './icons.js';
import { createSettings } from './settings.js';
import { setupSettings, setupTooltips } from './settings-dialog.js';
import { NAME_PATTERN } from '../src/core/mentions.js';

const desktop = window.ponjoDesktop;
const list = document.querySelector('.od-recent ul');
const empty = document.querySelector('.od-recent-empty');

hydrateIcons();
setupTooltips();
document.querySelector('[data-action="open-project"]').addEventListener('click', () => desktop.openFolder().catch(() => {}));

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---- settings: the same dialog as in a doc, saved for every window ----

let store = null;
let settings = null; // the dialog, once the settings are read
desktop.settings().then((initial) => {
  store = createSettings(initial, { save: (patch) => desktop.saveSettings(patch), onError: () => {} });
  settings = setupSettings({
    store,
    getName: () => store.get().name ?? '',
    setName(next) {
      if (!NAME_PATTERN.test(next)) return false;
      if (next !== store.get().name) store.set({ name: next });
      return true;
    },
    scripts: { list: desktop.agentScripts, reset: desktop.resetAgentScript, saveSecret: desktop.saveSecret, showFolder: desktop.showAgents },
  });
});
desktop.onCommand((name) => settings?.toggle(name === 'shortcuts' ? 'shortcuts' : 'general'));
// Changed in another window, or in settings.json: the look follows.
desktop.onSettingsChanged(() => desktop.settings().then((next) => store?.receive(next), () => {}));

// ---- recent projects ----

async function showRecent() {
  const recent = await desktop.recent();
  list.replaceChildren(...recent.map(({ name, folder }, index) => {
    const button = el('button');
    button.type = 'button';
    button.title = folder;
    // rtl keeps the end of a long path visible; the marks keep it readable
    button.append(icon('folder'), el('span', 'od-recent-name', name), el('span', 'od-recent-folder', `‎${folder}‎`));
    button.addEventListener('click', () => desktop.openRecent(index).catch(() => {}));
    const item = el('li');
    item.append(button);
    return item;
  }));
  empty.hidden = recent.length > 0;
}

desktop.onRecentChanged(showRecent);
showRecent();
