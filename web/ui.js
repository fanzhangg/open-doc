// The chrome around the editor: the toolbar (reflecting the formatting at the
// caret), a formatting bubble over selections, the link popover, the "/" block
// menu, a floating outline, the word count, tooltips that show shortcuts, and
// the Settings dialog (name, theme, font, width, outline, word count, focus mode, shortcuts).

import { hydrateIcons, icon } from './icons.js';
import { api } from './api.js';
import { checkAgentPatch } from '../src/core/agents.js';
import { avatar } from './threads.js';

const BLOCK_LABELS = { paragraph: 'Normal text', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', code_block: 'Code block' };
const SLASH_ITEMS = [
  { command: 'paragraph', icon: 'text', label: 'Text', words: 'text paragraph normal p' },
  { command: 'h1', icon: 'heading', label: 'Heading 1', words: 'heading h1 title' },
  { command: 'h2', icon: 'heading', label: 'Heading 2', words: 'heading h2 subtitle' },
  { command: 'h3', icon: 'heading', label: 'Heading 3', words: 'heading h3' },
  { command: 'bullets', icon: 'bullets', label: 'Bulleted list', words: 'bullet list ul unordered' },
  { command: 'numbers', icon: 'numbers', label: 'Numbered list', words: 'numbered list ol ordered' },
  { command: 'quote', icon: 'quote', label: 'Quote', words: 'quote blockquote' },
  { command: 'codeBlock', icon: 'codeBlock', label: 'Code block', words: 'code block fence pre' },
  { command: 'table', icon: 'table', label: 'Table', words: 'table grid' },
  { command: 'divider', icon: 'divider', label: 'Divider', words: 'divider hr rule line separator' },
];
const SHORTCUTS = [
  ['Comments', [['Comment on the selection', 'Mod+Alt+M'], ['Post comment or reply', 'Enter'], ['New line in a comment', 'Shift+Enter'], ['Cancel', 'Esc']]],
  ['Text', [['Bold', 'Mod+B'], ['Italic', 'Mod+I'], ['Strikethrough', 'Mod+Alt+X'], ['Inline code', 'Mod+E'], ['Link', 'Mod+K']]],
  ['Blocks', [['Insert block', '/'], ['Normal text', 'Mod+Alt+0'], ['Heading 1–3', 'Mod+Alt+1…3'], ['Bulleted list', 'Mod+Alt+8'], ['Numbered list', 'Mod+Alt+7'], ['Quote', 'Mod+Shift+B'], ['Code block', 'Mod+Alt+C']]],
  ['App', [['Undo', 'Mod+Z'], ['Redo', 'Mod+Shift+Z'], ['Focus mode', 'Mod+Shift+F'], ['Settings', 'Mod+,'], ['Keyboard shortcuts', 'Mod+/']]],
];

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

/** "Mod+Shift+F" → "Ctrl+Shift+F", or "⌘⇧F" on a Mac. */
export function keyLabel(keys) {
  if (!mac) return keys.replace(/Mod/g, 'Ctrl');
  const map = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Enter: '↩', Esc: 'esc' };
  return keys.split('+').map((k) => map[k] ?? k).join('');
}

/**
 * @param {{ editor: object, onComment: () => void, settings: ReturnType<typeof import('./settings.js').createSettings>,
 *           getName: () => string, setName: (name: string) => boolean,
 *           onAgentResult: (result: { settings?, sidecar?, agents? }) => void }} options
 */
