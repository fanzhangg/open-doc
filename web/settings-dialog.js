// The Settings dialog (General, Views, Rules, Shortcuts, Agents), tooltips that show shortcuts, and how shortcuts are written: shared
// by the editor (web/ui.js) and the desktop start window (web/start.js),
// so both look and behave the same. Settings are saved for every doc and
// window (see settings.js); a change made in another window shows up here
// too. Every window shows the same sections, Agents among them (the
// programs that do a buddy's work, and their settings), except Views and
// Rules, which only a doc's window has. Buddies are not here:
// they belong to a doc's People.

import { hydrateIcons, icon } from './icons.js';
import { agentSettings, ruleSettings, viewSettings } from '../src/core/settings.js';

const SHORTCUTS = [
  ['Comments', [['Comment on the selection', 'Mod+Alt+M'], ['Post comment or reply', 'Enter'], ['New line in a comment', 'Shift+Enter'], ['Cancel', 'Esc']]],
  ['App', [['Undo', 'Mod+Z'], ['Redo', 'Mod+Shift+Z'], ['Focus mode', 'Mod+Shift+F'], ['Plain text view', 'Mod+Shift+T'], ['Settings', 'Mod+,'], ['Keyboard shortcuts', 'Mod+/']]],
];

// The dialog itself, put into the page by setupSettings: static, no user text.
const DIALOG = `
<dialog class="pj-settings" aria-label="Settings">
  <nav class="pj-settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
    <div class="pj-settings-title">Settings</div>
    <button type="button" role="tab" data-section="general" data-icon="user">General</button>
    <button type="button" role="tab" data-section="views" data-icon="pencil">Views</button>
    <button type="button" role="tab" data-section="rules" data-icon="check">Rules</button>
    <button type="button" role="tab" data-section="shortcuts" data-icon="keyboard">Shortcuts</button>
    <button type="button" role="tab" data-section="agents" data-icon="settings">Agents</button>
  </nav>
  <div class="pj-settings-main">
    <button type="button" class="pj-icon-btn pj-settings-close" data-icon="close" data-action="close" aria-label="Close settings"></button>

    <section class="pj-settings-section" role="tabpanel" data-section="general">
      <h2>General</h2>
      <div class="pj-setting">
        <div class="pj-setting-text">
          <label for="pj-name-input">Your name</label>
        </div>
        <div class="pj-setting-control">
          <input id="pj-name-input" class="pj-input" type="text" autocomplete="off" spellcheck="false" maxlength="64">
          <div class="pj-input-error" role="alert" hidden>Use letters, digits, . _ or -</div>
        </div>
      </div>
      <div class="pj-setting">
        <div class="pj-setting-text">
          <span class="pj-setting-label">Theme</span>
        </div>
        <div class="pj-segmented" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" data-theme-choice="system">Auto</button>
          <button type="button" role="radio" data-theme-choice="light">Light</button>
          <button type="button" role="radio" data-theme-choice="dark">Dark</button>
        </div>
      </div>
    </section>

    <section class="pj-settings-section" role="tabpanel" data-section="views" hidden>
      <div class="pj-page-list">
        <h2>Views</h2>
        <p class="pj-settings-intro">How a file is edited. Each gives one kind of file its own editor. Off, those files open as plain text.</p>
        <ul class="pj-setting-pages"></ul>
      </div>
    </section>

    <section class="pj-settings-section" role="tabpanel" data-section="rules" hidden>
      <div class="pj-page-list">
        <h2>Rules</h2>
        <p class="pj-settings-intro">How changes to a file are merged, whatever its view. Each gives one kind of file its own rules. Off, those files merge as plain text.</p>
        <ul class="pj-setting-pages"></ul>
      </div>
    </section>

    <section class="pj-settings-section" role="tabpanel" data-section="agents" hidden>
      <h2>Agents</h2>
      <p class="pj-settings-intro">What does a buddy's work: a program in <code class="pj-agents-folder"></code>, with the prompt on stdin and the reply on stdout. The one picked runs every buddy.</p>
      <ul class="pj-choices" role="radiogroup" aria-label="Agents"></ul>
      <div class="pj-setting-row">
        <button type="button" class="pj-secondary" data-action="show-agents" hidden>Show folder</button>
      </div>
    </section>

    <section class="pj-settings-section" role="tabpanel" data-section="shortcuts" hidden>
      <h2>Keyboard shortcuts</h2>
      <div class="pj-shortcuts-body"></div>
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
 * The Settings dialog, opened by the page's `.pj-settings-toggle`, Mod+, and
 * Mod+/ (Shortcuts). `onApply(settings)` follows every change, for what only
 * one page shows. `views` (web/views/index.js) and `rules` (src/rules/index.js)
 * fill Views and Rules, which show only when there are some: a list of them,
 * each opening its own page.
 * `scripts` ({ list() → { agents, shipped, folder, secrets }, reset(id),
 * saveSecret(id, key, value), showFolder? }, see web/api.js) backs Agents:
 * the agents, read again each time it shows, one of them picked to run
 * every buddy, its settings open under it.
 * @param {{ store: ReturnType<typeof import('./settings.js').createSettings>, getName: () => string,
 *           setName: (name: string) => boolean, onApply?: (settings: object) => void, views?: object[], rules?: object[],
 *           scripts: object }} options
 */
export function setupSettings({ store, getName, setName, onApply = () => {}, views = [], rules = [], scripts }) {
  document.body.insertAdjacentHTML('beforeend', DIALOG);
  const dialog = document.querySelector('.pj-settings');
  // Views and Rules are lists of pages alike: `read(settings, item)` gives an item's settings.
  const lists = [['views', 'Views', views, viewSettings], ['rules', 'Rules', rules, ruleSettings]].map(([kind, title, items, read]) => {
    const list = dialog.querySelector(`[data-section="${kind}"] .pj-page-list`);
    const parts = items.map((item) => itemRowAndPage(kind, title, item, (patch) => store.set(patch)));
    list.querySelector('ul').append(...parts.map((part) => part.row));
    list.after(...parts.map((part) => part.page));
    if (items.length === 0) dialog.querySelector(`[role="tab"][data-section="${kind}"]`).remove();
    return { list, items, parts, read };
  });
  hydrateIcons(dialog);
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const sections = [...dialog.querySelectorAll('.pj-settings-section')];
  const nameInput = dialog.querySelector('#pj-name-input');
  const nameError = dialog.querySelector('.pj-input-error');

  fillShortcuts(dialog.querySelector('.pj-shortcuts-body'));
  dialog.querySelector('[data-action="show-agents"]').hidden = !scripts.showFolder;

  // The agents are read again each time Agents shows (the user may add one) and after a Reset.
  let secretsSet = {}; // which secrets are set: { <agent>: [<key>] }
  let paintAgents = () => {};
  async function listAgents() {
    let found;
    try {
      found = await scripts.list();
    } catch {
      return;
    }
    secretsSet = found.secrets;
    dialog.querySelector('.pj-agents-folder').textContent = found.folder;
    const choices = found.agents.map((agent) => agentChoice(agent, found.shipped.includes(agent.id), {
      pick: () => set({ agent: agent.id }),
      change: (key, value) => set({ agents: { [agent.id]: { [key]: value } } }),
      saveSecret: async (key, value) => {
        try {
          await scripts.saveSecret(agent.id, key, value);
          secretsSet = (await scripts.list()).secrets;
          apply();
        } catch {
          // not saved: it still shows as it was
        }
      },
      reset() {
        if (window.confirm(`Reset ${agent.name} to what Ponjo comes with?\n\nYour changes to its program and manifest are lost; its settings stay.`)) scripts.reset(agent.id).then(listAgents, () => {});
      },
    }));
    dialog.querySelector('[data-section="agents"] .pj-choices').replaceChildren(...choices.map((choice) => choice.node));
    paintAgents = (settings) => found.agents.forEach((agent, i) => {
      const secrets = Object.fromEntries((secretsSet[agent.id] ?? []).map((key) => [key, true]));
      choices[i].paint(settings.agent === agent.id, { ...agentSettings(settings, agent), ...secrets });
    });
    apply();
  }

  function apply() {
    const settings = store.get();
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    for (const button of dialog.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-checked', String(button.dataset.themeChoice === settings.theme));
    for (const { items, parts, read } of lists) {
      for (const [i, item] of items.entries()) {
        const own = read(settings, item);
        parts[i].state.textContent = item.always ? 'Always on' : own.enabled ? 'On' : 'Off';
        parts[i].paint(own);
      }
    }
    paintAgents(settings);
    if (document.activeElement !== nameInput) nameInput.value = getName();
    onApply(settings);
  }
  store.subscribe(apply);
  const set = (patch) => store.set(patch);
  const listOf = (button) => lists.find(({ list }) => list.parentElement === button.closest('.pj-settings-section'));

  function show(section) {
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.section === section));
    for (const panel of sections) panel.hidden = panel.dataset.section !== section;
    if (section === 'agents') listAgents();
    for (const list of lists) showPage(list, null);
  }

  // A list shows its rows, or the page of the item `id`.
  function showPage({ list, parts }, id) {
    list.hidden = id !== null;
    for (const { page } of parts) page.hidden = page.dataset.page !== id;
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
    else if (button.dataset.action === 'show-agents') scripts.showFolder(); else if (button.getAttribute('role') === 'tab') show(button.dataset.section);
    else if (button.dataset.openPage) {
      showPage(listOf(button), button.dataset.openPage);
      dialog.querySelector(`[data-page="${button.dataset.openPage}"] .pj-back`).focus();
    } else if (button.dataset.action === 'back') {
      const id = button.closest('[data-page]').dataset.page;
      showPage(listOf(button), null);
      dialog.querySelector(`[data-open-page="${id}"]`).focus();
    }
    else if (button.dataset.themeChoice) set({ theme: button.dataset.themeChoice });
  });
  // Up and down move between sections, as in a vertical tab list.
  dialog.querySelector('.pj-settings-nav').addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const at = tabs.indexOf(document.activeElement);
    const next = tabs[(at + (event.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length];
    show(next.dataset.section);
    next.focus();
  });

  document.querySelector('.pj-settings-toggle')?.addEventListener('click', () => open('general'));

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

// The row of a view or a rule (of `kind`) in its list (its name and
// extensions, what it does, on or off) and its page: its switch, then the
// fields it declares (shown while it is on, and while their `when` holds).
// `state` says on or off in the row; `paint(own)` shows the item's settings
// `own`; `save(patch)` saves a change. `title` is the list's, to go back to.
function itemRowAndPage(kind, title, item, save) {
  const extensions = (item.extensions ?? []).map((extension) => `.${extension}`);
  const name = el('span', 'pj-setting-label', item.name);
  if (extensions.length > 0) name.append(el('span', 'pj-setting-ext', extensions.join(' ')));
  const summary = el('span', 'pj-setting-text');
  summary.append(name, el('span', 'pj-setting-hint', item.about));
  const state = el('span');
  const stateBox = el('span', 'pj-setting-state');
  stateBox.append(state, icon('chevron'));
  const open = el('button');
  open.type = 'button';
  open.dataset.openPage = item.id;
  open.append(summary, stateBox);
  const row = el('li');
  row.append(open);

  const change = (key, value) => save({ [kind]: { [item.id]: { [key]: value } } });
  const enabled = item.always
    ? alwaysOn()
    : fieldRow(
      { key: 'enabled', type: 'switch', label: 'On', hint: `Off, ${new Intl.ListFormat('en').format(extensions)} files ${kind === 'views' ? 'open' : 'merge'} as plain text.` },
      item.id,
      change,
    );
  const fields = (item.settings ?? []).map((field) => fieldRow(field, item.id, change));
  const page = el('div');
  page.dataset.page = item.id;
  page.hidden = true;
  const back = el('button', 'pj-back', title);
  back.type = 'button';
  Object.assign(back.dataset, { action: 'back', icon: 'back' });
  page.append(back, el('h2', null, item.name), el('p', 'pj-settings-intro', item.about), enabled.node, ...fields.map((field) => field.node));
  const paint = (own) => {
    enabled.paint(own);
    fields.forEach((field, i) => {
      field.node.hidden = !own.enabled || !matches(item.settings[i].when, own);
      field.paint(own);
    });
  };
  return { row, page, state, paint };
}

// An agent in Agents: a radio that picks it to run every buddy, its name
// and what it is; and under it while it is picked, the fields its manifest
// declares (shown while their `when` holds) and, for one Ponjo ships,
// Reset to Default. `change(key, value)` and `saveSecret(key, value)` save a
// field. `paint(using, own)` shows whether it is picked and its settings
// `own`, a secret as true when set.
function agentChoice(agent, shipped, { pick, change, saveSecret, reset }) {
  const radio = el('input', 'pj-radio');
  Object.assign(radio, { type: 'radio', name: 'pj-agent' });
  radio.addEventListener('change', pick);
  const text = el('span', 'pj-setting-text');
  text.append(el('span', 'pj-setting-label', agent.name), el('span', 'pj-setting-hint', agent.about));
  const label = el('label', 'pj-choice');
  label.append(radio, text);
  const secret = (key) => agent.settings.find((field) => field.key === key).type === 'secret';
  const fields = agent.settings.map((field) => fieldRow(field, agent.id, (key, value) => (secret(key) ? saveSecret : change)(key, value)));
  const detail = el('div', 'pj-choice-detail');
  detail.append(...fields.map((field) => field.node));
  if (shipped) {
    const buttons = el('div', 'pj-setting-row');
    const button = el('button', 'pj-secondary', 'Reset to Default');
    button.type = 'button';
    button.addEventListener('click', reset);
    buttons.append(button);
    detail.append(buttons);
  }
  const node = el('li');
  node.append(label, detail);
  const paint = (using, own) => {
    radio.checked = using;
    detail.hidden = !using || detail.childElementCount === 0;
    fields.forEach((field, i) => {
      field.node.hidden = !matches(agent.settings[i].when, own);
      field.paint(own);
    });
  };
  return { node, paint };
}

// The Enabled row of a view that cannot be switched off: no switch.
function alwaysOn() {
  const line = el('div', 'pj-setting');
  const text = el('span', 'pj-setting-text');
  text.append(el('span', 'pj-setting-label', 'Enabled'), el('span', 'pj-setting-hint', 'The fallback for files no other view claims.'));
  line.append(text, el('span', 'pj-setting-state', 'Always on'));
  const node = el('div');
  node.append(line);
  return { node, paint() {} };
}

// Whether `when` ({ key: value | [values] } or { key: { not: value } }) holds for the settings `own`; no `when` always does.
function matches(when = {}, own) {
  return Object.entries(when).every(([key, want]) => (want && typeof want === 'object' && !Array.isArray(want) ? own[key] !== want.not : [want].flat().includes(own[key])));
}

// One setting of the view, rule or agent `id` as a row: its label and hint, and a control by
// type (marked with its owner and the key), under a heading if it starts a
// `group`. `change(key, value)` saves a change; `paint(own)` shows the current value.
function fieldRow(field, id, change) {
  const text = el('span', 'pj-setting-text');
  text.append(el('span', 'pj-setting-label', field.label));
  if (field.hint) text.append(el('span', 'pj-setting-hint', field.hint));
  const line = el(field.type === 'switch' ? 'label' : 'div', 'pj-setting');
  let control;
  let paint;
  if (field.type === 'switch') {
    control = el('input', 'pj-switch');
    control.type = 'checkbox';
    control.addEventListener('change', () => change(field.key, control.checked));
    paint = (own) => { control.checked = own[field.key]; };
  } else if (field.type === 'choice') {
    control = el('div', 'pj-segmented');
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
  } else if (field.type === 'text') {
    control = el('input', 'pj-input');
    Object.assign(control, { type: 'text', spellcheck: false, autocomplete: 'off', ariaLabel: field.label });
    control.addEventListener('change', () => change(field.key, control.value.trim() || field.default)); // empty is the default again
    paint = (own) => {
      if (document.activeElement !== control) control.value = own[field.key];
    };
  } else if (field.type === 'secret') {
    // Never shown, only whether it is set: typing one in replaces it.
    const input = el('input', 'pj-input');
    Object.assign(input, { type: 'password', autocomplete: 'off', ariaLabel: field.label });
    input.addEventListener('change', () => {
      if (input.value.trim()) change(field.key, input.value.trim());
      input.value = '';
    });
    const clear = el('button', 'pj-link-button', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', () => change(field.key, ''));
    control = el('div', 'pj-setting-row');
    control.append(input, clear);
    paint = (own) => {
      input.placeholder = own[field.key] ? 'Set' : 'Not set';
      clear.hidden = !own[field.key];
    };
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
    control = el('div', 'pj-segmented pj-stepper');
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
  Object.assign(control.dataset, { owner: id, key: field.key });
  line.append(text, control);
  const node = el('div');
  if (field.group) node.append(el('h3', 'pj-setting-group', field.group));
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
      row.className = 'pj-shortcut';
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

/** Tooltips for every `[data-tip]`, with its `data-keys` shortcut; the page has one `.pj-tip`. */
export function setupTooltips() {
  const tip = document.querySelector('.pj-tip');
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
