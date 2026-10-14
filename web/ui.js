// The chrome around the editor: the toolbar (reflecting the formatting at the
// caret), a formatting bubble over selections, the "/" block menu, a floating
// outline, the word count, display options (font, theme, width, focus
// mode), tooltips that show shortcuts, and the keyboard shortcut sheet.

import { hydrateIcons, icon } from './icons.js';

const DISPLAY_KEY = 'opendoc.display';
const DEFAULTS = { font: 'sans', theme: 'system', width: 'normal', focus: false };
const BLOCK_LABELS = { paragraph: 'Normal text', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', code_block: 'Code block' };
const SLASH_ITEMS = [
  { command: 'paragraph', icon: 'text', label: 'Text', hint: 'Plain paragraph', words: 'text paragraph normal p' },
  { command: 'h1', icon: 'heading', label: 'Heading 1', hint: 'Big section heading', words: 'heading h1 title' },
  { command: 'h2', icon: 'heading', label: 'Heading 2', hint: 'Medium section heading', words: 'heading h2 subtitle' },
  { command: 'h3', icon: 'heading', label: 'Heading 3', hint: 'Small section heading', words: 'heading h3' },
  { command: 'bullets', icon: 'bullets', label: 'Bulleted list', hint: 'A simple list', words: 'bullet list ul unordered' },
  { command: 'numbers', icon: 'numbers', label: 'Numbered list', hint: 'A list with numbers', words: 'numbered list ol ordered' },
  { command: 'quote', icon: 'quote', label: 'Quote', hint: 'Capture a quotation', words: 'quote blockquote' },
  { command: 'codeBlock', icon: 'codeBlock', label: 'Code block', hint: 'Fenced code', words: 'code block fence pre' },
  { command: 'table', icon: 'table', label: 'Table', hint: '3 × 3 table', words: 'table grid' },
  { command: 'divider', icon: 'divider', label: 'Divider', hint: 'Horizontal rule', words: 'divider hr rule line separator' },
  { command: 'comment', icon: 'comment', label: 'Comment on the doc', hint: 'Ask a question or request a change', words: 'comment ask ai agent' },
];
const SHORTCUTS = [
  ['Comments', [['Add comment', 'Mod+Alt+M'], ['Post comment or reply', 'Enter'], ['New line in a comment', 'Shift+Enter'], ['Cancel', 'Esc']]],
  ['Text', [['Bold', 'Mod+B'], ['Italic', 'Mod+I'], ['Strikethrough', 'Mod+Alt+X'], ['Inline code', 'Mod+E']]],
  ['Blocks', [['Insert block', '/'], ['Normal text', 'Mod+Alt+0'], ['Heading 1–3', 'Mod+Alt+1…3'], ['Bulleted list', 'Mod+Alt+8'], ['Numbered list', 'Mod+Alt+7'], ['Quote', 'Mod+Shift+B'], ['Code block', 'Mod+Alt+C']]],
  ['App', [['Undo', 'Mod+Z'], ['Redo', 'Mod+Shift+Z'], ['Focus mode', 'Mod+Shift+F'], ['Keyboard shortcuts', 'Mod+/']]],
];

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

/** "Mod+Shift+F" → "Ctrl+Shift+F", or "⌘⇧F" on a Mac. */
export function keyLabel(keys) {
  if (!mac) return keys.replace(/Mod/g, 'Ctrl');
  const map = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Enter: '↩', Esc: 'esc' };
  return keys.split('+').map((k) => map[k] ?? k).join('');
}

/**
 * @param {{ editor: object, onComment: () => void }} options
 */
export function createChrome({ editor, onComment }) {
  hydrateIcons();
  for (const kbd of document.querySelectorAll('kbd[data-keys]')) kbd.textContent = keyLabel(kbd.dataset.keys);
  setupTooltips();

  const display = setupDisplay();
  const toolbar = document.querySelector('.od-toolbar');
  const bubble = document.querySelector('.od-bubble');
  const slash = setupSlash(editor);
  const outline = setupOutline(editor);
  const blockPicker = setupBlockPicker(editor);
  const count = document.querySelector('.od-count');
  const shortcuts = setupShortcuts();

  // Toolbar and bubble buttons act on the editor without taking its selection.
  for (const bar of [toolbar, bubble]) {
    bar.addEventListener('mousedown', (event) => {
      const target = event.target.closest('button');
      if (!target || target.closest('.od-block-picker')) return;
      event.preventDefault();
      if (target.dataset.action === 'comment') onComment();
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
    if (mod && !event.altKey && event.key === '/') {
      event.preventDefault();
      shortcuts.toggle();
    } else if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      display.set({ focus: !display.get().focus });
    }
  });

  refresh();
  return {
    /** Show "Resolved (n)" on the toolbar toggle. */
    setResolvedCount(n) {
      document.querySelector('.od-resolved-label').textContent = n ? `Resolved · ${n}` : 'Resolved';
    },
    hideBubble() {
      bubble.hidden = true;
    },
  };
}

// ---- display options: font, theme, width, focus ----

function setupDisplay() {
  const toggle = document.querySelector('.od-display-toggle');
  const panel = document.querySelector('.od-display');
  let settings = { ...DEFAULTS };
  try {
    settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? '{}') };
  } catch {
    // storage unavailable or corrupt: defaults
  }

  function apply() {
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    root.dataset.font = settings.font;
    root.dataset.width = settings.width;
    root.toggleAttribute('data-focus', settings.focus);
    const mark = (selector, attr, value) => {
      for (const button of panel.querySelectorAll(selector)) button.setAttribute('aria-checked', String(button.dataset[attr] === value));
    };
    mark('[data-font]', 'font', settings.font);
    mark('[data-theme-choice]', 'themeChoice', settings.theme);
    mark('[data-width]', 'width', settings.width);
    panel.querySelector('[data-setting="focus"]').checked = settings.focus;
    window.dispatchEvent(new Event('resize')); // the comment margin re-lays out
  }

  function set(patch) {
    settings = { ...settings, ...patch };
    try {
      localStorage.setItem(DISPLAY_KEY, JSON.stringify(settings));
    } catch {
      // storage unavailable: applies to this visit only
    }
    apply();
  }

  panel.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.font) set({ font: button.dataset.font });
    else if (button.dataset.themeChoice) set({ theme: button.dataset.themeChoice });
    else if (button.dataset.width) set({ width: button.dataset.width });
    else if (button.dataset.action === 'shortcuts') {
      close();
      document.querySelector('.od-shortcuts').showModal();
    }
  });
  panel.querySelector('[data-setting="focus"]').addEventListener('change', (event) => set({ focus: event.target.checked }));

  const close = () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  document.addEventListener('mousedown', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) close();
  });

  apply();
  return { get: () => settings, set };
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
      const text = document.createElement('span');
      text.className = 'od-slash-text';
      const label = document.createElement('span');
      label.className = 'od-slash-label';
      label.textContent = item.label;
      const hint = document.createElement('span');
      hint.className = 'od-slash-hint';
      hint.textContent = item.hint;
      text.append(label, hint);
      const glyph = document.createElement('span');
      glyph.className = 'od-slash-icon';
      glyph.append(icon(item.icon));
      li.append(glyph, text);
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

// ---- keyboard shortcut sheet ----

function setupShortcuts() {
  const dialog = document.querySelector('.od-shortcuts');
  const body = dialog.querySelector('.od-shortcuts-body');
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
  dialog.querySelector('[data-action="close"]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close(); // backdrop
  });
  return {
    toggle: () => (dialog.open ? dialog.close() : dialog.showModal()),
  };
}

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}