export function createChrome({ editor, onComment, settings: store, getName, setName, onAgentResult }) {
  hydrateIcons();
  for (const kbd of document.querySelectorAll('kbd[data-keys]')) kbd.textContent = keyLabel(kbd.dataset.keys);
  setupTooltips();

  const settings = setupSettings({ store, getName, setName });
  const agentSettings = setupAgentSettings({ store, onResult: onAgentResult });
  const toolbar = document.querySelector('.od-toolbar');
  const bubble = document.querySelector('.od-bubble');
  const slash = setupSlash(editor);
  const link = setupLink(editor);
  const outline = setupOutline(editor);
  const blockPicker = setupBlockPicker(editor);
  const count = document.querySelector('.od-count');

  // Toolbar and bubble buttons act on the editor without taking its selection.
  for (const bar of [toolbar, bubble]) {
    bar.addEventListener('mousedown', (event) => {
      const target = event.target.closest('button');
      if (!target || target.closest('.od-block-picker')) return;
      event.preventDefault();
      if (target.dataset.action === 'comment') onComment();
      else if (target.dataset.command === 'link') link.toggle(target);
      else if (target.dataset.command) editor.run(target.dataset.command);
    });
  }

  // ---- reflect the editor's state ----

  let frame = 0;
  editor.onUi(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  });

  function refresh() {
    const { active, block, canUndo, canRedo } = editor.formatState();
    for (const button of document.querySelectorAll('.od-toolbar [data-command], .od-bubble [data-command]')) {
      const { command } = button.dataset;
      if (command === 'undo' || command === 'redo') {
        button.disabled = !(command === 'undo' ? canUndo : canRedo);
        continue;
      }
      button.setAttribute('aria-pressed', String(active.has(button.dataset.command)));
    }
    blockPicker.show(block);
    placeBubble();
    slash.refresh();
    outline.refresh();
    const { words, selected } = editor.counts();
    count.textContent = selected ? `${selected.toLocaleString()} of ${plural(words, 'word')}` : plural(words, 'word');
  }

  // ---- selection bubble ----

  let pointerDown = false;
  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('.od-editor') && !event.target.closest('.od-history-stage')) pointerDown = true;
  });
  document.addEventListener('mouseup', () => {
    if (!pointerDown) return;
    pointerDown = false;
    requestAnimationFrame(placeBubble);
  });

  function placeBubble() {
    const rect = !pointerDown && editor.selectionRect();
    if (!rect) {
      bubble.hidden = true;
      return;
    }
    bubble.querySelector('[data-action="comment"]').hidden = !rect.commentable;
    bubble.hidden = false;
    const stage = bubble.offsetParent.getBoundingClientRect();
    const page = document.querySelector('.od-page').getBoundingClientRect();
    const canvasTop = document.querySelector('.od-canvas').getBoundingClientRect().top;
    const { offsetWidth: width, offsetHeight: height } = bubble;
    const center = (rect.left + rect.right) / 2;
    const left = Math.min(Math.max(center - width / 2, page.left + 8), page.right - width - 8);
    const above = rect.top - height - 10 > canvasTop;
    const top = above ? rect.top - height - 10 : rect.bottom + 10;
    bubble.style.left = `${left - stage.left}px`;
    bubble.style.top = `${top - stage.top}px`;
    bubble.dataset.side = above ? 'above' : 'below';
  }
  document.querySelector('.od-canvas').addEventListener('scroll', () => {
    if (!bubble.hidden) placeBubble();
  }, { passive: true });

  // ---- global shortcuts ----

  document.addEventListener('keydown', (event) => {
    const mod = mac ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey && (event.key === '/' || event.key === ',')) {
      event.preventDefault();
      settings.toggle(event.key === '/' ? 'shortcuts' : 'general');
    } else if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      settings.set({ focus: !settings.get().focus });
    } else if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k' && event.target.closest?.('.od-editor')) {
      event.preventDefault();
      link.toggle();
    }
  });

  refresh();
  return {
    hideBubble() {
      bubble.hidden = true;
    },
    /** The statuses of the doc's agents changed. */
    agentStatus(statuses) {
      agentSettings.showStatus(statuses);
    },
    /** Open Settings > Agents on agent `id` (or the first one). */
    openAgent(id) {
      agentSettings.select(id);
      settings.open('agents');
    },
    /** A command from the desktop app's menu: 'settings', 'agent-settings' or 'shortcuts'. */
    command(name) {
      if (name === 'settings') settings.toggle('general');
      else if (name === 'agent-settings') settings.toggle('agents');
      else if (name === 'shortcuts') settings.toggle('shortcuts');
    },
  };
}

