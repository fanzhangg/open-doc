// The Settings dialog (General, Appearance, Editor, Shortcuts), tooltips that
// show shortcuts, and how shortcuts are written: shared by the editor
// (web/ui.js) and the desktop start window (desktop/start.js), so both look
// and behave the same. Settings are saved for every doc and window (see
// settings.js); a change made in another window shows up here too. In a doc,
// Agents at the foot of the list opens the Agents panel: agents are set up
// there, not twice.

import { hydrateIcons } from './icons.js';

const SHORTCUTS = [
  ['Comments', [['Comment on the selection', 'Mod+Alt+M'], ['Post comment or reply', 'Enter'], ['New line in a comment', 'Shift+Enter'], ['Cancel', 'Esc']]],
  ['Text', [['Bold', 'Mod+B'], ['Italic', 'Mod+I'], ['Strikethrough', 'Mod+Alt+X'], ['Inline code', 'Mod+E'], ['Link', 'Mod+K']]],
  ['Blocks', [['Insert block', '/'], ['Normal text', 'Mod+Alt+0'], ['Heading 1–3', 'Mod+Alt+1…3'], ['Bulleted list', 'Mod+Alt+8'], ['Numbered list', 'Mod+Alt+7'], ['Quote', 'Mod+Shift+B'], ['Code block', 'Mod+Alt+C']]],
  ['App', [['Undo', 'Mod+Z'], ['Redo', 'Mod+Shift+Z'], ['Focus mode', 'Mod+Shift+F'], ['Export', 'Mod+Shift+E'], ['Settings', 'Mod+,'], ['Keyboard shortcuts', 'Mod+/']]],
];

// The dialog itself, put into the page by setupSettings: static, no user text.
const DIALOG = `
<dialog class="od-settings" aria-label="Settings">
  <nav class="od-settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
    <div class="od-settings-title">Settings</div>
    <button type="button" role="tab" data-section="general" data-icon="user">General</button>
    <button type="button" role="tab" data-section="appearance" data-icon="display">Appearance</button>
    <button type="button" role="tab" data-section="editor" data-icon="text">Editor</button>
    <button type="button" role="tab" data-section="shortcuts" data-icon="keyboard">Shortcuts</button>
    <button type="button" class="od-settings-agents" data-action="agents" data-icon="users" hidden>Agents</button>
  </nav>
  <div class="od-settings-main">
    <button type="button" class="od-icon-btn od-settings-close" data-icon="close" data-action="close" aria-label="Close settings"></button>

    <section class="od-settings-section" role="tabpanel" data-section="general">
      <h2>General</h2>
      <div class="od-setting">
        <div class="od-setting-text">
          <label for="od-name-input">Your name</label>
        </div>
        <div class="od-setting-control">
          <input id="od-name-input" class="od-input" type="text" autocomplete="off" spellcheck="false" maxlength="64">
          <div class="od-input-error" role="alert" hidden>Use letters, digits, . _ or -</div>
        </div>
      </div>
    </section>

    <section class="od-settings-section" role="tabpanel" data-section="appearance" hidden>
      <h2>Appearance</h2>
      <div class="od-setting">
        <div class="od-setting-text">
          <span class="od-setting-label">Theme</span>
        </div>
        <div class="od-segmented" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" data-theme-choice="system">Auto</button>
          <button type="button" role="radio" data-theme-choice="light">Light</button>
          <button type="button" role="radio" data-theme-choice="dark">Dark</button>
        </div>
      </div>
      <div class="od-setting od-setting-stacked">
        <div class="od-setting-text">
          <span class="od-setting-label">Document font</span>
        </div>
        <div class="od-fonts" role="radiogroup" aria-label="Document font">
          <button type="button" role="radio" data-font="sans"><span class="od-font-sample">Ag</span>Sans</button>
          <button type="button" role="radio" data-font="serif"><span class="od-font-sample">Ag</span>Serif</button>
          <button type="button" role="radio" data-font="mono"><span class="od-font-sample">Ag</span>Mono</button>
        </div>
      </div>
      <div class="od-setting">
        <div class="od-setting-text">
          <span class="od-setting-label">Text width</span>
        </div>
        <div class="od-segmented" role="radiogroup" aria-label="Text width">
          <button type="button" role="radio" data-width="normal">Normal</button>
          <button type="button" role="radio" data-width="wide">Wide</button>
        </div>
      </div>
    </section>

    <section class="od-settings-section" role="tabpanel" data-section="editor" hidden>
      <h2>Editor</h2>
      <label class="od-setting">
        <span class="od-setting-text">
          <span class="od-setting-label">Outline</span>
        </span>
        <input type="checkbox" class="od-switch" data-setting="outline">
      </label>
      <label class="od-setting">
        <span class="od-setting-text">
          <span class="od-setting-label">Word count</span>
        </span>
        <input type="checkbox" class="od-switch" data-setting="wordCount">
      </label>
      <label class="od-setting">
        <span class="od-setting-text">
          <span class="od-setting-label">Focus mode</span>
        </span>
        <input type="checkbox" class="od-switch" data-setting="focus">
      </label>
    </section>

    <section class="od-settings-section" role="tabpanel" data-section="shortcuts" hidden>
      <h2>Keyboard shortcuts</h2>
      <div class="od-shortcuts-body"></div>
    </section>
  </div>
</dialog>
`;

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

