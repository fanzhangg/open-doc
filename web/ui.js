// The chrome around the editor: the toolbar (reflecting the formatting at the
// caret), a formatting bubble over selections, the link popover, the "/" block
// menu, a floating outline, the word count, tooltips that show shortcuts, and
// the Settings dialog (name, theme, font, width, outline, word count, focus mode, shortcuts).

import { hydrateIcons, icon } from './icons.js';
import { api } from './api.js';
import { checkSettingsPatch } from '../src/core/settings.js';

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
  { command: 'comment', icon: 'comment', label: 'Comment', words: 'comment ask ai agent' },
];
const SHORTCUTS = [
  ['Comments', [['Add comment', 'Mod+Alt+M'], ['Post comment or reply', 'Enter'], ['New line in a comment', 'Shift+Enter'], ['Cancel', 'Esc']]],
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
 *           agentSource: 'settings' | 'flags' | 'none' }} options
 */
export function createChrome({ editor, onComment, settings: store, getName, setName, agentSource }) {
  hydrateIcons();
  for (const kbd of document.querySelectorAll('kbd[data-keys]')) kbd.textContent = keyLabel(kbd.dataset.keys);
  setupTooltips();

  const settings = setupSettings({ store, getName, setName });
  const agentSettings = setupAgentSettings({ store, source: agentSource });
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
    const { active, block } = editor.formatState();
    for (const button of document.querySelectorAll('.od-toolbar [data-command], .od-bubble [data-command]')) {
      if (['undo', 'redo'].includes(button.dataset.command)) continue;
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
    if (event.target.closest('.od-editor')) pointerDown = true;
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
    /** The agent's status changed (or it stopped: null). */
    agentStatus(status) {
      agentSettings.showStatus(status);
    },
    /** A command from the desktop app's menu: 'settings' or 'shortcuts'. */
    command(name) {
      if (name === 'settings') settings.toggle('general');
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
  document.querySelector('.od-me').addEventListener('click', () => open('general'));

  apply();
  return {
    get: () => store.get(),
    set,
    /** Open on `section`, or close when it is already showing that section. */
    toggle(section) {
      const showing = dialog.open && !sections.find((panel) => panel.dataset.section === section).hidden;
      if (showing) dialog.close();
      else open(section);
    },
  };
}

// ---- Settings > Agent ----

const AGENT_STATES = {
  starting: 'Getting ready…',
  ready: 'Ready',
  running: 'Working on comments',
  paused: 'Paused',
  error: 'The last run failed',
  limited: 'Taking a break (hourly run limit)',
  unavailable: 'Unavailable',
  stopped: 'Stopped',
};

// The agent settings apply to every doc. Its program (the custom command or
// the Claude Code path) is set through the desktop app, which asks the user
// to confirm it; in a browser tab those fields are read-only.
function setupAgentSettings({ store, source }) {
  const section = document.querySelector('.od-settings-section[data-section="agent"]');
  const desktop = window.opendocDesktop;
  const stateText = section.querySelector('.od-agent-state-text');
  const check = section.querySelector('[data-action="agent-check"]');
  const warning = section.querySelector('.od-agent-warning');
  const options = section.querySelector('.od-agent-options');
  let status = null;

  section.querySelector('.od-agent-flags').hidden = source !== 'flags';
  section.querySelector('.od-program-note').hidden = Boolean(desktop);
  section.querySelector('[data-action="choose-claude"]').hidden = !desktop;
  for (const input of section.querySelectorAll('[data-agent-program]')) input.readOnly = !desktop;

  const agent = () => store.get().agent;
  const valid = (patch) => {
    try {
      checkSettingsPatch({ agent: patch });
      return true;
    } catch {
      return false;
    }
  };
  const set = (patch) => {
    if (valid(patch)) store.set({ agent: patch });
  };

  function paint() {
    const current = agent();
    section.dataset.kind = current.kind;
    section.querySelector('[data-agent="enabled"]').checked = current.enabled;
    section.querySelector('[data-agent="isolated"]').checked = current.isolated;
    options.toggleAttribute('data-off', !current.enabled);
    for (const button of section.querySelectorAll('[data-agent-kind]')) {
      button.setAttribute('aria-checked', String(button.dataset.agentKind === current.kind));
    }
    for (const button of section.querySelectorAll('[data-agent-mentions]')) {
      button.setAttribute('aria-checked', String(button.dataset.agentMentions === String(current.mentionsOnly)));
    }
    for (const input of section.querySelectorAll('input[data-agent]:not([type="checkbox"]), input[data-agent-program]')) {
      if (document.activeElement === input) continue;
      const key = input.dataset.agent ?? input.dataset.agentProgram;
      input.value = current[key] ?? '';
      input.removeAttribute('aria-invalid');
    }
    paintStatus();
  }

  function paintStatus() {
    const current = agent();
    let text;
    let state = status?.state ?? 'off';
    if (!status && (source === 'flags' || !current.enabled)) {
      text = 'Off. Turn it on to have the agent answer comments.';
    } else if (!status) {
      state = 'starting';
      text = AGENT_STATES.starting;
    } else {
      text = AGENT_STATES[status.state] ?? status.state;
      if (status.error) text += `: ${status.error}`;
      else if (status.program && ['ready', 'running', 'paused'].includes(status.state)) text += ` · ${status.program}`;
    }
    section.dataset.agentState = state;
    stateText.textContent = text;
    check.hidden = !status || !['unavailable', 'error'].includes(status.state);
    warning.textContent = status?.warning ? `Note: ${status.warning}.` : '';
    warning.hidden = !status?.warning;
  }

  section.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.agentKind) set({ kind: button.dataset.agentKind });
    else if (button.dataset.agentMentions) set({ mentionsOnly: button.dataset.agentMentions === 'true' });
    else if (button.dataset.action === 'choose-claude') desktop?.chooseClaude().catch(() => {});
    else if (button.dataset.action === 'agent-check') {
      check.disabled = true;
      try {
        showStatus(await api.agentAction('retry'));
      } catch {
        // no agent running here (yet)
      } finally {
        check.disabled = false;
      }
    }
  });

  section.addEventListener('change', (event) => {
    const input = event.target;
    if (input.type === 'checkbox' && input.dataset.agent) return set({ [input.dataset.agent]: input.checked });
    if (input.dataset.agentProgram) return setProgram(input);
    const key = input.dataset.agent;
    if (!key) return;
    const raw = input.value.trim();
    let value = raw;
    if (input.type === 'number') value = raw === '' ? null : Number(raw);
    else if (key === 'model') value = raw || null;
    if (!valid({ [key]: value })) {
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    input.removeAttribute('aria-invalid');
    set({ [key]: value });
  });
  section.addEventListener('focusout', (event) => {
    if (event.target.matches?.('input[aria-invalid="true"]')) paint(); // an invalid value is not kept
  });

  async function setProgram(input) {
    if (!desktop) return;
    try {
      const done = await desktop.setAgentProgram(input.dataset.agentProgram, input.value.trim() || null);
      if (!done) input.value = agent()[input.dataset.agentProgram] ?? '';
    } catch {
      input.value = agent()[input.dataset.agentProgram] ?? '';
    }
  }

  function showStatus(next) {
    status = next;
    paintStatus();
  }

  store.subscribe(paint);
  paint();
  return { showStatus };
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
    const elements = [...document.querySelectorAll('.od-editor .ProseMirror > :is(h1, h2, h3, h4, h5, h6)')].filter((h) => h.textContent.trim());
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