// ---- link popover: the URL for the selection or the link at the caret ----

// Enter applies, an empty URL removes the link, Escape or clicking away
// cancels. It sits under the text it links, or under the button that opened
// it when that text is out of view.
function setupLink(editor) {
  const popover = document.querySelector('.od-link');
  const input = popover.querySelector('.od-link-input');
  const unlink = popover.querySelector('[data-action="unlink"]');
  const canvas = document.querySelector('.od-canvas');
  let button = null; // the toolbar or bubble button it opened from

  function open(from) {
    button = from ?? null;
    const href = editor.beginLink();
    input.value = href ?? '';
    unlink.hidden = href === null;
    popover.hidden = false;
    place();
    input.focus();
    input.select();
  }

  // `href`: the URL to set, '' to remove the link, null to cancel.
  function close(href) {
    if (popover.hidden) return;
    popover.hidden = true;
    button = null;
    editor.endLink(href);
  }

  function place() {
    const rect = editor.linkRect();
    const view = canvas.getBoundingClientRect();
    const visible = rect && rect.bottom > view.top && rect.top < view.bottom;
    const shown = button?.isConnected && button.getClientRects().length > 0;
    const anchor = visible || !shown ? rect : button.getBoundingClientRect();
    if (!anchor) return;
    const { offsetWidth: width, offsetHeight: height } = popover;
    const left = visible ? rect.left - 10 : (anchor.left + anchor.right) / 2 - width / 2;
    const below = anchor.bottom + 8 + height < window.innerHeight - 8;
    popover.style.left = `${Math.min(Math.max(left, 8), window.innerWidth - width - 8)}px`;
    popover.style.top = `${below ? anchor.bottom + 8 : anchor.top - height - 8}px`;
  }

  popover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(null);
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      close(input.value.trim());
    } else if (event.key === 'Tab') {
      // Focus stays in the popover: the URL, Apply, Remove.
      const stops = [...popover.querySelectorAll('input, button:not([hidden])')];
      const next = stops.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1);
      if (next < 0 || next >= stops.length) {
        event.preventDefault();
        stops.at(next < 0 ? -1 : 0).focus();
      }
    }
  });
  popover.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'apply') close(input.value.trim());
    else if (action === 'unlink') close('');
  });
  // Clicking anywhere else cancels; the link buttons toggle it themselves.
  document.addEventListener('mousedown', (event) => {
    if (popover.hidden || popover.contains(event.target) || event.target.closest?.('[data-command="link"]')) return;
    close(null);
  }, true);
  canvas.addEventListener('scroll', () => {
    if (!popover.hidden) place();
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (!popover.hidden) place();
  });

  return {
    /** Open for the selection (`from`: the button that asked), or cancel when open. */
    toggle(from) {
      if (popover.hidden) open(from);
      else close(null);
    },
  };
}

// ---- settings: a dialog with General, Appearance, Editor and Shortcuts ----