/** "Mod+Shift+F" → "Ctrl+Shift+F", or "⌘⇧F" on a Mac. */
export function keyLabel(keys) {
  if (!mac) return keys.replace(/Mod/g, 'Ctrl');
  const map = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Enter: '↩', Esc: 'esc' };
  return keys.split('+').map((k) => map[k] ?? k).join('');
}

/**
 * The Settings dialog, opened by the page's `.od-settings-toggle`, Mod+, and
 * Mod+/ (Shortcuts). `onApply(settings)` follows every change, for what only
 * one page shows. With `openAgents`, the list has Agents, which opens that.
 * @param {{ store: ReturnType<typeof import('./settings.js').createSettings>, getName: () => string,
 *           setName: (name: string) => boolean, onApply?: (settings: object) => void, openAgents?: () => void }} options
 */
export function setupSettings({ store, getName, setName, onApply = () => {}, openAgents = null }) {
  document.body.insertAdjacentHTML('beforeend', DIALOG);
  const dialog = document.querySelector('.od-settings');
  hydrateIcons(dialog);
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const sections = [...dialog.querySelectorAll('.od-settings-section')];
  const nameInput = dialog.querySelector('#od-name-input');
  const nameError = dialog.querySelector('.od-input-error');

  fillShortcuts(dialog.querySelector('.od-shortcuts-body'));
  dialog.querySelector('[data-action="agents"]').hidden = !openAgents;

  function apply() {
    const settings = store.get();
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    root.dataset.font = settings.font;
    root.dataset.width = settings.width;
    root.toggleAttribute('data-focus', settings.focus);
    root.toggleAttribute('data-no-outline', !settings.outline);
    const mark = (selector, attr, value) => {
      for (const button of dialog.querySelectorAll(selector)) button.setAttribute('aria-checked', String(button.dataset[attr] === value));
    };
    mark('[data-font]', 'font', settings.font);
    mark('[data-theme-choice]', 'themeChoice', settings.theme);
    mark('[data-width]', 'width', settings.width);
    for (const box of dialog.querySelectorAll('[data-setting]')) box.checked = Boolean(settings[box.dataset.setting]);
    if (document.activeElement !== nameInput) nameInput.value = getName();
    onApply(settings);
  }
  store.subscribe(apply);
  const set = (patch) => store.set(patch);

  function show(section) {
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.section === section));
    for (const panel of sections) panel.hidden = panel.dataset.section !== section;
  }

  function open(section = 'general') {
    nameInput.value = getName();
    nameError.hidden = true;
    show(section);
    if (!dialog.open) dialog.showModal();
    if (section === 'general') nameInput.focus();
    else tabs.find((tab) => tab.dataset.section === section).focus();
  }

  // The name takes effect as soon as it is valid; an invalid one is pointed out and not kept.
  nameInput.addEventListener('input', () => {
    const next = nameInput.value.trim();
    nameError.hidden = next === '' || setName(next);
  });
  nameInput.addEventListener('blur', () => {
    nameInput.value = getName();
    nameError.hidden = true;
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) return dialog.close(); // backdrop
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'close') dialog.close();
    else if (button.dataset.action === 'agents') {
      dialog.close();
      openAgents();
    } else if (button.getAttribute('role') === 'tab') show(button.dataset.section);
    else if (button.dataset.font) set({ font: button.dataset.font });
    else if (button.dataset.themeChoice) set({ theme: button.dataset.themeChoice });
    else if (button.dataset.width) set({ width: button.dataset.width });
  });
  dialog.addEventListener('change', (event) => {
    const key = event.target.dataset?.setting;
    if (key) set({ [key]: event.target.checked });
  });
  // Up and down move between sections, as in a vertical tab list.
  dialog.querySelector('.od-settings-nav').addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const at = tabs.indexOf(document.activeElement);
    const next = tabs[(at + (event.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length];
    show(next.dataset.section);
    next.focus();
  });

  document.querySelector('.od-settings-toggle').addEventListener('click', () => open('general'));

  /** Open on `section`, or close when it is already showing that section. */
  function toggle(section) {
    const showing = dialog.open && !sections.find((panel) => panel.dataset.section === section).hidden;
    if (showing) dialog.close();
    else open(section);
  }

  document.addEventListener('keydown', (event) => {
    const mod = mac ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey && (event.key === '/' || event.key === ',')) {
      event.preventDefault();
      toggle(event.key === '/' ? 'shortcuts' : 'general');
    }
  });

  apply();
  return { get: () => store.get(), set, open, toggle };
}

