// The Settings dialog (General, Appearance, Editor, Plugins, Shortcuts,
// Agent), tooltips that show shortcuts, and how shortcuts are written: shared
// by the editor (web/ui.js) and the desktop start window (desktop/start.js),
// so both look and behave the same. Settings are saved for every doc and
// window (see settings.js); a change made in another window shows up here
// too. Every window shows the same sections, Agent among them (the agent
// script that runs every buddy), except Plugins, which only a doc's window
// has: the plugins come with the views (web/plugins/). Buddies are not here:
// they belong to a doc's People.

import { hydrateIcons, icon } from './icons.js';
import { pluginSettings } from '../src/core/settings.js';

const SHORTCUTS = [
  ['Comments', [['Comment on the selection', 'Mod+Alt+M'], ['Post comment or reply', 'Enter'], ['New line in a comment', 'Shift+Enter'], ['Cancel', 'Esc']]],
  ['App', [['Undo', 'Mod+Z'], ['Redo', 'Mod+Shift+Z'], ['Focus mode', 'Mod+Shift+F'], ['Settings', 'Mod+,'], ['Keyboard shortcuts', 'Mod+/']]],
];

// The dialog itself, put into the page by setupSettings: static, no user text.
const DIALOG = `
<dialog class="od-settings" aria-label="Settings">
  <nav class="od-settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
    <div class="od-settings-title">Settings</div>
    <button type="button" role="tab" data-section="general" data-icon="user">General</button>
    <button type="button" role="tab" data-section="appearance" data-icon="display">Appearance</button>
    <button type="button" role="tab" data-section="editor" data-icon="text">Editor</button>
    <button type="button" role="tab" data-section="plugins" data-icon="plugin">Plugins</button>
    <button type="button" role="tab" data-section="shortcuts" data-icon="keyboard">Shortcuts</button>
    <button type="button" role="tab" data-section="agent" data-icon="settings">Agent</button>
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
          <span class="od-setting-label">Word count</span>
        </span>
        <input type="checkbox" class="od-switch" data-setting="wordCount">
      </label>
    </section>

    <section class="od-settings-section" role="tabpanel" data-section="plugins" hidden>
      <div class="od-plugin-list">
        <h2>Plugins</h2>
        <p class="od-settings-intro">Each gives one kind of file its own editor, or its own rules for merging changes. Off, those files are plain text.</p>
        <ul class="od-setting-pages"></ul>
      </div>
    </section>

    <section class="od-settings-section" role="tabpanel" data-section="agent" hidden>
      <h2>Agent</h2>
      <div class="od-setting">
        <div class="od-setting-text">
          <label for="od-agent-script">Runs every buddy</label>
          <span class="od-setting-hint">A script in <code class="od-agents-folder"></code>: the prompt on stdin, the reply on stdout. Edit it to change the program, model or flags.</span>
        </div>
        <select id="od-agent-script" class="od-input"></select>
      </div>
      <div class="od-setting-row">
        <button type="button" class="od-secondary" data-action="reset-agent">Reset to Default</button>
        <button type="button" class="od-secondary" data-action="show-agents" hidden>Show folder</button>
      </div>
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
 * one page shows. `plugins` (web/plugins/index.js) fill Plugins, which shows
 * only when there are some: a list of them, each opening its own page.
 * `scripts` ({ list() → { agents, shipped, folder }, reset(name),
 * showFolder? }) backs Agent, which picks the agent script.
 * @param {{ store: ReturnType<typeof import('./settings.js').createSettings>, getName: () => string,
 *           setName: (name: string) => boolean, onApply?: (settings: object) => void, plugins?: object[],
 *           scripts: object }} options
 */
export function setupSettings({ store, getName, setName, onApply = () => {}, plugins = [], scripts }) {
  document.body.insertAdjacentHTML('beforeend', DIALOG);
  const dialog = document.querySelector('.od-settings');
  const pluginList = dialog.querySelector('.od-plugin-list');
  const pluginParts = plugins.map((plugin) => pluginRowAndPage(plugin, (patch) => store.set(patch)));
  pluginList.querySelector('ul').append(...pluginParts.map((part) => part.row));
  pluginList.after(...pluginParts.map((part) => part.page));
  hydrateIcons(dialog);
  if (plugins.length === 0) dialog.querySelector('[role="tab"][data-section="plugins"]').remove();
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const sections = [...dialog.querySelectorAll('.od-settings-section')];
  const nameInput = dialog.querySelector('#od-name-input');
  const nameError = dialog.querySelector('.od-input-error');

  fillShortcuts(dialog.querySelector('.od-shortcuts-body'));
  dialog.querySelector('[data-action="show-agents"]').hidden = !scripts.showFolder;
  const scriptSelect = dialog.querySelector('#od-agent-script');
  let shipped = [];

  // The scripts are read again each time the section shows: the user may add one.
  async function paintScripts() {
    let found;
    try {
      found = await scripts.list();
    } catch {
      return;
    }
    shipped = found.shipped;
    dialog.querySelector('.od-agents-folder').textContent = found.folder;
    const names = found.agents.includes(store.get().agent) ? found.agents : [...found.agents, store.get().agent];
    scriptSelect.replaceChildren(...names.map((name) => Object.assign(document.createElement('option'), { value: name, textContent: name })));
    scriptSelect.value = store.get().agent;
    dialog.querySelector('[data-action="reset-agent"]').disabled = !shipped.includes(scriptSelect.value);
  }
  scriptSelect.addEventListener('change', () => {
    set({ agent: scriptSelect.value });
    dialog.querySelector('[data-action="reset-agent"]').disabled = !shipped.includes(scriptSelect.value);
  });

  function apply() {
    const settings = store.get();
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    root.dataset.font = settings.font;
    root.dataset.width = settings.width;
    const mark = (selector, attr, value) => {
      for (const button of dialog.querySelectorAll(selector)) button.setAttribute('aria-checked', String(button.dataset[attr] === value));
    };
    mark('[data-font]', 'font', settings.font);
    mark('[data-theme-choice]', 'themeChoice', settings.theme);
    mark('[data-width]', 'width', settings.width);
    for (const box of dialog.querySelectorAll('[data-setting]')) box.checked = Boolean(settings[box.dataset.setting]);
    for (const [i, plugin] of plugins.entries()) {
      const own = pluginSettings(settings, plugin);
      pluginParts[i].state.textContent = own.enabled ? 'On' : 'Off';
      pluginParts[i].paint(own);
    }
    if (document.activeElement !== nameInput) nameInput.value = getName();
    onApply(settings);
  }
  store.subscribe(apply);
  const set = (patch) => store.set(patch);

  function show(section) {
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.section === section));
    for (const panel of sections) panel.hidden = panel.dataset.section !== section;
    if (section === 'agent') paintScripts();
    showPlugin(null);
  }

  // Plugins shows the list, or the page of plugin `id`.
  function showPlugin(id) {
    pluginList.hidden = id !== null;
    for (const { page } of pluginParts) page.hidden = page.dataset.pluginPage !== id;
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
    else if (button.dataset.action === 'reset-agent') {
      const name = scriptSelect.value;
      if (window.confirm(`Reset ${name} to the script OpenDoc comes with?\n\nYour changes to it are lost.`)) scripts.reset(name).catch(() => {});
    } else if (button.dataset.action === 'show-agents') scripts.showFolder(); else if (button.getAttribute('role') === 'tab') show(button.dataset.section);
    else if (button.dataset.openPlugin) {
      showPlugin(button.dataset.openPlugin);
      dialog.querySelector(`[data-plugin-page="${button.dataset.openPlugin}"] .od-back`).focus();
    } else if (button.dataset.action === 'plugins') {
      const id = button.closest('[data-plugin-page]').dataset.pluginPage;
      showPlugin(null);
      dialog.querySelector(`[data-open-plugin="${id}"]`).focus();
    }
    else if (button.dataset.font) set({ font: button.dataset.font });
    else if (button.dataset.themeChoice) set({ theme: button.dataset.themeChoice });
    else if (button.dataset.width) set({ width: button.dataset.width });
  });
  dialog.addEventListener('change', (event) => {
    const { setting } = event.target.dataset ?? {};
    if (setting) set({ [setting]: event.target.checked });
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

  document.querySelector('.od-settings-toggle')?.addEventListener('click', () => open('general'));

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

// A plugin's row in the list (its name and extensions, what it does, on or
// off) and its page: its switch, then the fields it declares (shown while it
// is on, and while their `when` holds). `state` says on or off in the row;
// `paint(own)` shows the plugin's settings `own`; `save(patch)` saves a change.
function pluginRowAndPage(plugin, save) {
  const extensions = plugin.extensions.map((extension) => `.${extension}`);
  const name = el('span', 'od-setting-label', plugin.name);
  name.append(el('span', 'od-setting-ext', extensions.join(' ')));
  const summary = el('span', 'od-setting-text');
  summary.append(name, el('span', 'od-setting-hint', plugin.about));
  const state = el('span');
  const stateBox = el('span', 'od-setting-state');
  stateBox.append(state, icon('chevron'));
  const open = el('button');
  open.type = 'button';
  open.dataset.openPlugin = plugin.id;
  open.append(summary, stateBox);
  const row = el('li');
  row.append(open);

  const change = (key, value) => save({ plugins: { [plugin.id]: { [key]: value } } });
  const enabled = fieldRow(
    { key: 'enabled', type: 'switch', label: 'On', hint: `Off, ${new Intl.ListFormat('en').format(extensions)} files ${plugin.createView ? 'open' : 'merge'} as plain text.` },
    plugin.id,
    change,
  );
  const fields = (plugin.settings ?? []).map((field) => fieldRow(field, plugin.id, change));
  const page = el('div');
  page.dataset.pluginPage = plugin.id;
  page.hidden = true;
  const back = el('button', 'od-back', 'Plugins');
  back.type = 'button';
  Object.assign(back.dataset, { action: 'plugins', icon: 'back' });
  page.append(back, el('h2', null, plugin.name), el('p', 'od-settings-intro', plugin.about), enabled.node, ...fields.map((field) => field.node));
  const paint = (own) => {
    enabled.paint(own);
    fields.forEach((field, i) => {
      field.node.hidden = !own.enabled || !matches(plugin.settings[i].when, own);
      field.paint(own);
    });
  };
  return { row, page, state, paint };
}

// Whether `when` ({ key: value | [values] } or { key: { not: value } }) holds for the settings `own`; no `when` always does.
function matches(when = {}, own) {
  return Object.entries(when).every(([key, want]) => (want && typeof want === 'object' && !Array.isArray(want) ? own[key] !== want.not : [want].flat().includes(own[key])));
}

// One setting of plugin `id` as a row: its label and hint, and a control by
// type (marked with the plugin and the key), under a heading if it starts a
// `group`. `change(key, value)` saves a change; `paint(own)` shows the current value.
function fieldRow(field, id, change) {
  const text = el('span', 'od-setting-text');
  text.append(el('span', 'od-setting-label', field.label));
  if (field.hint) text.append(el('span', 'od-setting-hint', field.hint));
  const line = el(field.type === 'switch' ? 'label' : 'div', 'od-setting');
  let control;
  let paint;
  if (field.type === 'switch') {
    control = el('input', 'od-switch');
    control.type = 'checkbox';
    control.addEventListener('change', () => change(field.key, control.checked));
    paint = (own) => { control.checked = own[field.key]; };
  } else if (field.type === 'choice') {
    control = el('div', 'od-segmented');
    control.setAttribute('role', 'radiogroup');
    control.ariaLabel = field.label;
    const buttons = field.options.map(([value, label]) => {
      const button = el('button', null, label);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.addEventListener('click', () => change(field.key, value));
      return button;
    });
    control.append(...buttons);
    paint = (own) => buttons.forEach((button, i) => button.setAttribute('aria-checked', String(field.options[i][0] === own[field.key])));
  } else {
    const step = field.step ?? 1;
    let now;
    const [less, more] = [-step, step].map((by) => {
      const button = el('button', null, by < 0 ? '−' : '+');
      button.type = 'button';
      button.ariaLabel = `${by < 0 ? 'Decrease' : 'Increase'} ${field.label}`;
      button.addEventListener('click', () => change(field.key, now + by));
      return button;
    });
    const value = el('span');
    control = el('div', 'od-segmented od-stepper');
    control.setAttribute('role', 'group');
    control.ariaLabel = field.label;
    control.append(less, value, more);
    paint = (own) => {
      now = own[field.key];
      value.textContent = field.unit ? `${now} ${field.unit}` : String(now);
      less.disabled = now - step < field.min;
      more.disabled = now + step > field.max;
    };
  }
  Object.assign(control.dataset, { plugin: id, key: field.key });
  line.append(text, control);
  const node = el('div');
  if (field.group) node.append(el('h3', 'od-setting-group', field.group));
  node.append(line);
  return { node, paint };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