// Settings are saved for every doc and window (see settings.js); a change
// made in another window shows up here too.
function setupSettings({ store, getName, setName }) {
  const dialog = document.querySelector('.od-settings');
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const sections = [...dialog.querySelectorAll('.od-settings-section')];
  const nameInput = dialog.querySelector('#od-name-input');
  const nameError = dialog.querySelector('.od-input-error');

  fillShortcuts(dialog.querySelector('.od-shortcuts-body'));

  function apply() {
    const settings = store.get();
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    root.dataset.font = settings.font;
    root.dataset.width = settings.width;
    root.toggleAttribute('data-focus', settings.focus);
    root.toggleAttribute('data-no-outline', !settings.outline);
    document.querySelector('.od-count').hidden = !settings.wordCount;
    const mark = (selector, attr, value) => {
      for (const button of dialog.querySelectorAll(selector)) button.setAttribute('aria-checked', String(button.dataset[attr] === value));
    };
    mark('[data-font]', 'font', settings.font);
    mark('[data-theme-choice]', 'themeChoice', settings.theme);
    mark('[data-width]', 'width', settings.width);
    for (const box of dialog.querySelectorAll('[data-setting]')) box.checked = Boolean(settings[box.dataset.setting]);
    if (document.activeElement !== nameInput) nameInput.value = getName();
    window.dispatchEvent(new Event('resize')); // the comment margin re-lays out
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
    else if (button.getAttribute('role') === 'tab') show(button.dataset.section);
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

  apply();
  return {
    get: () => store.get(),
    set,
    open,
    /** Open on `section`, or close when it is already showing that section. */
    toggle(section) {
      const showing = dialog.open && !sections.find((panel) => panel.dataset.section === section).hidden;
      if (showing) dialog.close();
      else open(section);
    },
  };
}

// ---- Settings > Agents ----

const AGENT_STATES = {
  starting: 'Connecting…',
  ready: 'Online in this doc',
  queued: 'Online in this doc · waiting for its turn',
  running: 'Online in this doc · working',
  error: 'Offline: the last run failed',
  limited: 'Offline: hourly run limit reached',
  unavailable: 'Offline',
  stopped: 'Offline',
};

// Asked before an agent may ask to reach beyond the doc. It still asks the
// human at first use (src/core/grants.js), but a yes there is quick.
const BOTH_RISK = 'With web search and other files both on, the agent could be tricked into sending your files to a website.';
const ACCESS_RISKS = {
  webAccess: {
    ask: 'Let the agent ask to search the web and open web pages?\n\n'
      + 'It asks you the first time. A web page can hide instructions that trick the agent into sending this doc to a website.',
    other: 'fileAccess',
  },
  fileAccess: {
    ask: 'Let the agent ask to read files other than this doc?\n\n'
      + 'It asks you the first time. Allowed, it can read files on this computer except keys and .env files, and a file can hide instructions it follows.',
    other: 'webAccess',
  },
};

// The user's agents, for every doc: a list to pick one from (the pilot
// first), and its profile (name, job, persona, role, permissions, what it runs
// on, limits).
// Changes save through the server as they are made. An agent's program (a
// custom command, or where Claude Code is) is set through the desktop app,
// which asks the user to confirm it; in a browser tab those fields are read-only.
function setupAgentSettings({ store, onResult }) {
  const section = document.querySelector('.od-settings-section[data-section="agents"]');
  const desktop = window.opendocDesktop;
  const list = section.querySelector('.od-roster-list');
  const form = section.querySelector('.od-agent-editor');
  const stateText = section.querySelector('.od-agent-state-text');
  const check = section.querySelector('[data-action="agent-check"]');
  const hooks = section.querySelector('.od-agent-hooks');
  const nameError = form.querySelector('.od-input-error');
  const roleHint = form.querySelector('.od-agent-role-hint');
  const makePilot = form.querySelector('[data-action="make-pilot"]');
  const remove = form.querySelector('[data-action="delete-agent"]');
  let statuses = [];
  let selected = null; // the id of the agent shown

  section.querySelector('.od-program-note').hidden = Boolean(desktop);
  for (const button of section.querySelectorAll('[data-action="choose-program"]')) button.hidden = !desktop;
  for (const input of section.querySelectorAll('[data-agent-program], [data-program]')) input.readOnly = !desktop;

  const agents = () => store.get().agents;
  const current = () => agents().find((a) => a.id === selected) ?? null;
  const statusOf = (agent) => statuses.find((s) => (s.id ? s.id === agent.id : s.name.toLowerCase() === agent.name.toLowerCase())) ?? null;
  const valid = (patch) => {
    try {
      checkAgentPatch(patch);
      return true;
    } catch {
      return false;
    }
  };

  async function save(patch) {
    const agent = current();
    if (!agent || !valid(patch)) return false;
    try {
      onResult(await api.updateAgent(agent.id, patch));
      return true;
    } catch (error) {
      if (Object.hasOwn(patch, 'name')) {
        nameError.textContent = error.message;
        nameError.hidden = false;
      }
      paint();
      return false;
    }
  }

  function paint() {
    const roster = [...agents()].sort((a, b) => Number(b.role === 'pilot') - Number(a.role === 'pilot'));
    if (selected && !roster.some((a) => a.id === selected)) selected = null;
    selected ??= roster[0]?.id ?? null;
    list.replaceChildren(...roster.map((agent) => {
      const row = el('button', 'od-roster-row');
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(agent.id === selected));
      row.dataset.agentId = agent.id;
      const who = el('span', 'od-roster-who');
      const name = el('span', 'od-roster-name', agent.name);
      if (agent.role === 'pilot') name.append(el('span', 'od-role', 'Pilot'));
      who.append(name, el('span', 'od-roster-sub', agent.tagline || firstLine(agent.persona) || 'No job yet'));
      row.append(avatar(agent.name, 'agent', true), who);
      if (statusOf(agent)) row.append(el('span', 'od-roster-here', 'In this doc'));
      return row;
    }));

    const agent = current();
    form.hidden = !agent;
    if (!agent) return;
    form.dataset.kind = agent.runtime;
    const mark = (attr, value) => {
      for (const button of form.querySelectorAll(`[data-${attr}]`)) {
        button.setAttribute('aria-checked', String(button.getAttribute(`data-${attr}`) === value));
      }
    };
    mark('agent-runtime', agent.runtime);
    mark('agent-edit-mode', agent.editMode);
    const pilot = agent.role === 'pilot';
    roleHint.textContent = pilot
      ? 'Pilot: in every doc, answers every comment that does not @mention someone else.'
      : 'Co-pilot: answers when @mentioned (which also brings it into the doc), and follow-ups in its own threads.';
    makePilot.hidden = pilot;
    remove.disabled = pilot;
    remove.title = pilot ? 'Make another agent the pilot to delete this one' : '';
    for (const box of form.querySelectorAll('input[type="checkbox"][data-agent]')) box.checked = Boolean(agent[box.dataset.agent]);
    for (const input of form.querySelectorAll('input[data-agent]:not([type="checkbox"]), textarea[data-agent], input[data-agent-program]')) {
      if (document.activeElement === input) continue;
      const key = input.dataset.agent ?? input.dataset.agentProgram;
      input.value = agent[key] ?? '';
      input.removeAttribute('aria-invalid');
    }
    for (const bin of section.querySelectorAll('[data-program]')) {
      if (document.activeElement !== bin) bin.value = store.get()[bin.dataset.program] ?? '';
    }
    paintStatus();
  }

  function paintStatus() {
    const agent = current();
    if (!agent) return;
    const status = statusOf(agent);
    let text;
    let state = status?.state ?? 'off';
    if (!status) {
      text = agent.role === 'pilot' ? 'Starting…' : `Not in this doc. @${agent.name} in a comment brings it in.`;
    } else {
      text = AGENT_STATES[status.state] ?? status.state;
      if (status.error) text += `: ${status.error.replace(/\u001b\[[0-9;]*m/g, '')}`;
      else if (status.program && ['ready', 'running'].includes(status.state)) text += ` · ${status.program}`;
    }
    form.dataset.agentState = state;
    stateText.textContent = text;
    check.hidden = !status || !['unavailable', 'error'].includes(status.state);
    hooks.textContent = status?.warning ? `Note: ${status.warning}.` : '';
    hooks.hidden = !status?.warning;
  }

  section.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.agentId) {
      selected = button.dataset.agentId;
      nameError.hidden = true;
      paint();
    } else if (button.dataset.agentRuntime) save({ runtime: button.dataset.agentRuntime });
    else if (button.dataset.agentEditMode) save({ editMode: button.dataset.agentEditMode });
    else if (button.dataset.action === 'make-pilot') save({ role: 'pilot' });
    else if (button.dataset.action === 'choose-program') desktop?.chooseProgram(button.dataset.programKey).catch(() => {});
    else if (button.dataset.action === 'new-agent') {
      try {
        const result = await api.createAgent({ name: 'agent' });
        selected = result.agent.id;
        onResult(result);
        form.querySelector('[data-agent="name"]').focus();
        form.querySelector('[data-agent="name"]').select();
      } catch {
        // at most MAX_AGENTS; the list shows what there is
      }
    } else if (button.dataset.action === 'delete-agent') {
      const agent = current();
      if (!agent || agent.role === 'pilot' || !window.confirm(`Delete ${agent.name}?\n\nIt leaves this doc and stops answering in every doc. Its comments stay.`)) return;
      try {
        onResult(await api.deleteAgent(agent.id));
      } catch {
        // already gone
      }
    } else if (button.dataset.action === 'agent-check') {
      const status = current() && statusOf(current());
      if (!status) return;
      check.disabled = true;
      try {
        const next = await api.agentAction(status.name, 'retry');
        showStatus(statuses.map((s) => (s === status ? next : s)));
      } catch {
        // it left the doc meanwhile
      } finally {
        check.disabled = false;
      }
    }
  });

  form.addEventListener('change', (event) => {
    const input = event.target;
    if (input.type === 'checkbox' && input.dataset.agent) {
      const risk = ACCESS_RISKS[input.dataset.agent];
      if (risk && input.checked && !window.confirm(current()?.[risk.other] ? `${risk.ask}\n\n${BOTH_RISK}` : risk.ask)) {
        input.checked = false;
        return;
      }
      return save({ [input.dataset.agent]: input.checked });
    }
    if (input.dataset.agentProgram) return setProgram(input, 'command', current()?.id);
    const key = input.dataset.agent;
    if (!key) return;
    const raw = key === 'persona' ? input.value : input.value.trim();
    if (key === 'name' && raw === '') return paint();
    let value = raw;
    if (input.type === 'number') value = raw === '' ? null : Number(raw);
    else if (key === 'model') value = raw || null;
    if (!valid({ [key]: value })) {
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    input.removeAttribute('aria-invalid');
    nameError.hidden = true;
    save({ [key]: value });
  });
  form.addEventListener('focusout', (event) => {
    if (event.target.matches?.('[aria-invalid="true"]')) paint(); // an invalid value is not kept
  });
  for (const bin of section.querySelectorAll('[data-program]')) bin.addEventListener('change', (event) => setProgram(event.target, bin.dataset.program));

  async function setProgram(input, key, id = null) {
    const before = () => (key === 'command' ? current()?.command : store.get()[key]) ?? '';
    if (!desktop) return;
    try {
      const done = await desktop.setAgentProgram(key, input.value.trim() || null, id);
      if (!done) input.value = before();
    } catch {
      input.value = before();
    }
  }

  function showStatus(next) {
    statuses = next ?? [];
    paint();
  }

  store.subscribe(paint);
  paint();
  return {
    showStatus,
    /** Show agent `id`'s profile (the dialog opens on the section separately). */
    select(id) {
      if (id) selected = id;
      nameError.hidden = true;
      paint();
    },
  };
}