function fillShortcuts(body) {
  for (const [group, rows] of SHORTCUTS) {
    const section = document.createElement('section');
    const title = document.createElement('h3');
    title.textContent = group;
    section.append(title);
    for (const [label, keys] of rows) {
      const row = document.createElement('div');
      row.className = 'od-shortcut';
      const name = document.createElement('span');
      name.textContent = label;
      const kbd = document.createElement('kbd');
      kbd.textContent = keyLabel(keys);
      row.append(name, kbd);
      section.append(row);
    }
    body.append(section);
  }
}

/** Tooltips for every `[data-tip]`, with its `data-keys` shortcut; the page has one `.od-tip`. */
export function setupTooltips() {
  const tip = document.querySelector('.od-tip');
  let timer;
  let owner = null;
  const hide = () => {
    clearTimeout(timer);
    tip.hidden = true;
    owner = null;
  };
  document.addEventListener('mouseover', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (target === owner) return;
    hide();
    if (!target) return;
    owner = target;
    timer = setTimeout(() => {
      tip.replaceChildren(target.dataset.tip);
      if (target.dataset.keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = keyLabel(target.dataset.keys);
        tip.append(kbd);
      }
      tip.hidden = false;
      const box = target.getBoundingClientRect();
      const left = Math.min(Math.max(box.left + box.width / 2 - tip.offsetWidth / 2, 8), window.innerWidth - tip.offsetWidth - 8);
      const below = box.bottom + 8 + tip.offsetHeight < window.innerHeight;
      tip.style.left = `${left}px`;
      tip.style.top = `${below ? box.bottom + 8 : box.top - tip.offsetHeight - 8}px`;
    }, 450);
  });
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', hide, true);
}