const firstLine = (text) => {
  const line = (text ?? '').trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

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

// ---- "Normal text ▾" block style picker ----

function setupBlockPicker(editor) {
  const root = document.querySelector('.od-block-picker');
  const button = root.querySelector('.od-block-button');
  const label = root.querySelector('.od-block-label');
  const menu = root.querySelector('.od-block-menu');
  button.append(icon('chevron', 'od-icon od-chevron'));

  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  });
  menu.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const item = event.target.closest('[data-command]');
    if (!item) return;
    close();
    editor.run(item.dataset.command);
  });
  document.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !root.contains(event.target)) close();
  });

  return {
    show(block) {
      label.textContent = BLOCK_LABELS[block] ?? 'Normal text';
      for (const item of menu.children) item.setAttribute('aria-selected', String(item.dataset.block === block));
    },
  };
}

// ---- "/" menu ----

function setupSlash(editor) {
  const menu = document.querySelector('.od-slash');
  let range = null;
  let items = [];
  let selected = 0;
  let dismissedAt = null; // slash position the human closed with Escape

  function refresh() {
    const query = editor.slashQuery();
    if (!query || query.from === dismissedAt) {
      if (!query) dismissedAt = null;
      return close();
    }
    const q = query.query.toLowerCase();
    const next = SLASH_ITEMS.filter((item) => !q || `${item.label} ${item.words}`.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
    if (next.length === 0) return close();
    if (range?.from !== query.from || items.length !== next.length) selected = 0;
    range = query;
    items = next;
    draw();
    const stage = menu.offsetParent.getBoundingClientRect();
    const at = editor.coordsAt(query.from);
    const room = window.innerHeight - at.bottom;
    menu.style.left = `${at.left - stage.left}px`;
    menu.style.top = room < menu.offsetHeight + 16 ? `${at.top - stage.top - menu.offsetHeight - 6}px` : `${at.bottom - stage.top + 6}px`;
  }

  function draw() {
    menu.replaceChildren(...items.map((item, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === selected));
      const label = document.createElement('span');
      label.className = 'od-slash-label';
      label.textContent = item.label;
      const glyph = document.createElement('span');
      glyph.className = 'od-slash-icon';
      glyph.append(icon(item.icon));
      li.append(glyph, label);
      li.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(i);
      });
      li.addEventListener('mousemove', () => {
        if (selected === i) return;
        selected = i;
        draw();
      });
      return li;
    }));
    menu.hidden = false;
    menu.children[selected]?.scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const item = items[i];
    const at = range;
    close();
    editor.runSlash(at, item.command);
  }

  function close() {
    menu.hidden = true;
    range = null;
    items = [];
  }

  editor.setKeyHandler((event) => {
    if (menu.hidden) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      draw();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      pick(selected);
      return true;
    }
    if (event.key === 'Escape') {
      dismissedAt = range.from;
      close();
      return true;
    }
    return false;
  });

  return { refresh };
}

// ---- outline: a tick per heading at the left edge, a list on hover ----

function setupOutline(editor) {
  const nav = document.querySelector('.od-outline');
  const ticks = nav.querySelector('.od-outline-ticks');
  const list = nav.querySelector('.od-outline-list');
  const canvas = document.querySelector('.od-canvas');
  let signature = '';
  let current = [];

  function refresh() {
    const headings = editor.headings();
    const next = JSON.stringify(headings.map((h) => [h.level, h.text]));
    current = headings;
    if (next === signature) return;
    signature = next;
    nav.hidden = headings.length < 2;
    const minLevel = Math.min(...headings.map((h) => h.level));
    ticks.replaceChildren(...headings.map((h) => {
      const tick = document.createElement('i');
      tick.dataset.depth = String(h.level - minLevel);
      return tick;
    }));
    list.replaceChildren(...headings.map((h, i) => {
      const li = document.createElement('li');
      const link = document.createElement('button');
      link.type = 'button';
      link.dataset.depth = String(h.level - minLevel);
      link.textContent = h.text;
      link.addEventListener('click', () => editor.scrollToHeading(current[i].pos));
      li.append(link);
      return li;
    }));
    markActive();
  }

  function markActive() {
    const top = canvas.getBoundingClientRect().top + 96;
    const elements = [...document.querySelectorAll('.od-stage:not(.od-history-stage) .od-editor .ProseMirror > :is(h1, h2, h3, h4, h5, h6)')].filter((h) => h.textContent.trim());
    let active = 0;
    elements.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= top) active = i;
    });
    [...ticks.children].forEach((tick, i) => tick.classList.toggle('od-on', i === active));
    [...list.querySelectorAll('button')].forEach((link, i) => link.classList.toggle('od-on', i === active));
  }
  canvas.addEventListener('scroll', () => requestAnimationFrame(markActive), { passive: true });

  return { refresh };
}

// ---- tooltips: label plus shortcut, after a short hover ----

function setupTooltips() {
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

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}
